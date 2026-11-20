// P9-04: automatic backups while the server runs, the restore drill, retention, the schedule, the owner's status
// page (admin only) and the USB copy using the newest automatic backup while the server keeps running.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockDrafter } from "@lbe/drafting";
import { MockLinkedInProvider } from "@lbe/publishing";
import { createApp } from "../../services/api/src/app.ts";
import { listAutoBackups, readAutoStatus, runAutoBackup, startAutoBackup } from "../../services/api/src/auto-backup.ts";
import { restorePglite } from "../../services/api/src/backup.ts";
import { backupStatus } from "../../services/api/src/backup-status.ts";
import { migrate, openDb, type Db } from "../../services/api/src/db.ts";
import { dbMockStore } from "../../services/api/src/jobs/publisher.ts";
import { seed } from "../../services/api/src/seed.ts";
import { TEST_PASSWORDS } from "../helpers/db.ts";

const ORIGIN = "http://localhost:5173";
let work: string;
let db: Db;
const stamp = (h: number) => new Date(Date.UTC(2026, 10, 20, 0, 0, 0) + h * 3_600_000);
const count = async () => (await db.query<{ n: number }>("select count(*)::int as n from lbe.audit_events"))[0]!.n;

beforeAll(async () => {
  work = await mkdtemp(path.join(tmpdir(), "lbe-autobackup-"));
  db = await openDb({ url: "pglite", dataDir: path.join(work, "live") });
  await migrate(db);
  await seed(db, TEST_PASSWORDS);
}, 180_000);

afterAll(async () => {
  await db.close();
  await rm(work, { recursive: true, force: true });
});

describe("automatic backups while the server runs (P9-04)", () => {
  it("takes a snapshot during ongoing writes, restore-tests it in a separate process, and only then writes the manifest", async () => {
    const dir = path.join(work, "auto-1");
    let writing = true;
    // Writes keep arriving while the backup runs (each yields to the event loop, as separate HTTP requests would).
    let writes = 0;
    const writer = (async () => {
      while (writing) {
        await db.query("select lbe.audit('test.write', 'test', null, $1::jsonb)", [JSON.stringify({ i: writes++ })]);
        await new Promise((r) => setImmediate(r));
      }
    })();
    const r = await runAutoBackup({ db, dir, environment: "staging", now: () => stamp(0) });
    writing = false;
    await writer;
    expect(writes).toBeGreaterThan(10);                                       // writes really overlapped the backup
    expect(r).toMatchObject({ ok: true, manifest: "lbe-auto-staging-2026-11-20T00-00-00-000Z.json" });
    // The manifest is the P1-01 format: the normal restore command accepts it and the contents match.
    const restored = await restorePglite({ manifestPath: path.join(dir, r.manifest!), targetDir: path.join(work, "restored-1") });
    expect(restored.fingerprint.rowCounts.audit_events).toBeGreaterThan(0);
    expect(await readAutoStatus(dir)).toMatchObject({ last_result: "ok", last_success_at: stamp(0).toISOString(), last_error: null });
    expect((await listAutoBackups(dir))[0]).toMatchObject({ manifest: r.manifest, created_at: stamp(0).toISOString() });
  }, 180_000);

  it("never captures a transaction half-way: the snapshot waits until an open transaction has finished", async () => {
    const before = await count();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const tx = db.tx(null, async (q) => {
      await q.query("select lbe.audit('test.tx', 'test', null, '{}'::jsonb)");
      await gate;                                                             // transaction stays open
      await q.query("select lbe.audit('test.tx', 'test', null, '{}'::jsonb)");
    });
    let snapshotDone = false;
    const dir = path.join(work, "auto-tx");
    const backup = runAutoBackup({ db, dir, environment: "staging", now: () => stamp(1) }).then((r) => { snapshotDone = true; return r; });
    await new Promise((r) => setTimeout(r, 300));
    expect(snapshotDone).toBe(false);                                         // still waiting for the transaction
    release();
    await tx;
    const r = await backup;
    expect(r.ok).toBe(true);
    const fp = await restorePglite({ manifestPath: path.join(dir, r.manifest!), targetDir: path.join(work, "restored-tx") });
    expect(fp.fingerprint.rowCounts.audit_events).toBe(before + 2);           // both rows, never just one
  }, 180_000);

  it("keeps the newest N verified backups and deletes only its own older files", async () => {
    const dir = path.join(work, "auto-keep");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "owner-notes.txt"), "not ours");
    const fakeDrill = async () => ({ migrations: [], rowCounts: { x: 1 } });
    for (let h = 0; h < 4; h++) expect((await runAutoBackup({ db, dir, environment: "staging", keep: 2, now: () => stamp(h), drill: fakeDrill })).ok).toBe(true);
    const names = (await readdir(dir)).sort();
    expect(names).toEqual([
      "lbe-auto-staging-2026-11-20T02-00-00-000Z.json", "lbe-auto-staging-2026-11-20T02-00-00-000Z.tar.gz",
      "lbe-auto-staging-2026-11-20T03-00-00-000Z.json", "lbe-auto-staging-2026-11-20T03-00-00-000Z.tar.gz",
      "owner-notes.txt", "status.json",
    ]);
  }, 180_000);

  it("a backup that fails its restore drill is removed, gets no manifest, and shows as failed on the status page", async () => {
    const dir = path.join(work, "auto-fail");
    const broken = { snapshot: async () => new TextEncoder().encode("this is not a database archive") };
    const r = await runAutoBackup({ db: broken, dir, environment: "staging", now: () => stamp(5) });
    expect(r.ok).toBe(false);
    expect(await listAutoBackups(dir)).toEqual([]);
    expect((await readdir(dir)).filter((n) => n.endsWith(".tar.gz"))).toEqual([]);
    expect(await readAutoStatus(dir)).toMatchObject({ last_result: "failed", last_success_at: null });
    const s = await backupStatus({ dir, externalMarker: path.join(work, "none.json"), intervalHours: 24, keep: 14 }, stamp(5));
    expect(s.warnings.join(" ")).toMatch(/last automatic backup failed/);
  }, 180_000);

  it("schedule: backs up when none is recent, not again within the interval, and stops cleanly", async () => {
    const dir = path.join(work, "auto-sched");
    const calls: string[] = [];
    const fakeDrill = async () => { calls.push("drill"); return { migrations: [], rowCounts: {} }; };
    // Instant snapshot and drill, so every 50 ms check could back up if the schedule ignored the interval.
    const instant = { snapshot: async () => new Uint8Array([1, 2, 3]) };
    const s = startAutoBackup({ db: instant, dir, environment: "staging", intervalHours: 24, firstCheckAfterMs: 10, checkEveryMs: 50, drill: fakeDrill });
    for (let i = 0; i < 300 && (await listAutoBackups(dir)).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 500));                             // ~10 more checks: none may back up again
    s.stop();
    while (s.runningNow()) await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(["drill"]);                                         // several checks, one backup
    expect(await listAutoBackups(dir)).toHaveLength(1);
  }, 60_000);

  it("status page: warns when there is no USB copy or it is a week old; all clear when both are fresh", async () => {
    const dir = path.join(work, "auto-1");
    const marker = path.join(work, "last-external-copy.json");
    const cfg = { dir, externalMarker: marker, intervalHours: 24, keep: 14 };
    expect((await backupStatus(cfg, stamp(1))).warnings.join(" ")).toMatch(/No copy on a USB drive yet/);
    await writeFile(marker, JSON.stringify({ at: stamp(-24 * 8).toISOString(), folder: "E:\\x", separate_disk: "yes", databases: ["staging"] }));
    expect((await backupStatus(cfg, stamp(1))).warnings.join(" ")).toMatch(/last USB copy is 8 days old/);
    await writeFile(marker, JSON.stringify({ at: stamp(-24).toISOString(), folder: "E:\\x", separate_disk: "yes", databases: ["staging"] }));
    const fresh = await backupStatus(cfg, stamp(1));
    expect(fresh.warnings).toEqual([]);
    expect(fresh.automatic).toMatchObject({ enabled: true, count: 1 });
    expect(fresh.external).toMatchObject({ days_since: 1 });
    expect((await backupStatus(cfg, stamp(60))).warnings.join(" ")).toMatch(/newest automatic backup is 60 hours old/);
  });

  it("API: only an admin can see backup status; signed-out users cannot", async () => {
    const app = createApp({
      db, drafter: new MockDrafter(), provider: new MockLinkedInProvider(dbMockStore(db)), appOrigins: [ORIGIN], cookieSecure: false,
      voiceDir: path.resolve(import.meta.dirname, "../../brand/voice"), workerId: "it", log: () => undefined,
      backups: { dir: path.join(work, "auto-1"), externalMarker: path.join(work, "last-external-copy.json"), intervalHours: 24, keep: 14 },
    });
    const login = async (email: string, password: string) => (await app.request("/api/auth/login", { method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ email, password }) })).headers.get("set-cookie")!.split(";")[0]!;
    const get = (cookie?: string) => app.request("/api/admin/backups", { headers: cookie ? { cookie } : {} });
    expect((await get()).status).toBe(401);
    expect((await get(await login("editor@lbe.test", TEST_PASSWORDS.editor))).status).toBe(403);
    const res = await get(await login("admin@lbe.test", TEST_PASSWORDS.admin));
    expect(res.status).toBe(200);
    const body = await res.json() as { automatic: { enabled: boolean; count: number; newest: { rows: number } } };
    expect(body.automatic).toMatchObject({ enabled: true, count: 1 });
    expect(body.automatic.newest.rows).toBeGreaterThan(0);
  });

  it("an automatic backup with a damaged archive is not offered (its checksum no longer matches) — the USB copy would fail loudly", async () => {
    const dir = path.join(work, "auto-1");
    const [b] = await listAutoBackups(dir);
    const m = JSON.parse(await readFile(path.join(dir, b!.manifest), "utf8")) as { archive: string };
    const target = path.join(work, "restored-damaged");
    const archive = await readFile(path.join(dir, m.archive));
    const copyDir = path.join(work, "damaged-copy");
    await mkdir(copyDir, { recursive: true });
    archive[archive.length - 5] = archive[archive.length - 5]! ^ 0xff;
    await writeFile(path.join(copyDir, m.archive), archive);
    await writeFile(path.join(copyDir, b!.manifest), await readFile(path.join(dir, b!.manifest)));
    await expect(restorePglite({ manifestPath: path.join(copyDir, b!.manifest), targetDir: target })).rejects.toThrow(/checksum mismatch/);
    expect(existsSync(target)).toBe(false);
  });
});
