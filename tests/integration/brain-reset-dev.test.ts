// P2-05: `brain:reset-dev` retires the synthetic development knowledge: a fresh DEVELOPMENT database with the dev
// logins and accounts only. Never touches staging; never deletes the old database.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, openDb } from "../../services/api/src/db.ts";
import { DevResetRefused, resetDevDatabase } from "../../services/api/src/dev-reset.ts";
import { seed } from "../../services/api/src/seed.ts";
import { TEST_PASSWORDS } from "../helpers/db.ts";

let root: string;
const DEV_ENV = [
  "LBE_ENV=development", "LBE_PORT=59996", "LBE_DATABASE_URL=pglite", "LBE_PGLITE_DIR=.data/pglite",
  `LBE_DEV_ADMIN_PASSWORD=${TEST_PASSWORDS.admin}`, `LBE_DEV_APPROVER_PASSWORD=${TEST_PASSWORDS.approver}`,
  `LBE_DEV_FOUNDER_PASSWORD=${TEST_PASSWORDS.founder}`, `LBE_DEV_EDITOR_PASSWORD=${TEST_PASSWORDS.editor}`,
].join("\n");
const noServer = async () => false;
const counts = async (dir: string) => {
  const db = await openDb({ url: "pglite", dataDir: dir });
  try {
    const n = async (t: string) => (await db.query<{ n: number }>(`select count(*)::int as n from lbe.${t}`))[0]!.n;
    return { users: await n("app_users"), accounts: await n("social_accounts"), claims: await n("claims"), entries: await n("brand_entries") };
  } finally { await db.close(); }
};

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lbe-devreset-"));
  await writeFile(path.join(root, ".env"), DEV_ENV);
  await writeFile(path.join(root, ".env.staging"), "LBE_ENV=staging\nLBE_PORT=59995\nLBE_DATABASE_URL=pglite\nLBE_PGLITE_DIR=.data/staging\n");
  // Today's development database: full synthetic seed.
  const db = await openDb({ url: "pglite", dataDir: path.join(root, ".data", "pglite") });
  await migrate(db);
  await seed(db, TEST_PASSWORDS);
  await db.close();
  // Staging (real data) must never be touched.
  await mkdir(path.join(root, ".data", "staging"), { recursive: true });
  await writeFile(path.join(root, ".data", "staging", "REAL-DATA.txt"), "owner data");
}, 180_000);

afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("brain:reset-dev (P2-05)", () => {
  it("fresh development database: dev logins and accounts, no synthetic claims, empty Brand Brain; old one kept; staging untouched", async () => {
    const old = path.join(root, ".data", "pglite");
    expect((await counts(old)).claims).toBe(4);
    const r = await resetDevDatabase({ repoRoot: root, portInUse: noServer, now: new Date("2026-11-20T10:00:00Z") });
    expect(r).toMatchObject({ users: 4, accounts: 2, claims: 0 });
    expect(r.movedTo).toBe(path.join(root, ".data", "pglite-before-reset-2026-11-20T10-00-00-000Z"));
    expect(await counts(r.dataDir)).toEqual({ users: 4, accounts: 2, claims: 0, entries: 0 });
    expect((await counts(r.movedTo!)).claims).toBe(4);                        // nothing was deleted
    expect(await readFile(path.join(root, ".data", "staging", "REAL-DATA.txt"), "utf8")).toBe("owner data");
    // The dev logins still work with the passwords in .env.
    const db = await openDb({ url: "pglite", dataDir: r.dataDir });
    try {
      const [login] = await db.tx("lbe_api", (q) => q.query<{ r: { token: string } }>("select lbe.login($1, $2) as r", ["admin@lbe.test", TEST_PASSWORDS.admin]));
      expect(login!.r.token).toBeTruthy();
    } finally { await db.close(); }
  }, 180_000);

  it("--with-synthetic-claims brings the [SYNTHETIC] examples back", async () => {
    const r = await resetDevDatabase({ repoRoot: root, portInUse: noServer, withSyntheticClaims: true, now: new Date("2026-11-20T11:00:00Z") });
    expect(r.claims).toBe(4);
    expect((await counts(r.dataDir)).claims).toBe(4);
  }, 180_000);

  it("refuses staging settings, a data folder that is staging's, PostgreSQL, a folder outside .data, a running server and missing passwords — and moves nothing", async () => {
    const before = (await import("node:fs/promises")).readdir(path.join(root, ".data"));
    const attempt = async (env: string, portInUse: (port: number) => Promise<boolean> = noServer) => {
      await writeFile(path.join(root, ".env"), env);
      try { return await resetDevDatabase({ repoRoot: root, portInUse }).then(() => null, (e: unknown) => e as Error); }
      finally { await writeFile(path.join(root, ".env"), DEV_ENV); }
    };
    const cases: Array<[string, Error | null, RegExp]> = [
      ["staging settings", await attempt(DEV_ENV.replace("LBE_ENV=development", "LBE_ENV=staging")), /never staging/],
      ["staging folder", await attempt(DEV_ENV.replace(".data/pglite", ".data/staging")), /staging database/],
      ["staging-like folder", await attempt(DEV_ENV.replace(".data/pglite", ".data/my-staging-copy")), /staging database/],
      ["PostgreSQL", await attempt(DEV_ENV.replace("LBE_DATABASE_URL=pglite", "LBE_DATABASE_URL=postgres://u:p@localhost/db")), /PostgreSQL/],
      ["outside .data", await attempt(DEV_ENV.replace(".data/pglite", "elsewhere/pglite")), /inside the project's .data folder/],
      ["server running", await attempt(DEV_ENV, async (p) => p === 59996), /Stop the development server first/],
      ["missing passwords", await attempt(DEV_ENV.replace(/LBE_DEV_EDITOR_PASSWORD=.*/, "LBE_DEV_EDITOR_PASSWORD=short")), /LBE_DEV_\*_PASSWORD/],
    ];
    for (const [name, e, msg] of cases) {
      expect(e, name).toBeInstanceOf(DevResetRefused);
      expect(e!.message, name).toMatch(msg);
    }
    expect(await (await import("node:fs/promises")).readdir(path.join(root, ".data"))).toEqual(await before);
    expect(existsSync(path.join(root, ".data", "staging", "REAL-DATA.txt"))).toBe(true);
  }, 180_000);
});
