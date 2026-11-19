import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectCode, freshDb, type TestDb } from "../helpers/db.ts";

let t: TestDb;
beforeAll(async () => { t = await freshDb(); });
afterAll(async () => t.db.close());

const asApi = (sql: string, params: unknown[] = []) => t.db.tx("lbe_api", (q) => q.query(sql, params));
const asWorker = (sql: string, params: unknown[] = []) => t.db.tx("lbe_worker", (q) => q.query(sql, params));

describe("lbe_api role has no direct write access", () => {
  const writes: Array<[string, string]> = [
    ["update content status", "update lbe.content_items set status = 'approved'"],
    ["update content body", "update lbe.content_items set body = 'x'"],
    ["insert approval", "insert into lbe.content_approvals(content_id, decision, package_hash, package, approver_id) select id, 'approved', package_hash, package, created_by from lbe.content_items limit 1"],
    ["insert outbox", "insert into lbe.publication_outbox(content_id, account_id, approval_id, package, package_hash, idempotency_key) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '{}', 'x', 'x')"],
    ["update control flags", "update lbe.control_flags set stopped = false"],
    ["insert audit", "insert into lbe.audit_events(actor, action, subject_type) values ('x', 'x', 'x')"],
    ["update claims", "update lbe.claims set status = 'verified'"],
    ["insert users", "insert into lbe.app_users(email, display_name, role, password_hash) values ('a@b.test', 'a', 'admin', 'x')"],
    ["write mock posts", "insert into lbe_mock.linkedin_posts(mock_post_urn, idempotency_key, author, commentary, visibility, payload) values ('a', 'b', 'c', 'd', 'e', '{}')"],
  ];
  for (const [label, sql] of writes) {
    it(`denies: ${label}`, async () => { await expectCode(asApi(sql), "42501"); });
  }

  it("cannot read sessions or password hashes", async () => {
    await expectCode(asApi("select * from lbe.sessions"), "42501");
    await expectCode(asApi("select password_hash from lbe.app_users"), "42501");
    const rows = await asApi("select id, email, role from lbe.app_users");
    expect(rows.length).toBeGreaterThan(0);
  });

  it("cannot call worker or owner-only functions", async () => {
    await expectCode(asApi("select * from lbe.claim_outbox('x', 1, 60)"), "42501");
    await expectCode(asApi("select lbe.complete_outbox(gen_random_uuid(), 'x', 'success', 'r', null, null)"), "42501");
    await expectCode(asApi("select lbe.admin_create_user('x@y.test', 'x', 'admin', 'aaaaaaaaaaaaaaaa')"), "42501");
    await expectCode(asApi("select lbe.require_user('x', array['admin'])"), "42501");
  });
});

describe("lbe_worker role is limited to outbox processing", () => {
  it("cannot edit content, approvals or flags", async () => {
    await expectCode(asWorker("update lbe.content_items set body = 'x'"), "42501");
    await expectCode(asWorker("select * from lbe.content_approvals"), "42501");
    await expectCode(asWorker("update lbe.control_flags set stopped = false"), "42501");
    await expectCode(asWorker("update lbe.publication_outbox set status = 'succeeded'"), "42501");
  });

  it("cannot call API functions", async () => {
    await expectCode(asWorker("select lbe.decide_content('x', gen_random_uuid(), 'x', 'approved', null)"), "42501");
    await expectCode(asWorker("select lbe.set_stop('x', 'global', false, 'r')"), "42501");
  });
});

describe("authentication", () => {
  it("wrong password fails without revealing whether the email exists", async () => {
    const bad = await t.api<{ ok: boolean }>("select lbe.login('editor@lbe.test', 'wrong-password-xxxx')");
    const unknown = await t.api<{ ok: boolean }>("select lbe.login('nobody@lbe.test', 'wrong-password-xxxx')");
    expect(bad).toEqual({ ok: false });
    expect(unknown).toEqual({ ok: false });
  });

  it("locks an account after 5 failed attempts, even with the right password", async () => {
    await t.db.query("select lbe.admin_create_user('lockme@lbe.test', 'Lock Me', 'viewer', 'correct-horse-battery')");
    for (let i = 0; i < 5; i++) await t.api("select lbe.login('lockme@lbe.test', 'nope-nope-nope')");
    const r = await t.api<{ ok: boolean }>("select lbe.login('lockme@lbe.test', 'correct-horse-battery')");
    expect(r.ok).toBe(false);
  });

  it("stores only a hash of the session token", async () => {
    const token = await t.login("editor");
    const rows = await t.db.query("select 1 from lbe.sessions where token_hash = $1", [token]);
    expect(rows).toHaveLength(0);
  });

  it("viewer role cannot create content", async () => {
    await t.db.query("select lbe.admin_create_user('viewer@lbe.test', 'Viewer', 'viewer', 'viewer-password-123')");
    const r = await t.api<{ token: string }>("select lbe.login('viewer@lbe.test', 'viewer-password-123')");
    await expectCode(t.api("select lbe.create_content($1, $2, 'threat-landscape', 'b', null, null)",
      [r.token, t.ids.accounts.company]), "LBE11");
  });

  it("rejects short passwords", async () => {
    await expectCode(t.db.query("select lbe.admin_create_user('short@lbe.test', 'S', 'viewer', 'short')"), "LBE02");
  });
});

describe("row-level security is enabled on every application table", () => {
  it("has RLS on all lbe tables", async () => {
    const rows = await t.db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('lbe', 'lbe_mock') and c.relkind = 'r'`);
    expect(rows.length).toBeGreaterThanOrEqual(13);
    expect(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
  });

  it("no lbe function is executable by PUBLIC", async () => {
    const rows = await t.db.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'lbe' and has_function_privilege('public', p.oid, 'execute')`);
    expect(rows.map((r) => r.proname)).toEqual([]);
  });
});
