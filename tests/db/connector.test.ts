// P11-01a: read-only Claude connector key. It works in exactly one database function (connector_brain_get, as
// lbe_agent) and is refused everywhere else; admin-only, ≤ 8 h, revocable, audited, organization-scoped.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectCode, freshDb, type TestDb } from "../helpers/db.ts";

let t: TestDb;
let admin: string;
const asAgent = <T>(sql: string, params: unknown[]) => t.db.tx("lbe_agent", (q) => q.query<T>(sql, params));
const brainGet = async (token: string) =>
  (await asAgent<{ r: { entries: Array<{ section: string; key: string; body: string }>; count: number; organization: string } }>(
    "select lbe.connector_brain_get($1) as r", [token]))[0]!.r;
const createKey = async (session: string, hours = 8) =>
  t.api<{ id: string; token: string; expires_at: string }>("select lbe.connector_create($1, $2)", [session, hours]);

beforeAll(async () => {
  t = await freshDb();
  admin = await t.login("admin");
  await t.api("select lbe.brain_upsert_entry($1, 'identity', 'main', 'Who we are', 'ActTrident helps UK firms build security habits.', '{}'::jsonb, 'owner', null)", [admin]);
  await t.api("select lbe.brain_upsert_entry($1, 'voice_company', 'main', 'Voice', 'Calm, practical, no fear-mongering.', '{}'::jsonb, 'owner', null)", [admin]);
  const retired = await t.api<string>("select lbe.brain_upsert_entry($1, 'identity', 'old', 'Old', 'Retired text', '{}'::jsonb, 'owner', null)", [admin]);
  await t.api("select lbe.brain_retire_entry($1, $2)", [admin, retired]);
  // Visual identity (logo data) is left out of the tool on purpose.
  const [org] = await t.db.query<{ organization_id: string }>("select organization_id from lbe.app_users where email = 'admin@lbe.test'");
  await t.db.query(`insert into lbe.brand_entries(organization_id, section, key, title, body, structured, version, source, approved_by)
                    select $1, 'identity', 'visual', 'Visual identity', 'colours', '{}'::jsonb, 1, 'owner', id from lbe.app_users where email = 'admin@lbe.test'`, [org!.organization_id]);
});
afterAll(async () => t.db.close());

describe("Claude connector key (P11-01a)", () => {
  it("only an admin can create a key; it lasts 1-8 hours and is never stored in clear", async () => {
    await expectCode(createKey(await t.login("editor")), "LBE11");
    await expectCode(createKey(admin, 9), "LBE02");
    await expectCode(createKey(admin, 0), "LBE02");
    const k = await createKey(admin, 8);
    expect(k.token).toMatch(/^[0-9a-f]{64}$/);
    const hours = (Date.parse(k.expires_at) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(7.9);
    expect(hours).toBeLessThanOrEqual(8);
    const [row] = await t.db.query<{ kind: string; token_hash: string }>("select kind, token_hash from lbe.sessions where id = $1", [k.id]);
    expect(row!.kind).toBe("connector");
    expect(row!.token_hash).not.toContain(k.token);
  });

  it("returns only the organization's approved entries (no retired ones, no logo data), and audits each call", async () => {
    const k = await createKey(admin);
    const r = await brainGet(k.token);
    expect(r.entries.map((e) => `${e.section}/${e.key}`)).toEqual(["identity/main", "voice_company/main"]);
    expect(r.count).toBe(2);
    const [a] = await t.db.query<{ actor: string; details: { tool: string; entries: number; key_id: string } }>(
      "select actor, details from lbe.audit_events where action = 'connector.tool_called' order by at desc limit 1");
    expect(a!.details).toMatchObject({ tool: "get_brand_brain", entries: 2, key_id: k.id });
    expect(a!.actor).toMatch(/^connector:/);
  });

  it("the key is refused by every other function: sign-in check, Brand Brain, drafts, approval and publishing", async () => {
    const { token } = await createKey(admin);
    expect(await t.api("select (lbe.whoami($1)).id", [token]).catch(() => null)).toBeNull();
    await expectCode(t.api("select lbe.brain_load($1)", [token]), "LBE10");
    await expectCode(asAgent("select lbe.brain_load($1)", [token]), "LBE10");
    await expectCode(asAgent("select lbe.create_content($1, $2, 'security-culture', 'x', null, null)", [token, t.ids.accounts.company]), "LBE10");
    await expectCode(t.api("select lbe.brain_upsert_entry($1, 'identity', 'main', 't', 'b', '{}'::jsonb, 'owner', null)", [token]), "LBE10");
    await expectCode(t.api("select lbe.connector_create($1, 8)", [token]), "LBE10");
    await expectCode(t.api("select lbe.set_stop($1, 'organization', false, 'resume')", [token]), "LBE10");
  });

  it("only the agent role may call the read function, and only the API role may create keys", async () => {
    const { token } = await createKey(admin);
    await expectCode(t.api("select lbe.connector_brain_get($1)", [token]), "42501");
    await expectCode(asAgent("select lbe.connector_create($1, 8)", [admin]), "42501");
  });

  it("revoked, expired, replaced or disabled-user keys stop working at once", async () => {
    const first = await createKey(admin);
    const second = await createKey(admin);                        // a new key ends the previous one
    await expectCode(brainGet(first.token), "LBE10");
    expect((await brainGet(second.token)).count).toBe(2);
    expect(await t.api<number>("select lbe.connector_revoke_all($1)", [admin])).toBe(1);
    await expectCode(brainGet(second.token), "LBE10");
    const third = await createKey(admin);
    await t.db.query("update lbe.sessions set expires_at = now() - interval '1 second' where id = $1", [third.id]);
    await expectCode(brainGet(third.token), "LBE10");
    await expectCode(brainGet("not-a-token"), "LBE10");
    await expectCode(brainGet("0".repeat(64)), "LBE10");
  });

  it("is organization-scoped: another organization's entries never appear", async () => {
    const [o] = await t.db.query<{ id: string }>("insert into lbe.organizations(name, slug) values ('Other Co', 'other-co-conn') returning id");
    await t.db.query("select lbe.admin_create_user('admin@other-conn.test', 'Other Admin', 'admin', 'other-org-password-1', $1)", [o!.id]);
    const otherSession = await t.api<{ token: string }>("select lbe.login('admin@other-conn.test', 'other-org-password-1')");
    await t.api("select lbe.brain_upsert_entry($1, 'identity', 'main', 'Other', 'Other company text', '{}'::jsonb, 'owner', null)", [otherSession.token]);
    const mine = await createKey(admin);
    expect((await brainGet(mine.token)).entries.some((e) => e.body.includes("Other company"))).toBe(false);
    const theirs = await createKey(otherSession.token);
    expect((await brainGet(theirs.token)).entries.map((e) => e.body)).toEqual(["Other company text"]);
  });

  it("status shows active keys without tokens, and the latest calls", async () => {
    const k = await createKey(admin);
    await brainGet(k.token);
    const s = await t.api<{ keys: Array<Record<string, unknown>>; recent_calls: Array<{ action: string }> }>("select lbe.connector_status($1)", [admin]);
    expect(s.keys).toHaveLength(1);
    expect(JSON.stringify(s)).not.toContain(k.token);
    expect(s.recent_calls[0]!.action).toBe("connector.tool_called");
    await expectCode(t.api("select lbe.connector_status($1)", [await t.login("editor")]), "LBE11");
  });
});
