// P0-07 (owner decision D-13, 2026-11-20: code and data stay on this PC; no cloud repository).
// A backup only protects against disk failure, theft or ransomware if it is on a SEPARATE physical device (a USB
// drive, another computer's shared folder). One command copies, into a new dated folder on that device:
//   * code.bundle: the whole Git repository with its full history (committed work only);
//   * databases/: a backup of each embedded database (development, staging), using the P1-01 format;
//   * backup-set.json: what was copied, with a SHA-256 checksum of every file;
//   * READ-ME-restore.txt: plain-English restore steps.
// Then it proves the copy works by restoring it into a temporary folder: cloning the bundle (same latest commit)
// and restoring every database (same migrations and row counts). Secrets (.env files, secrets/) are NOT copied.
//
// Refusals: a destination on the same physical disk as the project (unless explicitly allowed), a destination
// inside the project folder, and a running server (an open embedded database must not be copied).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv, promisify } from "node:util";
import { backupPglite, restorePglite, type BackupManifest } from "./backup.ts";

const run = promisify(execFile);

/** The backup cannot be made as asked; the message says what to do instead. */
export class BackupRefused extends Error {}

export interface BackupSet {
  format: "lbe-backup-set/1";
  created_at: string;
  separate_disk: "yes" | "no (allowed by the owner)" | "unknown";
  git: { head: string; branch: string; commits: number; uncommitted_changes: boolean };
  databases: Array<{ environment: string; manifest: string; migrations: number; rows: number }>;
  skipped: string[];
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

export interface ExternalBackupOptions {
  repoRoot: string;
  /** Folder on the separate device, e.g. E:\LBE-backups. A new dated folder is created inside it. */
  dest: string;
  /** Allow a destination on the same physical disk (only protects against accidental deletion). */
  allowSameDisk?: boolean;
  now?: Date;
  /** Which settings files describe databases to back up (default: .env and .env.staging, if present). */
  envFiles?: string[];
  /** Injectable for tests. */
  diskOf?: (p: string) => Promise<string | null>;
  portInUse?: (port: number) => Promise<boolean>;
  /** For tests: runs after the files are written and before the restore check (e.g. to simulate a faulty drive). */
  onWritten?: (setDir: string) => Promise<void>;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Identifies the physical disk holding `p` (Windows: disk number; elsewhere: device id); null if unknown. */
export async function physicalDiskOf(p: string): Promise<string | null> {
  const full = path.resolve(p);
  try {
    if (process.platform === "win32") {
      if (full.startsWith("\\\\")) return `network:${full.split("\\")[2]?.toLowerCase()}`;   // another computer
      const letter = /^([A-Za-z]):/.exec(full)?.[1];
      if (!letter) return null;
      const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-Partition -DriveLetter ${letter} -ErrorAction Stop).DiskNumber`], { windowsHide: true, timeout: 20_000 });
      const n = out.stdout.trim();
      return /^\d+$/.test(n) ? `disk:${n}` : null;
    }
    let dir = full;
    while (!existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    return `dev:${(await stat(dir)).dev}`;
  } catch {
    return null;
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
}

interface DbTarget { environment: string; dataDir: string; port: number }

/** Reads database settings from the env files without loading them into this process. */
function databasesToBackUp(repoRoot: string, envFiles: string[], skipped: string[]): DbTarget[] {
  const out: DbTarget[] = [];
  for (const file of envFiles) {
    const full = path.join(repoRoot, file);
    if (!existsSync(full)) continue;
    const env = parseEnv(readFileSync(full, "utf8"));
    const environment = env.LBE_ENV || (file === ".env" ? "development" : file.replace(/^\.env\./, ""));
    if ((env.LBE_DATABASE_URL || "pglite") !== "pglite") {
      skipped.push(`${environment}: uses a PostgreSQL server; back it up with pg_dump (docs/migrations-runbook.md)`);
      continue;
    }
    const dataDir = path.resolve(repoRoot, env.LBE_PGLITE_DIR || ".data/pglite");
    if (!existsSync(dataDir)) { skipped.push(`${environment}: no database yet`); continue; }
    out.push({ environment, dataDir, port: Number(env.LBE_PORT || 8787) });
  }
  return out;
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

/** Restores the set into a temporary folder: clone the code bundle, restore every database. Returns problems. */
async function proveRestore(setDir: string, set: Pick<BackupSet, "git" | "databases">): Promise<string[]> {
  const problems: string[] = [];
  const tmp = await mkdtemp(path.join(tmpdir(), "lbe-restore-check-"));
  try {
    const clone = path.join(tmp, "code");
    try {
      await run("git", ["clone", "--quiet", path.join(setDir, "code.bundle"), clone], { windowsHide: true });
      const head = await git(clone, "rev-parse", "HEAD");
      if (head !== set.git.head) problems.push(`code: restored latest commit ${head.slice(0, 7)} differs from ${set.git.head.slice(0, 7)}`);
    } catch (e) {
      problems.push(`code: the bundle could not be restored (${(e as Error).message.split("\n")[0]})`);
    }
    for (const d of set.databases) {
      try {
        await restorePglite({ manifestPath: path.join(setDir, "databases", d.manifest), targetDir: path.join(tmp, `db-${d.environment}`) });
      } catch (e) {
        problems.push(`${d.environment} database: ${(e as Error).message}`);
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return problems;
}

const RESTORE_HELP = (set: BackupSet) => `ActTrident LinkedIn Brand Engine - backup made ${set.created_at}

WHAT IS HERE
  code.bundle        the program code with its full history (latest commit ${set.git.head.slice(0, 7)})
  databases\\         ${set.databases.map((d) => `${d.environment} database (${d.rows} rows)`).join(", ") || "no databases"}
  backup-set.json    list of files with checksums

NOT INCLUDED (on purpose): passwords, API keys and LinkedIn app secrets (.env, .env.staging, secrets\\).
After restoring on a new PC, enter them again (docs\\owner-action-checklist.md) and reconnect LinkedIn.
Everyone signs in again after a restore.

CHECK THIS BACKUP (from the project folder):
  npm run backup:verify -- --set "<this folder>"

RESTORE ON A NEW PC (install Git and Node.js first):
  git clone "<this folder>\\code.bundle" linkdin-brand-engine
  cd linkdin-brand-engine
  npm ci
  npm run db:restore -- --manifest "<this folder>\\databases\\<file>.json" --target .data\\staging
  (use --target .data\\pglite for the development database)

Keep this drive unplugged and somewhere safe. Turn on BitLocker for it (right-click the drive in
File Explorer > Turn on BitLocker): it contains business data and password hashes.
`;

/** Makes a verified backup set in a new dated folder inside `opts.dest`. */
export async function createExternalBackup(opts: ExternalBackupOptions): Promise<{ setDir: string; set: BackupSet; warnings: string[] }> {
  const repoRoot = path.resolve(opts.repoRoot);
  const dest = path.resolve(opts.dest);
  const diskOf = opts.diskOf ?? physicalDiskOf;
  const portInUse = opts.portInUse ?? portOpen;
  const warnings: string[] = [];

  if (isInside(dest, repoRoot)) throw new BackupRefused("The backup folder is inside the project folder. Choose a folder on a USB drive or another computer.");
  const [repoDisk, destDisk] = await Promise.all([diskOf(repoRoot), diskOf(dest)]);
  let separate: BackupSet["separate_disk"] = "unknown";
  if (repoDisk && destDisk) {
    if (repoDisk !== destDisk) separate = "yes";
    else if (!opts.allowSameDisk) {
      throw new BackupRefused(`${dest} is on the same physical disk as the project (${repoDisk}), so this copy would be lost with the disk. `
        + "Plug in a USB drive and use its drive letter (for example E:\\LBE-backups).");
    } else {
      separate = "no (allowed by the owner)";
      warnings.push("This copy is on the same physical disk as the project: it protects against accidental deletion only.");
    }
  } else {
    warnings.push("Could not confirm that the backup folder is on a separate disk. Make sure it is a USB drive or another computer.");
  }

  const skipped: string[] = [];
  const dbs = databasesToBackUp(repoRoot, opts.envFiles ?? [".env", ".env.staging"], skipped);
  const running = [];
  for (const d of dbs) if (await portInUse(d.port)) running.push(`${d.environment} (port ${d.port})`);
  if (running.length) {
    throw new BackupRefused(`Stop the server first (Ctrl+C in its window), then run the backup again: ${running.join(", ")}. `
      + "An open database cannot be copied safely.");
  }

  const now = opts.now ?? new Date();
  const setDir = path.join(dest, `lbe-backup-${now.toISOString().replace(/[:.]/g, "-")}`);
  if (existsSync(setDir)) throw new BackupRefused(`${setDir} already exists`);
  await mkdir(setDir, { recursive: true });

  const head = await git(repoRoot, "rev-parse", "HEAD");
  const branch = await git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD");
  const commits = Number(await git(repoRoot, "rev-list", "--all", "--count"));
  const uncommitted = (await git(repoRoot, "status", "--porcelain")) !== "";
  if (uncommitted) warnings.push("Some changes are not committed yet, so they are not in this backup (only committed work is copied).");
  await git(repoRoot, "bundle", "create", path.join(setDir, "code.bundle"), "--all");

  const databases: BackupSet["databases"] = [];
  for (const d of dbs) {
    const { manifestPath, manifest } = await backupPglite({ dataDir: d.dataDir, outDir: path.join(setDir, "databases"), environment: d.environment, now });
    databases.push({ environment: d.environment, manifest: path.basename(manifestPath), migrations: manifest.fingerprint.migrations.length,
      rows: Object.values(manifest.fingerprint.rowCounts).reduce((a, b) => a + b, 0) });
  }

  const gitInfo = { head, branch, commits, uncommitted_changes: uncommitted };
  await opts.onWritten?.(setDir);
  const problems = await proveRestore(setDir, { git: gitInfo, databases });
  if (problems.length) throw new Error(`The backup was written to ${setDir} but could not be restored: ${problems.join("; ")}`);

  const files: BackupSet["files"] = [];
  for (const rel of await listFiles(setDir)) {
    const bytes = await readFile(path.join(setDir, rel));
    files.push({ path: rel, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  const set: BackupSet = { format: "lbe-backup-set/1", created_at: now.toISOString(), separate_disk: separate, git: gitInfo, databases, skipped, files };
  await writeFile(path.join(setDir, "backup-set.json"), JSON.stringify(set, null, 2), { flag: "wx" });
  await writeFile(path.join(setDir, "READ-ME-restore.txt"), RESTORE_HELP(set).replace(/\n/g, "\r\n"), { flag: "wx" });
  return { setDir, set, warnings };
}

/** Checks an existing backup set: every checksum, then a full restore into a temporary folder. */
export async function verifyExternalBackup(setDir: string): Promise<{ set: BackupSet; problems: string[] }> {
  const set = JSON.parse(await readFile(path.join(setDir, "backup-set.json"), "utf8")) as BackupSet;
  if (set.format !== "lbe-backup-set/1") throw new Error("not a backup set (unknown format)");
  const problems: string[] = [];
  for (const f of set.files) {
    if (f.path.split("/").includes("..") || path.isAbsolute(f.path)) { problems.push(`${f.path}: invalid path`); continue; }
    const full = path.join(setDir, ...f.path.split("/"));
    if (!existsSync(full)) { problems.push(`${f.path}: missing`); continue; }
    if (sha256(await readFile(full)) !== f.sha256) problems.push(`${f.path}: changed or damaged (checksum differs)`);
  }
  for (const d of set.databases) {
    const m = JSON.parse(await readFile(path.join(setDir, "databases", d.manifest), "utf8")) as BackupManifest;
    if (m.environment !== d.environment) problems.push(`${d.manifest}: environment differs`);
  }
  if (!problems.length) problems.push(...await proveRestore(setDir, set));
  return { set, problems };
}
