// P2-03b / ADR-032: PDF upload. The PDF is untrusted: it is read in a worker thread with memory, time, size, page and
// concurrency limits, with no network or file access, and the text is shown for review before any proposal.
import { fork } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { DocumentError, extractDocument } from "../../services/api/src/documents.ts";
import { PdfBusyError, pdfReaderForkOptions, pdfReadsInFlight, readPdfInWorker } from "../../services/api/src/pdf-text.ts";
import { makePdf } from "../helpers/pdf.ts";

const brand = [
  ["## Positioning", "ActTrident helps small UK businesses build steady security habits.", "Plans from \u00a349 a month (prices are examples)."],
  ["## Audience problems", "Our buyers worry that one convincing invoice email could empty the company account."],
];
const failure = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as Error; } };

describe("PDF upload (P2-03b)", () => {
  it("reads the text of every page, in order, and says how many pages it read", async () => {
    const r = await extractDocument({ name: "C:\\fakepath\\Brand guide.pdf", bytes: makePdf({ pages: brand }) });
    expect(r).toMatchObject({ name: "Brand guide.pdf", kind: "pdf", pages: 2, truncated: false });
    expect(r.text).toBe([...brand[0]!, "", ...brand[1]!].join("\n"));    // page break = blank line; £ decoded
    expect(r.warnings.join(" ")).toMatch(/Check it before creating proposals/);
    expect(pdfReadsInFlight()).toBe(0);
  });

  it("refuses files that are not PDFs, empty files and files over 5 MB, before starting the reader", async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect((await failure(extractDocument({ name: "x.pdf", bytes: enc("<html>not a pdf</html>") })))?.message).toMatch(/doesn't look like a PDF/);
    expect(await failure(extractDocument({ name: "x.pdf", bytes: new Uint8Array() }))).toBeInstanceOf(DocumentError);
    const big = new Uint8Array(5 * 1024 * 1024 + 1); big.set(enc("%PDF-1.4\n"));
    expect((await failure(extractDocument({ name: "x.pdf", bytes: big })))?.message).toMatch(/larger than 5 MB/);
  });

  it("refuses encrypted PDFs, whether or not they need a password", async () => {
    for (const encryption of ["open", "password"] as const) {
      const e = await failure(extractDocument({ name: "locked.pdf", bytes: makePdf({ pages: brand, encryption }) }));
      expect(e, encryption).toBeInstanceOf(DocumentError);
      expect(e!.message).toMatch(/password-protected or encrypted/);
    }
  });

  it("the encrypted test PDF is really readable without a password, so the refusal above is the policy, not a parse failure", async () => {
    const r = await readPdfInWorker(makePdf({ pages: brand, encryption: "open" }));
    expect(r).toMatchObject({ kind: "refused", reason: "encrypted" });
  });

  it("accepts 50 pages and refuses 51", async () => {
    const pages = (n: number) => Array.from({ length: n }, (_, i) => [`Page ${i + 1} of the brand guide.`]);
    const ok = await extractDocument({ name: "fifty.pdf", bytes: makePdf({ pages: pages(50) }) });
    expect(ok.pages).toBe(50);
    expect(ok.text).toContain("Page 50 of the brand guide.");
    expect((await failure(extractDocument({ name: "long.pdf", bytes: makePdf({ pages: pages(51) }) })))?.message)
      .toMatch(/has 51 pages; the limit is 50/);
  });

  it("a PDF with no text layer (like a scan) and a damaged PDF get clear 'paste instead' messages", async () => {
    expect((await failure(extractDocument({ name: "scan.pdf", bytes: makePdf({ pages: [[], []] }) })))?.message)
      .toMatch(/No readable text was found in this PDF.*paste it below/);
    const damaged = new TextEncoder().encode("%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >>\ngarbage garbage\n%%EOF");
    expect((await failure(extractDocument({ name: "broken.pdf", bytes: damaged })))?.message).toMatch(/couldn't be read/);
    expect(pdfReadsInFlight()).toBe(0);
  });

  it("time limit: a read that takes too long is stopped and the reader process killed", async () => {
    const e = await failure(extractDocument({ name: "slow.pdf", bytes: makePdf({ pages: brand }) }, { pdfLimits: { timeoutMs: 1 } }));
    expect(e?.message).toMatch(/took too long/);
    expect(pdfReadsInFlight()).toBe(0);
  });

  it("memory limit: running out of memory ends only the reader process (this test process survives), with a clear message", async () => {
    const e = await failure(extractDocument({ name: "heavy.pdf", bytes: makePdf({ pages: brand }) }, { pdfLimits: { maxHeapMb: 2 } }));
    expect(e).toBeInstanceOf(DocumentError);
    expect(e!.message).toMatch(/too complex to read safely/);
    expect(pdfReadsInFlight()).toBe(0);
  });

  it("at most 2 PDFs are read at once; a third gets 'try again' and the first two still succeed", async () => {
    const bytes = makePdf({ pages: brand });
    const a = extractDocument({ name: "a.pdf", bytes });
    const b = extractDocument({ name: "b.pdf", bytes });
    expect(await failure(extractDocument({ name: "c.pdf", bytes }))).toBeInstanceOf(PdfBusyError);
    expect((await a).pages).toBe(2);
    expect((await b).pages).toBe(2);
    expect(pdfReadsInFlight()).toBe(0);
  });

  it("links, open actions and remote file references in a PDF never cause network or file access", async () => {
    const blocked: string[][] = [];
    const r = await extractDocument({ name: "links.pdf", bytes: makePdf({ pages: brand, links: true }) }, { onSandboxBlocked: (a) => blocked.push(a) });
    expect(r.pages).toBe(2);
    expect(blocked).toEqual([]);                       // no attempt was even made
    const raw = await readPdfInWorker(makePdf({ pages: brand, links: true }));
    expect(raw).toMatchObject({ kind: "ok", blocked: [] });
  });
});

describe("PDF reader isolation", () => {
  it("the Node permission model alone refuses files, network, child processes, threads and eval; no environment is passed", async () => {
    const probe = fileURLToPath(new URL("../helpers/permission-probe.mjs", import.meta.url));
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const child = fork(probe, [join(root, ".env"), join(root, "plan.md")], pdfReaderForkOptions(256, [probe]));
    const { results, env } = await new Promise<{ results: Record<string, string>; env: string[] }>((resolve, reject) => {
      child.once("message", (m) => resolve(m as never)); child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`probe exited early (${code})`)));
    });
    expect(Object.keys(results)).toHaveLength(9);
    for (const [what, outcome] of Object.entries(results)) {
      expect(outcome, what).toMatch(/^(ERR_ACCESS_DENIED|EvalError)/);
    }
    // Only the operating-system variables that Windows' process launcher (libuv) always adds; none of ours.
    const windowsAlwaysAdded = ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"];
    const allowed = process.platform === "win32" ? windowsAlwaysAdded : [];
    expect(env.filter((k) => !allowed.includes(k.toUpperCase()))).toEqual([]);
    expect(env.filter((k) => /KEY|SECRET|TOKEN|PASSWORD|DATABASE|ANTHROPIC|LINKEDIN|^LBE/i.test(k))).toEqual([]);
  });

  it("JavaScript guards (second layer) block and record network and file access, including ES module imports", async () => {
    const w = new Worker(new URL("../helpers/sandbox-probe.ts", import.meta.url), { env: {} });
    const { results, attempts } = await new Promise<{ results: Record<string, string>; attempts: string[] }>((resolve, reject) => {
      w.once("message", resolve); w.once("error", reject);
    });
    await w.terminate();
    for (const [what, outcome] of Object.entries(results)) expect(outcome, what).toMatch(/^blocked in the PDF reader/);
    expect(Object.keys(results)).toHaveLength(10);
    expect(attempts.length).toBeGreaterThanOrEqual(10);
  });
});
