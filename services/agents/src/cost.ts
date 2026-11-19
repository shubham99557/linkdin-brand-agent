/**
 * Cost estimation for budget enforcement (USD).
 *
 * VERIFIED 2026-11-19 (P3-01) against Anthropic's official pricing page (Claude API, first-party):
 *   https://platform.claude.com/docs/en/about-claude/pricing
 *   https://platform.claude.com/docs/en/about-claude/models/overview
 * Applies to: global routing (we never send `inference_geo: "us"`, which would cost 1.1×), standard speed (no
 * fast mode), no prompt caching, no Batch API. Every input token is counted at the full base input price, so
 * estimates err on the HIGH side — a budget is never under-counted.
 */
export const PRICING_SOURCE = {
  url: "https://platform.claude.com/docs/en/about-claude/pricing",
  checkedOn: "2026-11-19",
} as const;

/** USD per million tokens (base input / output). */
export const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },        // default model of the agents and drafter
  "claude-sonnet-5-5": { input: 2, output: 10 },
  // Haiku 5.5 is tiered: $0.10/$0.50 for prompts up to 100k tokens, $0.50/$2.50 above. Usage reaches this
  // function summed over several calls (e.g. multi-turn research), so the prompt size of each call is unknown:
  // use the higher tier so the budget can never be exceeded through under-estimation.
  "claude-haiku-5-5": { input: 0.5, output: 2.5 },
  "claude-fable-5-2": { input: 8, output: 40 },
  // Server-side fallback target: with `fallbacks: "default"`, cyber-category refusals (our domain!) are re-run on
  // Claude Opus 4.8, billed at its own (higher) rates.
  "claude-opus-4-8": { input: 5, output: 25 },
};

/** Web search server tool: $10 per 1,000 searches; search results are additionally billed as input tokens (already in usage). Verified 2026-11-19. */
export const WEB_SEARCH_USD_PER_1K = 10;

/** `servedBy`: the model that actually answered (differs from the requested model when a server-side fallback ran). */
export interface Usage { inputTokens: number; outputTokens: number; webSearchRequests?: number; servedBy?: string }

export function estimateCostUsd(model: string, usage: Usage | undefined): number {
  if (!usage) return 0;
  const requested = PRICING[model];
  if (!requested) return Number.POSITIVE_INFINITY;   // unknown model: refuse to treat as free
  let p = requested;
  let attempts = 1;
  if (usage.servedBy && usage.servedBy !== model) {
    // A fallback ran: the declined attempt is billed at the requested model's rates AND the rescue at the
    // fallback's. Usage does not split the two, so take the dearer price for both — a deliberate upper bound.
    const fallback = PRICING[usage.servedBy];
    if (!fallback) return Number.POSITIVE_INFINITY;
    p = { input: Math.max(requested.input, fallback.input), output: Math.max(requested.output, fallback.output) };
    attempts = 2;
  }
  return attempts * (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000
    + ((usage.webSearchRequests ?? 0) * WEB_SEARCH_USD_PER_1K) / 1000;
}

export class Budget {
  private spent = 0;
  readonly byStep: Array<{ step: string; model: string; usd: number }> = [];
  constructor(readonly maxUsd: number | null) {}
  add(step: string, model: string, usage: Usage | undefined, provider: string): number {
    const usd = provider === "mock" ? 0 : estimateCostUsd(model, usage);
    this.spent += usd;
    this.byStep.push({ step, model, usd: Math.round(usd * 10000) / 10000 });
    return usd;
  }
  /** Spend already incurred by an earlier attempt of the same workflow (resume): counts towards the ceiling. */
  addPrior(usd: number): void {
    if (usd > 0) { this.spent += usd; this.byStep.push({ step: "earlier attempt", model: "-", usd: Math.round(usd * 10000) / 10000 }); }
  }
  get spentUsd() { return Math.round(this.spent * 10000) / 10000; }
  get exhausted() { return this.maxUsd !== null && this.spent >= this.maxUsd; }
}
