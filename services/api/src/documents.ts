// P2-03 Document upload for Brand Brain proposals: turn an uploaded file into plain text that the owner reviews
// before it is sent to the extraction agent (POST /api/brain/ingest). Nothing is stored here and no AI call is made.
//
// The uploaded file is untrusted data:
//   * Only .txt / .md / .markdown are accepted. PDF needs a parser dependency, which is pending the owner's
//     approval (ADR-032), so a PDF gets a clear message instead.
//   * Size is capped by the API body limit (256 KB) and here; the text is capped at the ingest limit
//     (50,000 characters), cut at a paragraph or word boundary, with a visible warning.
//   * Decoding is strict: UTF-8 (BOM removed), UTF-16 with a BOM, otherwise Windows-1252 with a warning. Files with
//     NUL bytes are refused as binary.
//   * Control characters are removed and line endings normalised. The text is never interpreted, rendered as markup
//     or followed as instructions: the extraction prompt treats it as data, and every proposal must quote it word
//     for word (validateExtraction), so proposals stay grounded in what the owner uploaded.

export const DOC_LIMITS = {
  maxBytes: 256 * 1024,      // same as the API body limit
  maxChars: 50_000,          // same as POST /api/brain/ingest
  minChars: 20,
  maxNameChars: 200,
} as const;

export type DocumentKind = "text" | "markdown";
export interface ExtractedDocument {
  name: string;
  kind: DocumentKind;
  text: string;
  chars: number;             // characters kept
  original_chars: number;    // characters before the cap
  truncated: boolean;
  warnings: string[];
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

export function extractDocumentText(file: { name: string; bytes: Uint8Array }): ExtractedDocument {
  const name = cleanFileName(file.name);
  if (!name) throw new DocumentError("The file needs a name ending in .txt or .md.");
  const ext = extensionOf(name);
  if (ext === ".pdf") {
    throw new DocumentError("PDF upload is not switched on yet. Open the PDF, copy the text and paste it below, or save it as a .txt file.");
  }
  const kind = TEXT_EXT[ext];
  if (!kind) throw new DocumentError("Only .txt and .md files can be uploaded. For other documents, copy the text and paste it below.");
  if (file.bytes.length === 0) throw new DocumentError("The file is empty.");
  if (file.bytes.length > DOC_LIMITS.maxBytes) {
    throw new DocumentError(`The file is larger than ${DOC_LIMITS.maxBytes / 1024} KB. Split it into smaller files or paste the relevant parts.`);
  }
  const warnings: string[] = [];
  const all = normaliseText(decode(file.bytes, warnings));
  if (all.length < DOC_LIMITS.minChars) throw new DocumentError("No readable text was found in the file.");
  const text = capText(all, DOC_LIMITS.maxChars);
  const truncated = text.length < all.length;
  if (truncated) {
    warnings.push(`Only the first ${text.length.toLocaleString("en-GB")} of ${all.length.toLocaleString("en-GB")} characters were kept. Upload the rest as a separate document.`);
  }
  return { name, kind, text, chars: text.length, original_chars: all.length, truncated, warnings };
}
