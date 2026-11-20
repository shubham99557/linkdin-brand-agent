// P2-05: retire the synthetic development knowledge. `npm run brain:reset-dev` gives the DEVELOPMENT environment a
// fresh database with the dev logins (.test emails) and the two DEV accounts, but no synthetic claims, so onboarding
// can be rehearsed on an empty Brand Brain without touching staging (where the real data lives, D-13).
//   * Development only: refuses unless .env says LBE_ENV=development with the embedded database, refuses a data
//     folder that is (or looks like) staging's, and refuses while the development server is running.
//   * Nothing is deleted: the current database folder is renamed to <folder>-before-reset-<time>; to go back, stop
//     the server and point LBE_PGLITE_DIR at it (or rename it back).
//   * --with-synthetic-claims adds the [SYNTHETIC] example claims again (the old `db:seed` behaviour).
import { existsSync, readFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";
import { parseEnv } from "node:util";
import { migrate, openDb } from "./db.ts";
import { seedSyntheticClaims, seedUsersAndAccounts } from "./seed.ts";

export class DevResetRefused extends Error {}

export interface DevResetOptions {
  repoRoot: string;
  /** The development settings file (default .env). */
  envFile?: string;
  withSyntheticClaims?: boolean;
  now?: Date;
  portInUse?: (port: number) => Promise<boolean>;
}

export interface DevResetResult { dataDir: string; movedTo: string | null; users: number; accounts: number; claims: number }

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
}

const envOf = (file: string) => (existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : null);

export async function resetDevDatabase(opts: DevResetOptions): Promise<DevResetResult> {
  const root = path.resolve(opts.repoRoot);
  const env = envOf(path.join(root, opts.envFile ?? ".env"));
  if (!env) throw new DevResetRefused("No .env found: this command only resets the development environment.");
  if ((env.LBE_ENV || "development") !== "development") {
    throw new DevResetRefused(`Refusing: the settings say LBE_ENV=${env.LBE_ENV}. brain:reset-dev only resets the development database, never staging.`);
  }
  if ((env.LBE_DATABASE_URL || "pglite") !== "pglite") throw new DevResetRefused("Refusing: the development database is a PostgreSQL server, not the embedded database.");
  const dataDir = path.resolve(root, env.LBE_PGLITE_DIR || ".data/pglite");
  const staging = envOf(path.join(root, ".env.staging"));
  const stagingDir = path.resolve(root, staging?.LBE_PGLITE_DIR || ".data/staging");
  if (dataDir === stagingDir || /staging/i.test(path.basename(dataDir))) {
    throw new DevResetRefused(`Refusing: ${dataDir} is the staging database (your real data).`);
  }
  const rel = path.relative(path.join(root, ".data"), dataDir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new DevResetRefused("Refusing: the development database must be inside the project's .data folder.");
  const port = Number(env.LBE_PORT || 8787);
  if (await (opts.portInUse ?? portOpen)(port)) {
    throw new DevResetRefused(`Stop the development server first (Ctrl+C in its window; it is listening on port ${port}).`);
  }
  const passwords = {
    admin: env.LBE_DEV_ADMIN_PASSWORD ?? "", approver: env.LBE_DEV_APPROVER_PASSWORD ?? "",
    founder: env.LBE_DEV_FOUNDER_PASSWORD ?? "", editor: env.LBE_DEV_EDITOR_PASSWORD ?? "",
  };
  if (Object.values(passwords).some((p) => p.length < 12)) {
    throw new DevResetRefused("LBE_DEV_*_PASSWORD (12+ characters each) must be set in .env. \"npm run setup:local\" creates them for a new .env.");
  }

  let movedTo: string | null = null;
  if (existsSync(dataDir)) {
    movedTo = `${dataDir}-before-reset-${(opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-")}`;
    if (existsSync(movedTo)) throw new DevResetRefused(`${movedTo} already exists`);
    await rename(dataDir, movedTo);
  }
  const db = await openDb({ url: "pglite", dataDir });
  try {
    await migrate(db);
    const base = await seedUsersAndAccounts(db, passwords);
    const claims = opts.withSyntheticClaims ? await seedSyntheticClaims(db, base.users) : [];
    return { dataDir, movedTo, users: Object.keys(base.users).length, accounts: Object.keys(base.accounts).length, claims: claims.length };
  } finally {
    await db.close();
  }
}
