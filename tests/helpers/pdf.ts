// Builds small, valid PDFs for tests (P2-03b), with no dependency: text pages in a standard font (not embedded),
// image-like pages with no text (like a scan), optional link/remote actions that must never be followed, and the
// standard PDF password protection (RC4, revision 2), either opening without a password or needing one.
import { createHash } from "node:crypto";

export interface TestPdf {
  /** Lines of text per page. An empty array is a page with only a grey box and no text (like a scanned page). */
  pages: string[][];
  /** "open": encrypted but opens without a password (copy restrictions only). "password": needs a password. */
  encryption?: "open" | "password";
  /** Adds a link to a web address, an open action pointing at a URL and a remote document reference. */
  links?: boolean;
}

const PAD = Buffer.from("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex");
const md5 = (...parts: Uint8Array[]) => { const h = createHash("md5"); for (const p of parts) h.update(p); return h.digest(); };
const padded = (pw: string) => Buffer.concat([Buffer.from(pw, "latin1"), PAD]).subarray(0, 32);

function rc4(key: Uint8Array, data: Uint8Array): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i]! + key[i % key.length]!) & 255; [s[i], s[j]] = [s[j]!, s[i]!]; }
  const out = Buffer.alloc(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + s[i]!) & 255; [s[i], s[j]] = [s[j]!, s[i]!];
    out[k] = data[k]! ^ s[(s[i]! + s[j]!) & 255]!;
  }
  return out;
}

const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

export function makePdf(o: TestPdf): Uint8Array {
  type Obj = { dict: string; stream?: Buffer };
  const objs: Obj[] = [];                 // object number = index + 1
  const add = (o: Obj) => { objs.push(o); return objs.length; };
  const catalog = add({ dict: "" });
  const pagesObj = add({ dict: "" });
  const font = add({ dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" });
  const link = o.links ? add({ dict: "<< /Type /Annot /Subtype /Link /Rect [72 700 300 720] /A << /S /URI /URI (http://127.0.0.1:9/track) >> >>" }) : 0;
  const kids: number[] = [];
  for (const lines of o.pages) {
    const content = lines.length
      ? `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`
      : "0.8 g 72 300 468 400 re f";
    const c = add({ dict: "", stream: Buffer.from(content, "latin1") });
    kids.push(add({ dict: `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R${link ? ` /Annots [${link} 0 R]` : ""} >>` }));
  }
  const actions = o.links ? " /OpenAction << /S /URI /URI (http://127.0.0.1:9/opened) >> /Names << /EmbeddedFiles << /Names [(remote) << /Type /Filespec /FS /URL /F (http://127.0.0.1:9/remote.pdf) >>] >> >>" : "";
  objs[catalog - 1] = { dict: `<< /Type /Catalog /Pages ${pagesObj} 0 R${actions} >>` };
  objs[pagesObj - 1] = { dict: `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>` };

  // Standard security handler, revision 2 (40-bit RC4), owner password "owner".
  const id = md5(Buffer.from(`test-pdf-${o.pages.length}-${o.encryption ?? "none"}`));
  let fileKey: Buffer | null = null;
  let encryptObj = 0;
  if (o.encryption) {
    const userPw = o.encryption === "password" ? "secret" : "";
    const P = -44;
    const O = rc4(md5(padded("owner")).subarray(0, 5), padded(userPw));
    const p = Buffer.alloc(4); p.writeInt32LE(P);
    fileKey = md5(padded(userPw), O, p, id).subarray(0, 5);
    const U = rc4(fileKey, PAD);
    encryptObj = add({ dict: `<< /Filter /Standard /V 1 /R 2 /O <${O.toString("hex")}> /U <${U.toString("hex")}> /P ${P} >>` });
  }

  const chunks: Buffer[] = [];
  let pos = 0;
  const push = (b: Buffer) => { chunks.push(b); pos += b.length; };
  push(Buffer.from("%PDF-1.4\n%âãÏÓ\n", "latin1"));
  const offsets: number[] = [];
  objs.forEach((obj, i) => {
    const n = i + 1;
    offsets[n] = pos;
    if (obj.stream === undefined) { push(Buffer.from(`${n} 0 obj\n${obj.dict}\nendobj\n`, "latin1")); return; }
    let data = obj.stream;
    if (fileKey && n !== encryptObj) {
      const objKey = md5(fileKey, Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0])).subarray(0, 10);
      data = rc4(objKey, data);
    }
    push(Buffer.from(`${n} 0 obj\n<< /Length ${data.length} >>\nstream\n`, "latin1"));
    push(data);
    push(Buffer.from("\nendstream\nendobj\n", "latin1"));
  });
  const xref = pos;
  let table = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= objs.length; n++) table += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  const idHex = id.toString("hex");
  table += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R${encryptObj ? ` /Encrypt ${encryptObj} 0 R` : ""} /ID [<${idHex}> <${idHex}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  push(Buffer.from(table, "latin1"));
  return new Uint8Array(Buffer.concat(chunks));
}
