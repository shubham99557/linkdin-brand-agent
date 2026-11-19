// Isolated server for browser tests: in-memory PGlite, synthetic seed, fixed test passwords,
// mock drafter + mock provider, and a LOCAL FAKE LinkedIn for the live path. No background worker
// (tests trigger the publisher explicitly). Never contacts LinkedIn.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { MockDrafter } from "@lbe/drafting";
import { LinkedInProvider, MockLinkedInProvider } from "@lbe/publishing";
import { createApp } from "../../services/api/src/app.ts";
import { migrate, openDb } from "../../services/api/src/db.ts";
import { dbMockStore, dbTokenSource } from "../../services/api/src/jobs/publisher.ts";
import { startAgentRunner } from "../../services/api/src/jobs/agent-runner.ts";
import { mockSpecialists } from "@lbe/agents";
import { seed } from "../../services/api/src/seed.ts";
import { TEST_PASSWORDS } from "../helpers/db.ts";
import { startFakeLinkedIn } from "../helpers/fake-linkedin.ts";

const PORT = 8788;
const root = path.resolve(import.meta.dirname, "../..");
const db = await openDb({ url: "pglite" });
await migrate(db);
await seed(db, TEST_PASSWORDS);
const fake = await startFakeLinkedIn();
const tokenKey = randomBytes(32);
const endpoints = { authBase: fake.base, apiBase: fake.base, allowedHosts: ["127.0.0.1"] };
const app = createApp({
  db,
  drafter: new MockDrafter(),
  provider: new MockLinkedInProvider(dbMockStore(db)),
  linkedin: {
    liveEnabled: true,
    apps: { founder_app: { clientId: "e2e-founder", clientSecret: "e2e-secret" } },
    redirectUri: `http://127.0.0.1:${PORT}/api/oauth/linkedin/callback`,   // test only; real config requires https
    tokenKey,
    tokenKeyId: "e2e",
    oauth: endpoints,
    liveProvider: new LinkedInProvider({ getAccessToken: dbTokenSource(db, "e2e", tokenKey), ...endpoints }),
  },
  appOrigins: [`http://127.0.0.1:${PORT}`],
  cookieSecure: false,
  voiceDir: path.join(root, "brand", "voice"),
  workerId: "e2e",
  log: () => undefined,
});
// Agent jobs run in the background, as in the real server (fast interval for tests).
startAgentRunner({ db, specialists: mockSpecialists(), writer: new MockDrafter(), voiceDir: path.join(root, "brand", "voice"),
  workerId: "e2e-agent", intervalMs: 300 });
// Lets tests assert what the fake LinkedIn received.
app.get("/__fake/posts", (c) => c.json(fake.posts));
const dist = path.relative(process.cwd(), path.join(root, "apps", "web", "dist"));
app.use("/*", serveStatic({ root: dist }));
app.get("*", serveStatic({ root: dist, path: "index.html" }));
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: PORT }, () => console.log(`e2e server on ${PORT} (fake LinkedIn ${fake.base})`));
