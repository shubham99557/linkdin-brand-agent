// P2-09 (ADR-038): the Brand Brain separates the buyer ICP (`icp`) from the ideal follower (`ideal_follower`).
// The database and the domain must list the same sections; the new section follows the same owner-only rules;
// an existing database upgrades without touching its entries or pending proposals.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BRAIN_SECTIONS, REQUIRED_SECTIONS } from "@lbe/domain";
import { migrate, MIGRATIONS_DIR, openDb } from "../../services/api/src/db.ts";
import { expectCode, freshDb, TEST_PASSWORDS, type TestDb } from "../helpers/db.ts";

let t: TestDb;
let admin: string;
let editor: string;
beforeAll(async () => {
  t = await freshDb();
  admin = await t.login("admin");
  editor = await t.login("editor");
});
afterAll(async () => t.db.close());

type Loaded = { entries: Array<{ section: string; key: string; body: string }>; missing_sections: string[] };
const load = async (s = admin) => t.api<Loaded>("select lbe.brain_load($1)", [s]);

describe("Brand Brain sections (P2-09)", () => {
  it("the database and the domain list exactly the same sections, in the same order, and the same required ones", async () => {
    const [r] = await t.db.query<{ all: string[]; req: string[] }>("select lbe.brain_sections() as all, lbe.brain_required_sections() as req");
    expect(r!.all).toEqual([...BRAIN_SECTIONS]);
    expect([...r!.req].sort()).toEqual([...REQUIRED_SECTIONS].sort());
    expect(BRAIN_SECTIONS).toContain("ideal_follower");
    expect(REQUIRED_SECTIONS).toContain("ideal_follower");
  });

  it("the ideal follower is missing until the owner saves it, and is kept apart from the buyer ICP", async () => {
    expect((await load()).missing_sections).toEqual(expect.arrayContaining(["icp", "ideal_follower"]));
    await t.api("select lbe.brain_upsert_entry($1, 'icp', 'main', 'Buyer ICP', 'UK firms with 20-250 staff; the buyer is the operations lead.', '{}'::jsonb, 'owner', null)", [admin]);
    expect((await load()).missing_sections).toContain("ideal_follower");
    await t.api("select lbe.brain_upsert_entry($1, 'ideal_follower', 'main', 'Ideal follower', 'IT managers who share practical advice with their teams.', '{}'::jsonb, 'owner', null)", [admin]);
    const b = await load();
    expect(b.missing_sections).not.toContain("ideal_follower");
    expect(b.missing_sections).not.toContain("icp");
    const bySection = Object.fromEntries(b.entries.filter((e) => e.key === "main").map((e) => [e.section, e.body]));
    expect(bySection.icp).toMatch(/operations lead/);
    expect(bySection.ideal_follower).toMatch(/IT managers/);
  });

  it("only the owner writes it directly; an editor (or agent) can only propose, and the owner decides", async () => {
    await expectCode(t.api("select lbe.brain_upsert_entry($1, 'ideal_follower', 'alt', 'T', 'Body text here', '{}'::jsonb, 'owner', null)", [editor]), "LBE11");
    const proposal = await t.api<string>(
      "select lbe.brain_propose($1, 'ideal_follower', 'communities', 'Communities', 'Members of UK IT manager groups.', '{}'::jsonb, 'from interview notes', '[]'::jsonb, 'brand_orchestrator')", [editor]);
    expect((await load()).entries.some((e) => e.section === "ideal_follower" && e.key === "communities")).toBe(false);
    await expectCode(t.api("select lbe.brain_decide_proposal($1, $2, 'accepted', null, null, null)", [editor, proposal]), "LBE11");
    await t.api("select lbe.brain_decide_proposal($1, $2, 'accepted', null, null, null)", [admin, proposal]);
    expect((await load()).entries.some((e) => e.section === "ideal_follower" && e.key === "communities")).toBe(true);
  });

  it("an unknown section is still refused (the list was widened, not removed)", async () => {
    await expect(t.api("select lbe.brain_upsert_entry($1, 'followers', 'main', 'T', 'Body text here', '{}'::jsonb, 'owner', null)", [admin]))
      .rejects.toThrow(/check constraint|violates/i);
  });
});

describe("upgrade from the schema before P2-09", () => {
  it("existing buyer ICP entries and pending proposals survive unchanged; the follower then shows as missing", async () => {
    const db = await openDb({ url: "pglite" });
    try {
      await migrate(db, MIGRATIONS_DIR, { until: "20261120000100_connector_poc.sql" });
      const email = ["upgrade-owner", "example.test"].join("@");
      await db.query("select lbe.admin_create_user($1, 'Upgrade Owner', 'admin', $2)", [email, TEST_PASSWORDS.admin]);
      const api = async <T>(sql: string, params: unknown[] = []) =>
        Object.values((await db.tx("lbe_api", (q) => q.query<Record<string, unknown>>(sql, params)))[0] ?? {})[0] as T;
      const login = await api<{ ok: boolean; token: string }>("select lbe.login($1, $2)", [email, TEST_PASSWORDS.admin]);
      expect(login.ok).toBe(true);
      const s = login.token;
      const entry = await api<string>("select lbe.brain_upsert_entry($1, 'icp', 'main', 'Ideal customers', 'UK SMEs; buyer is the IT lead.', '{}'::jsonb, 'owner', null)", [s]);
      const proposal = await api<string>("select lbe.brain_propose($1, 'icp', 'regions', 'Regions', 'England and Wales.', '{}'::jsonb, 'r', '[]'::jsonb, null)", [s]);
      const before = (await db.query<{ row: unknown }>("select to_jsonb(e) as row from lbe.brand_entries e where id = $1", [entry]))[0]!.row;

      const ran = await migrate(db);
      expect(ran).toContain("20261120000200_brain_buyer_follower.sql");

      const after = (await db.query<{ row: unknown }>("select to_jsonb(e) as row from lbe.brand_entries e where id = $1", [entry]))[0]!.row;
      expect(after).toEqual(before);
      const b = await api<Loaded>("select lbe.brain_load($1)", [s]);
      expect(b.missing_sections).toContain("ideal_follower");
      expect(b.missing_sections).not.toContain("icp");
      await api("select lbe.brain_decide_proposal($1, $2, 'accepted', null, null, null)", [s, proposal]);
      expect((await api<Loaded>("select lbe.brain_load($1)", [s])).entries.some((e) => e.key === "regions")).toBe(true);
    } finally {
      await db.close();
    }
  });
});
