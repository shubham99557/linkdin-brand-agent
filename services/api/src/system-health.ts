// P9-05: health checks for running the system on this PC (owner decision D-13). Shown to admins on the System
// health page and as a banner when something needs attention. Read-only; every check says what to do.
import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import path from "node:path";
import tls from "node:tls";
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
  /** P9-03: the HTTPS certificate the server started with (staging); undefined when the server runs plain HTTP. */
  tls?: { validTo: Date; names: string } | { error: string };
}

/** P9-03: Windows disk encryption and who can read the secret files. */
export interface WindowsSecurity {
  /** Windows "BitLocker protection" of the drive with the data: 1 on, 2 off, 3 encrypting, 4 decrypting, 5 suspended, 6 on (locked); null unknown. */
  bitlocker: number | null;
  /** Secret files or folders that broad groups (Everyone, Users, Authenticated Users, Guests) may open. */
  broadAccess: string[];
}

/** Validity of a PFX certificate (P9-03). The server calls this once at start with its own settings. */
export function certificateInfo(pfx: Buffer, passphrase?: string): NonNullable<RuntimeState["tls"]> {
  try {
    const ctx = tls.createSecureContext({ pfx, passphrase });
    const socket = new tls.TLSSocket(null as never, { secureContext: ctx, isServer: true });
    const cert = socket.getCertificate() as tls.PeerCertificate | null;
    socket.destroy();
    if (!cert?.valid_to) return { error: "the file contains no certificate" };
    return { validTo: new Date(cert.valid_to), names: cert.subjectaltname || String(cert.subject?.CN ?? "?") };
  } catch (e) {
    return { error: (e as Error).message.slice(0, 200) };
  }
}

// Well-known SIDs (language-independent): Everyone, Authenticated Users, Users, Guests.
const PROBE = `$ErrorActionPreference = 'SilentlyContinue'
$b = (New-Object -ComObject Shell.Application).NameSpace($env:LBE_PROBE_DRIVE).Self.ExtendedProperty('System.Volume.BitLockerProtection')
$broad = @()
foreach ($p in ($env:LBE_PROBE_FILES -split '\\|')) {
  if ($p -and (Test-Path -LiteralPath $p)) {
    foreach ($a in (Get-Acl -LiteralPath $p).Access) {
      $sid = $a.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      if ($a.AccessControlType -eq 'Allow' -and @('S-1-1-0','S-1-5-11','S-1-5-32-545','S-1-5-32-546') -contains $sid) { $broad += "$p ($($a.IdentityReference.Value))" }
    }
  }
}
ConvertTo-Json -Compress @{ bitlocker = $b; broad = @($broad) }`;

let securityCache: { at: number; key: string; value: WindowsSecurity | null } | null = null;
/** Default probe (Windows only, no admin rights needed), cached for 10 minutes; null elsewhere or on failure. */
export async function probeWindowsSecurity(dataPath: string, secretPaths: string[]): Promise<WindowsSecurity | null> {
  if (process.platform !== "win32") return null;
  const drive = /^[A-Za-z]:/.exec(dataPath)?.[0];
  if (!drive) return null;
  const key = `${drive}|${secretPaths.join("|")}`;
  if (securityCache && securityCache.key === key && Date.now() - securityCache.at < 600_000) return securityCache.value;
  let value: WindowsSecurity | null = null;
  try {
    const out = (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PROBE], {
      windowsHide: true, timeout: 30_000, env: { ...process.env, LBE_PROBE_DRIVE: drive, LBE_PROBE_FILES: secretPaths.join("|") },
    })).stdout.trim();
    const j = JSON.parse(out) as { bitlocker: unknown; broad: unknown };
    const n = Number(j.bitlocker);
    value = { bitlocker: j.bitlocker === null || j.bitlocker === "" || !Number.isFinite(n) ? null : n,
      broadAccess: Array.isArray(j.broad) ? j.broad.map(String) : j.broad ? [String(j.broad)] : [] };
  } catch {
    value = null;
  }
  securityCache = { at: Date.now(), key, value };
  return value;
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
  windowsSecurity?: (dataPath: string, secretPaths: string[]) => Promise<WindowsSecurity | null>;
}

const BITLOCKER: Record<number, { status: CheckStatus; text: string }> = {
  1: { status: "ok", text: "BitLocker is on for this drive." },
  6: { status: "ok", text: "BitLocker is on for this drive." },
  3: { status: "info", text: "BitLocker is encrypting this drive (in progress)." },
  2: { status: "warn", text: "This drive is not encrypted (BitLocker off). If the PC is stolen, the database and the secret files can be read from the disk." },
  4: { status: "warn", text: "BitLocker is being turned off for this drive." },
  5: { status: "warn", text: "BitLocker is suspended for this drive." },
};
const BITLOCKER_ACTION = "Turn on BitLocker for drive C: (Start → \"Manage BitLocker\" → Turn on BitLocker) and keep the recovery key somewhere safe, away from the PC. See docs/owner-action-checklist.md → OA-11.";

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

    // P9-03: who can open the secret files, and whether the disk is encrypted (Windows).
    const secretPaths = [".env", ".env.staging", "secrets"].map((p) => path.join(rt.repoRoot, p));
    const sec = await (opts.windowsSecurity ?? probeWindowsSecurity)(rt.dataPath, secretPaths);
    if (sec) {
      checks.push(sec.broadAccess.length
        ? { id: "secret_access", label: "Secret file access", status: "bad", detail: `Other users of this PC can open: ${sec.broadAccess.join(", ")}.`,
            action: "Tell your developer: the access rights of these files must be limited to your Windows account." }
        : { id: "secret_access", label: "Secret file access", status: "ok", detail: "Only your Windows account (and administrators) can open the settings and key files." });
      const b = sec.bitlocker === null ? undefined : BITLOCKER[sec.bitlocker];
      checks.push(b
        ? { id: "encryption", label: "Disk encryption", status: b.status, detail: b.text, ...(b.status === "warn" ? { action: BITLOCKER_ACTION } : {}) }
        : { id: "encryption", label: "Disk encryption", status: "info", detail: "Could not read the BitLocker status of this drive." });
    }
    if (rt.tls) {
      if ("error" in rt.tls) {
        checks.push({ id: "certificate", label: "HTTPS certificate", status: "bad", detail: `The certificate could not be read (${rt.tls.error}).`,
          action: "Run npm run staging:renew-cert, then restart the server." });
      } else {
        const days = Math.floor((rt.tls.validTo.getTime() - now.getTime()) / 86_400_000);
        const status: CheckStatus = days < 0 ? "bad" : days < 30 ? "warn" : "ok";
        checks.push({ id: "certificate", label: "HTTPS certificate", status,
          detail: days < 0 ? `Expired on ${rt.tls.validTo.toISOString().slice(0, 10)}: browsers refuse the dashboard.` : `Valid until ${rt.tls.validTo.toISOString().slice(0, 10)} (${days} days) for ${rt.tls.names}.`,
          ...(status !== "ok" ? { action: "Run npm run staging:renew-cert, then restart the server." } : {}) });
      }
    }
    checks.push({ id: "uptime", label: "Server", status: "info", detail: `${rt.environment} server running since ${rt.startedAt.toISOString()}.` });
  }

  const overall = checks.reduce<CheckStatus>((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), "ok");
  return { overall, checked_at: now.toISOString(), checks };
}
