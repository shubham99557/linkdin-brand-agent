// P9-04: what the owner sees on the Backups page. Read-only: built from the automatic-backup folder (status.json
// and verified manifests) and the record written after each USB copy (`npm run backup:external`).
import { readFile } from "node:fs/promises";
import { listAutoBackups, readAutoStatus } from "./auto-backup.ts";

export interface BackupStatusConfig { dir: string; externalMarker: string; intervalHours: number; keep: number }

export interface ExternalCopyRecord { at: string; folder: string; separate_disk: string; databases: string[] }

export const USB_COPY_DUE_DAYS = 7;

export async function readExternalMarker(file: string): Promise<ExternalCopyRecord | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as ExternalCopyRecord;
  } catch {
    return null;
  }
}

export async function backupStatus(cfg: BackupStatusConfig | undefined, now = new Date()) {
  const warnings: string[] = [];
  const enabled = !!cfg && cfg.intervalHours > 0;
  const list = cfg ? await listAutoBackups(cfg.dir) : [];
  const status = cfg ? await readAutoStatus(cfg.dir) : null;
  const newest = list[0] ?? null;
  const hoursOld = newest ? (now.getTime() - Date.parse(newest.created_at)) / 3_600_000 : null;

  if (!enabled) warnings.push("Automatic backups are switched off for this server.");
  else {
    if (status?.last_result === "failed") {
      warnings.push(`The last automatic backup failed (${status.last_error ?? "unknown error"}). The server tries again within the hour; if this message stays, tell your developer.`);
    }
    if (!newest) warnings.push("No automatic backup yet. The first one is taken about a minute after the server starts.");
    else if (hoursOld! > cfg!.intervalHours * 2) warnings.push(`The newest automatic backup is ${Math.floor(hoursOld!)} hours old.`);
  }

  const ext = cfg ? await readExternalMarker(cfg.externalMarker) : null;
  const daysSince = ext ? Math.floor((now.getTime() - Date.parse(ext.at)) / 86_400_000) : null;
  if (!ext) warnings.push("No copy on a USB drive yet. Plug one in and run: npm run backup:external -- --to E:\\LBE-backups");
  else if (daysSince! >= USB_COPY_DUE_DAYS) warnings.push(`The last USB copy is ${daysSince} days old. Plug in the drive and run: npm run backup:external -- --to <drive>:\\LBE-backups`);

  return {
    automatic: {
      enabled, interval_hours: cfg?.intervalHours ?? 0, keep: cfg?.keep ?? 0, count: list.length,
      newest, last_attempt_at: status?.last_attempt_at ?? null, last_result: status?.last_result ?? null, last_error: status?.last_error ?? null,
    },
    external: ext ? { last_copy_at: ext.at, days_since: daysSince, separate_disk: ext.separate_disk, due_after_days: USB_COPY_DUE_DAYS } : null,
    warnings,
  };
}
