// Real-PostgreSQL concurrency tests (multiple connections, real row locks).
// Run with: LBE_TEST_PG_URL=postgres://postgres:<pw>@127.0.0.1:54329/lbe npm run test:pg
// Each run creates and drops its own temporary database.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, openDb, type Db } from "../../services/api/src/db.ts";
import { seed, type SeedResult } from "../../services/api/src/seed.ts";
import { TEST_PASSWORDS } from "../helpers/db.ts";

const ADMIN_URL = process.env.LBE_TEST_PG_URL;
const suite = ADMIN_URL ? describe : describe.skip;

let db: Db;
let ids: SeedResult;
let dbName = "";
let sessions: Record<"editor" | "approver" | "admin", string>;

const api = async <T>(sql: string, params: unknown[] = []) =>
  db.tx("lbe_api", async (q) => Object.values((await q.query<Record<string, unknown>>(sql, params))[0] ?? {})[0] as T);
const settle = <T>(ps: Array<Promise<T>>) => Promise.allSettled(ps);

async function inReview(): Promise<string> {
  const id = await api<string>("select lbe.create_content($1, $2, 'threat-landscape', 'race test', null, null)",
    [sessions.editor, ids.accounts.company]);
  await api("select lbe.set_draft_output($1, $2, $3, $4::jsonb, '[]'::jsonb)", [sessions.editor, id,
    "[SYNTHETIC] ActTrident is a UK-registered cybersecurity company. Race test.",
    JSON.stringify([{ claim_id: ids.claims[0], quoted_span: "ActTrident is a UK-registered cybersecurity company" }])]);
  await api("select lbe.submit_for_review($1, $2)", [sessions.editor, id]);
  return id;
}
const hashOf = async (id: string) =>
  (await db.query<{ package_hash: string }>("select package_hash from lbe.content_items where id = $1", [id]))[0]!.package_hash;
async function queued(): Promise<string> {
  const id = await inReview();
  await api("select lbe.decide_content($1, $2, $3, 'approved', null)", [sessions.approver, id, await hashOf(id)]);
  await api("select lbe.enqueue_publication($1, $2)", [sessions.approver, id]);
  return id;
}

suite("PostgreSQL concurrency", () => {
  beforeAll(async () => {
    dbName = `lbe_test_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    await admin.end();
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${dbName}`;
    db = await openDb({ url: url.toString() });
    await migrate(db);
    ids = await seed(db, TEST_PASSWORDS);
    const login = async (email: string, pw: string) =>
      (await api<{ token: string }>("select lbe.login($1, $2)", [email, pw])).token;
    sessions = {
      editor: await login("editor@lbe.test", TEST_PASSWORDS.editor),
      approver: await login("marketing@lbe.test", TEST_PASSWORDS.approver),
      admin: await login("admin@lbe.test", TEST_PASSWORDS.admin),
    };
  });

  afterAll(async () => {
    if (!db) return;
    await db.close();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${dbName} with (force)`);
    await admin.end();
  });

  it("concurrent workers never claim the same outbox entry", async () => {
    const created = await Promise.all(Array.from({ length: 12 }, () => queued()));
    const claims = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      db.tx("lbe_worker", (q) => q.query<{ id: string }>("select id from lbe.claim_outbox($1, 3, 60, array['mock'])", [`w${i}`]))));
    const claimedIds = claims.flat().map((r) => r.id);
    expect(new Set(claimedIds).size).toBe(claimedIds.length);       // no duplicates
    expect(claimedIds.length).toBe(created.length);                    // everything claimed exactly once
  });

  it("racing approve and edit never leaves an approval bound to a different package", async () => {
    for (let i = 0; i < 15; i++) {
      const id = await inReview();
      const hash = await hashOf(id);
      await settle([
        api("select lbe.decide_content($1, $2, $3, 'approved', null)", [sessions.approver, id, hash]),
        api("select lbe.update_content($1, $2, $3::jsonb)", [sessions.editor, id, JSON.stringify({ visibility: "CONNECTIONS" })]),
      ]);
      const [row] = await db.query<{ status: string; package_hash: string }>(
        "select status, package_hash from lbe.content_items where id = $1", [id]);
      if (row!.status === "approved") {
        const [a] = await db.query<{ package_hash: string }>(
          "select package_hash from lbe.content_approvals where content_id = $1 order by created_at desc limit 1", [id]);
        expect(a!.package_hash).toBe(row!.package_hash);
      } else {
        expect(row!.status).toBe("draft");
      }
    }
  });

  it("two approvers deciding at once produce exactly one decision", async () => {
    const id = await inReview();
    const hash = await hashOf(id);
    const adminIsApprover = sessions.admin;   // admin is an approver for the company account in the seed
    const results = await settle([
      api("select lbe.decide_content($1, $2, $3, 'approved', null)", [sessions.approver, id, hash]),
      api("select lbe.decide_content($1, $2, $3, 'approved', null)", [adminIsApprover, id, hash]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rows = await db.query("select 1 from lbe.content_approvals where content_id = $1", [id]);
    expect(rows).toHaveLength(1);
  });

  it("concurrent double enqueue creates exactly one outbox entry", async () => {
    const id = await inReview();
    await api("select lbe.decide_content($1, $2, $3, 'approved', null)", [sessions.approver, id, await hashOf(id)]);
    const results = await settle([
      api("select lbe.enqueue_publication($1, $2)", [sessions.approver, id]),
      api("select lbe.enqueue_publication($1, $2)", [sessions.approver, id]),
      api("select lbe.enqueue_publication($1, $2)", [sessions.admin, id]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rows = await db.query("select 1 from lbe.publication_outbox where content_id = $1", [id]);
    expect(rows).toHaveLength(1);
  });

  it("after a STOP commits, no worker can claim", async () => {
    // Drain anything left over, then queue fresh work.
    await db.tx("lbe_worker", (q) => q.query("select lbe.claim_outbox('drain', 50, 60, array['mock'])"));
    await Promise.all(Array.from({ length: 4 }, () => queued()));
    await api("select lbe.set_stop($1, 'global', true, 'concurrency test')", [sessions.editor]);
    const claims = await Promise.all(Array.from({ length: 4 }, (_, i) =>
      db.tx("lbe_worker", (q) => q.query("select id from lbe.claim_outbox($1, 5, 60, array['mock'])", [`s${i}`]))));
    expect(claims.flat()).toHaveLength(0);
    await api("select lbe.set_stop($1, 'global', false, 'done')", [sessions.admin]);
  });
});
