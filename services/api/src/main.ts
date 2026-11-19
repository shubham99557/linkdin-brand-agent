import { existsSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { runPublisherTick } from "./jobs/publisher.ts";
import { buildDrafter, buildProvider, openConfiguredDb, VOICE_DIR, WEB_DIST } from "./runtime.ts";

const cfg = loadConfig();
const db = await openConfiguredDb(cfg);
const provider = buildProvider(cfg, db);
const drafter = buildDrafter(cfg);
const app = createApp({
  db, drafter, provider,
  appOrigins: cfg.appOrigins,
  cookieSecure: cfg.LBE_COOKIE_SECURE,
  voiceDir: VOICE_DIR,
  workerId: cfg.LBE_WORKER_ID,
  internalJobToken: cfg.LBE_INTERNAL_JOB_TOKEN,
});

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
      const s = await runPublisherTick(db, provider, { workerId: cfg.LBE_WORKER_ID });
      if (s.claimed || s.expired || s.errors.length) console.log(JSON.stringify({ at: new Date().toISOString(), msg: "publisher_tick", ...s }));
    } catch (err) {
      console.error(JSON.stringify({ msg: "publisher_tick_failed", error: (err as Error).message }));
    } finally {
      running = false;
    }
  }, cfg.LBE_WORKER_INTERVAL_MS);
}

serve({ fetch: app.fetch, hostname: cfg.LBE_HOST, port: cfg.LBE_PORT }, (info) => {
  console.log(`LinkedIn Brand Engine API listening on http://${info.address}:${info.port}`);
  console.log(`  database: ${cfg.LBE_DATABASE_URL === "pglite" ? `PGlite (${cfg.pgliteDir})` : "PostgreSQL"}`);
  console.log(`  drafter: ${drafter.provider} (${drafter.model}) | publishing: ${provider.name} (no external calls)`);
  console.log(`  in-process publisher worker: ${cfg.LBE_RUN_WORKER ? `every ${cfg.LBE_WORKER_INTERVAL_MS}ms` : "off"}`);
});
