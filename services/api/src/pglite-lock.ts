// One program at a time per embedded database folder (2026-11-20).
//
// The embedded database (PGlite) has no lock of its own: a second program can open the same folder while the server
// is running, and two copies of PostgreSQL writing the same files can damage them. This adds a lock file next to the
// folder (`<folder>.lock`, outside the folder so it never ends up in a backup). Whoever opens the folder takes the
// lock; anyone else is refused with a plain message. A lock left behind by a program that crashed or was killed is
// detected (its process no longer exists) and taken over.
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

export class DatabaseInUseError extends Error {
  override name = "DatabaseInUseError";
}

interface LockOwner { pid: number; since: string; command: string }

/** The lock file for an embedded database folder: next to it, not inside it. */
export function lockFileFor(dataDir: string): string {
  return `${path.resolve(dataDir).replace(/[\\/]+$/, "")}.lock`;
}

function readOwner(file: string): LockOwner | null {
  try {
    const owner = JSON.parse(readFileSync(file, "utf8")) as LockOwner;
    return Number.isInteger(owner.pid) && owner.pid > 0 ? owner : null;
  } catch {
    return null;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);   // signal 0: only checks that the process exists
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function inUseMessage(dataDir: string, file: string, owner: LockOwner | null): string {
  const who = owner ? `program ${owner.pid}${owner.command ? ` (${owner.command})` : ""}, since ${owner.since}` : "another program";
  return `The database at ${dataDir} is already open in ${who}. Only one program may open it at a time: `
    + `stop the server (Ctrl+C in its window) and try again. If you are sure nothing has it open, delete ${file}.`;
}

/**
 * Takes the lock for `dataDir`, or throws DatabaseInUseError. Returns the function that releases it (also called
 * automatically when this process exits normally).
 */
export function lockDataDir(dataDir: string): () => void {
  const file = lockFileFor(dataDir);
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number;
    try {
      fd = openSync(file, "wx");   // fails if the file exists: creating it is the lock
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const owner = readOwner(file);
      if (owner && processExists(owner.pid)) throw new DatabaseInUseError(inUseMessage(dataDir, file, owner));
      if (!owner) {
        // Unreadable: either another program is writing it right now, or it is damaged. Only a damaged, older file is
        // taken over.
        let ageMs = Infinity;
        try { ageMs = Date.now() - statSync(file).mtimeMs; } catch { /* gone meanwhile */ }
        if (ageMs < 10_000) throw new DatabaseInUseError(inUseMessage(dataDir, file, null));
      }
      try { unlinkSync(file); } catch { /* someone else removed it first */ }
      continue;
    }
    try {
      const command = process.argv.slice(1, 2).map((a) => path.basename(a)).join(" ");
      writeSync(fd, JSON.stringify({ pid: process.pid, since: new Date().toISOString(), command } satisfies LockOwner));
    } finally {
      closeSync(fd);
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      process.off("exit", release);
      if (readOwner(file)?.pid === process.pid) {
        try { unlinkSync(file); } catch { /* already gone */ }
      }
    };
    process.on("exit", release);
    return release;
  }
  throw new DatabaseInUseError(inUseMessage(dataDir, file, readOwner(file)));
}
