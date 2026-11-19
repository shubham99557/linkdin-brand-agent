import { loadConfig } from "../config.ts";
import { migrate, openDb } from "../db.ts";

const cfg = loadConfig();
const db = await openDb({ url: cfg.LBE_DATABASE_URL, dataDir: cfg.LBE_DATABASE_URL === "pglite" ? cfg.pgliteDir : undefined });
const ran = await migrate(db);
console.log(ran.length ? `Applied migrations:\n  ${ran.join("\n  ")}` : "Database is up to date.");
await db.close();
