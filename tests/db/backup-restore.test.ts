// P1-01: embedded-database backup and verified restore.
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backupPglite, restorePglite } from "../../services/api/src/backup.ts";
import { migrate, openDb } from "../../services/api/src/db.ts";
import { seed } from "../../services/api/src/seed.ts";
import { TEST_PASSWORDS } from "../helpers/db.ts";

let work: string;
let source: string;
let manifestPath: string;
let contentId: string;

beforeAll(async () => {
  work = await mkdtemp(path.join(tmpdir(), "lbe-backup-"));
  source = path.join(work, "source");
  const db = await openDb({ url: "pglite", dataDir: source });
  await migrate(db);
  const ids = await seed(db, TEST_PASSWORDS);
  const login = await db.tx("lbe_api", (q) => q.query<{ r: { token: string } }>("select lbe.login($1, $2) as r", ["editor@lbe.test", TEST_PASSWORDS.editor]));
  const token = login[0]!.r.token;
  contentId = (await db.tx("lbe_api", (q) => q.query<{ id: string }>(
    "select lbe.create_content($1, $2, $3, $4, null, null) as id", [token, ids.accounts.company, "threat-landscape", "Backup test brief"])))[0]!.id;
  await db.close();
  ({ manifestPath } = await backupPglite({ dataDir: source, outDir: path.join(work, "backups"), environment: "test" }));
}, 120_000);

afterAll(async () => { await rm(work, { recursive: true, force: true }); });

describe("database backup & restore", () => {
  it("writes an archive and a manifest with migrations and row counts", async () => {
    const m = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(m.format).toBe("lbe-pglite-backup/1");
    expect(m.archive_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.fingerprint.migrations.length).toBeGreaterThanOrEqual(6);
    expect(m.fingerprint.rowCounts.content_items).toBeGreaterThanOrEqual(1);
    expect(m.fingerprint.rowCounts.app_users).toBeGreaterThanOrEqual(4);
    expect(m.fingerprint.rowCounts).not.toHaveProperty("sessions");
  });

  it("restores into an empty folder, matches the backup, clears sessions, and is usable", async () => {
    const target = path.join(work, "restored");
    const r = await restorePglite({ manifestPath, targetDir: target });
    expect(r.sessionsPurged).toBeGreaterThanOrEqual(1);
    const db = await openDb({ url: "pglite", dataDir: target });
    try {
      expect(await migrate(db)).toEqual([]);                       // nothing pending, checksums intact
      const items = await db.query<{ brief: string }>("select brief from lbe.content_items where id = $1", [contentId]);
      expect(items[0]?.brief).toBe("Backup test brief");
      expect((await db.query<{ n: number }>("select count(*)::int as n from lbe.sessions"))[0]!.n).toBe(0);
      const login = await db.tx("lbe_api", (q) => q.query<{ r: { ok: boolean } }>("select lbe.login($1, $2) as r", ["admin@lbe.test", TEST_PASSWORDS.admin]));
      expect(login[0]!.r.ok).toBe(true);                           // password hashes survive
    } finally {
      await db.close();
    }
  }, 120_000);

  it("refuses to overwrite an existing database", async () => {
    await expect(restorePglite({ manifestPath, targetDir: source })).rejects.toThrow(/refusing to overwrite/);
    const other = path.join(work, "not-empty");
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, "x.txt"), "x");
    await expect(restorePglite({ manifestPath, targetDir: other })).rejects.toThrow(/refusing to overwrite/);
  });

  it("refuses a modified archive", async () => {
    const m = JSON.parse(await readFile(manifestPath, "utf8"));
    const archive = path.join(path.dirname(manifestPath), m.archive);
    const bytes = await readFile(archive);
    const tampered = path.join(work, "backups", "tampered.json");
    await writeFile(path.join(work, "backups", "tampered.tar.gz"), Buffer.concat([bytes, Buffer.from([0])]));
    await writeFile(tampered, JSON.stringify({ ...m, archive: "tampered.tar.gz" }));
    await expect(restorePglite({ manifestPath: tampered, targetDir: path.join(work, "t1") })).rejects.toThrow(/checksum mismatch/);
  });

  it("refuses path traversal in the manifest and a missing source database", async () => {
    const m = JSON.parse(await readFile(manifestPath, "utf8"));
    const evil = path.join(work, "backups", "evil.json");
    await writeFile(evil, JSON.stringify({ ...m, archive: "../source/PG_VERSION" }));
    await expect(restorePglite({ manifestPath: evil, targetDir: path.join(work, "t2") })).rejects.toThrow(/invalid archive name/);
    await expect(backupPglite({ dataDir: path.join(work, "nope"), outDir: path.join(work, "backups"), environment: "test" })).rejects.toThrow(/no database/);
  });
});
