// Back up the configured embedded database. Stop the server first (PGlite must not be open twice).
// Usage: npm run db:backup            (development, .env)
//        npm run db:backup:staging    (staging, .env.staging)
// Writes backups/lbe-<env>-<timestamp>.tar.gz + .json manifest (git-ignored; contains business data).
import { connect } from "node:net";
import path from "node:path";
import { backupPglite } from "../backup.ts";
import { loadConfig, REPO_ROOT } from "../config.ts";

const cfg = loadConfig();
if (cfg.LBE_DATABASE_URL !== "pglite") {
  console.error("This database is PostgreSQL: use pg_dump (see docs/migrations-runbook.md → Backups).");
  process.exit(1);
}
if (await portInUse(cfg.LBE_PORT)) {
  console.error(`Something is listening on port ${cfg.LBE_PORT} — stop the server (Ctrl+C) before backing up.`);
  process.exit(1);
}
const { manifestPath, manifest } = await backupPglite({ dataDir: cfg.pgliteDir, outDir: path.join(REPO_ROOT, "backups"), environment: cfg.LBE_ENV });
const rows = Object.values(manifest.fingerprint.rowCounts).reduce((a, b) => a + b, 0);
console.log(`Backup written: ${path.relative(REPO_ROOT, manifestPath)} (${manifest.archive_bytes} bytes, ${manifest.fingerprint.migrations.length} migrations, ${rows} rows)`);
console.log("It contains business data and password hashes — keep it private. Test it with: npm run db:restore -- --manifest <file> --target .data/restore-check");

export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
}
