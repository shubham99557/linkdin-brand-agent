import { migrate, openDb, type Db } from "../../services/api/src/db.ts";
import { seed, type SeedResult } from "../../services/api/src/seed.ts";

export const TEST_PASSWORDS = {
  admin: "test-admin-password-123",
  approver: "test-approver-password-123",
  founder: "test-founder-password-123",
  editor: "test-editor-password-123",
};

export interface TestDb {
  db: Db;
  ids: SeedResult;
  /** Log in through the database function and return a raw session token. */
  login(who: keyof typeof TEST_PASSWORDS): Promise<string>;
  /** Call a function as lbe_api and return the first column of the first row. */
  api<T = unknown>(sql: string, params?: unknown[]): Promise<T>;
  worker<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

const EMAILS = {
  admin: "admin@lbe.test",
  approver: "marketing@lbe.test",
  founder: "founder@lbe.test",
  editor: "editor@lbe.test",
} as const;

export async function freshDb(url = "pglite"): Promise<TestDb> {
  const db = await openDb({ url });
  await migrate(db);
  const ids = await seed(db, TEST_PASSWORDS);
  const api = async <T>(sql: string, params: unknown[] = []) =>
    db.tx("lbe_api", async (q) => {
      const rows = await q.query<Record<string, unknown>>(sql, params);
      const first = rows[0];
      return (first ? Object.values(first)[0] : undefined) as T;
    });
  const worker = async <T>(sql: string, params: unknown[] = []) =>
    db.tx("lbe_worker", (q) => q.query<T>(sql, params));
  const login = async (who: keyof typeof TEST_PASSWORDS) => {
    const r = await api<{ ok: boolean; token?: string }>("select lbe.login($1, $2)", [EMAILS[who], TEST_PASSWORDS[who]]);
    if (!r.ok || !r.token) throw new Error(`login failed for ${who}`);
    return r.token;
  };
  return { db, ids, api, worker, login };
}

/** Create a content item with a verified-claim citation and move it to in_review. */
export async function contentInReview(t: TestDb, session: string, account: "company" | "founder" = "company") {
  const accountId = t.ids.accounts[account];
  const pillar = account === "company" ? "threat-landscape" : "founder-lessons";
  const id = await t.api<string>("select lbe.create_content($1, $2, $3, $4, null, null)",
    [session, accountId, pillar, "Synthetic brief for tests"]);
  const claimId = t.ids.claims[0]!;
  const body = "[SYNTHETIC] ActTrident is a UK-registered cybersecurity company. Here is what we learned this week.";
  await t.api("select lbe.set_draft_output($1, $2, $3, $4::jsonb, '[]'::jsonb)", [
    session, id, body,
    JSON.stringify([{ claim_id: claimId, quoted_span: "ActTrident is a UK-registered cybersecurity company" }]),
  ]);
  await t.api("select lbe.submit_for_review($1, $2)", [session, id]);
  return id;
}

export async function packageHash(t: TestDb, contentId: string): Promise<string> {
  const rows = await t.db.query<{ package_hash: string }>("select package_hash from lbe.content_items where id = $1", [contentId]);
  return rows[0]!.package_hash;
}

/** Expect a promise to reject with the given SQLSTATE. */
export async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    const got = (e as { code?: string }).code;
    if (got !== code) throw new Error(`expected SQLSTATE ${code} but got ${got}: ${(e as Error).message}`);
    return;
  }
  throw new Error(`expected SQLSTATE ${code} but the operation succeeded`);
}
