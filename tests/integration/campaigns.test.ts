// P5-05: a whole month through the API and the durable runner — weeks in order, dates spread, no duplicate topics.
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockSpecialists, topicSimilarity } from "@lbe/agents";
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
beforeAll(async () => {
  t = await freshDb();
  app = createApp({ db: t.db, drafter: new MockDrafter(), provider: new MockLinkedInProvider(dbMockStore(t.db)),
    appOrigins: [ORIGIN], cookieSecure: false, voiceDir: VOICE, workerId: "camp", log: () => undefined });
});
afterAll(async () => t.db.close());

async function call(cookie: string, method: string, url: string, body?: unknown) {
  const res = await app.request(url, { method, headers: { cookie, origin: ORIGIN, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function login() {
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email: "editor@lbe.test", password: TEST_PASSWORDS.editor }) });
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe("monthly campaign", () => {
  it("plans 3 weeks × 3 posts with no duplicate topics across the month", async () => {
    const editor = await login();
    expect((await call(editor, "POST", "/api/agent/campaigns", { name: "x", objective: "awareness", goal: "Password hygiene for small teams",
      start_date: future(7), weeks: 3, posts_per_week: 3 })).status).toBe(422);            // name too short
    expect((await call(editor, "POST", "/api/agent/campaigns", { name: "March awareness", objective: "world_domination", goal: "x x x",
      start_date: future(7), weeks: 3, posts_per_week: 3 })).status).toBe(422);
    const r = await call(editor, "POST", "/api/agent/campaigns", { name: "March awareness", objective: "awareness",
      goal: "Password hygiene for small teams", start_date: future(7), weeks: 3, posts_per_week: 3 });
    expect(r.status).toBe(201);
    const id = r.body.campaign_id as string;
    expect((await call(editor, "GET", `/api/agent/campaigns/${id}`)).body.status).toBe("planned");

    for (let i = 0; i < 3; i++) {
      const tick = await runAgentJobTick({ db: t.db, specialists: mockSpecialists(), writer: new MockDrafter(), voiceDir: VOICE, workerId: "camp-runner" });
      expect(tick.job?.status).toBe("succeeded");
    }
    const c = (await call(editor, "GET", `/api/agent/campaigns/${id}`)).body as {
      status: string; week_jobs: Array<{ week: number; status: string; drafts: number }>;
      posts: Array<{ week: number; topic: string; account_kind: string; scheduled_for: string }> };
    expect(c.status).toBe("completed");
    expect(c.week_jobs.map((w) => w.status)).toEqual(["succeeded", "succeeded", "succeeded"]);

    // one topic per plan item (company + founder share it); 9 distinct items across the month
    const topics = [...new Set(c.posts.map((p) => p.topic))];
    expect(topics.length).toBe(9);
    for (let i = 0; i < topics.length; i++) {
      for (let j = i + 1; j < topics.length; j++) {
        expect(topicSimilarity(topics[i]!, topics[j]!), `${topics[i]} vs ${topics[j]}`).toBeLessThan(0.5);
      }
    }
    // every week's posts fall inside that week
    for (const p of c.posts) {
      const day = (new Date(p.scheduled_for).getTime() - new Date(`${future(7)}T00:00:00Z`).getTime()) / 86_400_000;
      expect(Math.floor(day / 7) + 1, p.topic).toBe(p.week);
    }
    expect((await call(editor, "GET", "/api/agent/campaigns")).body[0]).toMatchObject({ id, status: "completed" });
  }, 120_000);
});
