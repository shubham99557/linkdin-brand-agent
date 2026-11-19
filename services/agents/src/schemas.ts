import { z } from "zod";
import { BRAIN_SECTIONS } from "@lbe/domain";

/*
 * Specialist contracts. Every specialist returns UNTRUSTED output that is validated against these
 * schemas (strict: unknown keys rejected) and then by deterministic checks in validate.ts.
 */

// ---------------------------------------------------------------- Market Research Specialist
export interface ResearchInput {
  goal: string;
  region: string;
  audience: string;
  brandSummary: string;
  maxFindings: number;
}
export const ResearchOutputSchema = z.object({
  findings: z.array(z.object({
    statement: z.string().describe("One factual finding, stated neutrally."),
    source_url: z.string().describe("Exact URL of the source page the finding comes from."),
    source_title: z.string(),
    publisher: z.string().nullable(),
    published_date: z.string().nullable().describe("YYYY-MM-DD or YYYY, or null if unknown."),
    confidence: z.enum(["high", "medium", "low"]),
    relevance: z.string().describe("Why this matters for the goal."),
  }).strict()).max(20),
  gaps: z.array(z.string()).describe("What could not be found or verified."),
}).strict();
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;

// ---------------------------------------------------------------- Content Strategy Specialist
export interface StrategyInput {
  goal: string;
  startDate: string;
  days: number;
  postCount: number;
  brandContext: string;
  accounts: Array<{ kind: "company_page" | "founder_profile"; pillars: string[] }>;
  findings: Array<{ id: string; statement: string; source_url: string; confidence: string }>;
  claims: Array<{ id: string; statement: string }>;
  recentTopics: string[];
  prohibitedTopics: string[];
}
export const StrategyOutputSchema = z.object({
  summary: z.string(),
  items: z.array(z.object({
    day: z.number().int().min(1).max(31),
    topic: z.string().describe("Short topic label, used for duplicate detection."),
    angle: z.string().describe("The specific point this post makes."),
    objective: z.string(),
    audience_problem: z.string(),
    pillars: z.object({ company_page: z.string(), founder_profile: z.string() }).strict(),
    finding_ids: z.array(z.string()),
    claim_ids: z.array(z.string()),
  }).strict()).min(1).max(10),
}).strict();
export type StrategyOutput = z.infer<typeof StrategyOutputSchema>;
export type StrategyItem = StrategyOutput["items"][number];

// ---------------------------------------------------------------- Creative Brief Specialist
export interface CreativeInput {
  body: string;
  accountKind: "company_page" | "founder_profile";
  topic: string;
  visualIdentity: string;
  prohibitedTerms: string[];
}
export const CreativeOutputSchema = z.object({
  format: z.enum(["single_image", "document_carousel", "text_only"]),
  headline: z.string(),
  slides: z.array(z.object({ title: z.string(), text: z.string() }).strict()).max(10),
  visual_direction: z.string(),
  alt_text: z.string(),
  avoid: z.array(z.string()),
}).strict();
export type CreativeOutput = z.infer<typeof CreativeOutputSchema>;

// ---------------------------------------------------------------- Performance Analysis Specialist
export interface PerformanceInput {
  decisions: Array<{ content_id: string; decision: string; note: string | null; account_kind: string; pillar: string; topic: string; created_via: string }>;
  publications: Array<{ content_id: string; status: string; provider: string; account_kind: string; topic: string }>;
  metrics: "none_available";
  existingLessons: string[];
}
export const PerformanceOutputSchema = z.object({
  observations: z.array(z.string()),
  proposals: z.array(z.object({
    section: z.enum(["lessons", "communication_rules"]),
    key: z.string(),
    title: z.string(),
    body: z.string(),
    rationale: z.string(),
    evidence_refs: z.array(z.string()).describe("content_ids of the decisions/publications this is based on"),
  }).strict()).max(5),
}).strict();
export type PerformanceOutput = z.infer<typeof PerformanceOutputSchema>;

// ---------------------------------------------------------------- Brand Orchestrator: onboarding extraction
export interface ExtractionInput {
  sourceName: string;
  sourceText: string;
}
const EXTRACTABLE = BRAIN_SECTIONS.filter((s) => s !== "lessons") as [string, ...string[]];
export const ExtractionOutputSchema = z.object({
  proposals: z.array(z.object({
    section: z.enum(EXTRACTABLE),
    key: z.string(),
    title: z.string(),
    body: z.string(),
    source_quote: z.string().describe("Verbatim passage from the source that supports this entry."),
  }).strict()).max(20),
}).strict();
export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;

// ---------------------------------------------------------------- common
export type SpecialistResult =
  | { kind: "ok"; raw: unknown; usage?: { inputTokens: number; outputTokens: number }; allowedUrls?: string[] }
  | { kind: "refused"; reason: string }
  | { kind: "error"; message: string };

export type SpecialistRole = "market_research" | "content_strategy" | "creative_brief" | "performance_analysis" | "brand_orchestrator";

export interface Specialist<I> {
  readonly role: SpecialistRole;
  readonly provider: "mock" | "anthropic";
  readonly model: string;
  readonly promptVersion: string;
  run(input: I): Promise<SpecialistResult>;
}

export interface Specialists {
  research: Specialist<ResearchInput>;
  strategy: Specialist<StrategyInput>;
  creative: Specialist<CreativeInput>;
  performance: Specialist<PerformanceInput>;
  extraction: Specialist<ExtractionInput>;
}
