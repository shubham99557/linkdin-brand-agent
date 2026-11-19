// Standalone publisher worker (use instead of LBE_RUN_WORKER=true when running the API separately
// against PostgreSQL). With PGlite, run the worker in-process because PGlite allows one process only.
import { loadConfig } from "./config.ts";
import { runPublisherTick } from "./jobs/publisher.ts";
import { buildProvider, openConfiguredDb } from "./runtime.ts";

const cfg = loadConfig();
if (cfg.LBE_DATABASE_URL === "pglite") {
  console.error("The standalone worker needs PostgreSQL. With PGlite, keep LBE_RUN_WORKER=true on the API instead.");
  process.exit(1);
}
const db = await openConfiguredDb(cfg);
const provider = buildProvider(cfg, db);
const once = process.argv.includes("--once");

async function tick() {
  const s = await runPublisherTick(db, provider, { workerId: cfg.LBE_WORKER_ID });
  console.log(JSON.stringify({ at: new Date().toISOString(), msg: "publisher_tick", ...s }));
}

if (once) {
  await tick();
  await db.close();
} else {
  console.log(`Publisher worker ${cfg.LBE_WORKER_ID} polling every ${cfg.LBE_WORKER_INTERVAL_MS}ms (provider: ${provider.name})`);
  for (;;) {
    await tick().catch((e) => console.error(JSON.stringify({ msg: "publisher_tick_failed", error: (e as Error).message })));
    await new Promise((r) => setTimeout(r, cfg.LBE_WORKER_INTERVAL_MS));
  }
}
