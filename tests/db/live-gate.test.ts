import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentInReview, expectCode, freshDb, packageHash, type TestDb } from "../helpers/db.ts";

let t: TestDb;
let editor: string, approver: string, founder: string, admin: string;
const FAKE_CIPHERTEXT = `v1.${"a".repeat(16)}.${"b".repeat(22)}.${"c".repeat(40)}`;

beforeAll(async () => {
  t = await freshDb();
  [editor, approver, founder, admin] = await Promise.all([t.login("editor"), t.login("approver"), t.login("founder"), t.login("admin")]);
});
afterAll(async () => t.db.close());

const claim = (providers: string[] = ["mock", "linkedin"], worker = "w1") =>
  t.worker<{ id: string; provider: string }>("select * from lbe.claim_outbox($1, 10, 60, $2)", [worker, providers]);
const drain = async () => {
  for (const o of await claim(["mock"], "drain")) {
    await t.worker("select lbe.complete_outbox($1, 'drain', 'success', $2, null, null)", [o.id, `urn:li:share:drain-${o.id}`]);
  }
};
const status = async (id: string) =>
  (await t.db.query<{ status: string }>("select status from lbe.content_items where id = $1", [id]))[0]!.status;

async function connect(account: "company" | "founder", session = admin, expiresAt = "2099-01-01T00:00:00Z") {
  const accountId = t.ids.accounts[account];
  const { state } = await t.api<{ state: string }>("select lbe.begin_oauth($1, $2)", [session, accountId]);
  const consumed = await t.api<{ account_id: string } | null>("select lbe.consume_oauth_state($1, $2)", [session, state]);
  expect(consumed?.account_id).toBe(accountId);
  await t.api("select lbe.store_linkedin_credential($1, $2, $3, $4, $5, $6, 'k1', $7)",
    [session, state, account === "founder" ? "urn:li:person:abc123" : null, "Test Profile", ["w_member_social"], FAKE_CIPHERTEXT, expiresAt]);
  return state;
}
async function approveAndQueue(account: "company" | "founder") {
  const id = await contentInReview(t, editor, account);
  const who = account === "company" ? approver : founder;
  await t.api("select lbe.decide_content($1, $2, $3, 'approved', null)", [who, id, await packageHash(t, id)]);
  const outboxId = await t.api<string>("select lbe.enqueue_publication($1, $2)", [who, id]);
  return { id, outboxId };
}

describe("OAuth state", () => {
  it("only admins can start a connection", async () => {
    await expectCode(t.api("select lbe.begin_oauth($1, $2)", [approver, t.ids.accounts.company]), "LBE11");
  });
  it("is single-use", async () => {
    const { state } = await t.api<{ state: string }>("select lbe.begin_oauth($1, $2)", [admin, t.ids.accounts.company]);
    expect(await t.api("select lbe.consume_oauth_state($1, $2)", [admin, state])).not.toBeNull();
    expect(await t.api("select lbe.consume_oauth_state($1, $2)", [admin, state])).toBeNull();
  });
  it("expires after 10 minutes", async () => {
    const { state } = await t.api<{ state: string }>("select lbe.begin_oauth($1, $2)", [admin, t.ids.accounts.company]);
    await t.db.query("update lbe.oauth_states set expires_at = now() - interval '1 second' where state_hash = lbe.hash_text($1)", [state]);
    expect(await t.api("select lbe.consume_oauth_state($1, $2)", [admin, state])).toBeNull();
  });
  it("cannot be completed by a different admin", async () => {
    await t.db.query("select lbe.admin_create_user('admin2@lbe.test', 'Admin Two', 'admin', 'admin-two-password-1')");
    const other = (await t.api<{ token: string }>("select lbe.login('admin2@lbe.test', 'admin-two-password-1')")).token;
    const { state } = await t.api<{ state: string }>("select lbe.begin_oauth($1, $2)", [admin, t.ids.accounts.company]);
    expect(await t.api("select lbe.consume_oauth_state($1, $2)", [other, state])).toBeNull();
  });
  it("a credential can only be stored after the state was consumed, once", async () => {
    const { state } = await t.api<{ state: string }>("select lbe.begin_oauth($1, $2)", [admin, t.ids.accounts.company]);
    await expectCode(t.api("select lbe.store_linkedin_credential($1, $2, null, null, '{}', $3, 'k1', now() + interval '1 day')",
      [admin, state, FAKE_CIPHERTEXT]), "LBE01");
  });
});

describe("credential confidentiality", () => {
  it("lbe_api can read metadata but never the ciphertext", async () => {
    await connect("founder");
    const meta = await t.db.tx("lbe_api", (q) => q.query("select status, expires_at, subject_urn from lbe.linkedin_credentials"));
    expect(meta.length).toBeGreaterThan(0);
    await expectCode(t.db.tx("lbe_api", (q) => q.query("select token_ciphertext from lbe.linkedin_credentials")), "42501");
    await expectCode(t.db.tx("lbe_api", (q) => q.query("select * from lbe.linkedin_credentials")), "42501");
    await expectCode(t.db.tx("lbe_api", (q) => q.query("select * from lbe.oauth_states")), "42501");
  });
  it("lbe_api cannot call worker credential functions", async () => {
    await expectCode(t.api("select lbe.worker_get_credential('x', $1)", [t.ids.accounts.founder]), "42501");
  });
  it("audit entries for credentials contain no token material", async () => {
    const rows = await t.db.query<{ details: string }>("select details::text from lbe.audit_events where action like 'credential.%'");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.details).not.toContain(FAKE_CIPHERTEXT);
  });
  it("worker gets ciphertext only for live accounts with a valid credential", async () => {
    const before = await t.worker<{ c: unknown }>("select lbe.worker_get_credential('w', $1) as c", [t.ids.accounts.founder]);
    expect(before[0]!.c).toBeNull();   // credential exists but account is still mock
  });
});

describe("two-key live enablement", () => {
  it("cannot enable live without a valid credential", async () => {
    await expectCode(t.api("select lbe.set_live_publishing($1, $2, true, 'urn:li:organization:123')", [admin, t.ids.accounts.company]), "LBE01");
  });
  it("only admins can enable live", async () => {
    await expectCode(t.api("select lbe.set_live_publishing($1, $2, true, null)", [founder, t.ids.accounts.founder]), "LBE11");
  });
  it("enabling live forces manual release and invalidates approvals given for mock", async () => {
    const id = await contentInReview(t, editor, "founder");
    await t.api("select lbe.decide_content($1, $2, $3, 'approved', null)", [founder, id, await packageHash(t, id)]);
    expect(await status(id)).toBe("approved");
    await t.api("select lbe.set_live_publishing($1, $2, true, null)", [admin, t.ids.accounts.founder]);
    const [a] = await t.db.query<{ publishing_mode: string; release_mode: string; linkedin_urn: string }>(
      "select publishing_mode, release_mode, linkedin_urn from lbe.social_accounts where id = $1", [t.ids.accounts.founder]);
    expect(a).toEqual({ publishing_mode: "live", release_mode: "manual", linkedin_urn: "urn:li:person:abc123" });
    expect(await status(id)).toBe("draft");
  });
  it("a live account can never be switched to scheduled release (API Terms §3.1(26))", async () => {
    await expectCode(t.db.query("update lbe.social_accounts set release_mode = 'scheduled' where id = $1", [t.ids.accounts.founder]), "23514");
  });
  it("company pages need a well-formed organization URN", async () => {
    await connect("company");
    await expectCode(t.api("select lbe.set_live_publishing($1, $2, true, 'not-a-urn')", [admin, t.ids.accounts.company]), "LBE02");
  });
});

describe("live outbox behaviour", () => {
  it("live content goes to the linkedin provider and waits for manual release", async () => {
    await drain();
    const { outboxId } = await approveAndQueue("founder");
    const [o] = await t.db.query<{ provider: string; requires_release: boolean; package: { destination: { publishing_mode: string } } }>(
      "select provider, requires_release, package from lbe.publication_outbox where id = $1", [outboxId]);
    expect(o).toMatchObject({ provider: "linkedin", requires_release: true });
    expect(o!.package.destination.publishing_mode).toBe("live");
    expect(await claim()).toEqual([]);
    await expectCode(t.db.query("update lbe.publication_outbox set status = 'dispatching' where id = $1", [outboxId]), "LBE01");
    await expectCode(t.api("select lbe.release_publication($1, $2)", [approver, outboxId]), "LBE11");   // not founder's approver
    await t.api("select lbe.release_publication($1, $2)", [founder, outboxId]);
    await expectCode(t.api("select lbe.release_publication($1, $2)", [founder, outboxId]), "LBE01");    // only once
    expect(await claim(["mock"])).toEqual([]);                                                         // mock-only worker never takes it
    const claimed = await claim(["mock", "linkedin"]);
    expect(claimed.map((c) => [c.id, c.provider])).toEqual([[outboxId, "linkedin"]]);
    await t.worker("select lbe.complete_outbox($1, 'w1', 'success', 'urn:li:share:1', null, null)", [outboxId]);
  });

  it("worker can read the credential once the account is live", async () => {
    const r = await t.worker<{ c: { ciphertext: string } }>("select lbe.worker_get_credential('w', $1) as c", [t.ids.accounts.founder]);
    expect(r[0]!.c.ciphertext).toBe(FAKE_CIPHERTEXT);
  });

  it("an invalid credential auto-stops the account; workers cannot resume", async () => {
    await t.worker("select lbe.worker_mark_credential('w1', $1, 'invalid', '401 Unauthorized')", [t.ids.accounts.founder]);
    const [flag] = await t.db.query<{ stopped: boolean; reason: string }>(
      "select stopped, reason from lbe.control_flags where key = $1", [`account:${t.ids.accounts.founder}`]);
    expect(flag).toMatchObject({ stopped: true });
    expect(flag!.reason).toMatch(/^AUTO: LinkedIn credential invalid/);
    expect((await t.worker<{ s: boolean }>("select lbe.is_stopped($1) as s", [t.ids.accounts.founder]))[0]!.s).toBe(true);
    await expectCode(t.worker("select lbe.worker_mark_credential('w1', $1, 'valid', 'x')", [t.ids.accounts.founder]), "LBE02");
    await expectCode(t.worker("select lbe.set_stop('x', $1, false, 'r')", [`account:${t.ids.accounts.founder}`]), "42501");
  });

  it("a live account without a valid credential is treated as stopped even if its flag is cleared", async () => {
    await t.api("select lbe.set_stop($1, $2, false, 'admin cleared flag')", [admin, `account:${t.ids.accounts.founder}`]);
    expect((await t.worker<{ s: boolean }>("select lbe.is_stopped($1) as s", [t.ids.accounts.founder]))[0]!.s).toBe(true);
  });

  it("expired credentials are detected and stop the account", async () => {
    await connect("founder");   // fresh valid credential (replaces the invalid one)
    await t.api("select lbe.set_stop($1, $2, false, 'reconnected')", [admin, `account:${t.ids.accounts.founder}`]);
    expect((await t.worker<{ s: boolean }>("select lbe.is_stopped($1) as s", [t.ids.accounts.founder]))[0]!.s).toBe(false);
    await t.db.query("update lbe.linkedin_credentials set expires_at = now() - interval '1 minute' where account_id = $1", [t.ids.accounts.founder]);
    const n = await t.worker<{ n: number }>("select lbe.expire_credentials('w1') as n");
    expect(n[0]!.n).toBe(1);
    expect((await t.worker<{ s: boolean }>("select lbe.is_stopped($1) as s", [t.ids.accounts.founder]))[0]!.s).toBe(true);
  });

  it("disconnecting reverts the account to mock", async () => {
    await connect("founder");
    await t.api("select lbe.revoke_linkedin_credential($1, $2, 'test')", [admin, t.ids.accounts.founder]);
    const [a] = await t.db.query<{ publishing_mode: string }>("select publishing_mode from lbe.social_accounts where id = $1", [t.ids.accounts.founder]);
    expect(a!.publishing_mode).toBe("mock");
  });
});

describe("daily cap", () => {
  it("stops claiming for an account once 25 publications were dispatched today", async () => {
    await drain();
    for (let i = 0; i < 25; i++) {
      const { outboxId } = await approveAndQueue("company");
      const c = await claim(["mock"]);
      expect(c.map((x) => x.id)).toEqual([outboxId]);
      await t.worker("select lbe.complete_outbox($1, 'w1', 'success', $2, null, null)", [outboxId, `urn:li:share:cap-${i}`]);
    }
    await approveAndQueue("company");
    expect(await claim(["mock"])).toEqual([]);
  });
});
