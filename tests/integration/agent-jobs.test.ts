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
