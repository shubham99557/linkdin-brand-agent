// P1-02: idle timeout (enforced in the database) and "sign out everywhere".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectCode, freshDb, type TestDb } from "../helpers/db.ts";

let t: TestDb;
beforeAll(async () => { t = await freshDb(); });
afterAll(async () => t.db.close());

const age = (token: string, minutes: number) => t.db.query(
  "update lbe.sessions set last_seen_at = now() - make_interval(mins => $2) where token_hash = lbe.hash_text($1)", [token, minutes]);
const lastSeen = async (token: string) => (await t.db.query<{ s: string }>(
  "select last_seen_at::text as s from lbe.sessions where token_hash = lbe.hash_text($1)", [token]))[0]!.s;

describe("idle timeout", () => {
  it("a session idle for longer than 60 minutes is rejected by whoami and require_user", async () => {
    const s = await t.login("editor");
    await age(s, 61);
    expect(await t.api("select lbe.whoami($1)", [s])).toBeNull();
    await expectCode(t.api("select lbe.create_content($1, $2, 'threat-landscape', 'x', null, null)", [s, t.ids.accounts.company]), "LBE10");
  });

  it("a session idle for less than 60 minutes still works and its activity is refreshed", async () => {
    const s = await t.login("editor");
    await age(s, 59);
    const before = await lastSeen(s);
    expect(await t.api<{ role: string }>("select lbe.whoami($1)", [s])).toMatchObject({ role: "editor" });
    expect(await lastSeen(s)).not.toBe(before);
    await age(s, 59);
    await t.api("select lbe.create_content($1, $2, 'threat-landscape', 'idle-test', null, null)", [s, t.ids.accounts.company]);
    await age(s, 59);                                                  // refreshed by require_user, so 59 more minutes is fine
    expect(await t.api("select lbe.whoami($1)", [s])).not.toBeNull();
  });

  it("activity is recorded at most once a minute (no write on every request)", async () => {
    const s = await t.login("editor");
    const first = await lastSeen(s);
    await t.api("select lbe.whoami($1)", [s]);
    expect(await lastSeen(s)).toBe(first);
  });

  it("the 12-hour absolute limit still applies to active sessions", async () => {
    const s = await t.login("editor");
    await t.db.query("update lbe.sessions set expires_at = now() - interval '1 second' where token_hash = lbe.hash_text($1)", [s]);
    expect(await t.api("select lbe.whoami($1)", [s])).toBeNull();
  });
});

describe("sign out everywhere", () => {
  it("revokes every session of the caller only, and is audited", async () => {
    const a = await t.login("approver");
    const b = await t.login("approver");
    const other = await t.login("admin");
    const n = await t.api<number>("select lbe.logout_all($1)", [a]);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(await t.api("select lbe.whoami($1)", [a])).toBeNull();
    expect(await t.api("select lbe.whoami($1)", [b])).toBeNull();
    expect(await t.api("select lbe.whoami($1)", [other])).not.toBeNull();
    const audit = await t.db.query<{ details: { sessions_revoked: number } }>(
      "select details from lbe.audit_events where action = 'auth.logout_all' order by id desc limit 1");
    expect(audit[0]!.details.sessions_revoked).toBe(n);
  });

  it("requires a live session", async () => {
    await expectCode(t.api("select lbe.logout_all($1)", ["f".repeat(64)]), "LBE10");
  });

  it("application roles cannot call the internal session helper", async () => {
    const s = await t.login("editor");
    await expectCode(t.api("select lbe.session_user_touch($1)", [s]), "42501");
  });
});
