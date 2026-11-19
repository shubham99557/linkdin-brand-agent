// P5-02: brand templates — visual brief → renderable carousel/single image, visual identity handling.
import { describe, expect, it } from "vitest";
import {
  briefToCarousel, identityBody, identityFromEntries, MAX_LOGO_BYTES, PLACEHOLDER_IDENTITY, SIZES, themeFor, validateCarousel,
  validateIdentity, type VisualBrief,
} from "@lbe/render";

const theme = themeFor(null, "ActTrident").theme;
const brief = (over: Partial<VisualBrief> = {}): VisualBrief => ({
  format: "document_carousel", headline: "Spot phishing fast", slides: [{ title: "Check sender", text: "Look at the address." }, { title: "Pause", text: "Urgency is a tactic." }], ...over });

describe("briefToCarousel", () => {
  it("document carousel → cover slide + brief slides at 1080×1350", () => {
    const c = briefToCarousel(brief(), theme)!;
    expect(c.slides.map((s) => s.title)).toEqual(["Spot phishing fast", "Check sender", "Pause"]);
    expect({ width: c.width, height: c.height }).toEqual(SIZES.carousel);
  });
  it("single image → one square slide with the headline", () => {
    const c = briefToCarousel(brief({ format: "single_image" }), theme)!;
    expect(c.slides).toHaveLength(1);
    expect(c.slides[0]!.title).toBe("Spot phishing fast");
    expect({ width: c.width, height: c.height }).toEqual(SIZES.single);
  });
  it("text-only posts have no visual", () => {
    expect(briefToCarousel(brief({ format: "text_only" }), theme)).toBeNull();
    expect(briefToCarousel(brief({ headline: "", slides: [] }), theme)).toBeNull();
  });
  it("over-long model output is clipped to the template limits, never rejected", () => {
    const c = briefToCarousel(brief({ headline: "H".repeat(500), slides: Array.from({ length: 15 }, () => ({ title: "T".repeat(300), text: "x ".repeat(1000) })) }), theme)!;
    expect(() => validateCarousel(c)).not.toThrow();
    expect(c.slides).toHaveLength(10);                                     // cover + 9
    expect(c.slides[0]!.title.endsWith("…")).toBe(true);
  });
});

describe("visual identity", () => {
  const entry = (structured: Record<string, unknown>) => [{ section: "identity", key: "visual", structured }];
  it("reads a valid identity from the Brand Brain entry; malformed or missing → null (placeholder)", () => {
    expect(identityFromEntries(entry({ background: "#000000", foreground: "#ffffff", accent: "#ff0000" })))
      .toEqual({ background: "#000000", foreground: "#ffffff", accent: "#ff0000" });
    expect(identityFromEntries(entry({ background: "black", foreground: "#ffffff", accent: "#ff0000" }))).toBeNull();
    expect(identityFromEntries([{ section: "identity", key: "main", structured: {} }])).toBeNull();
    expect(themeFor(null, "X")).toMatchObject({ placeholder: true, theme: PLACEHOLDER_IDENTITY });
  });
  it("validation refuses remote logos and oversize logos", () => {
    const ok = { background: "#000000", foreground: "#ffffff", accent: "#ff0000" };
    expect(() => validateIdentity({ ...ok, logoDataUri: "https://example.com/logo.png" }, "X")).toThrow();
    const big = `data:image/png;base64,${Buffer.alloc(MAX_LOGO_BYTES + 10).toString("base64")}`;
    expect(() => validateIdentity({ ...ok, logoDataUri: big }, "X")).toThrow(/at most/);
    expect(() => validateIdentity(ok, "X")).not.toThrow();
  });
  it("the stored body (what agents read) never contains the logo data", () => {
    const body = identityBody({ background: "#000000", foreground: "#ffffff", accent: "#ff0000", logoDataUri: "data:image/png;base64,AAAA" });
    expect(body).toContain("#ff0000");
    expect(body).toContain("Logo: provided");
    expect(body).not.toContain("base64");
  });
});
