/**
 * Cost estimation for budget enforcement. Prices are USD per million tokens from the Claude API reference
 * cached 2026-11-03 (first-party API). Web search pricing is NOT confirmed here — verify on the Anthropic
 * pricing page before any paid run. Estimates count all input at the full input price (no cache discount),
 * so they err on the high side.
 */
export const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-fable-5-2": { input: 8, output: 40 },
};
export const WEB_SEARCH_USD_PER_1K = 10; // UNVERIFIED assumption — confirm before a paid evaluation

export interface Usage { inputTokens: number; outputTokens: number; webSearchRequests?: number }

export function estimateCostUsd(model: string, usage: Usage | undefined): number {
  if (!usage) return 0;
  const p = PRICING[model];
  if (!p) return Number.POSITIVE_INFINITY;   // unknown model: refuse to treat as free
  return (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000
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
  get spentUsd() { return Math.round(this.spent * 10000) / 10000; }
  get exhausted() { return this.maxUsd !== null && this.spent >= this.maxUsd; }
}
