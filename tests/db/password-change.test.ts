// P1-06: self-service password change and forced change of admin-issued temporary passwords.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectCode, freshDb, TEST_PASSWORDS, type TestDb } from "../helpers/db.ts";

let t: TestDb;
let admin: string;
const TEMP = "temporary-password-111";
const MINE = "my-own-chosen-password-222";

beforeAll(async () => { t = await freshDb(); admin = await t.login("admin"); });
afterAll(async () => t.db.close());

const login = (email: string, pw: string) => t.api<{ ok: boolean; token?: string }>("select lbe.login($1, $2)", [email, pw]);
const change = (s: string, cur: string, next: string) =>
  t.api<{ ok: boolean; error?: string; other_sessions_ended?: number }>("select lbe.change_password($1, $2, $3)", [s, cur, next]);

describe("temporary passwords must be changed first", () => {
  it("an admin-created user can sign in but can do nothing else until they choose a password", async () => {
    await t.api("select lbe.admin_add_user($1, 'temp@lbe.test', 'Temp', 'editor', $2)", [admin, TEMP]);
    const s = (await login("temp@lbe.test", TEMP)).token!;
    expect(await t.api<{ must_change_password: boolean }>("select lbe.whoami($1)", [s])).toMatchObject({ must_change_password: true });
    await expectCode(t.api("select lbe.create_content($1, $2, 'threat-landscape', 'x', null, null)", [s, t.ids.accounts.company]), "LBE12");
    await expectCode(t.api("select lbe.brain_load($1)", [s]), "LBE12");
    const r = await change(s, TEMP, MINE);
    expect(r.ok).toBe(true);
    expect(await t.api<{ must_change_password: boolean }>("select lbe.whoami($1)", [s])).toMatchObject({ must_change_password: false });
    await t.api("select lbe.create_content($1, $2, 'threat-landscape', 'now allowed', null, null)", [s, t.ids.accounts.company]);
    expect((await login("temp@lbe.test", TEMP)).ok).toBe(false);
    expect((await login("temp@lbe.test", MINE)).ok).toBe(true);
  });

  it("an admin password reset makes the password temporary again", async () => {
    const id = (await t.db.query<{ id: string }>("select id from lbe.app_users where email = 'temp@lbe.test'"))[0]!.id;
    await t.api("select lbe.admin_reset_password($1, $2, $3)", [admin, id, TEMP]);
    const s = (await login("temp@lbe.test", TEMP)).token!;
    await expectCode(t.api("select lbe.logout_all($1)", [s]), "LBE12");
    expect((await change(s, TEMP, MINE)).ok).toBe(true);
  });

  it("operator-created (CLI/seed) users are not forced to change", async () => {
    const s = await t.login("editor");
    expect(await t.api<{ must_change_password: boolean }>("select lbe.whoami($1)", [s])).toMatchObject({ must_change_password: false });
  });
});

describe("changing your own password", () => {
  it("requires the current password, ends your other sessions but keeps this one; audited without the password", async () => {
    const here = await t.login("approver");
    const elsewhere = await t.login("approver");
    const bad = await change(here, "not-the-current-one", MINE);
    expect(bad).toMatchObject({ ok: false, error: "current password is incorrect" });
    const ok = await change(here, TEST_PASSWORDS.approver, MINE);
    expect(ok.ok).toBe(true);
    expect(ok.other_sessions_ended).toBeGreaterThanOrEqual(1);
    expect(await t.api("select lbe.whoami($1)", [here])).not.toBeNull();
    expect(await t.api("select lbe.whoami($1)", [elsewhere])).toBeNull();
    const audit = await t.db.query("select details from lbe.audit_events where action in ('auth.password_changed', 'auth.password_change_failed')");
    expect(JSON.stringify(audit)).not.toContain(MINE);
    expect(JSON.stringify(audit)).not.toContain("not-the-current-one");
    await change(here, MINE, TEST_PASSWORDS.approver);              // restore for other tests
  });

  it("validates the new password", async () => {
    const s = await t.login("approver");
    await expectCode(change(s, TEST_PASSWORDS.approver, "short"), "LBE02");
    await expectCode(change(s, TEST_PASSWORDS.approver, "x".repeat(73)), "LBE02");
    await expectCode(change(s, TEST_PASSWORDS.approver, TEST_PASSWORDS.approver), "LBE02");
  });

  it("5 wrong current passwords lock the account and end every session (stolen-session guessing)", async () => {
    const s = await t.login("founder");
    for (let i = 0; i < 5; i++) expect((await change(s, `wrong-guess-${i}-xxxxxx`, MINE)).ok).toBe(false);
    expect(await t.api("select lbe.whoami($1)", [s])).toBeNull();
    expect((await login("founder@lbe.test", TEST_PASSWORDS.founder)).ok).toBe(false);   // locked for 15 minutes
  });

  it("requires a live session", async () => {
    await expectCode(change("0".repeat(64), "a", "b".repeat(12)), "LBE10");
  });
});
