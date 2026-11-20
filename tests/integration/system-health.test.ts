// P9-05: System health checks for running on this PC (disk, database, backups, workers, secrets), the overall
// verdict that drives the admin banner, and admin-only access.
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockDrafter } from "@lbe/drafting";
import { MockLinkedInProvider } from "@lbe/publishing";
import { createApp } from "../../services/api/src/app.ts";
import { assertSeparateDatabase, REPO_ROOT } from "../../services/api/src/config.ts";
import { dbMockStore } from "../../services/api/src/jobs/publisher.ts";
import { certificateInfo, probeWindowsSecurity, systemHealth, type RuntimeState } from "../../services/api/src/system-health.ts";
import { freshDb, TEST_PASSWORDS, type TestDb } from "../helpers/db.ts";

const NOW = new Date("2026-11-20T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const GB = 1024 ** 3;
let t: TestDb;
let work: string;
let backups: { dir: string; externalMarker: string; intervalHours: number; keep: number };

const runtime = (over: Partial<RuntimeState> = {}): RuntimeState => ({
  startedAt: ago(3_600_000), environment: "staging", livePublishing: false, dataPath: work, repoRoot: work,
  publisher: { enabled: true, intervalMs: 15_000, lastTickAt: ago(5_000), lastError: null },
  agentRunner: { enabled: true, intervalMs: 2_000, lastTickAt: ago(1_000), busySince: null, lastError: null },
  ...over,
});
const healthy = { freeBytes: async () => 50 * GB, trackedSecrets: async () => [] as string[], windowsSecurity: async () => ({ bitlocker: 1, broadAccess: [] as string[] }) };
const status = async (over: Partial<RuntimeState> = {}, extra: Partial<Parameters<typeof systemHealth>[0]> = {}) =>
  systemHealth({ db: t.db, runtime: runtime(over), backups, now: NOW, ...healthy, ...extra });
const check = (h: Awaited<ReturnType<typeof systemHealth>>, id: string) => h.checks.find((c) => c.id === id)!;

beforeAll(async () => {
  t = await freshDb();
  work = await mkdtemp(path.join(tmpdir(), "lbe-health-"));
  backups = { dir: path.join(work, "auto"), externalMarker: path.join(work, "last-external-copy.json"), intervalHours: 24, keep: 14 };
  // A verified automatic backup from 2 hours ago and a USB copy from yesterday: backups are fine.
  await mkdir(backups.dir, { recursive: true });
  const base = "lbe-auto-staging-2026-11-20T10-00-00-000Z";
  await writeFile(path.join(backups.dir, `${base}.tar.gz`), "x");
  await writeFile(path.join(backups.dir, `${base}.json`), JSON.stringify({ format: "lbe-pglite-backup/1", created_at: ago(7_200_000).toISOString(),
    environment: "staging", archive: `${base}.tar.gz`, archive_sha256: "0", archive_bytes: 1, fingerprint: { migrations: [], rowCounts: { a: 3 } } }));
  await writeFile(path.join(backups.dir, "status.json"), JSON.stringify({ last_attempt_at: ago(7_200_000).toISOString(), last_success_at: ago(7_200_000).toISOString(), last_result: "ok", last_error: null }));
  await writeFile(backups.externalMarker, JSON.stringify({ at: ago(86_400_000).toISOString(), folder: "E:\\b", separate_disk: "yes", databases: ["staging"] }));
});
afterAll(async () => { await t.db.close(); await rm(work, { recursive: true, force: true }); });

describe("System health (P9-05)", () => {
  it("everything fine → overall ok; informational items (live publishing, uptime) never raise the alarm", async () => {
    const h = await status();
    expect(h.overall).toBe("ok");
    expect(h.checks.map((c) => c.id)).toEqual(["database", "disk", "backups", "publisher", "agent_runner", "live", "secrets", "secret_access", "encryption", "uptime"]);
    expect(h.checks.filter((c) => c.status !== "ok" && c.status !== "info")).toEqual([]);
  });

  it("disk space: under 5 GB needs attention, under 1 GB is a problem", async () => {
    expect(check(await status({}, { freeBytes: async () => 3 * GB }), "disk").status).toBe("warn");
    const low = await status({}, { freeBytes: async () => 0.5 * GB });
    expect(check(low, "disk")).toMatchObject({ status: "bad", detail: expect.stringMatching(/0\.5 GB free/) });
    expect(low.overall).toBe("bad");
  });

  it("a worker with no activity is a problem (restart); a pilot server with the publisher off is only information", async () => {
    const stale = await status({ publisher: { enabled: true, intervalMs: 15_000, lastTickAt: ago(10 * 60_000), lastError: null } });
    expect(check(stale, "publisher")).toMatchObject({ status: "bad", action: expect.stringMatching(/Restart the server/) });
    const off = await status({ publisher: { enabled: false, intervalMs: 15_000, lastTickAt: null, lastError: null } });
    expect(check(off, "publisher").status).toBe("info");
    expect(off.overall).toBe("ok");
  });

  it("agent runner: a job running over an hour needs attention; a runner that is switched off needs attention", async () => {
    const long = await status({ agentRunner: { enabled: true, intervalMs: 2_000, lastTickAt: ago(2 * 3_600_000), busySince: ago(90 * 60_000), lastError: null } });
    expect(check(long, "agent_runner")).toMatchObject({ status: "warn", detail: expect.stringMatching(/running for 90 minutes/) });
    const off = await status({ agentRunner: { enabled: false, intervalMs: 2_000, lastTickAt: null, busySince: null, lastError: null } });
    expect(check(off, "agent_runner").status).toBe("warn");
  });

  it("just started: no worker activity yet is fine for the first minutes", async () => {
    const h = await status({ startedAt: ago(10_000), publisher: { enabled: true, intervalMs: 15_000, lastTickAt: null, lastError: null } });
    expect(check(h, "publisher").status).toBe("ok");
  });

  it("secret files tracked by Git are a problem; on the real project none are", async () => {
    const leaked = await status({}, { trackedSecrets: async () => [".env.staging"] });
    expect(check(leaked, "secrets")).toMatchObject({ status: "bad", detail: expect.stringMatching(/\.env\.staging/) });
    const real = await systemHealth({ db: t.db, runtime: runtime({ repoRoot: REPO_ROOT }), backups, now: NOW, freeBytes: healthy.freeBytes, windowsSecurity: healthy.windowsSecurity });
    expect(check(real, "secrets").status).toBe("ok");                         // asks Git about this repository
  });

  it("a database that does not answer, or a failed automatic backup, is a problem", async () => {
    const dead = await status({}, { db: { query: async () => { throw new Error("database is closed"); } } });
    expect(check(dead, "database")).toMatchObject({ status: "bad", detail: expect.stringMatching(/database is closed/) });
    await writeFile(path.join(backups.dir, "status.json"), JSON.stringify({ last_attempt_at: NOW.toISOString(), last_success_at: ago(7_200_000).toISOString(), last_result: "failed", last_error: "disk full" }));
    expect(check(await status(), "backups")).toMatchObject({ status: "bad", detail: expect.stringMatching(/disk full/) });
    await writeFile(path.join(backups.dir, "status.json"), JSON.stringify({ last_attempt_at: ago(7_200_000).toISOString(), last_success_at: ago(7_200_000).toISOString(), last_result: "ok", last_error: null }));
  });

  it("real free-space reading works on this computer", async () => {
    const h = await systemHealth({ db: t.db, runtime: runtime({ dataPath: REPO_ROOT }), backups, now: NOW, trackedSecrets: healthy.trackedSecrets, windowsSecurity: healthy.windowsSecurity });
    expect(check(h, "disk").detail).toMatch(/GB free/);
  });

  it("API: admin only; signed-out users get 401", async () => {
    const ORIGIN = "http://localhost:5173";
    const app = createApp({ db: t.db, drafter: new MockDrafter(), provider: new MockLinkedInProvider(dbMockStore(t.db)), appOrigins: [ORIGIN],
      cookieSecure: false, voiceDir: path.resolve(import.meta.dirname, "../../brand/voice"), workerId: "it", log: () => undefined,
      backups, runtime: runtime() });
    const login = async (email: string, password: string) => (await app.request("/api/auth/login", { method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ email, password }) })).headers.get("set-cookie")!.split(";")[0]!;
    const get = (cookie?: string) => app.request("/api/admin/system", { headers: cookie ? { cookie } : {} });
    expect((await get()).status).toBe(401);
    expect((await get(await login("marketing@lbe.test", TEST_PASSWORDS.approver))).status).toBe(403);
    expect((await get(await login("editor@lbe.test", TEST_PASSWORDS.editor))).status).toBe(403);
    const res = await get(await login("admin@lbe.test", TEST_PASSWORDS.admin));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { checks: Array<{ id: string }> }).checks.map((c) => c.id)).toEqual(expect.arrayContaining(["database", "disk", "backups", "secrets"]));
  });
});

describe("Secrets, HTTPS and environment separation (P9-03)", () => {
  it("disk encryption: off or suspended needs attention with what to do; on is fine; unknown is information", async () => {
    const enc = async (bitlocker: number | null) => check(await status({}, { windowsSecurity: async () => ({ bitlocker, broadAccess: [] }) }), "encryption");
    expect(await enc(2)).toMatchObject({ status: "warn", action: expect.stringMatching(/Turn on BitLocker/) });
    expect((await enc(5)).status).toBe("warn");
    expect((await enc(1)).status).toBe("ok");
    expect((await enc(6)).status).toBe("ok");
    expect((await enc(null)).status).toBe("info");
  });

  it("secret files that other Windows users can open are a problem", async () => {
    const h = await status({}, { windowsSecurity: async () => ({ bitlocker: 1, broadAccess: ["C:\\p\\.env.staging (Everyone)"] }) });
    expect(check(h, "secret_access")).toMatchObject({ status: "bad", detail: expect.stringMatching(/\.env\.staging \(Everyone\)/) });
    expect(h.overall).toBe("bad");
  });

  it("HTTPS certificate: expired is a problem, under 30 days needs attention, otherwise fine; plain HTTP servers have no such check", async () => {
    const cert = async (days: number) => check(await status({ tls: { validTo: new Date(NOW.getTime() + days * 86_400_000), names: "DNS:localhost", fingerprint256: "AA:BB" } }), "certificate");
    expect(await cert(-1)).toMatchObject({ status: "bad", action: expect.stringMatching(/staging:renew-cert/) });
    expect(await cert(10)).toMatchObject({ status: "warn", detail: expect.stringMatching(/10 days/) });
    expect((await cert(200)).status).toBe("ok");
    expect(check(await status({ tls: { error: "bad password" } }), "certificate").status).toBe("bad");
    expect(check(await status(), "certificate")).toBeUndefined();
    expect(certificateInfo(Buffer.from("not a certificate"), "x")).toMatchObject({ error: expect.any(String) });
  });

  it.runIf(process.platform === "win32")("real probe on this PC: reads BitLocker, finds the project's secret files private, and detects a file opened to Everyone", async () => {
    const files = [".env", ".env.staging", "secrets"].map((p) => path.join(REPO_ROOT, p));
    const real = await probeWindowsSecurity(REPO_ROOT, files);
    expect(real).not.toBeNull();
    expect(real!.broadAccess).toEqual([]);
    expect(real!.bitlocker === null || Number.isInteger(real!.bitlocker)).toBe(true);
    const open = path.join(work, "shared-secret.txt");
    await writeFile(open, "x");
    await promisify(execFile)("icacls", [open, "/grant", "*S-1-1-0:R"]);
    const probed = await probeWindowsSecurity(work, [open]);
    expect(probed!.broadAccess.join(" ")).toMatch(/shared-secret\.txt/);
  }, 60_000);

  it("development and staging may never use the same database folder", async () => {
    const root = path.join(work, "envsep");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, ".env"), "LBE_ENV=development\nLBE_PGLITE_DIR=.data/pglite\n");
    await writeFile(path.join(root, ".env.staging"), "LBE_ENV=staging\nLBE_PGLITE_DIR=.data/pglite\n");
    const staging = { LBE_ENV: "staging" as const, LBE_DATABASE_URL: "pglite", pgliteDir: path.join(root, ".data", "pglite") };
    expect(() => assertSeparateDatabase(staging, root)).toThrow(/same database folder as development/);
    expect(() => assertSeparateDatabase({ ...staging, LBE_ENV: "development" }, root)).toThrow(/same database folder as staging/);
    await writeFile(path.join(root, ".env.staging"), "LBE_ENV=staging\nLBE_PGLITE_DIR=.data/staging\n");
    expect(() => assertSeparateDatabase({ ...staging, pgliteDir: path.join(root, ".data", "staging") }, root)).not.toThrow();
    expect(() => assertSeparateDatabase({ ...staging, LBE_DATABASE_URL: "postgres://x" }, root)).not.toThrow();
    expect(() => assertSeparateDatabase({ LBE_ENV: "development", LBE_DATABASE_URL: "pglite", pgliteDir: path.join(REPO_ROOT, ".data", "pglite") })).not.toThrow();   // this PC's real settings
  });
});