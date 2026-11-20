// P2-03b / ADR-032: read the text of an uploaded PDF in a separate, locked-down Node process (pdf-child.ts):
//   * Node permission model: the child may read only its own two source files, the API package.json and the PDF
//     library; no network, no other files, no child processes, no worker threads, no addons, no eval;
//   * no environment variables (no keys, no database address);
//   * about 256 MB of memory, 15 seconds, then the process is killed; a crash (even V8 running out of memory) ends
//     only the child, never the API;
//   * at most 5 MB and 50 pages (the caller checks size and the "%PDF-" header); at most 2 PDFs read at once;
//   * the child's output is discarded, so nothing from a document reaches the logs.
// A worker thread was tried first: V8 can abort the whole process when a worker runs out of memory, so a separate
// process is used instead.
import { fork, type ForkOptions } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PDF_LIMITS = { maxBytes: 5 * 1024 * 1024, maxPages: 50, timeoutMs: 15_000, maxHeapMb: 256, maxConcurrent: 2 };
export type PdfLimits = typeof PDF_LIMITS;

export interface PdfChildInput { bytes: Uint8Array; maxPages: number }
/** Messages from the child: "ready" once PDF.js is loaded and the guards are in place, then one result. */
export type PdfChildMessage =
  | { kind: "ready" }
  | { kind: "ok"; pages: number; pageTexts: string[]; blocked: string[] }
  | { kind: "refused"; reason: "encrypted" | "password" | "pages"; pages?: number; blocked: string[] }
  | { kind: "unreadable"; blocked: string[] };

export type PdfReadResult = Exclude<PdfChildMessage, { kind: "ready" }> | { kind: "timeout" } | { kind: "too_complex" };

/** Too many PDFs are being read at once (mapped to HTTP 429). */
export class PdfBusyError extends Error {}

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "pdf-child.ts");
const unpdfEntry = createRequire(import.meta.url).resolve("unpdf");          // …/node_modules/unpdf/dist/index.mjs
/** Everything the reader process may read: its own code, the API package.json (module type) and the PDF library. */
export const PDF_READER_READ_PATHS = [CHILD, join(here, "pdf-sandbox.ts"), join(here, "..", "package.json"), dirname(dirname(unpdfEntry))];

/**
 * How the reader process is started: Node permission model, no eval, memory limit, none of our environment
 * (keys, database address; Windows needs SystemRoot to run at all), output discarded except stderr (read only to
 * recognise "out of memory"). Exported so a test can start a probe under exactly the same rules.
 */
export function pdfReaderForkOptions(maxHeapMb: number, extraReadPaths: string[] = []): ForkOptions {
  return {
    execPath: process.execPath,
    execArgv: [
      "--permission",
      ...[...PDF_READER_READ_PATHS, ...extraReadPaths].map((p) => `--allow-fs-read=${p}`),
      "--disallow-code-generation-from-strings",
      `--max-old-space-size=${maxHeapMb}`, "--max-semi-space-size=16",
    ],
    env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
    stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced", windowsHide: true,
  };
}

let inFlight = 0;
/** How many PDF reader processes are running right now (for tests: must be 0 after every read). */
export const pdfReadsInFlight = () => inFlight;

export async function readPdfInWorker(bytes: Uint8Array, limits: Partial<PdfLimits> = {}): Promise<PdfReadResult> {
  const l = { ...PDF_LIMITS, ...limits };
  if (inFlight >= l.maxConcurrent) throw new PdfBusyError("Other PDFs are being read right now. Try again in a moment.");
  inFlight++;
  const child = fork(CHILD, [pathToFileURL(unpdfEntry).href], pdfReaderForkOptions(l.maxHeapMb));
  let stderrTail = "";     // kept only to recognise "out of memory"; never logged
  child.stderr?.on("data", (d: Buffer) => { stderrTail = (stderrTail + d.toString("utf8")).slice(-4096); });
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  try {
    return await new Promise<PdfReadResult>((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => resolve({ kind: "timeout" }), l.timeoutMs);
      const finish = (f: () => void) => { clearTimeout(timer); f(); };
      child.on("message", (m: PdfChildMessage) => {
        if (m.kind !== "ready") { finish(() => resolve(m)); return; }
        ready = true;
        child.send({ bytes, maxPages: l.maxPages } satisfies PdfChildInput);
      });
      child.once("error", (e) => finish(() => reject(e)));                 // could not be started: a server fault
      child.once("exit", (code, signal) => {
        // Give the stderr pipe a moment to deliver the last lines before deciding why the reader stopped.
        setImmediate(() => finish(() => {
          if (/out of memory/i.test(stderrTail)) resolve({ kind: "too_complex" });
          else if (ready) resolve({ kind: "unreadable", blocked: [] });   // the document broke the reader
          else reject(new Error(`PDF reader stopped before it was ready (exit ${code ?? signal})`));
        }));
      });
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    inFlight--;
  }
}
