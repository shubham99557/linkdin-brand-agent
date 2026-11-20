// P9-04: restore drill for an automatic backup, in a separate process so the API stays responsive while a
// second copy of the database is loaded. argv: <archive file> <empty target folder>.
// Sends one IPC message: { ok: true, fingerprint } or { ok: false, error }.
// Plain Node TypeScript (erasable syntax only): Node runs this file directly.
import { readFile } from "node:fs/promises";
import { fingerprintArchive } from "./backup.ts";

const [archivePath, target] = process.argv.slice(2);
try {
  const fingerprint = await fingerprintArchive(new Uint8Array(await readFile(archivePath!)), target!);
  process.send!({ ok: true, fingerprint });
} catch (e) {
  process.send!({ ok: false, error: (e as Error).message });
}
process.disconnect?.();
