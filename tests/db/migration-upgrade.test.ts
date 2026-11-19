// Upgrade rehearsal: a database populated at schema 0400 (before the Brand Brain) is upgraded to the latest
// schema. Data, approvals and invariants must survive; a failing migration must leave no partial state.
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrate, MIGRATIONS_DIR, openDb } from "../../services/api/src/db.ts";
import { TEST_PASSWORDS } from "../helpers/db.ts";

const BEFORE_BRAIN = "20261119000400_phase2_live_gate.sql";

async function populatedAt0400() {
  const db = await openDb({ url: "pglite" });
  await migrate(db, MIGRATIONS_DIR, { until: BEFORE_BRAIN });
  const one = async <T>(sql: string, params: unknown[] = []) => Object.values((await db.query<Record<string, unknown>>(sql, params))[0] ?? {})[0] as T;
  const admin = await one<string>("select lbe.admin_create_user('admin@up.test', 'A', 'admin', $1)", [TEST_PASSWORDS.admin]);
  const approver = await one<string>("select lbe.admin_create_user('appr@up.test', 'B', 'approver', $1)", [TEST_PASSWORDS.approver]);
  const account = await one<string>("insert into lbe.social_accounts(kind, display_name, voice_profile, pillars) values ('company_page', 'Co', 'company', array['p']) returning id");
  await db.query("insert into lbe.account_approvers values ($1, $2), ($1, $3)", [account, approver, admin]);
  const login = async (email: string, pw: string) => (await db.tx("lbe_api", (q) => q.query<{ r: { token: string } }>("select lbe.login($1, $2) as r", [email, pw])))[0]!.r.token;
  const api = async <T>(sql: string, params: unknown[]) => Object.values((await db.tx("lbe_api", (q) => q.query<Record<string, unknown>>(sql, params)))[0] ?? {})[0] as T;
  const s = await login("appr@up.test", TEST_PASSWORDS.approver);
  // content approved (not yet queued) + content queued
  const mk = async () => {
    const id = await api<string>("select lbe.create_content($1, $2, 'p', 'brief', null, null)", [s, account]);
    await api("select lbe.update_content($1, $2, '{\"body\":\"Hello world, a post.\"}'::jsonb)", [s, id]);
    await api("select lbe.submit_for_review($1, $2)", [s, id]);
    const h = (await db.query<{ h: string }>("select package_hash as h from lbe.content_items where id = $1", [id]))[0]!.h;
    await api("select lbe.decide_content($1, $2, $3, 'approved', null)", [s, id, h]);
    return { id, h };
  };
  const approved = await mk();
  const queued = await mk();
  await api("select lbe.enqueue_publication($1, $2)", [s, queued.id]);
  return { db, account, approved, queued, admin, login, api };
}

describe("upgrade from 0400 to latest", () => {
  it("preserves data, assigns everything to the first organization, keeps approvals valid", async () => {
    const x = await populatedAt0400();
    const auditBefore = (await x.db.query<{ n: number }>("select count(*)::int as n from lbe.audit_events"))[0]!.n;
    const ran = await migrate(x.db);
    expect(ran.length).toBeGreaterThanOrEqual(2);
    const [org] = await x.db.query<{ id: string }>("select id from lbe.organizations");
    for (const table of ["app_users", "social_accounts", "claims"]) {
      const rows = await x.db.query<{ n: number }>(`select count(*)::int as n from lbe.${table} where organization_id is distinct from $1`, [org!.id]);
      expect(rows[0]!.n, table).toBe(0);
    }
    // package hashes unchanged → approvals still match
    const [a] = await x.db.query<{ status: string; package_hash: string }>("select status, package_hash from lbe.content_items where id = $1", [x.approved.id]);
    expect(a).toEqual({ status: "approved", package_hash: x.approved.h });
    // audit rows preserved and attributed
    const after = await x.db.query<{ n: number; attributed: number }>("select count(*)::int as n, count(organization_id)::int as attributed from lbe.audit_events");
    expect(after[0]!.n).toBeGreaterThanOrEqual(auditBefore);
    expect(after[0]!.attributed).toBeGreaterThan(0);
    // the approved item can still be queued and the queued one still dispatched after the upgrade
    const s = await x.login("appr@up.test", TEST_PASSWORDS.approver);
    await x.api("select lbe.enqueue_publication($1, $2)", [s, x.approved.id]);
    const claimed = await x.db.tx("lbe_worker", (q) => q.query("select id from lbe.claim_outbox('w', 10, 60, array['mock'])"));
    expect(claimed).toHaveLength(2);
    // organization STOP flag exists for the pre-existing organization
    expect((await x.db.query("select 1 from lbe.control_flags where key = $1", [`org:${org!.id}`]))).toHaveLength(1);
    await x.db.close();
  });

  it("a failing migration is atomic: nothing from it is applied or recorded", async () => {
    const x = await populatedAt0400();
    // Simulate a conflicting object so 0500 fails half-way.
    await x.db.query("create table lbe.brand_entries(id int)");
    await expect(migrate(x.db)).rejects.toThrow();
    const recorded = await x.db.query<{ version: string }>("select version from public.lbe_schema_migrations order by version");
    expect(recorded.map((r) => r.version).at(-1)).toBe(BEFORE_BRAIN);
    expect(await x.db.query("select 1 from information_schema.tables where table_schema = 'lbe' and table_name = 'organizations'")).toHaveLength(0);
    expect(await x.db.query("select 1 from information_schema.columns where table_schema = 'lbe' and table_name = 'social_accounts' and column_name = 'organization_id'")).toHaveLength(0);
    await x.db.close();
  });

  it("refuses to run if an applied migration file was modified", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lbe-mig-"));
    for (const f of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"))) {
      await writeFile(path.join(dir, f), await readFile(path.join(MIGRATIONS_DIR, f), "utf8"));
    }
    const db = await openDb({ url: "pglite" });
    await migrate(db, dir);
    const first = (await readdir(dir)).sort()[0]!;
    await writeFile(path.join(dir, first), (await readFile(path.join(dir, first), "utf8")) + "\n-- tampered\n");
    await expect(migrate(db, dir)).rejects.toThrow(/modified after being applied/);
    await db.close();
  });
});
