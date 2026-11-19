// Real-PostgreSQL concurrency tests (multiple connections, real row locks).
// Run with: LBE_TEST_PG_URL=postgres://postgres:<pw>@127.0.0.1:54329/lbe npm run test:pg
// Each run creates and drops its own temporary database.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, openDb, type Db } from "../../services/api/src/db.ts";
import { seed, type SeedResult } from "../../services/api/src/seed.ts";
import { TEST_PASSWORDS } from "../helpers/db.ts";

const ADMIN_URL = process.env.LBE_TEST_PG_URL;
const suite = ADMIN_URL ? describe : describe.skip;

let db: Db;
let ids: SeedResult;
let dbName = "";
let sessions: Record<"editor" | "approver" | "admin", string>;

const api = async <T>(sql: string, params: unknown[] = []) =>
  db.tx("lbe_api", async (q) => Object.values((await q.query<Record<string, unknown>>(sql, params))[0] ?? {})[0] as T);
const settle = <T>(ps: Array<Promise<T>>) => Promise.allSettled(ps);

async function inReview(): Promise<string> {
  const id = await api<string>("select lbe.create_content($1, $2, 'threat-landscape', 'race test', null, null)",
    [sessions.editor, ids.accounts.company]);
  await api("select lbe.set_draft_output($1, $2, $3, $4::jsonb, '[]'::jsonb)", [sessions.editor, id,
    "[SYNTHETIC] ActTrident is a UK-registered cybersecurity company. Race test.",
    JSON.stringify([{ claim_id: ids.claims[0], quoted_span: "ActTrident is a UK-registered cybersecurity company" }])]);
  await api("select lbe.submit_for_review($1, $2)", [sessions.editor, id]);
  return id;
}
const hashOf = async (id: string) =>
  (await db.query<{ package_hash: string }>("select package_hash from lbe.content_items where id = $1", [id]))[0]!.package_hash;
async function queued(): Promise<string> {
  const id = await inReview();
  await api("select lbe.decide_content($1, $2, $3, 'approved', null)", [sessions.approver, id, await hashOf(id)]);
  await api("select lbe.enqueue_publication($1, $2)", [sessions.approver, id]);
  return id;
}

suite("PostgreSQL concurrency", () => {
  beforeAll(async () => {
    dbName = `lbe_test_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    await admin.end();
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${dbName}`;
    db = await openDb({ url: url.toString() });
    await migrate(db);
    ids = await seed(db, TEST_PASSWORDS);
    const login = async (email: string, pw: string) =>
      (await api<{ token: string }>("select lbe.login($1, $2)", [email, pw])).token;
    sessions = {
      editor: await login("editor@lbe.test", TEST_PASSWORDS.editor),
      approver: await login("marketing@lbe.test", TEST_PASSWORDS.approver),
      admin: await login("admin@lbe.test", TEST_PASSWORDS.admin),
    };
  });

  afterAll(async () => {
    if (!db) return;
    await db.close();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${dbName} with (force)`);
    await admin.end();
  });

  it("concurrent workers never claim the same outbox entry", async () => {
    const created = await Promise.all(Array.from({ length: 12 }, () => queued()));
    const claims = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      db.tx("lbe_worker", (q) => q.query<{ id: string }>("select id from lbe.claim_outbox($1, 3, 60, array['mock'])", [`w${i}`]))));
    const claimedIds = claims.flat().map((r) => r.id);
    expect(new Set(claimedIds).size).toBe(claimedIds.length);       // no duplicates
    expect(claimedIds.length).toBe(created.length);                    // everything claimed exactly once
  });

  it("racing approve and edit never leaves an approval bound to a different package", async () => {
    for (let i = 0; i < 15; i++) {
      const id = await inReview();
      const hash = await hashOf(id);
      await settle([
        api("select lbe.decide_content($1, $2, $3, 'approved', null)", [sessions.approver, id, hash]),
        api("select lbe.update_content($1, $2, $3::jsonb)", [sessions.editor, id, JSON.stringify({ visibility: "CONNECTIONS" })]),
      ]);
      const [row] = await db.query<{ status: string; package_hash: string }>(
        "select status, package_hash from lbe.content_items where id = $1", [id]);
      if (row!.status === "approved") {
        const [a] = await db.query<{ package_hash: string }>(
          "select package_hash from lbe.content_approvals where content_id = $1 order by created_at desc limit 1", [id]);
        expect(a!.package_hash).toBe(row!.package_hash);
      } else {
        expect(row!.status).toBe("draft");
      }
    }
  });

  it("two approvers deciding at once produce exactly one decision", async () => {
    const id = await inReview();
    const hash = await hashOf(id);
    const adminIsApprover = sessions.admin;   // admin is an approver for the company account in the seed
    const results = await settle([
      api("select lbe.decide_content($1, $2, $3, 'approved', null)", [sessions.approver, id, hash]),
      api("select lbe.decide_content($1, $2, $3, 'approved', null)", [adminIsApprover, id, hash]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rows = await db.query("select 1 from lbe.content_approvals where content_id = $1", [id]);
    expect(rows).toHaveLength(1);
  });

  it("concurrent double enqueue creates exactly one outbox entry", async () => {
    const id = await inReview();
    await api("select lbe.decide_content($1, $2, $3, 'approved', null)", [sessions.approver, id, await hashOf(id)]);
    const results = await settle([
      api("select lbe.enqueue_publication($1, $2)", [sessions.approver, id]),
      api("select lbe.enqueue_publication($1, $2)", [sessions.approver, id]),
      api("select lbe.enqueue_publication($1, $2)", [sessions.admin, id]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rows = await db.query("select 1 from lbe.publication_outbox where content_id = $1", [id]);
    expect(rows).toHaveLength(1);
  });

  it("after a STOP commits, no worker can claim", async () => {
    // Drain anything left over, then queue fresh work.
    await db.tx("lbe_worker", (q) => q.query("select lbe.claim_outbox('drain', 50, 60, array['mock'])"));
    await Promise.all(Array.from({ length: 4 }, () => queued()));
    await api("select lbe.set_stop($1, 'global', true, 'concurrency test')", [sessions.editor]);
    const claims = await Promise.all(Array.from({ length: 4 }, (_, i) =>
      db.tx("lbe_worker", (q) => q.query("select id from lbe.claim_outbox($1, 5, 60, array['mock'])", [`s${i}`]))));
    expect(claims.flat()).toHaveLength(0);
    await api("select lbe.set_stop($1, 'global', false, 'done')", [sessions.admin]);
  });

  it("STOP racing claims of pending jobs: no claim succeeds after the STOP transaction commits", async () => {
    await db.tx("lbe_worker", (q) => q.query("select lbe.claim_outbox('drain2', 50, 60, array['mock'])"));
    await Promise.all(Array.from({ length: 6 }, () => queued()));
    // Fire STOP and many claimers concurrently; afterwards nothing may move to dispatching.
    const results = await settle([
      api("select lbe.set_stop($1, 'global', true, 'race')", [sessions.editor]),
      ...Array.from({ length: 6 }, (_, i) => db.tx("lbe_worker", (q) => q.query<{ id: string }>("select id from lbe.claim_outbox($1, 1, 60, array['mock'])", [`r${i}`]))),
    ]);
    expect(results[0]!.status).toBe("fulfilled");
    const claimedDuringRace = results.slice(1).flatMap((r) => (r.status === "fulfilled" ? (r.value as Array<{ id: string }>) : []));
    const after = await Promise.all(Array.from({ length: 4 }, (_, i) =>
      db.tx("lbe_worker", (q) => q.query("select id from lbe.claim_outbox($1, 5, 60, array['mock'])", [`a${i}`]))));
    expect(after.flat()).toHaveLength(0);
    // Anything claimed in the race was claimed by exactly one worker.
    expect(new Set(claimedDuringRace.map((c) => c.id)).size).toBe(claimedDuringRace.length);
    await api("select lbe.set_stop($1, 'global', false, 'race over')", [sessions.admin]);
  });

  it("duplicate provider responses: concurrent completions record exactly one outcome", async () => {
    await db.tx("lbe_worker", (q) => q.query("select lbe.claim_outbox('drain3', 50, 60, array['mock'])"));
    const id = await queued();
    const [ob] = await db.tx("lbe_worker", (q) => q.query<{ id: string }>("select id from lbe.claim_outbox('w-dup', 1, 60, array['mock'])"));
    const results = await settle([
      db.tx("lbe_worker", (q) => q.query("select lbe.complete_outbox($1, 'w-dup', 'success', 'urn:li:share:dup-1', null, null)", [ob!.id])),
      db.tx("lbe_worker", (q) => q.query("select lbe.complete_outbox($1, 'w-dup', 'success', 'urn:li:share:dup-2', null, null)", [ob!.id])),
      db.tx("lbe_worker", (q) => q.query("select lbe.complete_outbox($1, 'w-dup', 'ambiguous', null, 'late', null)", [ob!.id])),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [row] = await db.query<{ status: string; provider_ref: string | null }>("select status, provider_ref from lbe.publication_outbox where id = $1", [ob!.id]);
    const [content] = await db.query<{ status: string }>("select status from lbe.content_items where id = $1", [id]);
    expect(["succeeded", "needs_reconciliation"]).toContain(row!.status);
    expect(content!.status).toBe(row!.status === "succeeded" ? "published" : "needs_reconciliation");
  });

  it("recovery after an ambiguous outcome: concurrent reconciliation and lease expiry cannot double-dispatch", async () => {
    await db.tx("lbe_worker", (q) => q.query("select lbe.claim_outbox('drain4', 50, 60, array['mock'])"));
    const id = await queued();
    const [ob] = await db.tx("lbe_worker", (q) => q.query<{ id: string }>("select id from lbe.claim_outbox('w-amb', 1, 60, array['mock'])"));
    await db.tx("lbe_worker", (q) => q.query("select lbe.complete_outbox($1, 'w-amb', 'ambiguous', null, 'timeout', null)", [ob!.id]));
    // Two admins resolve at the same time with different conclusions; exactly one wins.
    const results = await settle([
      api("select lbe.reconcile_publication($1, $2, 'confirmed_not_published', null, 'checked: absent')", [sessions.admin, ob!.id]),
      api("select lbe.reconcile_publication($1, $2, 'confirmed_published', 'urn:li:share:found', 'checked: present')", [sessions.admin, ob!.id]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    // If re-queued, concurrent workers dispatch it at most once.
    const claims = await Promise.all(Array.from({ length: 4 }, (_, i) =>
      db.tx("lbe_worker", (q) => q.query<{ id: string }>("select id from lbe.claim_outbox($1, 5, 60, array['mock'])", [`rec${i}`]))));
    expect(claims.flat().filter((c) => c.id === ob!.id).length).toBeLessThanOrEqual(1);
    const [c] = await db.query<{ status: string }>("select status from lbe.content_items where id = $1", [id]);
    expect(["published", "queued"]).toContain(c!.status);
  });

  it("cross-organization requests in parallel never touch the other organization", async () => {
    const [o] = await db.query<{ id: string }>("insert into lbe.organizations(name, slug) values ('Par B', $1) returning id", [`par-${Date.now()}`]);
    await db.query("select lbe.admin_create_user($1, 'PB', 'admin', 'parallel-b-password', $2)", [`pb-${Date.now()}@b.test`, o!.id]);
    const [u] = await db.query<{ email: string }>("select email from lbe.app_users where organization_id = $1", [o!.id]);
    const sB = (await api<{ token: string }>("select lbe.login($1, 'parallel-b-password')", [u!.email])).token;
    const id = await queued();
    const [ob] = await db.query<{ id: string }>("select id from lbe.publication_outbox where content_id = $1", [id]);
    const results = await settle([
      api("select lbe.cancel_publication($1, $2)", [sB, ob!.id]),
      api("select lbe.set_stop($1, $2, true, 'x')", [sB, `account:${ids.accounts.company}`]),
      api("select lbe.update_content($1, $2, '{\"brief\":\"x\"}'::jsonb)", [sB, id]),
      api("select lbe.brain_load($1)", [sB]),
    ]);
    expect(results.slice(0, 3).every((r) => r.status === "rejected" && (r.reason as { code?: string }).code === "LBE04")).toBe(true);
    expect(results[3]!.status).toBe("fulfilled");
    const [row] = await db.query<{ status: string }>("select status from lbe.publication_outbox where id = $1", [ob!.id]);
    expect(row!.status).toBe("pending");
  });

  it("agent jobs (P4-01): concurrent runners claim each job exactly once, one job session each", async () => {
    const jobs = [];
    for (let i = 0; i < 4; i++) {
      jobs.push(await api<string>("select lbe.job_enqueue($1, 'brand_workflow', $2::jsonb)", [sessions.editor, JSON.stringify({ goal: `race goal ${i}` })]));
    }
    const claims = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      db.tx("lbe_worker", async (q) => (await q.query<{ r: { id: string } | null }>("select lbe.job_claim($1, 60) as r", [`runner-${i}`]))[0]!.r)));
    const ids = claims.filter((c): c is { id: string } => !!c).map((c) => c.id);
    expect(ids.length).toBe(jobs.length);
    expect(new Set(ids).size).toBe(jobs.length);
    const [s] = await db.query<{ n: number }>("select count(*)::int as n from lbe.sessions where kind = 'agent_job' and job_id = any($1::uuid[])", [jobs]);
    expect(s!.n).toBe(jobs.length);
    // Lease recovery racing a heartbeat: the job ends up either still running (heartbeat won) or re-queued for
    // resume (P4-02) with the lost runner's session revoked — never both.
    const victim = jobs[0]!;
    const owner = (await db.query<{ lease_owner: string }>("select lease_owner from lbe.agent_jobs where id = $1", [victim]))[0]!.lease_owner;
    await db.query("update lbe.agent_jobs set lease_expires_at = now() - interval '1 second' where id = $1", [victim]);
    await settle([
      db.tx("lbe_worker", (q) => q.query("select lbe.job_recover_expired()")),
      db.tx("lbe_worker", (q) => q.query("select lbe.job_heartbeat($1, $2, '{}'::jsonb, null, 60)", [owner, victim])),
    ]);
    const [v] = await db.query<{ status: string }>("select status from lbe.agent_jobs where id = $1", [victim]);
    expect(["running", "queued"]).toContain(v!.status);
    const [live] = await db.query<{ n: number }>("select count(*)::int as n from lbe.sessions where job_id = $1 and revoked_at is null", [victim]);
    expect(live!.n).toBe(v!.status === "running" ? 1 : 0);
    await db.query("update lbe.agent_jobs set status = 'cancelled', lease_owner = null, lease_expires_at = null where status in ('queued', 'running')");
  });

  it("campaigns (P5-05): concurrent runners can only ever take week 1 first", async () => {
    const start = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const id = await api<string>("select lbe.campaign_create($1, 'Race campaign', 'awareness', 'Race goal text', $2::date, 3, 3)", [sessions.editor, start]);
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      db.tx("lbe_worker", async (q) => (await q.query<{ r: { params: { campaign?: { id: string; week: number } } } | null }>(
        "select lbe.job_claim($1, 60) as r", [`camp-${i}`]))[0]!.r)));
    const got = claims.filter((c) => c?.params.campaign?.id === id).map((c) => c!.params.campaign!.week);
    expect(got).toEqual([1]);
  });
});
