// Creative Studio renderer (P5-01, ADR-029): deterministic brand templates → PNG slides → PDF document carousel.
//
// Security conditions (ADR-029):
//  1. Rasteriser behind this module's interface (resvg WASM today; swappable).
//  2. No network or file access during rendering: images only as validated data: URIs; Satori gets no
//     `loadAdditionalAsset` hook, so nothing is ever fetched. Tests assert fetch is never called.
//  3. Untrusted text (drafts) is passed as text nodes, never parsed as markup; strict length/count limits.
//  4. pdfkit receives in-memory Buffers only (never paths or URLs).
//  5. Deterministic: embedded fonts only (Inter, OFL-1.1), no system fonts.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import PDFDocument from "pdfkit";
import satori from "satori";

const require = createRequire(import.meta.url);

export interface RenderTheme {
  brandName: string;
  background: string;   // #rrggbb
  foreground: string;   // #rrggbb
  accent: string;       // #rrggbb
  /** Optional logo as a data: URI (PNG, JPEG or SVG). Remote URLs are refused. */
  logoDataUri?: string;
}

export interface Slide { title: string; text?: string }

export interface CarouselInput {
  theme: RenderTheme;
  slides: Slide[];
  /** Footer text on every slide, e.g. a short call to action. */
  footer?: string;
  width?: number;
  height?: number;
}

export const LIMITS = {
  slides: 20,                 // LinkedIn allows 300 pages; our carousels stay short
  title: 120,
  text: 700,
  footer: 80,
  brandName: 60,
  logoBytes: 2 * 1024 * 1024,
  pdfBytes: 100 * 1024 * 1024, // LinkedIn document limit
} as const;

/** Portrait 4:5 is LinkedIn's recommended document/carousel shape. */
export const DEFAULT_SIZE = { width: 1080, height: 1350 } as const;

export class RenderInputError extends Error {
  constructor(message: string) { super(message); this.name = "RenderInputError"; }
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const DATA_URI = /^data:image\/(png|jpeg|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/;

export function validateCarousel(input: CarouselInput): void {
  const t = input.theme;
  if (!t || typeof t.brandName !== "string" || t.brandName.trim().length === 0 || t.brandName.length > LIMITS.brandName) {
    throw new RenderInputError(`brand name is required (max ${LIMITS.brandName} characters)`);
  }
  for (const k of ["background", "foreground", "accent"] as const) {
    if (!HEX.test(t[k] ?? "")) throw new RenderInputError(`${k} colour must be #rrggbb`);
  }
  if (t.logoDataUri !== undefined) {
    const m = DATA_URI.exec(t.logoDataUri);
    if (!m) throw new RenderInputError("logo must be a data:image/(png|jpeg|svg+xml);base64 URI — remote or file URLs are not allowed");
    if (Buffer.byteLength(m[2]!, "base64") > LIMITS.logoBytes) throw new RenderInputError("logo is too large (max 2 MB)");
    if (m[1] === "svg+xml" && /(href|src)\s*=\s*["'](?!#|data:)/i.test(Buffer.from(m[2]!, "base64").toString("utf8"))) {
      throw new RenderInputError("SVG logo must not reference external resources");
    }
  }
  if (!Array.isArray(input.slides) || input.slides.length === 0 || input.slides.length > LIMITS.slides) {
    throw new RenderInputError(`a carousel needs 1-${LIMITS.slides} slides`);
  }
  input.slides.forEach((s, i) => {
    if (typeof s.title !== "string" || s.title.trim().length === 0 || s.title.length > LIMITS.title) {
      throw new RenderInputError(`slide ${i + 1}: title is required (max ${LIMITS.title} characters)`);
    }
    if (s.text !== undefined && (typeof s.text !== "string" || s.text.length > LIMITS.text)) {
      throw new RenderInputError(`slide ${i + 1}: text is too long (max ${LIMITS.text} characters)`);
    }
  });
  if (input.footer !== undefined && input.footer.length > LIMITS.footer) throw new RenderInputError(`footer is too long (max ${LIMITS.footer})`);
  const w = input.width ?? DEFAULT_SIZE.width, h = input.height ?? DEFAULT_SIZE.height;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 400 || h < 400 || w > 2400 || h > 3000) {
    throw new RenderInputError("size must be between 400×400 and 2400×3000 pixels");
  }
}

// ---------------------------------------------------------------- engine (lazy, once per process)
let engine: Promise<{ fonts: Array<{ name: string; data: Buffer; weight: 400 | 700; style: "normal" }> }> | undefined;
function loadEngine() {
  engine ??= (async () => {
    await initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
    const font = (weight: 400 | 700) => ({
      name: "Inter", weight, style: "normal" as const,
      data: readFileSync(require.resolve(`@fontsource/inter/files/inter-latin-${weight}-normal.woff`)),
    });
    return { fonts: [font(400), font(700)] };
  })();
  return engine;
}

// ---------------------------------------------------------------- template (plain element objects; no JSX, no HTML parsing)
type Node = { type: string; props: Record<string, unknown> & { children?: unknown; style?: Record<string, unknown> } };
const el = (type: string, style: Record<string, unknown>, children?: unknown, extra: Record<string, unknown> = {}): Node =>
  ({ type, props: { style, children, ...extra } });

function slideTree(input: CarouselInput, index: number, w: number, h: number): Node {
  const { theme } = input;
  const s = input.slides[index]!;
  const cover = index === 0;
  const pad = Math.round(w * 0.074);
  const header = el("div", { display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }, [
    el("div", { display: "flex", alignItems: "center", gap: 20 }, [
      ...(theme.logoDataUri ? [el("img", { width: 64, height: 64, objectFit: "contain" }, undefined, { src: theme.logoDataUri, width: 64, height: 64 })] : []),
      el("div", { fontSize: 34, fontWeight: 700, color: theme.accent }, theme.brandName),
    ]),
    // Page counter only for multi-slide carousels ("1 / 1" on a single image is noise).
    ...(input.slides.length > 1 ? [el("div", { fontSize: 30, color: theme.foreground, opacity: 0.7 }, `${index + 1} / ${input.slides.length}`)] : []),
  ]);
  const body = el("div", { display: "flex", flexDirection: "column", gap: 40, flexGrow: 1, justifyContent: cover ? "center" : "flex-start", paddingTop: cover ? 0 : 80 }, [
    el("div", { fontSize: cover ? 84 : 64, fontWeight: 700, lineHeight: 1.15, color: theme.foreground }, s.title),
    ...(s.text ? [el("div", { fontSize: cover ? 44 : 40, lineHeight: 1.4, color: theme.foreground, opacity: 0.9 }, s.text)] : []),
  ]);
  const footer = el("div", { display: "flex", flexDirection: "column", gap: 24, width: "100%" }, [
    el("div", { width: 160, height: 10, backgroundColor: theme.accent, borderRadius: 5 }),
    ...(input.footer ? [el("div", { fontSize: 30, color: theme.foreground, opacity: 0.8 }, input.footer)] : []),
  ]);
  // The content box gets an explicit size inside the padding: padding on a fixed-size box would otherwise push
  // content off the right and bottom edges of the canvas (seen in the first visual check).
  return el("div", { display: "flex", width: w, height: h, backgroundColor: theme.background, fontFamily: "Inter" }, [
    el("div", { display: "flex", flexDirection: "column", width: w - 2 * pad, height: h - 2 * pad, marginLeft: pad, marginTop: pad },
      [header, body, footer]),
  ]);
}

/**
 * Defence in depth for ADR-029 condition 2. Satori resolves (DNS) and fetches any non-data image source, so a
 * single stray URL would mean network traffic. Validation already refuses such input; this walks the final
 * element tree right before rendering and refuses ANY resource reference that is not an inline data: URI.
 */
export function assertNoExternalResources(node: unknown, path = "root"): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((n, i) => assertNoExternalResources(n, `${path}[${i}]`)); return; }
  const props = (node as { props?: Record<string, unknown> }).props ?? {};
  for (const key of ["src", "href", "xlinkHref"]) {
    const v = props[key];
    if (v !== undefined && !(typeof v === "string" && v.startsWith("data:"))) {
      throw new RenderInputError(`external resource refused at ${path}.${key}`);
    }
  }
  const style = (props.style ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(style)) {
    if (typeof v === "string" && /url\(/i.test(v) && !/url\(\s*["']?data:/i.test(v)) throw new RenderInputError(`external resource refused at ${path}.style.${k}`);
  }
  assertNoExternalResources(props.children, `${path}.children`);
}

/** Exposed for tests: the element tree for one slide (no rendering). */
export function buildSlideTree(input: CarouselInput, index: number): unknown {
  validateCarousel(input);
  return slideTree(input, index, input.width ?? DEFAULT_SIZE.width, input.height ?? DEFAULT_SIZE.height);
}

// ---------------------------------------------------------------- public API
/** Render one slide of the carousel to PNG bytes. */
export async function renderSlidePng(input: CarouselInput, index: number): Promise<Uint8Array> {
  validateCarousel(input);
  if (!Number.isInteger(index) || index < 0 || index >= input.slides.length) throw new RenderInputError("slide index out of range");
  const { fonts } = await loadEngine();
  const w = input.width ?? DEFAULT_SIZE.width, h = input.height ?? DEFAULT_SIZE.height;
  const tree = slideTree(input, index, w, h);
  assertNoExternalResources(tree);
  const svg = await satori(tree as never, { width: w, height: h, fonts });
  const resvg = new Resvg(svg, { fitTo: { mode: "original" }, font: { loadSystemFonts: false } });
  try {
    return resvg.render().asPng();
  } finally {
    resvg.free();
  }
}

/** Render every slide to PNG and assemble a PDF document carousel (one slide per page). */
export async function renderCarousel(input: CarouselInput, meta: { title?: string; createdAt?: Date } = {}):
  Promise<{ pngs: Uint8Array[]; pdf: Uint8Array }> {
  validateCarousel(input);
  const pngs: Uint8Array[] = [];
  for (let i = 0; i < input.slides.length; i++) pngs.push(await renderSlidePng(input, i));
  const w = input.width ?? DEFAULT_SIZE.width, h = input.height ?? DEFAULT_SIZE.height;
  const pdf = await new Promise<Uint8Array>((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false, margin: 0, info: {
      Title: (meta.title ?? input.slides[0]!.title).slice(0, 200), Author: input.theme.brandName,
      Creator: "LinkedIn Brand Engine", Producer: "LinkedIn Brand Engine", CreationDate: meta.createdAt ?? new Date(),
    } });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    doc.on("error", reject);
    for (const png of pngs) doc.addPage({ size: [w, h], margin: 0 }).image(Buffer.from(png), 0, 0, { width: w, height: h });
    doc.end();
  });
  if (pdf.byteLength > LIMITS.pdfBytes) throw new RenderInputError("the PDF is larger than LinkedIn's 100 MB limit");
  return { pngs, pdf };
}
