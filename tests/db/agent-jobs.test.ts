// P4-01: durable agent jobs — queue, claim/lease, job sessions, heartbeat ownership, cancel, interruption.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectCode, freshDb, type TestDb } from "../helpers/db.ts";

let t: TestDb;
let editor: string;
let admin: string;
beforeAll(async () => { t = await freshDb(); editor = await t.login("editor"); admin = await t.login("admin"); });
afterAll(async () => t.db.close());

const enqueue = (s: string, goal = "A week on phishing awareness") =>
  t.api<string>("select lbe.job_enqueue($1, 'brand_workflow', $2::jsonb)", [s, JSON.stringify({ goal })]);
const w1 = async <T>(sql: string, params: unknown[] = []) => (await t.worker<Record<string, T>>(sql, params))[0]!;
const claim = async (worker = "w1") => Object.values(await w1<{ id: string; session: string } | null>("select lbe.job_claim($1, 60) as r", [worker]))[0];
const job = async (id: string) => (await t.db.query<{ status: string; lease_owner: string | null; error: string | null; workflow_id: string | null }>(
  "select status, lease_owner, error, workflow_id from lbe.agent_jobs where id = $1", [id]))[0]!;
/** Finish any leftover job so each test starts with an empty queue. */
const drain = async () => {
  await t.db.query("update lbe.agent_jobs set status = 'cancelled', lease_owner = null, lease_expires_at = null where status in ('queued', 'running')");
};

describe("queue and claim", () => {
  it("editors enqueue; viewers cannot; goal validated", async () => {
    const id = await enqueue(editor);
    expect((await job(id)).status).toBe("queued");
    await expectCode(t.api("select lbe.job_enqueue($1, 'brand_workflow', $2::jsonb)", [editor, JSON.stringify({ goal: "x" })]), "LBE02");
    await expectCode(t.api("select lbe.job_enqueue($1, 'other', $2::jsonb)", [editor, JSON.stringify({ goal: "valid goal" })]), "LBE02");
    await drain();
  });

  it("a claim leases the job to one worker and mints a job session that the dashboard refuses", async () => {
    const id = await enqueue(editor);
    const c = (await claim("w1"))!;
    expect(c.id).toBe(id);
    expect(await job(id)).toMatchObject({ status: "running", lease_owner: "w1" });
    expect(await claim("w2")).toBeNull();                                         // nothing else to claim
    expect(await t.api("select lbe.whoami($1)", [c.session])).toBeNull();        // cannot sign in / use the API
    // …but database functions accept it as the requesting user (all rules still apply), e.g. via the agent role:
    const brain = await t.db.tx("lbe_agent", (q) => q.query<{ b: { organization: { name: string } } }>("select lbe.brain_load($1) as b", [c.session]));
    expect(brain[0]!.b.organization.name).toBeTruthy();
    // The agent role still cannot approve with it.
    await expectCode(t.db.tx("lbe_agent", (q) => q.query("select lbe.decide_content($1, gen_random_uuid(), 'x', 'approved', null)", [c.session])), "42501");
    // Finishing revokes the job session.
    await t.worker("select lbe.job_finish('w1', $1, 'succeeded', null)", [id]);
    await expectCode(t.db.tx("lbe_agent", (q) => q.query("select lbe.brain_load($1)", [c.session])), "LBE10");
    const [s] = await t.db.query<{ n: number }>("select count(*)::int as n from lbe.sessions where job_id = $1 and revoked_at is null", [id]);
    expect(s!.n).toBe(0);
  });

  it("only the lease owner can heartbeat or finish", async () => {
    const id = await enqueue(editor);
    await claim("w1");
    const hb = Object.values(await w1<{ ok: boolean }>("select lbe.job_heartbeat('intruder', $1, '{}'::jsonb, null, 60) as r", [id]))[0]!;
    expect(hb.ok).toBe(false);
    await expectCode(t.worker("select lbe.job_finish('intruder', $1, 'succeeded', null)", [id]), "LBE01");
    await t.worker("select lbe.job_finish('w1', $1, 'failed', 'test')", [id]);
    expect((await job(id)).status).toBe("failed");
  });

  it("jobs of a disabled user fail at claim time", async () => {
    const id = await enqueue(editor);
    await t.db.query("update lbe.app_users set disabled = true where id = $1", [t.ids.users.editor]);
    expect(await claim()).toBeNull();
    expect(await job(id)).toMatchObject({ status: "failed", error: "the requesting user is disabled" });
    await t.db.query("update lbe.app_users set disabled = false where id = $1", [t.ids.users.editor]);
    editor = await t.login("editor");
  });

  it("an organization can have at most 5 waiting/running jobs", async () => {
    for (let i = 0; i < 5; i++) await enqueue(editor, `goal number ${i}`);
    await expectCode(enqueue(editor, "one too many"), "LBE01");
    await drain();
  });
});

describe("cancel", () => {
  it("queued → cancelled immediately; running → flag the runner sees on heartbeat", async () => {
    const q = await enqueue(editor);
    expect(await t.api("select lbe.job_cancel($1, $2)", [editor, q])).toBe("cancelled");
    expect((await job(q)).status).toBe("cancelled");
    const r = await enqueue(editor);
    await claim("w1");
    expect(await t.api("select lbe.job_cancel($1, $2)", [admin, r])).toBe("cancel_requested");   // admin may cancel others' jobs
    const hb = Object.values(await w1<{ ok: boolean; cancel: boolean }>("select lbe.job_heartbeat('w1', $1, '{}'::jsonb, null, 60) as r", [r]))[0]!;
    expect(hb).toMatchObject({ ok: true, cancel: true });
    await t.worker("select lbe.job_finish('w1', $1, 'cancelled', 'cancelled by user')", [r]);
    await expectCode(t.api("select lbe.job_cancel($1, $2)", [editor, r]), "LBE01");               // already finished
  });

  it("other users (non-admin) cannot cancel someone else's job; other organizations get 'not found'", async () => {
    const id = await enqueue(editor);
    await expectCode(t.api("select lbe.job_cancel($1, $2)", [await t.login("approver"), id]), "LBE11");
    const [o] = await t.db.query<{ id: string }>("insert into lbe.organizations(name, slug) values ('Org J', 'org-j') returning id");
    await t.db.query("select lbe.admin_create_user('j@lbe.test', 'J', 'admin', 'org-j-password-123', $1)", [o!.id]);
    const other = (await t.api<{ token: string }>("select lbe.login('j@lbe.test', 'org-j-password-123')")).token;
    await expectCode(t.api("select lbe.job_cancel($1, $2)", [other, id]), "LBE04");
    await expectCode(t.api("select lbe.job_get($1, $2)", [other, id]), "LBE04");
    expect(await t.api<unknown[]>("select lbe.job_list($1)", [other])).toEqual([]);
    await drain();
  });
});

describe("interruption", () => {
  it("P4-02: an expired lease revokes the lost runner's session and re-queues the SAME workflow (up to 3 attempts), then marks it interrupted", async () => {
    const id = await enqueue(editor);
    const expire = () => t.db.query("update lbe.agent_jobs set lease_expires_at = now() - interval '1 second' where id = $1", [id]);
    const c = (await claim("w1"))!;
    const wf = await t.db.tx("lbe_agent", async (q) => (await q.query<{ id: string }>("select lbe.workflow_create($1, 'interrupted goal', '{}'::jsonb) as id", [c.session]))[0]!.id);
    await t.worker("select lbe.job_heartbeat('w1', $1, '{\"stage\":\"research\",\"estimated_usd\":0.42}'::jsonb, $2, 60)", [id, wf]);
    await expire();
    expect(Object.values(await w1<number>("select lbe.job_recover_expired() as n"))[0]).toBe(1);
    await expectCode(t.db.tx("lbe_agent", (q) => q.query("select lbe.brain_load($1)", [c.session])), "LBE10");   // zombie cut off
    expect(await job(id)).toMatchObject({ status: "queued", workflow_id: wf });
    const c2 = (await claim("w2")) as unknown as { id: string; workflow_id: string; spent_usd: number };
    expect(c2).toMatchObject({ id, workflow_id: wf });                              // resume the same workflow…
    expect(Number(c2.spent_usd)).toBeCloseTo(0.42);                                 // …and count the earlier spend
    await expire(); await t.worker("select lbe.job_recover_expired()");            // attempt 2 lost
    await claim("w3");
    await expire(); await t.worker("select lbe.job_recover_expired()");            // attempt 3 lost → give up
    expect(await job(id)).toMatchObject({ status: "interrupted", lease_owner: null, workflow_id: wf });
    expect(await claim("w4")).toBeNull();
    const [w] = await t.db.query<{ status: string }>("select status from lbe.agent_workflows where id = $1", [wf]);
    expect(w!.status).toBe("failed");
    // Manual resume (requester or admin) re-queues it and reopens the workflow.
    await expectCode(t.api("select lbe.job_resume($1, $2)", [await t.login("approver"), id]), "LBE11");
    await t.api("select lbe.job_resume($1, $2)", [editor, id]);
    expect(await job(id)).toMatchObject({ status: "queued", workflow_id: wf });
    const [w2] = await t.db.query<{ status: string }>("select status from lbe.agent_workflows where id = $1", [wf]);
    expect(w2!.status).toBe("running");
    await expectCode(t.api("select lbe.job_resume($1, $2)", [editor, id]), "LBE01");                // only interrupted jobs
    await drain();
  });

  it("P4-03: retry only for failed/cancelled jobs, by the requester or an admin, once; runs as the person who retried", async () => {
    const id = await enqueue(editor, "retry rules goal");
    await expectCode(t.api("select lbe.job_retry($1, $2)", [editor, id]), "LBE01");                 // still queued
    await t.api("select lbe.job_cancel($1, $2)", [editor, id]);
    await expectCode(t.api("select lbe.job_retry($1, $2)", [await t.login("approver"), id]), "LBE11");
    const r = await t.api<string>("select lbe.job_retry($1, $2)", [admin, id]);
    const [row] = await t.db.query<{ retry_of: string; requested_by: string; params: { goal: string }; status: string }>(
      "select retry_of, requested_by, params, status from lbe.agent_jobs where id = $1", [r]);
    expect(row).toMatchObject({ retry_of: id, requested_by: t.ids.users.admin, params: { goal: "retry rules goal" }, status: "queued" });
    await expectCode(t.api("select lbe.job_retry($1, $2)", [editor, id]), "LBE01");                 // already retried
    const [o] = await t.db.query<{ id: string }>("select id from lbe.organizations where slug = 'org-j'");
    if (o) {
      const other = (await t.api<{ token: string }>("select lbe.login('j@lbe.test', 'org-j-password-123')")).token;
      await expectCode(t.api("select lbe.job_retry($1, $2)", [other, id]), "LBE04");
    }
    await drain();
  });

  it("P4-02: the database allows only one draft per (workflow, plan item, account)", async () => {
    const id = await enqueue(editor);
    const c = (await claim("w1"))!;
    const agent = <T>(sql: string, p: unknown[]) => t.db.tx("lbe_agent", async (q) => Object.values((await q.query<Record<string, T>>(sql, p))[0]!)[0]!);
    const wf = await agent<string>("select lbe.workflow_create($1, 'dup guard goal', '{}'::jsonb)", [c.session]);
    const meta = JSON.stringify({ workflow_id: wf, variant_group: "11111111-2222-4333-8444-555555555555", created_via: "agent" });
    const first = await agent<string>("select lbe.create_content($1, $2, 'threat-landscape', 'one', null, null)", [c.session, t.ids.accounts.company]);
    await agent("select lbe.set_agent_metadata($1, $2, $3::jsonb)", [c.session, first, meta]);
    const second = await agent<string>("select lbe.create_content($1, $2, 'threat-landscape', 'two', null, null)", [c.session, t.ids.accounts.company]);
    await expectCode(agent("select lbe.set_agent_metadata($1, $2, $3::jsonb)", [c.session, second, meta]), "23505");
    // The founder account may have its own draft for the same plan item.
    const founder = await agent<string>("select lbe.create_content($1, $2, 'founder-lessons', 'f', null, null)", [c.session, t.ids.accounts.founder]);
    await agent("select lbe.set_agent_metadata($1, $2, $3::jsonb)", [c.session, founder, meta]);
    await t.worker("select lbe.job_finish('w1', $1, 'failed', 'test')", [id]);
  });

  it("heartbeat cannot attach another organization's workflow", async () => {
    const [o] = await t.db.query<{ id: string }>("select id from lbe.organizations where slug = 'org-j'");
    const otherWf = (await t.db.query<{ id: string }>(
      "insert into lbe.agent_workflows(organization_id, goal, created_by) values ($1, 'other', (select id from lbe.app_users where email = 'j@lbe.test')) returning id", [o!.id]))[0]!.id;
    const id = await enqueue(editor);
    await claim("w1");
    await expectCode(t.worker("select lbe.job_heartbeat('w1', $1, '{}'::jsonb, $2, 60)", [id, otherWf]), "LBE04");
    await t.worker("select lbe.job_finish('w1', $1, 'failed', 'test')", [id]);
  });
});
