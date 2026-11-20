// P0-07: copy the code and databases to a separate device (USB drive) and prove the copy restores.
// Usage (the server may keep running: its newest automatic backup is used, P9-04):
//   npm run backup:external -- --to E:\LBE-backups
//   npm run backup:verify -- --set E:\LBE-backups\lbe-backup-<date>
// --same-disk-ok allows a folder on the same physical disk (protects against accidental deletion only).
import path from "node:path";
import { parseArgs } from "node:util";
import { BackupRefused, createExternalBackup, verifyExternalBackup } from "../external-backup.ts";
import { REPO_ROOT } from "../config.ts";

const { values } = parseArgs({ options: { to: { type: "string" }, set: { type: "string" }, "same-disk-ok": { type: "boolean" } } });

try {
  if (values.set) {
    const { set, problems } = await verifyExternalBackup(path.resolve(values.set));
    if (problems.length) {
      console.error(`Backup check FAILED for ${values.set}:\n  - ${problems.join("\n  - ")}`);
      process.exit(1);
    }
    console.log(`Backup check passed: ${set.files.length} files match their checksums; the code (commit ${set.git.head.slice(0, 7)}) `
      + `and ${set.databases.length} database(s) were restored into a temporary folder and match.`);
  } else if (values.to) {
    const { setDir, set, warnings } = await createExternalBackup({ repoRoot: REPO_ROOT, dest: values.to, allowSameDisk: values["same-disk-ok"] });
    console.log(`Backup written and verified: ${setDir}`);
    console.log(`  code: ${set.git.commits} commits, latest ${set.git.head.slice(0, 7)} (${set.git.branch})`);
    for (const d of set.databases) console.log(`  ${d.environment} database: ${d.rows} rows, ${d.migrations} migrations (${d.source})`);
    for (const s of set.skipped) console.log(`  skipped: ${s}`);
    for (const w of warnings) console.log(`  WARNING: ${w}`);
    console.log("Secrets (.env files, secrets\\) are not copied. Unplug the drive and keep it somewhere safe.");
  } else {
    console.error("Usage: npm run backup:external -- --to E:\\LBE-backups   |   npm run backup:verify -- --set <backup folder>");
    process.exit(1);
  }
} catch (e) {
  console.error(e instanceof BackupRefused ? `Backup not made: ${e.message}` : `Backup failed: ${(e as Error).message}`);
  process.exit(1);
}
