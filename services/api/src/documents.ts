// P2-03 Document upload for Brand Brain proposals: turn an uploaded file into plain text that the owner reviews
// before it is sent to the extraction agent (POST /api/brain/ingest). Nothing is stored here and no AI call is made.
//
// The uploaded file is untrusted data:
//   * Only .pdf / .txt / .md / .markdown are accepted.
//   * Text files: at most 256 KB. Decoding is strict: UTF-8 (BOM removed), UTF-16 with a BOM, otherwise
//     Windows-1252 with a warning. Files with NUL bytes are refused as binary.
//   * PDFs (P2-03b, ADR-032): at most 5 MB and 50 pages, must start with "%PDF-", encrypted PDFs refused; read in an
//     isolated worker thread with memory and time limits and no network or file access (pdf-text.ts).
//   * The text is capped at the ingest limit (50,000 characters), cut at a paragraph or word boundary, with a
//     visible warning.
//   * Control characters are removed and line endings normalised. The text is never interpreted, rendered as markup
//     or followed as instructions: the extraction prompt treats it as data, and every proposal must quote it word
//     for word (validateExtraction), so proposals stay grounded in what the owner uploaded.
import { PDF_LIMITS, readPdfInWorker, type PdfLimits } from "./pdf-text.ts";

export const DOC_LIMITS = {
  maxBytes: 256 * 1024,      // text files; same as the API body limit for every other route
  maxPdfBytes: PDF_LIMITS.maxBytes,
  maxPdfPages: PDF_LIMITS.maxPages,
  maxChars: 50_000,          // same as POST /api/brain/ingest
  minChars: 20,
  maxNameChars: 200,
} as const;

export type DocumentKind = "text" | "markdown" | "pdf";
export interface ExtractedDocument {
  name: string;
  kind: DocumentKind;
  text: string;
  chars: number;             // characters kept
  original_chars: number;    // characters before the cap
  truncated: boolean;
  warnings: string[];
  pages?: number;            // PDFs only
}

/** A problem with the uploaded file that the user can fix (mapped to HTTP 422). */
export class DocumentError extends Error {}

const TEXT_EXT: Record<string, DocumentKind> = { ".txt": "text", ".md": "markdown", ".markdown": "markdown" };

/** Base name only, no path or control characters, at most 200 characters. */
export function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, DOC_LIMITS.maxNameChars);
  return cleaned;
}

function extensionOf(name: string): string {
  const m = /\.[a-z0-9]+$/i.exec(name);
  return m ? m[0].toLowerCase() : "";
}

function decode(bytes: Uint8Array, warnings: string[]): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  if (bytes.includes(0)) throw new DocumentError("This file doesn't look like a text file. Upload a .txt or .md file, or paste the text.");
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    warnings.push("The file was not saved as UTF-8, so it was read as Windows-1252. Check special characters such as £, € and quotes.");
    return new TextDecoder("windows-1252").decode(body);
  }
}

// Built from code points so the source stays ASCII (a literal U+2028 would end a regex literal).
const cp = (...codes: number[]) => codes.map((c) => String.fromCharCode(c)).join("");
const LINE_SEPARATORS = new RegExp(`[${cp(0x2028, 0x2029)}]`, "g");
/** C0 controls except tab/newline/CR, DEL, zero-width space and stray byte-order marks. */
const CONTROL = new RegExp(`[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f${cp(0x200b, 0xfeff)}]`, "g");

/** Normalise line endings, drop control characters (keep newlines and tabs), collapse long blank runs. */
export function normaliseText(s: string): string {
  return s
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(LINE_SEPARATORS, "\n")
    .replace(CONTROL, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Cut to at most `max` characters, preferring a paragraph break, then a line break, then a space. */
export function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  for (const sep of ["\n\n", "\n", " "]) {
    const at = head.lastIndexOf(sep);
    if (at >= max * 0.8) return head.slice(0, at).trimEnd();
  }
  return head;
}

const PASTE_INSTEAD = "Copy the text out of it and paste it below instead.";
const NO_NAME = "The file needs a name ending in .pdf, .txt or .md.";
const OTHER_TYPES = "Only .pdf, .txt and .md files can be uploaded. For other documents, copy the text and paste it below.";

/** Normalise, check there is enough text, cap at the ingest limit with a warning. */
function finish(name: string, kind: DocumentKind, raw: string, warnings: string[], noTextMessage: string,
                extra: Partial<ExtractedDocument> = {}): ExtractedDocument {
  const all = normaliseText(raw);
  if (all.length < DOC_LIMITS.minChars) throw new DocumentError(noTextMessage);
  const text = capText(all, DOC_LIMITS.maxChars);
  const truncated = text.length < all.length;
  if (truncated) {
    warnings.push(`Only the first ${text.length.toLocaleString("en-GB")} of ${all.length.toLocaleString("en-GB")} characters were kept. Upload the rest as a separate document.`);
  }
  return { name, kind, text, chars: text.length, original_chars: all.length, truncated, warnings, ...extra };
}

/** Text files (.txt / .md / .markdown); synchronous. Use extractDocument() for uploads, which also reads PDFs. */
export function extractDocumentText(file: { name: string; bytes: Uint8Array }): ExtractedDocument {
  const name = cleanFileName(file.name);
  if (!name) throw new DocumentError(NO_NAME);
  const ext = extensionOf(name);
  if (ext === ".pdf") throw new Error("PDFs are read by extractDocument(), not extractDocumentText()");
  const kind = TEXT_EXT[ext];
  if (!kind) throw new DocumentError(OTHER_TYPES);
  if (file.bytes.length === 0) throw new DocumentError("The file is empty.");
  if (file.bytes.length > DOC_LIMITS.maxBytes) {
    throw new DocumentError(`The file is larger than ${DOC_LIMITS.maxBytes / 1024} KB. Split it into smaller files or paste the relevant parts.`);
  }
  const warnings: string[] = [];
  return finish(name, kind, decode(file.bytes, warnings), warnings, "No readable text was found in the file.");
}

export interface ExtractOptions {
  pdfLimits?: Partial<PdfLimits>;
  /** Called if the PDF reader tried to open a connection or a file (blocked); for the security log. */
  onSandboxBlocked?: (attempts: string[]) => void;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];   // "%PDF-"

/** Any supported upload → plain text for review. PDFs are read in an isolated worker (pdf-text.ts). */
export async function extractDocument(file: { name: string; bytes: Uint8Array }, opts: ExtractOptions = {}): Promise<ExtractedDocument> {
  const name = cleanFileName(file.name);
  if (!name) throw new DocumentError(NO_NAME);
  if (extensionOf(name) !== ".pdf") return extractDocumentText(file);

  const limits = { ...PDF_LIMITS, ...opts.pdfLimits };
  const bytes = file.bytes;
  if (bytes.length === 0) throw new DocumentError("The file is empty.");
  if (bytes.length > limits.maxBytes) {
    throw new DocumentError(`The PDF is larger than ${limits.maxBytes / (1024 * 1024)} MB. Split it, or copy the relevant pages and paste them below.`);
  }
  if (!PDF_MAGIC.every((b, i) => bytes[i] === b)) {
    throw new DocumentError("This file doesn't look like a PDF. Upload a .pdf, .txt or .md file, or paste the text below.");
  }
  const r = await readPdfInWorker(bytes, limits);
  if ("blocked" in r && r.blocked.length > 0) opts.onSandboxBlocked?.(r.blocked);
  switch (r.kind) {
    case "ok": {
      const warnings = ["Text taken from a PDF can have broken lines, missing words or jumbled columns, and leaves out images and charts. Check it before creating proposals."];
      return finish(name, "pdf", r.pageTexts.join("\n\n"), warnings,
        `No readable text was found in this PDF. It may be a scan or a picture of text. ${PASTE_INSTEAD}`, { pages: r.pages });
    }
    case "refused":
      if (r.reason === "pages") {
        throw new DocumentError(`This PDF has ${r.pages} pages; the limit is ${limits.maxPages}. Split it, or copy the relevant pages and paste them below.`);
      }
      throw new DocumentError(`This PDF is password-protected or encrypted, so it can't be read. ${PASTE_INSTEAD}`);
    case "timeout":
      throw new DocumentError(`Reading this PDF took too long, so it was stopped. ${PASTE_INSTEAD}`);
    case "too_complex":
      throw new DocumentError(`This PDF is too complex to read safely. ${PASTE_INSTEAD}`);
    case "unreadable":
      throw new DocumentError(`This PDF couldn't be read; it may be damaged. ${PASTE_INSTEAD}`);
  }
}
