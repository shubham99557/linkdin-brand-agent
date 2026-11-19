// P5-01: render service — PNG slides + PDF carousel, ADR-029 conditions (no network, data URIs only,
// text never parsed as markup, input limits, deterministic output).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertNoExternalResources, buildSlideTree, LIMITS, RenderInputError, renderCarousel, renderSlidePng, validateCarousel, type CarouselInput,
} from "@lbe/render";

const theme = { brandName: "Test Brand", background: "#0b1f3a", foreground: "#ffffff", accent: "#3fb4ff" };
const base: CarouselInput = { theme, slides: [{ title: "Cover title", text: "Intro text" }, { title: "Second", text: "Body" }], footer: "Footer" };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const pngSize = (b: Uint8Array) => {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
};
// 1×1 transparent PNG
const LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("render service", () => {
  it("renders a PNG at the LinkedIn portrait size (1080×1350)", async () => {
    const png = await renderSlidePng(base, 0);
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(pngSize(png)).toEqual({ width: 1080, height: 1350 });
  }, 60_000);

  it("is deterministic: same input → identical bytes; different text → different bytes", async () => {
    const a = await renderSlidePng(base, 1);
    const b = await renderSlidePng(base, 1);
    const c = await renderSlidePng({ ...base, slides: [base.slides[0]!, { title: "Different", text: "Body" }] }, 1);
    expect(sha(a)).toBe(sha(b));
    expect(sha(a)).not.toBe(sha(c));
  }, 60_000);

  // Satori looks up (DNS) and fetches any non-data image source, and keeps its own reference to fetch — so
  // spying on fetch cannot prove "no network". The guarantee is structural: nothing but data: URIs ever
  // reaches the renderer. These tests check exactly that.
  it("no external reference reaches the renderer: markup in text stays text; only the data: logo is an image", async () => {
    const input: CarouselInput = { ...base, theme: { ...theme, logoDataUri: LOGO },
      slides: [{ title: '<img src="https://evil.example/x.png">', text: "<script>alert(1)</script> url(https://evil.example/t.png)" }] };
    const tree = buildSlideTree(input, 0);
    const refs: string[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      const p = (n as { type: string; props: Record<string, unknown> }).props;
      if (typeof p.src === "string") refs.push(p.src);
      walk(p.children);
    };
    walk(tree);
    expect(refs).toEqual([LOGO]);                                          // the only image is the inline logo
    expect(JSON.stringify(tree)).toContain('"children":"<img src=\\"https://evil.example/x.png\\">"');   // a text node
    expect(() => assertNoExternalResources(tree)).not.toThrow();
    const { pngs } = await renderCarousel(input);
    expect(pngs).toHaveLength(1);
  }, 60_000);

  it("the last-line check refuses any non-data resource in an element tree", () => {
    const img = (src: string) => ({ type: "div", props: { children: [{ type: "img", props: { src } }] } });
    for (const src of ["https://example.com/a.png", "//example.com/a.png", "file:///c:/x.png", "/local.png"]) {
      expect(() => assertNoExternalResources(img(src)), src).toThrow(/external resource refused/);
    }
    expect(() => assertNoExternalResources({ type: "div", props: { style: { backgroundImage: "url(https://x.example/a.png)" } } })).toThrow(/external/);
    expect(() => assertNoExternalResources(img(LOGO))).not.toThrow();
  });

  it("refuses remote, file and script logo sources, and SVG logos with external references", () => {
    for (const logoDataUri of ["https://example.com/logo.png", "http://127.0.0.1/x.png", "file:///etc/passwd",
      "javascript:alert(1)", "data:text/html;base64,PGI+", "data:image/png,notbase64"]) {
      expect(() => validateCarousel({ ...base, theme: { ...theme, logoDataUri } }), logoDataUri).toThrow(RenderInputError);
    }
    const evilSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/a.png"/></svg>').toString("base64");
    expect(() => validateCarousel({ ...base, theme: { ...theme, logoDataUri: `data:image/svg+xml;base64,${evilSvg}` } })).toThrow(/external/);
    expect(() => validateCarousel({ ...base, theme: { ...theme, logoDataUri: LOGO } })).not.toThrow();
  });

  it("enforces input limits and colour format", () => {
    expect(() => validateCarousel({ ...base, slides: [] })).toThrow(/1-20 slides/);
    expect(() => validateCarousel({ ...base, slides: Array.from({ length: LIMITS.slides + 1 }, () => ({ title: "t" })) })).toThrow(/slides/);
    expect(() => validateCarousel({ ...base, slides: [{ title: "x".repeat(LIMITS.title + 1) }] })).toThrow(/title/);
    expect(() => validateCarousel({ ...base, slides: [{ title: "t", text: "x".repeat(LIMITS.text + 1) }] })).toThrow(/too long/);
    expect(() => validateCarousel({ ...base, theme: { ...theme, accent: "red" } })).toThrow(/#rrggbb/);
    expect(() => validateCarousel({ ...base, theme: { ...theme, background: "#fff;}" } })).toThrow(/#rrggbb/);
    expect(() => validateCarousel({ ...base, width: 10_000 })).toThrow(/size/);
  });

  it("assembles a PDF with one page per slide, within LinkedIn's size limit", async () => {
    const slides = Array.from({ length: 5 }, (_, i) => ({ title: `Slide ${i + 1}`, text: "Body text for the slide." }));
    const { pngs, pdf } = await renderCarousel({ ...base, slides }, { title: "Test carousel", createdAt: new Date("2026-01-01T00:00:00Z") });
    expect(pngs).toHaveLength(5);
    const text = Buffer.from(pdf).toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text.match(/\/Type \/Page\b(?!s)/g)?.length).toBe(5);
    expect(text).toContain("/Count 5");
    expect(pdf.byteLength).toBeLessThan(LIMITS.pdfBytes);
  }, 120_000);
});
