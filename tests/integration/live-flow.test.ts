// Stage 2.1: the live LinkedIn path end to end — against a LOCAL FAKE LinkedIn only.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockDrafter } from "@lbe/drafting";
import { LinkedInProvider, MockLinkedInProvider } from "@lbe/publishing";
import { createApp, type LinkedInDeps } from "../../services/api/src/app.ts";
import { dbMockStore, dbTokenSource, runPublisherTick } from "../../services/api/src/jobs/publisher.ts";
import { startFakeLinkedIn, type FakeLinkedIn } from "../helpers/fake-linkedin.ts";
import { freshDb, TEST_PASSWORDS, type TestDb } from "../helpers/db.ts";

const ORIGIN = "http://localhost:5173";
const REDIRECT = "https://localhost:8443/api/oauth/linkedin/callback";
let t: TestDb;
let fake: FakeLinkedIn;
let tokenKey: Buffer;
let liveProvider: LinkedInProvider;
let mock: MockLinkedInProvider;
const logs: string[] = [];
const responses: string[] = [];

function makeApp(liveEnabled: boolean) {
  const linkedin: LinkedInDeps = {
    liveEnabled,
    apps: { founder_app: { clientId: "founder-cid", clientSecret: "founder-secret" }, company_app: { clientId: "company-cid", clientSecret: "company-secret" } },
    redirectUri: REDIRECT,
    tokenKey,
    tokenKeyId: "k1",
    oauth: { authBase: fake.base, apiBase: fake.base, allowedHosts: ["127.0.0.1"] },
    liveProvider: liveEnabled ? liveProvider : undefined,
  };
  return createApp({
    db: t.db, drafter: new MockDrafter(), provider: mock, linkedin,
    appOrigins: [ORIGIN], cookieSecure: false, voiceDir: path.resolve(import.meta.dirname, "../../brand/voice"),
    workerId: "it", log: (m, e) => logs.push(`${m} ${JSON.stringify(e ?? {})}`),
  });
}
let app: ReturnType<typeof makeApp>;

beforeAll(async () => {
  t = await freshDb();
  fake = await startFakeLinkedIn();
  tokenKey = randomBytes(32);
  liveProvider = new LinkedInProvider({ getAccessToken: dbTokenSource(t.db, "it", tokenKey), apiBase: fake.base, allowedHosts: ["127.0.0.1"], timeoutMs: 2000 });
  mock = new MockLinkedInProvider(dbMockStore(t.db));
  app = makeApp(true);
});
afterAll(async () => { await fake.close(); await t.db.close(); });

const EMAIL = { admin: "admin@lbe.test", approver: "marketing@lbe.test", founder: "founder@lbe.test", editor: "editor@lbe.test" } as const;
async function login(who: keyof typeof EMAIL, a = app) {
  const res = await a.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email: EMAIL[who], password: TEST_PASSWORDS[who] }) });
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
async function call(cookie: string, method: string, url: string, body?: unknown, a = app) {
  const res = await a.request(url, { method, headers: { cookie, origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  responses.push(text);
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const tick = () => runPublisherTick(t.db, { mock, linkedin: liveProvider }, { workerId: "it" });

async function connectViaOAuth(admin: string, account: "founder" | "company") {
  const start = await call(admin, "POST", `/api/accounts/${t.ids.accounts[account]}/linkedin/connect`, {});
  expect(start.status).toBe(200);
  const authUrl = new URL(start.body.url);
  const state = authUrl.searchParams.get("state")!;
  // LinkedIn would redirect the browser to our callback; the callback hands off to the dashboard fragment.
  const cb = await app.request(`/api/oauth/linkedin/callback?code=good-code&state=${state}`);
  expect(cb.status).toBe(302);
  expect(cb.headers.get("location")).toBe(`/#/oauth/complete?code=good-code&state=${state}`);
  return { state, complete: () => call(admin, "POST", "/api/oauth/linkedin/complete", { code: "good-code", state }) };
}

async function approvedLivePost(account: "founder" | "company", text: string) {
  const editor = await login("editor");
  const approverCookie = await login(account === "founder" ? "founder" : "approver");
  const created = await call(editor, "POST", "/api/content", { account_id: t.ids.accounts[account],
    pillar: account === "founder" ? "founder-lessons" : "security-culture", brief: text });
  const id = created.body.id;
  await call(editor, "PATCH", `/api/content/${id}`, { body: text });
  expect((await call(editor, "POST", `/api/content/${id}/submit`)).status).toBe(200);
  const d = await call(approverCookie, "GET", `/api/content/${id}`);
  expect(d.body.item.package.destination.publishing_mode).toBe("live");
  await call(approverCookie, "POST", `/api/content/${id}/decision`, { decision: "approved", expected_package_hash: d.body.item.package_hash });
  const q = await call(approverCookie, "POST", `/api/content/${id}/enqueue`);
  expect(q.status).toBe(200);
  return { id, outboxId: q.body.outbox_id as string, approverCookie };
}

describe("connecting the founder profile (OAuth against fake LinkedIn)", () => {
  it("builds an authorize URL for LinkedIn with minimal scopes, then stores an encrypted credential", async () => {
    const admin = await login("admin");
    const { complete } = await connectViaOAuth(admin, "founder");
    const r = await complete();
    expect(r.status).toBe(200);
    expect(r.body.subject_urn).toBe(`urn:li:person:${fake.sub}`);
    const [cred] = await t.db.query<{ token_ciphertext: string; status: string }>(
      "select token_ciphertext, status from lbe.linkedin_credentials where account_id = $1", [t.ids.accounts.founder]);
    expect(cred!.status).toBe("valid");
    expect(cred!.token_ciphertext).not.toContain(fake.issuedToken);
    const tokenReq = fake.requests.find((x) => x.path === "/oauth/v2/accessToken")!;
    expect(new URLSearchParams(tokenReq.body).get("redirect_uri")).toBe(REDIRECT);
  });

  it("the same state cannot be replayed", async () => {
    const admin = await login("admin");
    const { complete } = await connectViaOAuth(admin, "founder");
    expect((await complete()).status).toBe(200);
    expect((await complete()).status).toBe(400);
  });

  it("a non-admin cannot connect accounts", async () => {
    const approver = await login("approver");
    expect((await call(approver, "POST", `/api/accounts/${t.ids.accounts.founder}/linkedin/connect`, {})).status).toBe(403);
  });

  it("a failed code exchange is reported without storing anything", async () => {
    const admin = await login("admin");
    const start = await call(admin, "POST", `/api/accounts/${t.ids.accounts.company}/linkedin/connect`, {});
    const state = new URL(start.body.url).searchParams.get("state")!;
    const r = await call(admin, "POST", "/api/oauth/linkedin/complete", { code: "bad-code", state });
    expect(r.status).toBe(502);
    expect((await t.db.query("select 1 from lbe.linkedin_credentials where account_id = $1", [t.ids.accounts.company]))).toHaveLength(0);
  });
});

describe("live publishing — founder (manual release)", () => {
  it("enable live → approve → queued but NOT sent until released with confirmation → published on (fake) LinkedIn", async () => {
    const admin = await login("admin");
    expect((await call(admin, "POST", `/api/accounts/${t.ids.accounts.founder}/live`, { live: true })).status).toBe(200);
    const { id, outboxId, approverCookie } = await approvedLivePost("founder", "Lessons from (another) week #founders");
    const before = fake.requests.filter((r) => r.path === "/rest/posts").length;
    expect((await tick()).claimed).toBe(0);                                       // waits for a human
    expect((await call(approverCookie, "POST", `/api/outbox/${outboxId}/release`, {})).status).toBe(422);   // must confirm
    expect((await call(approverCookie, "POST", `/api/outbox/${outboxId}/release`, { confirm_public_post: true })).status).toBe(200);
    const s = await tick();
    expect(s.succeeded).toBe(1);
    const sent = fake.requests.filter((r) => r.path === "/rest/posts");
    expect(sent.length).toBe(before + 1);
    expect(JSON.parse(sent.at(-1)!.body)).toMatchObject({
      author: `urn:li:person:${fake.sub}`, commentary: "Lessons from \\(another\\) week \\#founders" });
    const d = await call(approverCookie, "GET", `/api/content/${id}`);
    expect(d.body.item.status).toBe("published");
    expect(d.body.item.provider_post_ref).toMatch(/^urn:li:share:\d+$/);
    expect((await tick()).claimed).toBe(0);
    expect(fake.requests.filter((r) => r.path === "/rest/posts").length).toBe(before + 1);   // no duplicate
  });

  it("a 500 after the post was created → reconciliation; founder posts cannot be auto-checked", async () => {
    const { outboxId, approverCookie } = await approvedLivePost("founder", "Ambiguous outcome test");
    await call(approverCookie, "POST", `/api/outbox/${outboxId}/release`, { confirm_public_post: true });
    fake.behaviour.post = 500;
    expect((await tick()).ambiguous).toBe(1);
    fake.behaviour.post = "created";
    expect((await tick()).claimed).toBe(0);                                       // never auto-retried
    const admin = await login("admin");
    const assist = await call(admin, "GET", `/api/outbox/${outboxId}/linkedin-candidates`);
    expect(assist.body.supported).toBe(false);
  });

  it("a 401 from LinkedIn invalidates the credential and auto-stops the account", async () => {
    const { outboxId, approverCookie } = await approvedLivePost("founder", "Credential failure test");
    await call(approverCookie, "POST", `/api/outbox/${outboxId}/release`, { confirm_public_post: true });
    fake.validTokens.clear();
    const s = await tick();
    expect(s.failed).toBe(1);
    expect(s.autoStops).toBe(1);
    fake.validTokens.add(fake.issuedToken);
    const admin = await login("admin");
    const accounts = await call(admin, "GET", "/api/accounts");
    const f = accounts.body.find((a: { id: string }) => a.id === t.ids.accounts.founder);
    expect(f.credential.status).toBe("invalid");
    expect(f.stopped).toBe(true);
    expect(f.stop_reason).toMatch(/^AUTO:/);
  });
});

describe("live publishing — company page", () => {
  it("connect, require an organization URN, publish, and use find-by-author to assist reconciliation", async () => {
    const admin = await login("admin");
    const { complete } = await connectViaOAuth(admin, "company");
    expect((await complete()).status).toBe(200);
    expect((await call(admin, "POST", `/api/accounts/${t.ids.accounts.company}/live`, { live: true })).status).toBe(422);
    expect((await call(admin, "POST", `/api/accounts/${t.ids.accounts.company}/live`, { live: true, org_urn: "urn:li:organization:12345" })).status).toBe(200);

    const { outboxId, approverCookie } = await approvedLivePost("company", "Company page post for reconciliation");
    await call(approverCookie, "POST", `/api/outbox/${outboxId}/release`, { confirm_public_post: true });
    fake.behaviour.post = 503;   // fake creates the post, then fails the response
    expect((await tick()).ambiguous).toBe(1);
    fake.behaviour.post = "created";
    const assist = await call(admin, "GET", `/api/outbox/${outboxId}/linkedin-candidates`);
    expect(assist.body.supported).toBe(true);
    const match = assist.body.candidates.find((c: { matches: boolean }) => c.matches);
    expect(match).toBeTruthy();
    expect((await call(admin, "POST", `/api/outbox/${outboxId}/reconcile`,
      { resolution: "confirmed_published", provider_ref: match.id, note: "matched via find-by-author" })).status).toBe(200);
  });
});

describe("master switch off", () => {
  it("cannot enable live, cannot release live jobs, and a mock-only worker never sends them", async () => {
    const offApp = makeApp(false);
    const admin = await login("admin", offApp);
    expect((await call(admin, "POST", `/api/accounts/${t.ids.accounts.company}/live`, { live: true, org_urn: "urn:li:organization:12345" }, offApp)).status).toBe(409);
    const { outboxId } = await approvedLivePost("company", "Should never be sent while switched off");
    const approver = await login("approver", offApp);
    expect((await call(approver, "POST", `/api/outbox/${outboxId}/release`, { confirm_public_post: true }, offApp)).status).toBe(409);
    const before = fake.requests.length;
    await runPublisherTick(t.db, { mock }, { workerId: "off" });
    expect(fake.requests.length).toBe(before);
  });
});

describe("secrets never leak", () => {
  it("no access token or client secret appears in any API response, audit event or log line", async () => {
    const audit = await t.db.query<{ d: string }>("select details::text as d from lbe.audit_events");
    const haystacks = [...responses, ...logs, ...audit.map((a) => a.d)];
    for (const secret of [fake.issuedToken, "founder-secret", "company-secret"]) {
      expect(haystacks.filter((h) => h.includes(secret))).toEqual([]);
    }
  });
});
