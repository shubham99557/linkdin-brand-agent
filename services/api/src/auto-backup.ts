// P9-04 (ADR-034): automatic backups of the embedded database while the server runs, for running the system on
// this PC (owner decision D-13).
//   * Every `intervalHours` (default 24) the server takes a snapshot (Db.snapshot: between transactions), writes it
//     to backups/auto/<environment>/, restores it in a separate process (restore drill) and only then writes the
//     manifest. A backup whose drill fails gets no manifest, so it can never be used by db:restore or the USB copy.
//   * The newest `keep` (default 14) backups are kept; older ones are deleted (only files this module wrote).
//   * status.json records the last attempt for the dashboard (admin) and the logs.
// These copies are on the same disk as the database: they protect against mistakes, a damaged database or a bad
// update, not against losing the PC. The weekly USB copy (npm run backup:external) covers that, and it can use
// these backups while the server is running.
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { manifestFor, type BackupManifest, type Fingerprint } from "./backup.ts";
import type { Db } from "./db.ts";

export interface AutoBackupStatus {
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_result: "ok" | "failed" | null;
  last_error: string | null;
}

export interface AutoBackupOptions {
  db: Pick<Db, "snapshot">;
  /** Folder for this environment's automatic backups, e.g. backups/auto/staging. */
  dir: string;
  environment: string;
  keep?: number;
  now?: () => Date;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Restore drill; default: a separate Node process (backup-drill-child.ts). Injectable for tests. */
  drill?: (archivePath: string) => Promise<Fingerprint>;
}

const NAME = /^lbe-auto-(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.(json|tar\.gz)$/;
const DRILL_CHILD = path.join(import.meta.dirname, "backup-drill-child.ts");

/** Default restore drill: load the archive into a temporary folder in a separate process and fingerprint it. */
export async function drillInChildProcess(archivePath: string, timeoutMs = 120_000): Promise<Fingerprint> {
  const tmp = await mkdtemp(path.join(tmpdir(), "lbe-drill-"));
  const target = path.join(tmp, "db");
  const child = fork(DRILL_CHILD, [archivePath, target], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  child.stderr?.resume();
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  try {
    return await new Promise<Fingerprint>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("restore drill took too long")), timeoutMs);
      child.once("message", (m: { ok: boolean; fingerprint?: Fingerprint; error?: string }) => {
        clearTimeout(timer);
        if (m.ok && m.fingerprint) resolve(m.fingerprint); else reject(new Error(m.error ?? "restore drill failed"));
      });
      child.once("error", (e) => { clearTimeout(timer); reject(e); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`restore drill stopped (exit ${code})`)); });
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    await rm(tmp, { recursive: true, force: true });
  }
}

export interface AutoBackupEntry { manifest: string; created_at: string; rows: number; migrations: number; bytes: number }

/** Verified automatic backups in `dir`, newest first (only those with a manifest, i.e. whose drill passed). */
export async function listAutoBackups(dir: string): Promise<AutoBackupEntry[]> {
  if (!existsSync(dir)) return [];
  const out: AutoBackupEntry[] = [];
  for (const name of await readdir(dir)) {
    if (!NAME.test(name) || !name.endsWith(".json")) continue;
    try {
      const m = JSON.parse(await readFile(path.join(dir, name), "utf8")) as BackupManifest;
      if (m.format !== "lbe-pglite-backup/1" || !existsSync(path.join(dir, m.archive))) continue;
      out.push({ manifest: name, created_at: m.created_at, bytes: m.archive_bytes, migrations: m.fingerprint.migrations.length,
        rows: Object.values(m.fingerprint.rowCounts).reduce((a, b) => a + b, 0) });
    } catch { /* unreadable manifest: not a usable backup */ }
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function readAutoStatus(dir: string): Promise<AutoBackupStatus> {
  try {
    return JSON.parse(await readFile(path.join(dir, "status.json"), "utf8")) as AutoBackupStatus;
  } catch {
    return { last_attempt_at: null, last_success_at: null, last_result: null, last_error: null };
  }
}

/** Takes one automatic backup now: snapshot → archive file → restore drill → manifest → prune → status. */
export async function runAutoBackup(opts: AutoBackupOptions): Promise<{ ok: boolean; manifest?: string; error?: string }> {
  if (!opts.db.snapshot) throw new Error("automatic backups need the embedded database (use pg_dump for PostgreSQL)");
  const now = (opts.now ?? (() => new Date()))();
  const keep = Math.max(1, opts.keep ?? 14);
  const drill = opts.drill ?? ((p: string) => drillInChildProcess(p));
  const status = await readAutoStatus(opts.dir);
  status.last_attempt_at = now.toISOString();
  await mkdir(opts.dir, { recursive: true });
  const base = `lbe-auto-${opts.environment}-${now.toISOString().replace(/[:.]/g, "-")}`;
  const archivePath = path.join(opts.dir, `${base}.tar.gz`);
  try {
    const archive = await opts.db.snapshot();
    await writeFile(archivePath, archive, { flag: "wx" });
    const fp = await drill(archivePath);
    const manifest = manifestFor(path.basename(archivePath), archive, opts.environment, now, fp);
    await writeFile(path.join(opts.dir, `${base}.json`), JSON.stringify(manifest, null, 2), { flag: "wx" });
    await prune(opts.dir, keep);
    Object.assign(status, { last_success_at: now.toISOString(), last_result: "ok", last_error: null });
    const rows = Object.values(fp.rowCounts).reduce((a, b) => a + b, 0);
    opts.log?.("auto_backup_ok", { environment: opts.environment, manifest: `${base}.json`, bytes: archive.byteLength, rows });
    return { ok: true, manifest: `${base}.json` };
  } catch (e) {
    const error = (e as Error).message.slice(0, 300);
    await rm(archivePath, { force: true });          // never leave an unverified archive behind
    Object.assign(status, { last_result: "failed", last_error: error });
    opts.log?.("auto_backup_failed", { environment: opts.environment, error });
    return { ok: false, error };
  } finally {
    await writeFile(path.join(opts.dir, "status.json"), JSON.stringify(status, null, 2));
  }
}

/** Keeps the newest `keep` verified backups; deletes older ones and any archive without a manifest. */
async function prune(dir: string, keep: number): Promise<void> {
  const verified = await listAutoBackups(dir);
  const keepArchives = new Set<string>();
  for (const b of verified.slice(0, keep)) {
    const m = JSON.parse(await readFile(path.join(dir, b.manifest), "utf8")) as BackupManifest;
    keepArchives.add(b.manifest).add(m.archive);
  }
  for (const name of await readdir(dir)) {
    if (NAME.test(name) && !keepArchives.has(name)) await rm(path.join(dir, name), { force: true });
  }
}

export interface AutoBackupSchedule {
  intervalHours: number;
  /** How often to check whether a backup is due (default hourly) and the delay before the first check. */
  checkEveryMs?: number;
  firstCheckAfterMs?: number;
}

/** Starts the schedule: a backup is taken whenever the newest verified one is older than the interval. */
export function startAutoBackup(opts: AutoBackupOptions & AutoBackupSchedule): { stop: () => void; runningNow: () => boolean } {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const newest = (await listAutoBackups(opts.dir))[0];
      const now = (opts.now ?? (() => new Date()))().getTime();
      if (!newest || now - Date.parse(newest.created_at) >= opts.intervalHours * 3_600_000) await runAutoBackup(opts);
    } catch (e) {
      opts.log?.("auto_backup_failed", { environment: opts.environment, error: (e as Error).message.slice(0, 300) });
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), opts.firstCheckAfterMs ?? 60_000);
  const every = setInterval(() => void tick(), opts.checkEveryMs ?? 3_600_000);
  first.unref(); every.unref();
  return { stop: () => { stopped = true; clearTimeout(first); clearInterval(every); }, runningNow: () => running };
}
