// Backup and restore for the embedded (PGlite) database. A backup is a gzip tarball of the PGlite data folder
// plus a manifest (SHA-256 of the archive, migration list, row count per table). Restore verifies the archive
// hash, refuses to overwrite an existing database, loads the archive into a NEW folder and checks that the
// restored database matches the manifest. For a PostgreSQL URL use pg_dump/pg_restore (docs/migrations-runbook.md).
//
// Backups contain business data, password hashes and encrypted LinkedIn tokens: keep them in git-ignored
// `backups/` or encrypted storage. Restored databases have all sessions and pending OAuth states removed.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { lockDataDir } from "./pglite-lock.ts";

export interface Fingerprint {
  migrations: Array<{ version: string; checksum: string }>;
  rowCounts: Record<string, number>;
}

export interface BackupManifest {
  format: "lbe-pglite-backup/1";
  created_at: string;
  environment: string;
  archive: string;
  archive_sha256: string;
  archive_bytes: number;
  fingerprint: Fingerprint;
}

type Q = { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> };

/** Migration list + exact row count of every table in the lbe schema (sessions/oauth_states excluded: purged on restore). */
export async function fingerprint(db: Q): Promise<Fingerprint> {
  const migrations = (await db.query<{ version: string; checksum: string }>(
    "select version, checksum from public.lbe_schema_migrations order by version")).rows;
  const tables = (await db.query<{ t: string }>(
    `select tablename as t from pg_tables where schemaname = 'lbe' and tablename not in ('sessions', 'oauth_states') order by tablename`)).rows;
  const rowCounts: Record<string, number> = {};
  for (const { t } of tables) {
    const r = await db.query<{ n: number }>(`select count(*)::int as n from lbe.${quoteIdent(t)}`);
    rowCounts[t] = r.rows[0]!.n;
  }
  return { migrations, rowCounts };
}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export function diffFingerprints(a: Fingerprint, b: Fingerprint): string[] {
  const problems: string[] = [];
  if (JSON.stringify(a.migrations) !== JSON.stringify(b.migrations)) problems.push("migration list differs");
  const keys = new Set([...Object.keys(a.rowCounts), ...Object.keys(b.rowCounts)]);
  for (const k of [...keys].sort()) {
    if (a.rowCounts[k] !== b.rowCounts[k]) problems.push(`lbe.${k}: expected ${a.rowCounts[k] ?? "missing"}, got ${b.rowCounts[k] ?? "missing"}`);
  }
  return problems;
}

/** Opens an embedded database folder under the one-program lock (see pglite-lock.ts) and runs fn on it. */
async function withPglite<T>(dataDir: string, opts: { loadDataDir?: Blob }, fn: (db: PGlite) => Promise<T>): Promise<T> {
  const unlock = lockDataDir(dataDir);
  try {
    const db = await PGlite.create({ dataDir, extensions: { pgcrypto }, ...opts });
    try {
      return await fn(db);
    } finally {
      await db.close();
    }
  } finally {
    unlock();
  }
}

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return true;
  return (await readdir(dir)).length === 0;
}

/** Back up the PGlite data folder `dataDir` into `outDir`. The database must not be open in another process. */
export async function backupPglite(opts: { dataDir: string; outDir: string; environment: string; now?: Date }): Promise<{ manifestPath: string; manifest: BackupManifest }> {
  if (await isEmptyOrMissing(opts.dataDir)) throw new Error(`no database found at ${opts.dataDir}`);
  const { fp, archive } = await withPglite(opts.dataDir, {}, async (db) => ({
    fp: await fingerprint(db),
    archive: new Uint8Array(await (await db.dumpDataDir("gzip")).arrayBuffer()),
  }));
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const base = `lbe-${opts.environment}-${stamp}`;
  await mkdir(opts.outDir, { recursive: true });
  const archivePath = path.join(opts.outDir, `${base}.tar.gz`);
  const manifestPath = path.join(opts.outDir, `${base}.json`);
  if (existsSync(archivePath) || existsSync(manifestPath)) throw new Error(`backup ${base} already exists`);
  await writeFile(archivePath, archive, { flag: "wx" });
  const manifest: BackupManifest = {
    format: "lbe-pglite-backup/1", created_at: (opts.now ?? new Date()).toISOString(), environment: opts.environment,
    archive: path.basename(archivePath), archive_sha256: sha256(archive), archive_bytes: archive.byteLength, fingerprint: fp,
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { encoding: "utf8", flag: "wx" });
  return { manifestPath, manifest };
}

/**
 * Loads an archive into `targetDir` (must be missing or empty) and returns what it contains. Used by the
 * automatic-backup restore drill (P9-04), which writes the manifest only after this succeeds.
 */
export async function fingerprintArchive(archive: Uint8Array, targetDir: string): Promise<Fingerprint> {
  if (!(await isEmptyOrMissing(targetDir))) throw new Error(`refusing to use non-empty folder ${targetDir}`);
  await mkdir(targetDir, { recursive: true });
  return withPglite(targetDir, { loadDataDir: new Blob([archive as Uint8Array<ArrayBuffer>], { type: "application/x-gzip" }) }, fingerprint);
}

/** Manifest for an archive whose contents were checked by restoring it. Same format as backupPglite. */
export function manifestFor(archiveName: string, archive: Uint8Array, environment: string, createdAt: Date, fp: Fingerprint): BackupManifest {
  return {
    format: "lbe-pglite-backup/1", created_at: createdAt.toISOString(), environment,
    archive: archiveName, archive_sha256: sha256(archive), archive_bytes: archive.byteLength, fingerprint: fp,
  };
}

/** Restore a backup (by manifest path) into `targetDir`, which must be missing or empty. Verifies hash and contents. */
export async function restorePglite(opts: { manifestPath: string; targetDir: string }): Promise<{ fingerprint: Fingerprint; sessionsPurged: number }> {
  const manifest = JSON.parse(await readFile(opts.manifestPath, "utf8")) as BackupManifest;
  if (manifest.format !== "lbe-pglite-backup/1") throw new Error("unknown backup format");
  if (path.basename(manifest.archive) !== manifest.archive) throw new Error("invalid archive name in manifest");
  const archive = new Uint8Array(await readFile(path.join(path.dirname(opts.manifestPath), manifest.archive)));
  if (sha256(archive) !== manifest.archive_sha256) throw new Error("archive checksum mismatch — backup is corrupt or was modified");
  if (!(await isEmptyOrMissing(opts.targetDir))) throw new Error(`refusing to overwrite existing database at ${opts.targetDir} — restore into an empty folder`);
  await mkdir(opts.targetDir, { recursive: true });
  return withPglite(opts.targetDir, { loadDataDir: new Blob([archive as Uint8Array<ArrayBuffer>], { type: "application/x-gzip" }) }, async (db) => {
    const fp = await fingerprint(db);
    const problems = diffFingerprints(manifest.fingerprint, fp);
    if (problems.length) throw new Error(`restored database does not match the backup: ${problems.join("; ")}`);
    // Old sessions and OAuth states must not come back to life.
    const purged = await db.query<{ n: number }>("with d as (delete from lbe.sessions returning 1) select count(*)::int as n from d");
    await db.query("delete from lbe.oauth_states");
    return { fingerprint: fp, sessionsPurged: purged.rows[0]!.n };
  });
}
