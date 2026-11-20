// P2-03b / ADR-032: PDF text extraction runs here, in a separate Node process started by pdf-text.ts with the Node
// permission model (it may read only this reader's own code; no network, no files, no child processes, no worker
// threads, no eval), a memory limit and a time limit. A hostile or broken PDF can at worst crash or stall this
// process, which is then killed; the API process is unaffected.
//
// Protocol (IPC): the child sends "ready" once PDF.js is loaded and the guards are in place, receives the PDF bytes,
// sends one result and exits. Plain Node TypeScript (erasable syntax only): Node runs this file directly.
import { installSandboxGuards } from "./pdf-sandbox.ts";
import type { PdfChildInput, PdfChildMessage } from "./pdf-text.ts";

type Unpdf = typeof import("unpdf");
const send = (m: PdfChildMessage) => process.send!(m);

// The parent passes the exact location of the PDF library, so nothing outside the allowed paths is looked up.
const { getResolvedPDFJS } = (await import(process.argv[2]!)) as Unpdf;
const pdfjs = await getResolvedPDFJS();       // load PDF.js first (loading reads module files) ...
const blocked = installSandboxGuards();       // ... then record and refuse any file or network access

process.once("message", async (input: PdfChildInput) => {
  send(await extract(input));
  process.disconnect?.();
});
send({ kind: "ready" });

async function extract(input: PdfChildInput): Promise<PdfChildMessage> {
  // Bytes only: no URL for fonts, character maps, colour profiles or image decoders, so nothing is fetched or read.
  // No system fonts, no font loading, no WebAssembly, no XFA forms, no canvas or image decoding (text only).
  const task = pdfjs.getDocument({
    data: input.bytes,
    useSystemFonts: false, disableFontFace: true, useWasm: false, enableXfa: false,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    disableAutoFetch: true, disableStream: true, disableRange: true,
    verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    const { info } = await pdf.getMetadata();
    if ((info as { EncryptFilterName?: string | null }).EncryptFilterName) return { kind: "refused", reason: "encrypted", blocked };
    if (pdf.numPages > input.maxPages) return { kind: "refused", reason: "pages", pages: pdf.numPages, blocked };
    const pageTexts: string[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {          // one page at a time keeps memory use flat
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pageTexts.push(content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : "")).join("")
        .replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n"));
      page.cleanup();
    }
    return { kind: "ok", pages: pdf.numPages, pageTexts, blocked };
  } catch (e) {
    if ((e as { name?: string }).name === "PasswordException") return { kind: "refused", reason: "password", blocked };
    return { kind: "unreadable", blocked };
  } finally {
    await task.destroy();
  }
}
