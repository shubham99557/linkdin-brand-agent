// One program at a time per embedded database folder (2026-11-20). Found when the pilot pre-flight opened the
// staging database while the staging server was running: nothing stopped a second copy of PostgreSQL from opening
// the same files. Now every opener takes a lock file next to the folder.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backupPglite, restorePglite } from "../../services/api/src/backup.ts";
import { migrate, openDb } from "../../services/api/src/db.ts";
import { DatabaseInUseError, lockDataDir, lockFileFor } from "../../services/api/src/pglite-lock.ts";

let work: string;
beforeAll(async () => { work = await mkdtemp(path.join(tmpdir(), "lbe-lock-")); });
afterAll(async () => { await rm(work, { recursive: true, force: true }); });

/** The pid of a process that has already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  return r.pid!;
}

describe("embedded database: one program at a time", () => {
  it("a second open of the same folder is refused while the first is open, and allowed after close", async () => {
    const dir = path.join(work, "a");
    const first = await openDb({ url: "pglite", dataDir: dir });
    try {
      expect(existsSync(lockFileFor(dir))).toBe(true);
      expect(JSON.parse(await readFile(lockFileFor(dir), "utf8")).pid).toBe(process.pid);
      await expect(openDb({ url: "pglite", dataDir: dir })).rejects.toThrow(DatabaseInUseError);
      await expect(openDb({ url: "pglite", dataDir: dir })).rejects.toThrow(/already open in program \d+.*stop the server/);
    } finally {
      await first.close();
    }
    expect(existsSync(lockFileFor(dir))).toBe(false);
    const again = await openDb({ url: "pglite", dataDir: dir });
    await again.close();
  });

  it("the lock file sits next to the folder, never inside it (so it is never in a backup)", () => {
    const dir = path.join(work, "x", "staging");
    expect(lockFileFor(dir)).toBe(path.join(work, "x", "staging.lock"));
    expect(lockFileFor(dir + path.sep)).toBe(path.join(work, "x", "staging.lock"));
  });

  it("a lock left behind by a program that no longer exists (crash, killed) is taken over", async () => {
    const dir = path.join(work, "b");
    await writeFile(lockFileFor(dir), JSON.stringify({ pid: deadPid(), since: "2026-11-20T00:00:00Z", command: "main.ts" }));
    const db = await openDb({ url: "pglite", dataDir: dir });
    try {
      expect(JSON.parse(await readFile(lockFileFor(dir), "utf8")).pid).toBe(process.pid);
    } finally {
      await db.close();
    }
  });

  it("a fresh unreadable lock counts as in use; an old damaged one is taken over", async () => {
    const dir = path.join(work, "c");
    await writeFile(lockFileFor(dir), "");
    expect(() => lockDataDir(dir)).toThrow(DatabaseInUseError);
    const old = new Date(Date.now() - 60_000);
    await utimes(lockFileFor(dir), old, old);
    const release = lockDataDir(dir);
    release();
    expect(existsSync(lockFileFor(dir))).toBe(false);
  });

  it("backup and restore take the same lock: backing up an open database is refused", async () => {
    const dir = path.join(work, "d");
    const db = await openDb({ url: "pglite", dataDir: dir });
    try {
      await migrate(db);
      await expect(backupPglite({ dataDir: dir, outDir: path.join(work, "bk"), environment: "test" })).rejects.toThrow(DatabaseInUseError);
    } finally {
      await db.close();
    }
    const { manifestPath } = await backupPglite({ dataDir: dir, outDir: path.join(work, "bk"), environment: "test" });
    expect(existsSync(lockFileFor(dir))).toBe(false);
    const target = path.join(work, "restored");
    await restorePglite({ manifestPath, targetDir: target });
    expect(existsSync(lockFileFor(target))).toBe(false);
  });

  it("a real second program is refused while this one has the database open (the staging incident)", async () => {
    const dir = path.join(work, "e");
    const db = await openDb({ url: "pglite", dataDir: dir });
    const dbModule = pathToFileURL(path.resolve("services/api/src/db.ts")).href;
    const script = `import { openDb } from ${JSON.stringify(dbModule)};
      try { const d = await openDb({ url: "pglite", dataDir: ${JSON.stringify(dir)} }); await d.close(); console.log("OPENED"); }
      catch (e) { console.log(e.name + ": " + e.message); }`;
    const childFile = path.join(work, "second-program.mts");
    await writeFile(childFile, script);
    const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
    try {
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [tsxCli, childFile], { stdio: ["ignore", "pipe", "pipe"] });
        let text = "";
        child.stdout.on("data", (d) => { text += d; });
        child.stderr.on("data", (d) => { text += d; });
        child.on("error", reject);
        child.on("exit", () => resolve(text));
      });
      expect(out).toContain("DatabaseInUseError");
      expect(out).toContain(`program ${process.pid}`);
      expect(out).not.toContain("OPENED");
    } finally {
      await db.close();
    }
  }, 60_000);
});
