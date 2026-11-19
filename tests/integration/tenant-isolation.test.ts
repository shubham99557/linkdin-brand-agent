// Hardening regression tests: every API read/write path, the controls model, and auth edge cases.
// Org A = seeded ActTrident; org B = a second organization with its own admin, approver and account.
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockDrafter, type Drafter } from "@lbe/drafting";
import { MockLinkedInProvider } from "@lbe/publishing";
import { createApp } from "../../services/api/src/app.ts";
import { dbMockStore, runPublisherTick } from "../../services/api/src/jobs/publisher.ts";
import { contentInReview, expectCode, freshDb, packageHash, TEST_PASSWORDS, type TestDb } from "../helpers/db.ts";

const ORIGIN = "http://localhost:5173";
let t: TestDb;
let app: ReturnType<typeof createApp>;
let drafterCalls = 0;
let B: { org: string; account: string };
const provider = () => new MockLinkedInProvider(dbMockStore(t.db));

const USERS = {
  admin: ["admin@lbe.test", TEST_PASSWORDS.admin], approver: ["marketing@lbe.test", TEST_PASSWORDS.approver],
  founder: ["founder@lbe.test", TEST_PASSWORDS.founder], editor: ["editor@lbe.test", TEST_PASSWORDS.editor],
  adminB: ["admin@b.test", "org-b-admin-password"], editorB: ["editor@b.test", "org-b-editor-password"],
} as const;

beforeAll(async () => {
  t = await freshDb();
  const real = new MockDrafter();
  const drafter: Drafter = { provider: "mock", model: "spy", draft: (i) => { drafterCalls++; return real.draft(i); } };
  app = createApp({ db: t.db, drafter, provider: provider(), appOrigins: [ORIGIN], cookieSecure: false,
    voiceDir: path.resolve(import.meta.dirname, "../../brand/voice"), workerId: "iso", log: () => undefined });
  const [o] = await t.db.query<{ id: string }>("insert into lbe.organizations(name, slug) values ('Org B', 'org-b') returning id");
  const adminB = (await t.db.query<{ id: string }>("select lbe.admin_create_user($1, 'B Admin', 'admin', $2, $3) as id", [USERS.adminB[0], USERS.adminB[1], o!.id]))[0]!.id;
  await t.db.query("select lbe.admin_create_user($1, 'B Editor', 'editor', $2, $3)", [USERS.editorB[0], USERS.editorB[1], o!.id]);
  const [a] = await t.db.query<{ id: string }>(
    "insert into lbe.social_accounts(kind, display_name, voice_profile, pillars, organization_id) values ('company_page', 'B page', 'company', array['news'], $1) returning id", [o!.id]);
  await t.db.query("insert into lbe.account_approvers(account_id, user_id) values ($1, $2)", [a!.id, adminB]);
  B = { org: o!.id, account: a!.id };
});
afterAll(async () => t.db.close());

async function login(who: keyof typeof USERS, headers: Record<string, string> = {}) {
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify({ email: USERS[who][0], password: USERS[who][1] }) });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
const token = (cookie: string) => cookie.split("=")[1]!;
async function call(cookie: string, method: string, url: string, body?: unknown) {
  const res = await app.request(url, { method, headers: { cookie, origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
/** Org A content approved and queued (released immediately, mock). */
async function queuedA() {
  const editor = token(await login("editor"));
  const approver = token(await login("approver"));
  const id = await contentInReview(t, editor);
  await t.api("select lbe.decide_content($1, $2, $3, 'approved', null)", [approver, id, await packageHash(t, id)]);
  const outboxId = await t.api<string>("select lbe.enqueue_publication($1, $2)", [approver, id]);
  return { id, outboxId };
}

describe("read paths are organization-scoped", () => {
  it("audit log shows only the caller's organization", async () => {
    await queuedA();
    const a = await call(await login("admin"), "GET", "/api/audit?limit=1000");
    expect(a.body.length).toBeGreaterThan(0);
    const b = await call(await login("adminB"), "GET", "/api/audit?limit=1000");
    const aIds = new Set<string>([t.ids.accounts.company, t.ids.accounts.founder, ...t.ids.claims]);
    expect(b.body.filter((e: { subject_id: string | null }) => e.subject_id && aIds.has(e.subject_id))).toEqual([]);
    expect(b.body.filter((e: { subject_type: string }) => e.subject_type === "content_item")).toEqual([]);
  });

  it("mock LinkedIn posts are only visible to their organization", async () => {
    const { outboxId } = await queuedA();
    await t.db.query("update lbe.publication_outbox set available_at = now() where id = $1", [outboxId]);
    await runPublisherTick(t.db, provider(), { workerId: "iso" });
    expect((await call(await login("admin"), "GET", "/api/mock/posts")).body.length).toBeGreaterThan(0);
    expect((await call(await login("adminB"), "GET", "/api/mock/posts")).body).toEqual([]);
  });

  it("controls list shows only the caller's organization and accounts", async () => {
    const b = await call(await login("adminB"), "GET", "/api/controls");
    const keys = b.body.map((f: { key: string }) => f.key);
    expect(keys).not.toContain(`account:${t.ids.accounts.company}`);
    expect(keys).not.toContain(`account:${t.ids.accounts.founder}`);
    expect(keys).toContain(`account:${B.account}`);
  });

  it("another organization's account voice is not readable", async () => {
    expect((await call(await login("adminB"), "GET", `/api/accounts/${t.ids.accounts.company}/voice`)).status).toBe(404);
  });
});

describe("write paths are organization-scoped", () => {
  it("drafting another organization's content is refused before any AI call", async () => {
    const editor = token(await login("editor"));
    const id = await t.api<string>("select lbe.create_content($1, $2, 'threat-landscape', 'confidential brief of org A', null, null)",
      [editor, t.ids.accounts.company]);
    const before = drafterCalls;
    const r = await call(await login("adminB"), "POST", `/api/content/${id}/draft`);
    expect(r.status).toBe(404);
    expect(drafterCalls).toBe(before);
    expect((await call(await login("adminB"), "PATCH", `/api/content/${id}`, { brief: "x" })).status).toBe(404);
  });

  it("cannot stop another organization's account", async () => {
    const r = await call(await login("editorB"), "POST", "/api/controls", { key: `account:${t.ids.accounts.company}`, stopped: true, reason: "attack" });
    expect(r.status).toBe(404);
    const [f] = await t.db.query<{ stopped: boolean }>("select stopped from lbe.control_flags where key = $1", [`account:${t.ids.accounts.company}`]);
    expect(f!.stopped).toBe(false);
  });

  it("'stop all publishing' in org B does not stop org A, and org B cannot resume org A", async () => {
    const { outboxId } = await queuedA();
    await t.db.query("update lbe.publication_outbox set available_at = now() where id = $1", [outboxId]);
    expect((await call(await login("editorB"), "POST", "/api/controls", { key: "global", stopped: true, reason: "B incident" })).status).toBe(200);
    const s = await runPublisherTick(t.db, provider(), { workerId: "iso" });
    expect(s.succeeded).toBe(1);     // org A unaffected
    // org A stops; org B's admin must not be able to lift it
    expect((await call(await login("editor"), "POST", "/api/controls", { key: "global", stopped: true, reason: "A incident" })).status).toBe(200);
    expect((await call(await login("adminB"), "POST", "/api/controls", { key: "global", stopped: false, reason: "B resumes" })).status).toBe(200);
    const { outboxId: o2 } = await queuedA();
    await t.db.query("update lbe.publication_outbox set available_at = now() where id = $1", [o2]);
    expect((await runPublisherTick(t.db, provider(), { workerId: "iso" })).claimed).toBe(0);   // A still stopped
    await call(await login("admin"), "POST", "/api/controls", { key: "global", stopped: false, reason: "A resolved" });
    expect((await runPublisherTick(t.db, provider(), { workerId: "iso" })).succeeded).toBe(1);
  });

  it("cannot cancel or reconcile another organization's publication", async () => {
    const { outboxId } = await queuedA();
    const b = await login("adminB");
    expect((await call(b, "POST", `/api/outbox/${outboxId}/cancel`)).status).toBe(404);
    await t.db.query("update lbe.publication_outbox set available_at = now() where id = $1", [outboxId]);
    await runPublisherTick(t.db, new MockLinkedInProvider(dbMockStore(t.db), () => "server_error"), { workerId: "iso" });
    expect((await call(b, "POST", `/api/outbox/${outboxId}/reconcile`, { resolution: "abandon", note: "x" })).status).toBe(404);
  });

  it("within an organization, only that account's approvers (or an admin) can cancel", async () => {
    const editor = token(await login("editor"));
    const founder = token(await login("founder"));
    const id = await contentInReview(t, editor, "founder");
    await t.api("select lbe.decide_content($1, $2, $3, 'approved', null)", [founder, id, await packageHash(t, id)]);
    const outboxId = await t.api<string>("select lbe.enqueue_publication($1, $2)", [founder, id]);
    expect((await call(await login("approver"), "POST", `/api/outbox/${outboxId}/cancel`)).status).toBe(403);
    expect((await call(await login("founder"), "POST", `/api/outbox/${outboxId}/cancel`)).status).toBe(200);
  });

  it("cannot start LinkedIn connections, switch live or disconnect another organization's account", async () => {
    const b = token(await login("adminB"));
    await expectCode(t.api("select lbe.begin_oauth($1, $2)", [b, t.ids.accounts.company]), "LBE04");
    await expectCode(t.api("select lbe.set_live_publishing($1, $2, false, null)", [b, t.ids.accounts.company]), "LBE04");
    await expectCode(t.api("select lbe.revoke_linkedin_credential($1, $2, 'x')", [b, t.ids.accounts.company]), "LBE04");
  });

  it("an organization admin's manual publisher run only processes that organization", async () => {
    const { outboxId } = await queuedA();
    await t.db.query("update lbe.publication_outbox set available_at = now() where id = $1", [outboxId]);
    const r = await call(await login("adminB"), "POST", "/api/jobs/publisher-tick");
    expect(r.body.claimed).toBe(0);
    const [o] = await t.db.query<{ status: string }>("select status from lbe.publication_outbox where id = $1", [outboxId]);
    expect(o!.status).toBe("pending");
    await runPublisherTick(t.db, provider(), { workerId: "iso" });
  });

  it("agent run records cannot reference another organization's workflow", async () => {
    const a = token(await login("editor"));
    const wf = await t.api<string>("select lbe.workflow_create($1, 'goal A', '{}'::jsonb)", [a]);
    const b = token(await login("editorB"));
    await expectCode(t.api("select lbe.record_agent_run($1, $2::jsonb)", [b, JSON.stringify({
      purpose: "research", provider: "mock", model: "m", prompt_version: "v", status: "succeeded",
      input_refs: { workflow_id: wf }, started_at: new Date().toISOString() })]), "LBE04");
  });
});

describe("authentication hardening", () => {
  it("rotating X-Forwarded-For does not bypass login rate limiting", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await app.request("/api/auth/login", { method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": `203.0.113.${i}` },
        body: JSON.stringify({ email: "nobody-ratelimit@lbe.test", password: "wrong-password-x" }) });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it("refuses passwords longer than 72 bytes (bcrypt would silently truncate)", async () => {
    await expectCode(t.db.query("select lbe.admin_create_user('long@lbe.test', 'L', 'viewer', $1)", ["x".repeat(73)]), "LBE02");
  });

  it("expired and disabled-user sessions are rejected", async () => {
    const cookie = await login("editor");
    await t.db.query("update lbe.sessions set expires_at = now() - interval '1 second' where token_hash = lbe.hash_text($1)", [token(cookie)]);
    expect((await call(cookie, "GET", "/api/me")).status).toBe(401);
    const c2 = await login("editorB");
    await t.db.query("update lbe.app_users set disabled = true where email = $1", [USERS.editorB[0]]);
    expect((await call(c2, "GET", "/api/me")).status).toBe(401);
    await t.db.query("update lbe.app_users set disabled = false where email = $1", [USERS.editorB[0]]);
  });
});
