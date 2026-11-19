// P2-01: content pillars are edited by the owner (admin) only, per account, validated and audited.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectCode, freshDb, type TestDb } from "../helpers/db.ts";

let t: TestDb;
let admin: string;
let otherAccount: string;
beforeAll(async () => {
  t = await freshDb();
  admin = await t.login("admin");
  const [o] = await t.db.query<{ id: string }>("insert into lbe.organizations(name, slug) values ('Org B', 'org-b') returning id");
  otherAccount = (await t.db.query<{ id: string }>(
    "insert into lbe.social_accounts(kind, display_name, voice_profile, pillars, organization_id) values ('company_page', 'B', 'company', array['news'], $1) returning id", [o!.id]))[0]!.id;
});
afterAll(async () => t.db.close());

const set = (pillars: string[], account = t.ids.accounts.company, s = admin) =>
  t.api<string[]>("select lbe.set_account_pillars($1, $2, $3)", [s, account, pillars]);

describe("set_account_pillars", () => {
  it("admin sets pillars; duplicates removed, order kept; audited with before/after", async () => {
    expect(await set(["threat-landscape", "awareness-habits", "threat-landscape"])).toEqual(["threat-landscape", "awareness-habits"]);
    const [a] = await t.db.query<{ details: { from: string[]; to: string[] }; actor: string }>(
      "select details, actor from lbe.audit_events where action = 'account.pillars_changed' order by id desc limit 1");
    expect(a!.details.to).toEqual(["threat-landscape", "awareness-habits"]);
    expect(a!.details.from.length).toBeGreaterThan(0);
    expect(a!.actor).toBe(`user:${t.ids.users.admin}`);
  });

  it("non-admins cannot change pillars", async () => {
    for (const who of ["approver", "editor", "founder"] as const) {
      await expectCode(set(["x-y"], t.ids.accounts.company, await t.login(who)), "LBE11");
    }
  });

  it("another organization's account is 'not found'", async () => {
    await expectCode(set(["x-y"], otherAccount), "LBE04");
    expect((await t.db.query<{ pillars: string[] }>("select pillars from lbe.social_accounts where id = $1", [otherAccount]))[0]!.pillars).toEqual(["news"]);
  });

  it("validates count and format", async () => {
    await expectCode(set([]), "LBE02");
    await expectCode(set(Array.from({ length: 9 }, (_, i) => `pillar-${i}`)), "LBE02");
    await expectCode(set(["Has Spaces"]), "LBE02");
    await expectCode(set(["x"]), "LBE02");
    await expectCode(set(["ok-one", "<script>"]), "LBE02");
  });

  it("the agent role cannot change pillars", async () => {
    await expectCode(t.db.tx("lbe_agent", (q) => q.query("select lbe.set_account_pillars($1, $2, $3)", [admin, t.ids.accounts.company, ["a-b"]])), "42501");
  });
});
