import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { redactForLog } from "@lbe/security";
import { createApp } from "./app.ts";
import { startAutoBackup } from "./auto-backup.ts";
import { autoBackupDir, EXTERNAL_MARKER } from "./backup-paths.ts";
import { certificateInfo, type RuntimeState } from "./system-health.ts";
import { connectorKeyFile } from "./connector.ts";
import { assertSeparateDatabase, loadConfig, REPO_ROOT } from "./config.ts";
import { startAgentRunner } from "./jobs/agent-runner.ts";
import { runPublisherTick } from "./jobs/publisher.ts";
import { buildDrafter, buildLinkedIn, buildProvider, buildRegistry, buildSpecialists, openConfiguredDb, VOICE_DIR, WEB_DIST } from "./runtime.ts";

const cfg = loadConfig();
assertSeparateDatabase(cfg);                       // P9-03: development and staging never share a database folder
const db = await openConfiguredDb(cfg);
const provider = buildProvider(cfg, db);
const linkedin = buildLinkedIn(cfg, db);
const registry = buildRegistry(provider, linkedin);
const drafter = buildDrafter(cfg);
const tls = !!cfg.LBE_TLS_PFX;
const specialists = buildSpecialists(cfg);
const logLine = (msg: string, extra?: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...extra }));
// P9-04: automatic backups (embedded database only; a PostgreSQL server is backed up with pg_dump).
const backups = cfg.LBE_DATABASE_URL === "pglite" && cfg.LBE_AUTO_BACKUP_HOURS > 0
  ? { dir: autoBackupDir(cfg.LBE_ENV), externalMarker: EXTERNAL_MARKER, intervalHours: cfg.LBE_AUTO_BACKUP_HOURS, keep: cfg.LBE_AUTO_BACKUP_KEEP }
  : undefined;
// P9-05: what the System health page reports; the workers below update their heartbeats here.
const runtime: RuntimeState = {
  startedAt: new Date(), environment: cfg.LBE_ENV, livePublishing: cfg.liveEnabled,
  dataPath: cfg.LBE_DATABASE_URL === "pglite" ? cfg.pgliteDir : REPO_ROOT, repoRoot: REPO_ROOT,
  publisher: { enabled: cfg.LBE_RUN_WORKER, intervalMs: cfg.LBE_WORKER_INTERVAL_MS, lastTickAt: null, lastError: null },
  agentRunner: { enabled: cfg.LBE_RUN_AGENT_JOBS, intervalMs: cfg.LBE_AGENT_JOB_INTERVAL_MS, lastTickAt: null, busySince: null, lastError: null },
  // P9-03: the certificate this server serves (checked once at start; the passphrase stays in this process).
  ...(tls ? { tls: certificateInfo(readFileSync(path.resolve(REPO_ROOT, cfg.LBE_TLS_PFX!)), cfg.LBE_TLS_PFX_PASSPHRASE) } : {}),
};
const app = createApp({
  db, drafter, provider, linkedin, specialists,
  appOrigins: cfg.appOrigins,
  cookieSecure: cfg.LBE_COOKIE_SECURE || tls,
  voiceDir: VOICE_DIR,
  workerId: cfg.LBE_WORKER_ID,
  internalJobToken: cfg.LBE_INTERNAL_JOB_TOKEN,
  backups: backups ?? { dir: autoBackupDir(cfg.LBE_ENV), externalMarker: EXTERNAL_MARKER, intervalHours: 0, keep: cfg.LBE_AUTO_BACKUP_KEEP },
  runtime,
  environment: cfg.LBE_ENV,
  connector: {
    enabled: cfg.LBE_CONNECTOR === "on", environment: cfg.LBE_ENV, keyFile: connectorKeyFile(REPO_ROOT, cfg.LBE_ENV),
    baseUrl: `${tls ? "https" : "http"}://127.0.0.1:${cfg.LBE_PORT}`,
    ...(runtime.tls && "fingerprint256" in runtime.tls ? { certSha256: runtime.tls.fingerprint256 } : {}),
  },
});
if (backups) {
  startAutoBackup({ db, dir: backups.dir, environment: cfg.LBE_ENV, keep: backups.keep, intervalHours: backups.intervalHours, log: logLine });
}

// Serve the built dashboard (npm run build:web) from the same origin.
if (existsSync(path.join(WEB_DIST, "index.html"))) {
  const root = path.relative(process.cwd(), WEB_DIST);
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ root, path: "index.html" }));
}

if (cfg.LBE_RUN_WORKER) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const s = await runPublisherTick(db, registry, { workerId: cfg.LBE_WORKER_ID });
      runtime.publisher.lastError = s.errors.length ? `${s.errors.length} error(s) in the last round` : null;
      if (s.claimed || s.expired || s.credentialsExpired || s.errors.length) {
        console.log(JSON.stringify({ at: new Date().toISOString(), msg: "publisher_tick", ...s }));
      }
    } catch (err) {
      console.error(JSON.stringify({ at: new Date().toISOString(), msg: "publisher_tick_failed", error: redactForLog(err) }));
      runtime.publisher.lastError = redactForLog(err).slice(0, 200);
    } finally {
      running = false;
      runtime.publisher.lastTickAt = new Date();
    }
  }, cfg.LBE_WORKER_INTERVAL_MS);
}

if (cfg.LBE_RUN_AGENT_JOBS) {
  startAgentRunner({
    db, specialists, writer: drafter, voiceDir: VOICE_DIR, workerId: `${cfg.LBE_WORKER_ID}-agent`, intervalMs: cfg.LBE_AGENT_JOB_INTERVAL_MS,
    log: (msg, extra) => console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...extra })),
    onTick: (phase, error) => {
      if (phase === "start") runtime.agentRunner.busySince = new Date();
      else Object.assign(runtime.agentRunner, { busySince: null, lastTickAt: new Date(), lastError: error ?? null });
    },
  });
}

serve({
  fetch: app.fetch, hostname: cfg.LBE_HOST, port: cfg.LBE_PORT,
  ...(tls ? {
    createServer: createHttpsServer,
    serverOptions: { pfx: readFileSync(path.resolve(REPO_ROOT, cfg.LBE_TLS_PFX!)), passphrase: cfg.LBE_TLS_PFX_PASSPHRASE },
  } : {}),
}, (info) => {
  console.log(`LinkedIn Brand Engine API listening on ${tls ? "https" : "http"}://${info.address}:${info.port}`);
  console.log(`  database: ${cfg.LBE_DATABASE_URL === "pglite" ? `PGlite (${cfg.pgliteDir})` : "PostgreSQL"}`);
  console.log(`  drafter: ${drafter.provider} (${drafter.model}) | agents: ${specialists.research.provider} | mock publishing: on | LIVE LinkedIn publishing: ${cfg.liveEnabled ? "ON (staging)" : "off"}`);
  console.log(`  LinkedIn apps configured: ${linkedin ? Object.keys(linkedin.apps).filter((k) => linkedin.apps[k as "founder_app"]).join(", ") : "none"}`);
  console.log(`  in-process publisher worker: ${cfg.LBE_RUN_WORKER ? `every ${cfg.LBE_WORKER_INTERVAL_MS}ms` : "off"}`);
  console.log(`  agent job runner: ${cfg.LBE_RUN_AGENT_JOBS ? `every ${cfg.LBE_AGENT_JOB_INTERVAL_MS}ms` : "off (queued Branding Agent jobs will wait)"}`);
  console.log(`  Claude connector (read-only): ${cfg.LBE_CONNECTOR === "on" ? "ON - one tool, get_brand_brain" : "off"}`);
  console.log(`  automatic backups: ${backups ? `every ${backups.intervalHours} h, keep ${backups.keep}, in ${path.relative(REPO_ROOT, backups.dir)}` : "off"}`);
});
