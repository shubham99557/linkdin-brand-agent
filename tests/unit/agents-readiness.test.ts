import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { describe, expect, it } from "vitest";
import {
  anthropicSpecialists, Budget, CreativeOutputSchema, estimateCostUsd, ExtractionOutputSchema, findingRestatements, PerformanceOutputSchema,
  PRICING, PRICING_SOURCE, ResearchOutputSchema, StrategyOutputSchema, usableEvidence, validateResearch, WEB_SEARCH_USD_PER_1K,
} from "@lbe/agents";
import { AnthropicDrafter, DraftOutputSchema } from "@lbe/drafting";

const NOW = new Date("2026-11-19T12:00:00Z");
const f = (url: string, statement = "s") => ({ statement, source_url: url, source_title: "t", publisher: null, published_date: "2026-06-01", confidence: "high", relevance: "r" });

describe("structured-output schema compatibility (what the SDK sends to the API)", () => {
  const UNSUPPORTED = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems", "uniqueItems", "pattern"];
  const walk = (node: unknown, path: string, problems: string[]) => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    for (const k of UNSUPPORTED) if (k in n) problems.push(`${path}: unsupported keyword ${k}`);
    if ("minItems" in n && ![0, 1].includes(n.minItems as number)) problems.push(`${path}: minItems ${String(n.minItems)}`);
    if (n.type === "object") {
      if (n.additionalProperties !== false) problems.push(`${path}: additionalProperties must be false`);
      const props = Object.keys((n.properties as object) ?? {});
      const req = (n.required as string[]) ?? [];
      for (const p of props) if (!req.includes(p)) problems.push(`${path}: property ${p} not required`);
    }
    for (const [k, v] of Object.entries(n)) {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}.${k}[${i}]`, problems));
      else if (v && typeof v === "object") walk(v, `${path}.${k}`, problems);
    }
  };
  for (const [name, schema] of Object.entries({ ResearchOutputSchema, StrategyOutputSchema, CreativeOutputSchema, PerformanceOutputSchema, ExtractionOutputSchema, DraftOutputSchema })) {
    it(name, () => {
      const problems: string[] = [];
      walk((zodOutputFormat(schema as never) as unknown as { schema: unknown }).schema, name, problems);
      expect(problems).toEqual([]);
    });
  }
});

describe("contradictory and outdated evidence", () => {
  it("findings named in a conflict are flagged, lowered and excluded from evidence", () => {
    const r = validateResearch({ findings: [f("https://a.example/1"), f("https://b.example/2"), f("https://c.example/3")], gaps: [],
      conflicts: [{ finding_indexes: [0, 2], description: "different figures" }] }, { now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.accepted.map((x) => x.flags.includes("contradicted"))).toEqual([true, false, true]);
    expect(r.accepted.filter(usableEvidence).map((x) => x.source_url)).toEqual(["https://b.example/2"]);
    expect(r.contradictions).toEqual([{ source_urls: ["https://a.example/1", "https://c.example/3"], description: "different figures" }]);
  });
  it("producers that omit `conflicts` are accepted as having none", () => {
    expect(validateResearch({ findings: [f("https://a.example/1")], gaps: [] }, { now: NOW }).ok).toBe(true);
  });
});

describe("claim-to-source verification", () => {
  const findings = [{ statement: "Phishing-resistant multi-factor authentication reduces the impact of stolen passwords.", source_url: "https://src.example/mfa" }];
  it("flags a sentence that restates a research finding without a verified claim", () => {
    const out = findingRestatements("Good news. Phishing-resistant MFA reduces the impact of stolen passwords. Ask your IT lead.", [], findings);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/restates research from https:\/\/src.example\/mfa/);
  });
  it("does not flag sentences covered by a verified-claim citation, or unrelated sentences", () => {
    const body = "Phishing-resistant MFA reduces the impact of stolen passwords. Culture matters.";
    expect(findingRestatements(body, ["Phishing-resistant MFA reduces the impact of stolen passwords."], findings)).toEqual([]);
    expect(findingRestatements("Culture matters more than tools.", [], findings)).toEqual([]);
  });
});

describe("cost estimation and budget", () => {
  it("prices known models and never treats unknown models as free", () => {
    expect(estimateCostUsd("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(4 + 2, 5);
    expect(estimateCostUsd("claude-opus-5-5", { inputTokens: 0, outputTokens: 0, webSearchRequests: 5 })).toBeCloseTo(0.05, 5);
    expect(estimateCostUsd("some-new-model", { inputTokens: 1, outputTokens: 1 })).toBe(Number.POSITIVE_INFINITY);
  });
  it("P3-01: prices match Anthropic's official pricing page (verified 2026-11-19)", () => {
    expect(PRICING_SOURCE).toEqual({ url: "https://platform.claude.com/docs/en/about-claude/pricing", checkedOn: "2026-11-19" });
    expect(PRICING["claude-opus-5-5"]).toEqual({ input: 4, output: 20 });
    expect(PRICING["claude-sonnet-5-5"]).toEqual({ input: 2, output: 10 });
    expect(PRICING["claude-fable-5-2"]).toEqual({ input: 8, output: 40 });
    expect(WEB_SEARCH_USD_PER_1K).toBe(10);
  });
  it("P3-01: Haiku 5.5 is priced at its higher (>100k-token prompt) tier so the budget never under-counts", () => {
    // official: $0.10/$0.50 up to 100k-token prompts, $0.50/$2.50 above
    expect(estimateCostUsd("claude-haiku-5-5", { inputTokens: 200_000, outputTokens: 10_000 })).toBeCloseTo(0.2 * 0.5 + 0.01 * 2.5, 6);
  });
  it("P3-01: a server-side fallback (cyber refusals → Opus 4.8, $5/$25) is priced as an upper bound, never at Opus 5.5 rates", () => {
    const u = { inputTokens: 1_000_000, outputTokens: 100_000 };
    expect(estimateCostUsd("claude-opus-5-5", { ...u, servedBy: "claude-opus-5-5" })).toBeCloseTo(4 + 2, 5);
    expect(estimateCostUsd("claude-opus-5-5", { ...u, servedBy: "claude-opus-4-8" })).toBeCloseTo(2 * (5 + 2.5), 5);
    expect(estimateCostUsd("claude-opus-5-5", { ...u, servedBy: "claude-unknown-x" })).toBe(Number.POSITIVE_INFINITY);
  });
  it("P3-01: every model the product calls by default has a verified price (else budgets would refuse every call)", () => {
    const models = [new AnthropicDrafter({ apiKey: "not-used" }).model, ...Object.values(anthropicSpecialists({ apiKey: "not-used" })).map((s) => s.model)];
    for (const m of models) expect(PRICING[m], m).toBeDefined();
  });
  it("mock providers cost nothing; the budget reports exhaustion", () => {
    const b = new Budget(1);
    b.add("research", "mock-specialist-v1", { inputTokens: 1e9, outputTokens: 1e9 }, "mock");
    expect(b.exhausted).toBe(false);
    b.add("strategy", "claude-opus-5-5", { inputTokens: 200_000, outputTokens: 20_000 }, "anthropic");
    expect(b.spentUsd).toBeCloseTo(1.2, 4);
    expect(b.exhausted).toBe(true);
  });
});
