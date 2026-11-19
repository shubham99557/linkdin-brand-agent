// Brand templates (P5-02): turn the agent's visual brief + the owner's visual identity into a renderable
// carousel or single image. Pure functions — no I/O.
import { RenderInputError, validateCarousel, type CarouselInput, type RenderTheme } from "./render.ts";

/** Owner-approved visual identity, stored in the Brand Brain (section "identity", key "visual"). */
export interface VisualIdentity { background: string; foreground: string; accent: string; logoDataUri?: string }

/** Used until the owner sets real colours. Deliberately neutral; every preview made with it is labelled. */
export const PLACEHOLDER_IDENTITY: VisualIdentity = { background: "#1f2933", foreground: "#f5f7fa", accent: "#9aa5b1" };

export const VISUAL_IDENTITY_KEY = { section: "identity", key: "visual" } as const;
/** Logo size accepted from the dashboard (keeps Brand Brain payloads small; render allows more). */
export const MAX_LOGO_BYTES = 150 * 1024;

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Read the visual identity from Brand Brain entries; null when absent or malformed (→ placeholder). */
export function identityFromEntries(entries: Array<{ section: string; key: string; structured: Record<string, unknown> }>): VisualIdentity | null {
  const e = entries.find((x) => x.section === VISUAL_IDENTITY_KEY.section && x.key === VISUAL_IDENTITY_KEY.key);
  if (!e) return null;
  const s = e.structured;
  if (![s.background, s.foreground, s.accent].every((v) => typeof v === "string" && HEX.test(v))) return null;
  return {
    background: s.background as string, foreground: s.foreground as string, accent: s.accent as string,
    ...(typeof s.logo_data_uri === "string" && s.logo_data_uri ? { logoDataUri: s.logo_data_uri } : {}),
  };
}

/** Validate an identity the way the renderer will use it (throws RenderInputError). */
export function validateIdentity(identity: VisualIdentity, brandName: string): void {
  if (identity.logoDataUri !== undefined) {
    const b64 = identity.logoDataUri.split(",")[1] ?? "";
    if (Buffer.byteLength(b64, "base64") > MAX_LOGO_BYTES) throw new RenderInputError(`logo must be at most ${MAX_LOGO_BYTES / 1024} KB`);
  }
  validateCarousel({ theme: { brandName, ...identity }, slides: [{ title: "Check" }] });
}

/** Human-readable summary stored as the entry body (what agents read; never contains the logo data). */
export function identityBody(identity: VisualIdentity): string {
  return `Visual identity for images and carousels: background ${identity.background}, text ${identity.foreground}, accent ${identity.accent}. ` +
    `Logo: ${identity.logoDataUri ? "provided" : "not provided"}.`;
}

export function themeFor(identity: VisualIdentity | null, brandName: string): { theme: RenderTheme; placeholder: boolean } {
  const id = identity ?? PLACEHOLDER_IDENTITY;
  return { theme: { brandName: brandName.slice(0, 60) || "Brand", ...id }, placeholder: identity === null };
}

/** Minimal shape of the Creative Brief Specialist's output (services/agents CreativeOutputSchema). */
export interface VisualBrief {
  format: "single_image" | "document_carousel" | "text_only";
  headline: string;
  slides: Array<{ title: string; text: string }>;
}

const clip = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};

export const SIZES = { carousel: { width: 1080, height: 1350 }, single: { width: 1080, height: 1080 } } as const;

/**
 * Map a visual brief to a renderable input. Model text is clipped to the template limits (never rejected for
 * length), so a long brief still previews. Returns null for text-only posts.
 */
export function briefToCarousel(brief: VisualBrief, theme: RenderTheme, opts: { footer?: string } = {}): CarouselInput | null {
  if (!brief || brief.format === "text_only") return null;
  const headline = clip(brief.headline || brief.slides[0]?.title || "", 120);
  if (!headline) return null;
  const footer = opts.footer ? clip(opts.footer, 80) : undefined;
  if (brief.format === "single_image") {
    const first = brief.slides[0];
    return { theme, ...SIZES.single, ...(footer ? { footer } : {}),
      slides: [{ title: headline, ...(first?.text ? { text: clip(first.text, 300) } : {}) }] };
  }
  const body = brief.slides.slice(0, 9).map((s) => ({ title: clip(s.title || headline, 120), ...(s.text ? { text: clip(s.text, 700) } : {}) }));
  return { theme, ...SIZES.carousel, ...(footer ? { footer } : {}), slides: [{ title: headline }, ...body] };
}
