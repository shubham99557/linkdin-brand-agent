// P9-05: health checks for running the system on this PC (owner decision D-13). Shown to admins on the System
// health page and as a banner when something needs attention. Read-only; every check says what to do.
import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { promisify } from "node:util";
import { backupStatus, type BackupStatusConfig } from "./backup-status.ts";
import type { Queryable } from "./db.ts";

const run = promisify(execFile);

/** What the running server knows about itself; updated by main.ts (heartbeats). */
export interface RuntimeState {
  startedAt: Date;
  environment: string;
  livePublishing: boolean;
  /** Folder whose drive holds the database and backups (free-space check). */
  dataPath: string;
  repoRoot: string;
  publisher: { enabled: boolean; intervalMs: number; lastTickAt: Date | null; lastError: string | null };
  agentRunner: { enabled: boolean; intervalMs: number; lastTickAt: Date | null; busySince: Date | null; lastError: string | null };
}

export type CheckStatus = "ok" | "info" | "warn" | "bad";
export interface HealthCheck { id: string; label: string; status: CheckStatus; detail: string; action?: string }

export interface HealthOptions {
  db: Queryable;
  runtime?: RuntimeState;
  backups?: BackupStatusConfig;
  now?: Date;
  /** Injectable for tests. */
  freeBytes?: (p: string) => Promise<number | null>;
  trackedSecrets?: (repoRoot: string) => Promise<string[] | null>;
}

const GB = 1024 ** 3;
const RANK: Record<CheckStatus, number> = { ok: 0, info: 0, warn: 1, bad: 2 };
const minutes = (ms: number) => Math.round(ms / 60_000);

async function defaultFreeBytes(p: string): Promise<number | null> {
  try {
    const s = await statfs(p);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

let secretsCache: { at: number; repoRoot: string; files: string[] | null } | null = null;
/** Secret files that Git tracks (should be none). Cached for 10 minutes; null when Git cannot be asked. */
async function defaultTrackedSecrets(repoRoot: string): Promise<string[] | null> {
  if (secretsCache && secretsCache.repoRoot === repoRoot && Date.now() - secretsCache.at < 600_000) return secretsCache.files;
  let files: string[] | null;
  try {
    const out = (await run("git", ["ls-files", "--", ".env", ".env.*", "secrets", "*.pem", "*.key", "*.pfx"], { cwd: repoRoot, windowsHide: true })).stdout;
    files = out.split(/\r?\n/).filter((f) => f && f !== ".env.example");
  } catch {
    files = null;
  }
  secretsCache = { at: Date.now(), repoRoot, files };
  return files;
}

function workerCheck(id: string, label: string, w: RuntimeState["publisher"] & { busySince?: Date | null }, now: Date, startedAt: Date,
                     offMessage: { status: CheckStatus; detail: string; action?: string }): HealthCheck {
  if (!w.enabled) return { id, label, ...offMessage };
  const stale = Math.max(5 * w.intervalMs, 120_000);
  if (w.busySince && now.getTime() - w.busySince.getTime() > 3_600_000) {
    return { id, label, status: "warn", detail: `A job has been running for ${minutes(now.getTime() - w.busySince.getTime())} minutes.`,
      action: "Open Agent workspace → In progress. Long runs are normal for large campaigns; cancel it if it looks stuck." };
  }
  const last = w.lastTickAt ?? (now.getTime() - startedAt.getTime() > stale ? null : startedAt);
  if (!w.busySince && (!last || now.getTime() - last.getTime() > stale)) {
    return { id, label, status: "bad", detail: `No activity for ${last ? minutes(now.getTime() - last.getTime()) : minutes(now.getTime() - startedAt.getTime())} minutes.`,
      action: "Restart the server (Ctrl+C in its window, then start it again). If it happens again, tell your developer." };
  }
  if (w.lastError) return { id, label, status: "warn", detail: `Running; the last round reported an error: ${w.lastError}`, action: "If this stays, tell your developer the time shown." };
  return { id, label, status: "ok", detail: `Running (checked ${w.lastTickAt ? `${Math.max(0, Math.round((now.getTime() - w.lastTickAt.getTime()) / 1000))} s ago` : "since start"}).` };
}

export async function systemHealth(opts: HealthOptions): Promise<{ overall: CheckStatus; checked_at: string; checks: HealthCheck[] }> {
  const now = opts.now ?? new Date();
  const rt = opts.runtime;
  const checks: HealthCheck[] = [];

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([opts.db.query("select 1"),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("no answer within 5 s")), 5_000); })]);
    checks.push({ id: "database", label: "Database", status: "ok", detail: "Answering." });
  } catch (e) {
    checks.push({ id: "database", label: "Database", status: "bad", detail: `Not answering (${(e as Error).message}).`,
      action: "Restart the server. If it still fails, see docs/incident-runbook.md → Database damaged." });
  } finally {
    clearTimeout(timer);
  }

  if (rt) {
    const free = await (opts.freeBytes ?? defaultFreeBytes)(rt.dataPath);
    if (free === null) checks.push({ id: "disk", label: "Disk space", status: "info", detail: "Could not read free space." });
    else {
      const gb = free / GB;
      const status: CheckStatus = gb < 1 ? "bad" : gb < 5 ? "warn" : "ok";
      checks.push({ id: "disk", label: "Disk space", status, detail: `${gb.toFixed(1)} GB free on the drive with the database and backups.`,
        ...(status !== "ok" ? { action: "Free up space (empty the Recycle Bin, remove large downloads). The database stops working when the disk is full." } : {}) });
    }
  }

  const b = await backupStatus(opts.backups, now);
  const failed = b.automatic.enabled && b.automatic.last_result === "failed";
  checks.push({ id: "backups", label: "Backups", status: failed ? "bad" : b.warnings.length ? "warn" : "ok",
    detail: b.warnings.length ? b.warnings.join(" ") : `Newest automatic backup ${b.automatic.newest?.created_at ?? "—"}; last USB copy ${b.external?.last_copy_at ?? "—"}.`,
    ...(b.warnings.length ? { action: "Open the Backups page for details." } : {}) });

  if (rt) {
    checks.push(workerCheck("publisher", "Publishing worker", rt.publisher, now, rt.startedAt,
      { status: "info", detail: "Off on this server: approved posts are released by an admin with \"Run publisher now\" (pilot setting)." }));
    checks.push(workerCheck("agent_runner", "Branding Agent runner", rt.agentRunner, now, rt.startedAt,
      { status: "warn", detail: "Off: queued Branding Agent jobs will wait.", action: "Set LBE_RUN_AGENT_JOBS=true in the settings file and restart." }));
    checks.push({ id: "live", label: "Live LinkedIn publishing", status: "info",
      detail: rt.livePublishing ? "ON (staging pilot): every live post still needs an approver and a release click." : "Off: posts go to the mock provider only." });
    const tracked = await (opts.trackedSecrets ?? defaultTrackedSecrets)(rt.repoRoot);
    if (tracked === null) checks.push({ id: "secrets", label: "Secret files", status: "info", detail: "Could not ask Git whether secret files are tracked." });
    else if (tracked.length) {
      checks.push({ id: "secrets", label: "Secret files", status: "bad", detail: `Git tracks secret files: ${tracked.join(", ")}.`,
        action: "Tell your developer now: these files must be removed from Git and their keys replaced (docs/incident-runbook.md → Secret exposed)." });
    } else checks.push({ id: "secrets", label: "Secret files", status: "ok", detail: "Settings and key files are kept out of Git and out of backups." });
    checks.push({ id: "uptime", label: "Server", status: "info", detail: `${rt.environment} server running since ${rt.startedAt.toISOString()}.` });
  }

  const overall = checks.reduce<CheckStatus>((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), "ok");
  return { overall, checked_at: now.toISOString(), checks };
}
