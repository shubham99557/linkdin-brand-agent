// Restore a backup into a NEW, empty folder and verify it against the manifest. Never overwrites a database.
// Usage: npm run db:restore -- --manifest backups/<file>.json --target .data/restore-check
// To switch to the restored copy: stop the server, then point LBE_PGLITE_DIR at the target folder
// (or rename folders). Sessions and pending LinkedIn connections are cleared — everyone signs in again.
import path from "node:path";
import { parseArgs } from "node:util";
import { restorePglite } from "../backup.ts";
import { REPO_ROOT } from "../config.ts";

const { values } = parseArgs({ options: { manifest: { type: "string" }, target: { type: "string" } } });
if (!values.manifest || !values.target) {
  console.error("Usage: npm run db:restore -- --manifest backups/<file>.json --target <empty folder>");
  process.exit(1);
}
const target = path.resolve(REPO_ROOT, values.target);
if (!target.startsWith(path.join(REPO_ROOT, ".data") + path.sep)) {
  console.error("Restore targets must be inside .data/ (git-ignored).");
  process.exit(1);
}
try {
  const { fingerprint, sessionsPurged } = await restorePglite({ manifestPath: path.resolve(REPO_ROOT, values.manifest), targetDir: target });
  const rows = Object.values(fingerprint.rowCounts).reduce((a, b) => a + b, 0);
  console.log(`Restore verified: ${fingerprint.migrations.length} migrations, ${rows} rows match the backup. ${sessionsPurged} old session(s) cleared.`);
  console.log(`Restored database: ${path.relative(REPO_ROOT, target)}`);
} catch (e) {
  console.error(`Restore failed: ${(e as Error).message}`);
  process.exit(1);
}
