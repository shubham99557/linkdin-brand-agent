// Isolated server for browser tests: in-memory PGlite, synthetic seed, fixed test passwords,
// mock drafter + mock provider, no background worker (tests trigger the publisher explicitly).
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { MockDrafter } from "@lbe/drafting";
import { MockLinkedInProvider } from "@lbe/publishing";
import { createApp } from "../../services/api/src/app.ts";
import { migrate, openDb } from "../../services/api/src/db.ts";
import { dbMockStore } from "../../services/api/src/jobs/publisher.ts";
import { seed } from "../../services/api/src/seed.ts";
import { TEST_PASSWORDS } from "../helpers/db.ts";

const PORT = 8788;
const root = path.resolve(import.meta.dirname, "../..");
const db = await openDb({ url: "pglite" });
await migrate(db);
await seed(db, TEST_PASSWORDS);
const app = createApp({
  db,
  drafter: new MockDrafter(),
  provider: new MockLinkedInProvider(dbMockStore(db)),
  appOrigins: [`http://127.0.0.1:${PORT}`],
  cookieSecure: false,
  voiceDir: path.join(root, "brand", "voice"),
  workerId: "e2e",
  log: () => undefined,
});
const dist = path.relative(process.cwd(), path.join(root, "apps", "web", "dist"));
app.use("/*", serveStatic({ root: dist }));
app.get("*", serveStatic({ root: dist, path: "index.html" }));
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: PORT }, () => console.log(`e2e server on ${PORT}`));
