// Runs the real-PostgreSQL concurrency suite (tests/pg) against a temporary, isolated PostgreSQL 18.6 server
// (embedded-postgres dev dependency): 127.0.0.1 only, random port, random password, throwaway data folder that
// is deleted afterwards. No Docker, no admin rights. Usage: npm run test:pg:embedded
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

const root = path.resolve(import.meta.dirname, "..");
const dir = await mkdtemp(path.join(tmpdir(), "lbe-pg-"));
const port = await freePort();
const password = randomBytes(18).toString("base64url");
const logs: string[] = [];
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, "data"), port, user: "postgres", password, authMethod: "scram-sha-256", persistent: false,
  // UTF-8 like production PostgreSQL/Supabase (the Windows default would be WIN1252).
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "max_connections=50"],
  onLog: (m) => logs.push(String(m)), onError: (e) => logs.push(`ERR ${String(e)}`),
});

let code = 1;
try {
  await pg.initialise();
  await pg.start();
  const version = await (async () => {
    const c = pg.getPgClient("postgres", "127.0.0.1");
    await c.connect();
    const r = await c.query("select version() as v");
    await c.end();
    return (r.rows[0] as { v: string }).v;
  })();
  console.log(`Temporary PostgreSQL started on 127.0.0.1:${port} — ${version}`);
  // Connection URL for the temporary server (random per-run password, never stored).
  const url = new URL(`postgres://127.0.0.1:${port}/postgres`);
  url.username = "postgres";
  url.password = password;
  code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "node_modules", "vitest", "vitest.mjs"), "run", "tests/pg", "--reporter=verbose"], {
      cwd: root, stdio: "inherit",
      env: { ...process.env, LBE_TEST_PG_URL: url.toString() },
    });
    child.on("exit", (c) => resolve(c ?? 1));
  });
} catch (err) {
  console.error(`Could not run the PostgreSQL suite: ${(err as Error).message}`);
  console.error(logs.slice(-20).join("\n"));
} finally {
  await pg.stop().catch(() => undefined);           // persistent:false → deletes the cluster files
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log("Temporary PostgreSQL stopped and its data folder deleted.");
}
process.exitCode = code;
