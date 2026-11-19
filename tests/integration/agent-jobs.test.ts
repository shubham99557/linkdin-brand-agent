// P4-01: the Branding Agent runs as a durable background job (API → queue → runner), with progress,
// cancellation at step boundaries and no long-running HTTP request.
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockSpecialists, type Specialists } from "@lbe/agents";
import { MockDrafter } from "@lbe/drafting";
import { MockLinkedInProvider } from "@lbe/publishing";
import { createApp } from "../../services/api/src/app.ts";
import { runAgentJobTick } from "../../services/api/src/jobs/agent-runner.ts";
import { dbMockStore } from "../../services/api/src/jobs/publisher.ts";
import { freshDb, TEST_PASSWORDS, type TestDb } from "../helpers/db.ts";

const ORIGIN = "http://localhost:5173";
const VOICE = path.resolve(import.meta.dirname, "../../brand/voice");
let t: TestDb;
let app: ReturnType<typeof createApp>;
const logs: string[] = [];

beforeAll(async () => {
  t = await freshDb();
  app = createApp({ db: t.db, drafter: new MockDrafter(), provider: new MockLinkedInProvider(dbMockStore(t.db)),
    appOrigins: [ORIGIN], cookieSecure: false, voiceDir: VOICE, workerId: "jobs", log: () => undefined });
});
afterAll(async () => t.db.close());

async function login(email = "editor@lbe.test", pw = TEST_PASSWORDS.editor) {
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: pw }) });
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
async function call(cookie: string, method: string, url: string, body?: unknown) {
  const res = await app.request(url, { method, headers: { cookie, origin: ORIGIN, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const tick = (specialists: Specialists = mockSpecialists(), workerId = "runner-1") =>
  runAgentJobTick({ db: t.db, specialists, writer: new MockDrafter(), voiceDir: VOICE, workerId, log: (m, e) => logs.push(`${m} ${JSON.stringify(e)}`) });

describe("durable Branding Agent jobs", () => {
  it("POST returns 202 at once; the runner executes it; progress and result are visible", async () => {
    const editor = await login();
    const q = await call(editor, "POST", "/api/agent/workflows", { goal: "One week on phishing awareness for UK SMEs", start_date: "2027-05-03" });
    expect(q.status).toBe(202);
    expect((await call(editor, "GET", `/api/agent/jobs/${q.body.job_id}`)).body.status).toBe("queued");
    const r = await tick();
    expect(r.job).toMatchObject({ id: q.body.job_id, status: "succeeded" });
    const job = (await call(editor, "GET", `/api/agent/jobs/${q.body.job_id}`)).body;
    expect(job).toMatchObject({ status: "succeeded", progress: { stage: "succeeded" } });
    expect(job.progress.total).toBeGreaterThan(0);
    const wf = (await call(editor, "GET", `/api/agent/workflows/${job.workflow_id}`)).body;
    expect(wf.status).toBe("completed");
    expect(wf.drafts.length).toBe(job.progress.total);
    expect((await call(editor, "GET", "/api/agent/jobs")).body[0].id).toBe(q.body.job_id);
    // No job session left behind, and no session token in the runner's logs.
    const [s] = await t.db.query<{ n: number }>("select count(*)::int as n from lbe.sessions where kind = 'agent_job' and revoked_at is null");
    expect(s!.n).toBe(0);
    expect(logs.join("\n")).not.toMatch(/[0-9a-f]{64}/);
  });

  it("cancelling a running job stops it at the next step; saved work is kept and no further model calls happen", async () => {
    const editor = await login();
    const q = await call(editor, "POST", "/api/agent/workflows", { goal: "Cancellation test goal", start_date: "2027-05-10" });
    const base = mockSpecialists();
    let strategyCalls = 0;
    const specialists: Specialists = {
      ...base,
      // The user presses Cancel while research is running.
      research: { ...base.research, run: async (i) => { await call(editor, "POST", `/api/agent/jobs/${q.body.job_id}/cancel`); return base.research.run(i); } },
      strategy: { ...base.strategy, run: async (i) => { strategyCalls++; return base.strategy.run(i); } },
    };
    const r = await tick(specialists);
    expect(r.job?.status).toBe("cancelled");
    expect(strategyCalls).toBe(0);
    const job = (await call(editor, "GET", `/api/agent/jobs/${q.body.job_id}`)).body;
    expect(job.status).toBe("cancelled");
    const wf = (await call(editor, "GET", `/api/agent/workflows/${job.workflow_id}`)).body;
    expect(wf.status).toBe("cancelled");
    expect(wf.findings.length).toBeGreaterThan(0);                     // research already saved is kept
    expect(wf.drafts.length).toBe(0);
  });

  it("a failing workflow fails the job with a redacted error; the queue keeps working", async () => {
    const editor = await login();
    const q = await call(editor, "POST", "/api/agent/workflows", { goal: "Failure test goal" });
    const base = mockSpecialists();
    const r = await tick({ ...base, strategy: { ...base.strategy, run: async () => ({ kind: "error", message: `boom owner@acme.example ${"a".repeat(64)}` }) } });
    expect(r.job?.status).toBe("failed");
    const job = (await call(editor, "GET", `/api/agent/jobs/${q.body.job_id}`)).body;
    expect(job.error).toContain("strategy specialist failed");
    expect(job.error).not.toContain("owner@acme.example");
    expect(job.error).not.toContain("a".repeat(64));
    expect((await tick()).job).toBeNull();                              // nothing left
  });

  it("P4-02: a runner that hangs mid-run is replaced; the job resumes the same workflow with no duplicate drafts, and the zombie cannot write", async () => {
    const editor = await login();
    const q = await call(editor, "POST", "/api/agent/workflows", { goal: "Crash and resume test goal", start_date: "2027-06-07" });
    const base = mockSpecialists();
    const realWriter = new MockDrafter();
    // Runner A: the 3rd draft hangs (simulated crash / frozen process) until we release it.
    let callsA = 0;
    let hung!: () => void;
    let reachedHang!: () => void;
    const hangReached = new Promise<void>((r) => { reachedHang = r; });
    const writerA = { provider: "mock" as const, model: "mock-drafter-v1", draft: async (i: Parameters<MockDrafter["draft"]>[0]) => {
      callsA++;
      if (callsA === 3) { reachedHang(); await new Promise<void>((r) => { hung = r; }); }
      return realWriter.draft(i);
    } };
    const tickA = runAgentJobTick({ db: t.db, specialists: base, writer: writerA, voiceDir: VOICE, workerId: "runner-A", heartbeatMs: 3_600_000 });
    await hangReached;
    const jobId = q.body.job_id as string;
    const wfId = (await call(editor, "GET", `/api/agent/jobs/${jobId}`)).body.workflow_id as string;
    const before = await t.db.query<{ id: string; body: string | null }>("select id, body from lbe.content_items where workflow_id = $1 order by created_at", [wfId]);
    expect(before.length).toBe(3);                                       // 2 finished + the one being written
    expect(before.filter((d) => d.body).length).toBe(2);
    const inFlight = before.find((d) => !d.body)!.id;

    // The lease runs out (runner A is "dead"); runner B recovers the job and resumes it.
    await t.db.query("update lbe.agent_jobs set lease_expires_at = now() - interval '1 second' where id = $1", [jobId]);
    let callsB = 0;
    const writerB = { provider: "mock" as const, model: "mock-drafter-v1", draft: async (i: Parameters<MockDrafter["draft"]>[0]) => { callsB++; return realWriter.draft(i); } };
    let researchCallsB = 0;
    const specialistsB: Specialists = { ...base, research: { ...base.research, run: async (i) => { researchCallsB++; return base.research.run(i); } } };
    const rB = await runAgentJobTick({ db: t.db, specialists: specialistsB, writer: writerB, voiceDir: VOICE, workerId: "runner-B" });
    expect(rB.recovered).toBe(1);
    expect(rB.job).toMatchObject({ id: jobId, status: "succeeded", workflowId: wfId });
    expect(researchCallsB).toBe(0);                                      // saved research reused

    const after = await t.db.query<{ id: string; variant_group: string; account_id: string; status: string }>(
      "select id, variant_group, account_id, status from lbe.content_items where workflow_id = $1", [wfId]);
    const job = (await call(editor, "GET", `/api/agent/jobs/${jobId}`)).body;
    expect(after.length).toBe(job.progress.total);                       // exactly one draft per plan item and account
    expect(new Set(after.map((d) => `${d.variant_group}:${d.account_id}`)).size).toBe(after.length);
    expect(after.some((d) => d.id === inFlight)).toBe(true);             // the half-written draft was continued, not replaced
    expect(callsB).toBe(after.length - 2);                               // only unfinished drafts were written again
    const wf = (await call(editor, "GET", `/api/agent/workflows/${wfId}`)).body;
    expect(wf.status).toBe("completed");
    expect(wf.result.warnings.join(" ")).toMatch(/Resumed after an interruption/);

    // Release the zombie: its session was revoked, so it cannot change anything.
    hung();
    const rA = await tickA;
    expect(rA.job?.status).toBe("failed");
    const final = await t.db.query("select id from lbe.content_items where workflow_id = $1", [wfId]);
    expect(final.length).toBe(after.length);
    expect((await call(editor, "GET", `/api/agent/jobs/${jobId}`)).body.status).toBe("succeeded");
  });

  it("P4-03: a stuck writer call is aborted at the step time limit; the draft is held with a clear reason and the run finishes", async () => {
    const editor = await login();
    const q = await call(editor, "POST", "/api/agent/workflows", { goal: "Timeout test goal for drafts", start_date: "2027-07-05" });
    const signals: AbortSignal[] = [];
    // A writer that never answers unless its request is aborted.
    const stuck = { provider: "mock" as const, model: "mock-drafter-v1", draft: (_i: unknown, opts?: { signal?: AbortSignal }) => new Promise<never>((_, reject) => {
      signals.push(opts!.signal!);
      opts!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
    }) };
    const started = Date.now();
    const r = await runAgentJobTick({ db: t.db, specialists: mockSpecialists(), writer: stuck, voiceDir: VOICE, workerId: "runner-T",
      stepTimeoutsMs: { draft: 150 } });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(r.job?.status).toBe("succeeded");
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.aborted)).toBe(true);                 // the model request itself was cancelled
    const job = (await call(editor, "GET", `/api/agent/jobs/${q.body.job_id}`)).body;
    const wf = (await call(editor, "GET", `/api/agent/workflows/${job.workflow_id}`)).body;
    const drafts = wf.result.drafts as Array<{ status: string; error?: string }>;
    expect(drafts.every((d) => d.status === "draft" && /timed out after 0s|timed out/.test(d.error ?? ""))).toBe(true);
    expect(wf.drafts.every((d: { status: string }) => d.status === "draft")).toBe(true);   // nothing reached review
  });

  it("P4-03: a stuck strategy step fails the job cleanly; Retry starts a linked new run that succeeds", async () => {
    const editor = await login();
    const q = await call(editor, "POST", "/api/agent/workflows", { goal: "Strategy timeout then retry", start_date: "2027-07-12" });
    const base = mockSpecialists();
    const r1 = await runAgentJobTick({ db: t.db, workerId: "runner-T", writer: new MockDrafter(), voiceDir: VOICE, stepTimeoutsMs: { strategy: 100 },
      specialists: { ...base, strategy: { ...base.strategy, run: (_i, opts) => new Promise((_, rej) => opts?.signal?.addEventListener("abort", () => rej(new Error("aborted")))) } } });
    expect(r1.job?.status).toBe("failed");
    const failed = (await call(editor, "GET", `/api/agent/jobs/${q.body.job_id}`)).body;
    expect(failed.error).toMatch(/strategy timed out/);
    expect(failed.progress.estimated_usd).toBeDefined();

    const retry = await call(editor, "POST", `/api/agent/jobs/${q.body.job_id}/retry`);
    expect(retry.status).toBe(202);
    expect((await call(editor, "POST", `/api/agent/jobs/${q.body.job_id}/retry`)).status).toBe(409);   // only once
    const r2 = await tick();
    expect(r2.job).toMatchObject({ id: retry.body.job_id, status: "succeeded" });
    const newJob = (await call(editor, "GET", `/api/agent/jobs/${retry.body.job_id}`)).body;
    expect(newJob).toMatchObject({ retry_of: q.body.job_id, goal: "Strategy timeout then retry" });
    expect(newJob.workflow_id).not.toBe(failed.workflow_id);            // a fresh run; the failed one stays as it was
    expect((await call(editor, "GET", `/api/agent/jobs/${q.body.job_id}`)).body.retried_as).toBe(retry.body.job_id);
  });

  it("viewers cannot start jobs; the API never accepts a job session as a login", async () => {
    await t.db.query("select lbe.admin_create_user('viewer@lbe.test', 'Viewer', 'viewer', 'viewer-password-123')");
    const viewer = await login("viewer@lbe.test", "viewer-password-123");
    expect((await call(viewer, "POST", "/api/agent/workflows", { goal: "Should not run" })).status).toBe(403);
    const editor = await login();
    const q = await call(editor, "POST", "/api/agent/workflows", { goal: "Session misuse test" });
    const claimed = (await t.worker<{ r: { session: string } }>("select lbe.job_claim('manual', 60) as r"))[0]!.r;
    const res = await app.request("/api/me", { headers: { cookie: `lbe_session=${claimed.session}` } });
    expect(res.status).toBe(401);
    await t.worker("select lbe.job_finish('manual', $1, 'failed', 'test')", [q.body.job_id]);
  });
});
