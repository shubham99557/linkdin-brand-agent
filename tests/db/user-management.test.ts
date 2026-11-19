// P1-03: admin user management — organization-scoped, admin-only, audited, lock-out safe.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectCode, freshDb, type TestDb } from "../helpers/db.ts";

let t: TestDb;
let admin: string;
let otherOrgUser: string;
let otherOrgAccount: string;
const PW = "a-long-temporary-password-1";

beforeAll(async () => {
  t = await freshDb();
  admin = await t.login("admin");
  const [o] = await t.db.query<{ id: string }>("insert into lbe.organizations(name, slug) values ('Org B', 'org-b') returning id");
  otherOrgUser = (await t.db.query<{ id: string }>("select lbe.admin_create_user('b@lbe.test', 'B User', 'approver', $1, $2) as id", [PW, o!.id]))[0]!.id;
  otherOrgAccount = (await t.db.query<{ id: string }>(
    "insert into lbe.social_accounts(kind, display_name, voice_profile, organization_id) values ('company_page', 'B page', 'company', $1) returning id", [o!.id]))[0]!.id;
});
afterAll(async () => t.db.close());

const loginAs = async (email: string, password = PW) =>
  t.api<{ ok: boolean; token?: string }>("select lbe.login($1, $2)", [email, password]);
const add = (email: string, role = "editor", name = "New Person") =>
  t.api<string>("select lbe.admin_add_user($1, $2, $3, $4, $5)", [admin, email, name, role, PW]);
const update = (id: string, patch: { role?: string; disabled?: boolean; name?: string }, session = admin) =>
  t.api<{ sessions_revoked: number; approver_assignments_removed: number }>("select lbe.admin_update_user($1, $2, $3, $4, $5)",
    [session, id, patch.role ?? null, patch.disabled ?? null, patch.name ?? null]);
const lastAudit = async (action: string) => (await t.db.query<{ actor: string; details: Record<string, unknown> }>(
  "select actor, details from lbe.audit_events where action = $1 order by id desc limit 1", [action]))[0];

describe("only admins manage users", () => {
  it("non-admins are refused every user-management function", async () => {
    for (const who of ["approver", "editor", "founder"] as const) {
      const s = await t.login(who);
      await expectCode(t.api("select lbe.admin_list_users($1)", [s]), "LBE11");
      await expectCode(t.api("select lbe.admin_add_user($1, 'x@lbe.test', 'X', 'admin', $2)", [s, PW]), "LBE11");
      await expectCode(t.api("select lbe.admin_update_user($1, $2, 'admin', null, null)", [s, t.ids.users.editor]), "LBE11");
      await expectCode(t.api("select lbe.admin_reset_password($1, $2, $3)", [s, t.ids.users.admin, PW]), "LBE11");
    }
  });

  it("lists only the admin's own organization, without secrets", async () => {
    const users = await t.api<Array<Record<string, unknown>>>("select lbe.admin_list_users($1)", [admin]);
    expect(users.length).toBeGreaterThanOrEqual(4);
    expect(users.some((u) => u.email === "b@lbe.test")).toBe(false);
    for (const u of users) expect(Object.keys(u)).not.toContain("password_hash");
    expect(users.find((u) => u.is_me)?.role).toBe("admin");
  });
});

describe("create, update, disable", () => {
  it("creates a user in the admin's organization who can then sign in; audited", async () => {
    const id = await add("Person.One@LBE.test");
    const [row] = await t.db.query<{ email: string; organization_id: string }>("select email, organization_id from lbe.app_users where id = $1", [id]);
    expect(row!.email).toBe("person.one@lbe.test");
    const [me] = await t.db.query<{ organization_id: string }>("select organization_id from lbe.app_users where id = $1", [t.ids.users.admin]);
    expect(row!.organization_id).toBe(me!.organization_id);
    expect((await loginAs("person.one@lbe.test")).ok).toBe(true);
    expect((await lastAudit("user.created"))?.actor).toBe(`user:${t.ids.users.admin}`);
  });

  it("validates input and refuses duplicates", async () => {
    await expectCode(add("person.one@lbe.test"), "23505");
    await expectCode(add("not-an-email"), "LBE02");
    await expectCode(add("r@lbe.test", "superuser"), "LBE02");
    await expectCode(t.api("select lbe.admin_add_user($1, 'short@lbe.test', 'S', 'viewer', 'short')", [admin]), "LBE02");
  });

  it("disabling a user ends their sessions immediately and blocks sign-in; audited", async () => {
    const id = await add("to-disable@lbe.test");
    const s = (await loginAs("to-disable@lbe.test")).token!;
    const r = await update(id, { disabled: true });
    expect(r.sessions_revoked).toBe(1);
    expect(await t.api("select lbe.whoami($1)", [s])).toBeNull();
    expect((await loginAs("to-disable@lbe.test")).ok).toBe(false);
    const audit = await lastAudit("user.updated");
    expect(audit?.details).toMatchObject({ disabled: { from: false, to: true }, sessions_revoked: 1 });
    await update(id, { disabled: false });
    expect((await loginAs("to-disable@lbe.test")).ok).toBe(true);
  });

  it("an admin cannot demote or disable themselves", async () => {
    await expectCode(update(t.ids.users.admin, { role: "editor" }), "LBE11");
    await expectCode(update(t.ids.users.admin, { disabled: true }), "LBE11");
    await update(t.ids.users.admin, { name: "Admin (renamed)" });   // harmless self-edit is fine
  });

  it("another admin may change an admin (the acting admin always remains, so the org is never left without one)", async () => {
    await add("second-admin@lbe.test", "admin");
    const s2 = (await loginAs("second-admin@lbe.test")).token!;
    await update(t.ids.users.admin, { role: "approver" }, s2);     // allowed: second admin remains
    await update(t.ids.users.admin, { role: "admin" }, s2);        // restore
    admin = await t.login("admin");
  });

  it("users of another organization are 'not found'", async () => {
    await expectCode(update(otherOrgUser, { disabled: true }), "LBE04");
    await expectCode(t.api("select lbe.admin_end_sessions($1, $2)", [admin, otherOrgUser]), "LBE04");
    await expectCode(t.api("select lbe.admin_reset_password($1, $2, $3)", [admin, otherOrgUser, PW]), "LBE04");
    await expectCode(t.api("select lbe.admin_set_approver($1, $2, $3, true)", [admin, otherOrgUser, t.ids.accounts.company]), "LBE04");
  });
});

describe("approver assignment", () => {
  it("assigns and removes approvers; only approver/admin roles qualify; audited", async () => {
    const id = await add("new-approver@lbe.test", "approver");
    await t.api("select lbe.admin_set_approver($1, $2, $3, true)", [admin, id, t.ids.accounts.company]);
    expect((await t.db.query("select 1 from lbe.account_approvers where user_id = $1", [id])).length).toBe(1);
    expect((await lastAudit("user.approver_added"))?.details).toMatchObject({ user_id: id });
    await t.api("select lbe.admin_set_approver($1, $2, $3, false)", [admin, id, t.ids.accounts.company]);
    expect((await t.db.query("select 1 from lbe.account_approvers where user_id = $1", [id])).length).toBe(0);
    const editor = await add("an-editor@lbe.test", "editor");
    await expectCode(t.api("select lbe.admin_set_approver($1, $2, $3, true)", [admin, editor, t.ids.accounts.company]), "LBE02");
  });

  it("an admin cannot make themselves approver of the founder profile (F-1); another admin can", async () => {
    await expectCode(t.api("select lbe.admin_set_approver($1, $2, $3, true)", [admin, t.ids.users.admin, t.ids.accounts.founder]), "LBE11");
    expect((await t.db.query("select 1 from lbe.account_approvers where user_id = $1 and account_id = $2",
      [t.ids.users.admin, t.ids.accounts.founder])).length).toBe(0);
    const other = await add("founder-helper-admin@lbe.test", "admin");
    const s2 = (await loginAs("founder-helper-admin@lbe.test")).token!;
    await t.api("select lbe.admin_set_approver($1, $2, $3, true)", [s2, t.ids.users.admin, t.ids.accounts.founder]);
    await t.api("select lbe.admin_set_approver($1, $2, $3, false)", [admin, t.ids.users.admin, t.ids.accounts.founder]); // removing yourself is fine
    await update(other, { disabled: true });
  });

  it("cannot attach anyone to another organization's account", async () => {
    await expectCode(t.api("select lbe.admin_set_approver($1, $2, $3, true)", [admin, t.ids.users.approver, otherOrgAccount]), "LBE04");
  });

  it("demoting an approver to editor removes their approver assignments", async () => {
    const id = await add("demote-me@lbe.test", "approver");
    await t.api("select lbe.admin_set_approver($1, $2, $3, true)", [admin, id, t.ids.accounts.company]);
    const r = await update(id, { role: "editor" });
    expect(r.approver_assignments_removed).toBe(1);
  });
});

describe("sessions and password reset", () => {
  it("ends another user's sessions", async () => {
    const s = await t.login("editor");
    const n = await t.api<number>("select lbe.admin_end_sessions($1, $2)", [admin, t.ids.users.editor]);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await t.api("select lbe.whoami($1)", [s])).toBeNull();
  });

  it("resets a password: old one stops working, sessions end, lockout clears; the password is not audited", async () => {
    const id = await add("forgetful@lbe.test");
    const s = (await loginAs("forgetful@lbe.test")).token!;
    await t.db.query("update lbe.app_users set locked_until = now() + interval '10 minutes' where id = $1", [id]);
    const fresh = "another-temporary-password-2";
    await t.api("select lbe.admin_reset_password($1, $2, $3)", [admin, id, fresh]);
    expect(await t.api("select lbe.whoami($1)", [s])).toBeNull();
    expect((await loginAs("forgetful@lbe.test")).ok).toBe(false);
    expect((await loginAs("forgetful@lbe.test", fresh)).ok).toBe(true);
    const audit = await lastAudit("user.password_reset");
    expect(JSON.stringify(audit)).not.toContain(fresh);
  });
});
