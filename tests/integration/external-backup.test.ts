// P0-07: backup to a separate device. A throwaway project (Git repo + embedded database + .env files) is backed
// up to a folder that the test presents as a different physical disk; the copy must restore exactly.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, openDb } from "../../services/api/src/db.ts";
import { BackupRefused, createExternalBackup, physicalDiskOf, verifyExternalBackup } from "../../services/api/src/external-backup.ts";
import { seed } from "../../services/api/src/seed.ts";
import { TEST_PASSWORDS } from "../helpers/db.ts";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd });

let work: string;
let repo: string;
let usb: string;
/** The project is on "disk:0"; anything under `usb` is on "disk:9" (a USB drive). */
const diskOf = async (p: string) => (path.resolve(p).startsWith(usb) ? "disk:9" : "disk:0");
const noServer = async () => false;

beforeAll(async () => {
  work = await mkdtemp(path.join(tmpdir(), "lbe-extbackup-"));
  repo = path.join(work, "project");
  usb = path.join(work, "usb");
  await run("git", ["init", "--quiet", "-b", "main", repo]);
  await writeFile(path.join(repo, "README.md"), "# Project\n");
  await writeFile(path.join(repo, ".gitignore"), ".env\n.env.*\n.data/\nsecrets/\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "--quiet", "-m", "first");
  await writeFile(path.join(repo, "app.ts"), "export const x = 1;\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "--quiet", "-m", "second");
  // Settings files with a (fake) secret, and a database with real rows.
  await writeFile(path.join(repo, ".env"), "LBE_ENV=development\nLBE_PORT=59998\nLBE_DATABASE_URL=pglite\nLBE_PGLITE_DIR=.data/pglite\nANTHROPIC_API_KEY=fake-secret-value-for-test\n");
  await writeFile(path.join(repo, ".env.staging"), "LBE_ENV=staging\nLBE_PORT=59997\nLBE_DATABASE_URL=pglite\nLBE_PGLITE_DIR=.data/staging\n");
  const db = await openDb({ url: "pglite", dataDir: path.join(repo, ".data", "pglite") });
  await migrate(db);
  await seed(db, TEST_PASSWORDS);
  await db.close();
}, 180_000);

afterAll(async () => { await rm(work, { recursive: true, force: true }); });

describe("backup to a separate device (P0-07)", () => {
  let setDir: string;

  it("copies the code (full history) and the database, proves both restore, and copies no secrets", async () => {
    const r = await createExternalBackup({ repoRoot: repo, dest: path.join(usb, "LBE-backups"), diskOf, portInUse: noServer, now: new Date("2026-11-20T10:00:00Z") });
    setDir = r.setDir;
    expect(path.basename(setDir)).toBe("lbe-backup-2026-11-20T10-00-00-000Z");
    expect(r.set.separate_disk).toBe("yes");
    expect(r.set.git).toMatchObject({ branch: "main", commits: 2, uncommitted_changes: false });
    expect(r.set.git.head).toBe((await git(repo, "rev-parse", "HEAD")).stdout.trim());
    expect(r.set.databases).toEqual([expect.objectContaining({ environment: "development", migrations: expect.any(Number), rows: expect.any(Number) })]);
    expect(r.set.databases[0]!.rows).toBeGreaterThan(0);
    expect(r.set.skipped).toEqual(["staging: no database yet"]);
    expect(r.warnings).toEqual([]);

    // Everything listed is there; nothing secret is copied anywhere in the set.
    const names = (await readdir(setDir, { recursive: true })).map((n) => n.split(path.sep).join("/")).sort();
    expect(names).toEqual(expect.arrayContaining(["code.bundle", "backup-set.json", "READ-ME-restore.txt", "databases"]));
    expect(names.some((n) => /(^|\/)\.env/.test(n) || n.startsWith("secrets"))).toBe(false);
    for (const n of names.filter((x) => !x.endsWith("databases"))) {
      expect((await readFile(path.join(setDir, n))).includes("fake-secret-value-for-test"), n).toBe(false);
    }
    const restoreHelp = await readFile(path.join(setDir, "READ-ME-restore.txt"), "utf8");
    expect(restoreHelp).toMatch(/NOT INCLUDED \(on purpose\)/);
    expect(restoreHelp).toMatch(/BitLocker/);

    // The bundle really restores the whole history.
    const clone = path.join(work, "restored-code");
    await run("git", ["clone", "--quiet", path.join(setDir, "code.bundle"), clone]);
    expect((await git(clone, "rev-list", "--count", "HEAD")).stdout.trim()).toBe("2");
    expect(existsSync(path.join(clone, "app.ts"))).toBe(true);
    expect(existsSync(path.join(clone, ".env"))).toBe(false);
  }, 180_000);

  it("an untouched backup passes the check; a damaged one is caught", async () => {
    expect((await verifyExternalBackup(setDir)).problems).toEqual([]);
    const set = JSON.parse(await readFile(path.join(setDir, "backup-set.json"), "utf8")) as { files: Array<{ path: string }> };
    const archive = set.files.find((f) => f.path.endsWith(".tar.gz"))!.path;
    const bytes = await readFile(path.join(setDir, archive));
    bytes[bytes.length - 10] = bytes[bytes.length - 10]! ^ 0xff;
    await writeFile(path.join(setDir, archive), bytes);
    const { problems } = await verifyExternalBackup(setDir);
    expect(problems.join(" ")).toMatch(/changed or damaged/);
  }, 180_000);

  it("refuses a folder on the same physical disk as the project (unless the owner allows it), or inside the project", async () => {
    const sameDisk = path.join(work, "same-disk-folder");
    const e = await createExternalBackup({ repoRoot: repo, dest: sameDisk, diskOf, portInUse: noServer }).catch((x) => x);
    expect(e).toBeInstanceOf(BackupRefused);
    expect((e as Error).message).toMatch(/same physical disk/);
    expect(existsSync(sameDisk)).toBe(false);                     // nothing written

    const allowed = await createExternalBackup({ repoRoot: repo, dest: sameDisk, diskOf, portInUse: noServer, allowSameDisk: true });
    expect(allowed.set.separate_disk).toBe("no (allowed by the owner)");
    expect(allowed.warnings.join(" ")).toMatch(/accidental deletion only/);

    const inside = await createExternalBackup({ repoRoot: repo, dest: path.join(repo, "backup-here"), diskOf: async () => "disk:9", portInUse: noServer }).catch((x) => x);
    expect(inside).toBeInstanceOf(BackupRefused);
    expect((inside as Error).message).toMatch(/inside the project folder/);
  }, 180_000);

  it("a copy that is damaged while being written (faulty drive) is reported as failed, not as a good backup", async () => {
    const corrupt = async (dir: string) => {
      const dbDir = path.join(dir, "databases");
      const archive = (await readdir(dbDir)).find((n) => n.endsWith(".tar.gz"))!;
      const bytes = await readFile(path.join(dbDir, archive));
      bytes[bytes.length - 10] = bytes[bytes.length - 10]! ^ 0xff;
      await writeFile(path.join(dbDir, archive), bytes);
    };
    const e = await createExternalBackup({ repoRoot: repo, dest: path.join(usb, "faulty"), diskOf, portInUse: noServer, onWritten: corrupt }).catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/could not be restored.*development database/);
  }, 180_000);

  it("refuses while the server is running (an open database must not be copied)", async () => {
    const e = await createExternalBackup({ repoRoot: repo, dest: path.join(usb, "other"), diskOf, portInUse: async (p) => p === 59998 }).catch((x) => x);
    expect(e).toBeInstanceOf(BackupRefused);
    expect((e as Error).message).toMatch(/Stop the server first.*development \(port 59998\)/);
    expect(existsSync(path.join(usb, "other"))).toBe(false);
  });

  it("warns that uncommitted changes are not in the backup", async () => {
    await writeFile(path.join(repo, "app.ts"), "export const x = 2; // not committed\n");
    const r = await createExternalBackup({ repoRoot: repo, dest: path.join(usb, "LBE-backups"), diskOf, portInUse: noServer });
    expect(r.set.git.uncommitted_changes).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/not committed yet/);
    await git(repo, "checkout", "--", "app.ts");
  }, 180_000);

  it("finds the physical disk of a folder on this computer", async () => {
    const here = await physicalDiskOf(process.cwd());
    expect(here).not.toBeNull();
    expect(await physicalDiskOf(path.join(process.cwd(), "does", "not", "exist", "yet"))).toBe(here);
    if (process.platform === "win32") expect(here).toMatch(/^disk:\d+$/);
  }, 60_000);
});
