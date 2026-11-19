// P5-05: campaigns — weekly jobs with an objective; weeks run strictly in order; one active campaign per org.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectCode, freshDb, type TestDb } from "../helpers/db.ts";

let t: TestDb;
let editor: string;
beforeAll(async () => { t = await freshDb(); editor = await t.login("editor"); });
afterAll(async () => t.db.close());

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const create = (weeks = 3, s = editor, start = future(7)) => t.api<string>(
  "select lbe.campaign_create($1, 'Q1 awareness', 'awareness', 'Password hygiene for small teams', $2::date, $3, 4)", [s, start, weeks]);
const claim = async (worker: string) => (await t.worker<{ r: { id: string; params: Record<string, unknown> } | null }>(
  "select lbe.job_claim($1, 60) as r", [worker]))[0]!.r;
const finish = (worker: string, id: string, status = "succeeded") => t.worker("select lbe.job_finish($1, $2, $3, null)", [worker, id, status]);
const drain = () => t.db.query("update lbe.agent_jobs set status = 'cancelled', lease_owner = null, lease_expires_at = null where status in ('queued', 'running')");

describe("campaigns", () => {
  it("creates one job per week with dates, objective and a rotating pillar focus", async () => {
    const id = await create(3);
    const jobs = await t.db.query<{ campaign_week: number; params: { goal: string; start_date: string; post_count: number; campaign: { focus: string } } }>(
      "select campaign_week, params from lbe.agent_jobs where campaign_id = $1 order by campaign_week", [id]);
    expect(jobs.map((j) => j.campaign_week)).toEqual([1, 2, 3]);
    expect(jobs.map((j) => j.params.start_date)).toEqual([future(7), future(14), future(21)]);
    expect(jobs[0]!.params.goal).toMatch(/week 1 of 3, objective: build awareness/);
    expect(jobs[0]!.params.post_count).toBe(4);
    expect(new Set(jobs.map((j) => j.params.campaign.focus)).size).toBe(3);   // different pillar each week
    await drain();
  });

  it("weeks run strictly in order, even with several runners", async () => {
    const id = await create(3);
    const first = await claim("r1");
    expect(first!.params).toMatchObject({ campaign: { id, week: 1 } });
    expect(await claim("r2")).toBeNull();                         // week 2 waits for week 1
    await finish("r1", first!.id);
    const second = await claim("r2");
    expect(second!.params).toMatchObject({ campaign: { week: 2 } });
    await finish("r2", second!.id, "failed");                     // a failed week does not block the rest…
    const third = await claim("r3");
    expect(third!.params).toMatchObject({ campaign: { week: 3 } });
    await finish("r3", third!.id);
    const c = await t.api<{ status: string; week_jobs: Array<{ status: string }> }>("select lbe.campaign_get($1, $2)", [editor, id]);
    expect(c.status).toBe("partially_completed");                 // …but the campaign says so honestly
    expect(c.week_jobs.map((w) => w.status)).toEqual(["succeeded", "failed", "succeeded"]);
  });

  it("a retried week keeps its place in the campaign", async () => {
    const id = await create(2);
    const w1 = await claim("r1");
    await finish("r1", w1!.id, "failed");
    const retry = await t.api<string>("select lbe.job_retry($1, $2)", [editor, w1!.id]);
    const [row] = await t.db.query<{ campaign_id: string; campaign_week: number }>("select campaign_id, campaign_week from lbe.agent_jobs where id = $1", [retry]);
    expect(row).toMatchObject({ campaign_id: id, campaign_week: 1 });
    // the retried week 1 runs first; week 2 waits for it, so it still sees week 1's drafts
    const next = await claim("r2");
    expect(next!.id).toBe(retry);
    expect(await claim("r3")).toBeNull();
    await finish("r2", retry);
    expect((await claim("r3"))!.params).toMatchObject({ campaign: { week: 2 } });
    await drain();
  });

  it("one active campaign per organization; campaigns don't use the ad-hoc job limit; cancel stops all weeks", async () => {
    const id = await create(3);
    await expectCode(create(2), "LBE01");
    for (let i = 0; i < 5; i++) await t.api("select lbe.job_enqueue($1, 'brand_workflow', $2::jsonb)", [editor, JSON.stringify({ goal: `ad hoc ${i}` })]);
    await expectCode(t.api("select lbe.job_enqueue($1, 'brand_workflow', $2::jsonb)", [editor, JSON.stringify({ goal: "one more" })]), "LBE01");
    await expectCode(t.api("select lbe.job_enqueue($1, 'brand_workflow', $2::jsonb)", [editor, JSON.stringify({ goal: "fake", campaign: {} })]), "LBE02");
    expect(await t.api<number>("select lbe.campaign_cancel($1, $2)", [editor, id])).toBe(3);
    const c = await t.api<{ status: string }>("select lbe.campaign_get($1, $2)", [editor, id]);
    expect(c.status).toBe("cancelled");
    await drain();
  });

  it("validates input; viewers cannot plan; other organizations cannot see it", async () => {
    await expectCode(create(2, editor, "2020-01-01"), "LBE02");
    await t.db.query("select lbe.admin_create_user('vc@lbe.test', 'V', 'viewer', 'viewer-password-123')");
    const viewer = (await t.api<{ token: string }>("select lbe.login('vc@lbe.test', 'viewer-password-123')")).token;
    await expectCode(create(2, viewer), "LBE11");
    const id = await create(1);
    const [o] = await t.db.query<{ id: string }>("insert into lbe.organizations(name, slug) values ('Org C', 'org-c') returning id");
    await t.db.query("select lbe.admin_create_user('c@lbe.test', 'C', 'admin', 'org-c-password-123', $1)", [o!.id]);
    const other = (await t.api<{ token: string }>("select lbe.login('c@lbe.test', 'org-c-password-123')")).token;
    await expectCode(t.api("select lbe.campaign_get($1, $2)", [other, id]), "LBE04");
    expect(await t.api<unknown[]>("select lbe.campaign_list($1)", [other])).toEqual([]);
    await drain();
  });
});
