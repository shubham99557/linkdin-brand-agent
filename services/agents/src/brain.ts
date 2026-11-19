import { SECTION_META, type BrainSection } from "@lbe/domain";

/** Shape returned by lbe.brain_load(session). Always scoped to the caller's organization by the database. */
export interface BrandBrain {
  organization: { id: string; name: string; slug: string };
  entries: Array<{
    id: string; section: BrainSection; key: string; title: string; body: string;
    structured: Record<string, unknown>; version: number; source: string; source_ref: string | null; approved_at: string;
  }>;
  missing_sections: BrainSection[];
  accounts: Array<{ id: string; kind: "company_page" | "founder_profile"; display_name: string; pillars: string[]; publishing_mode: string }>;
  claims: Array<{ id: string; statement: string; category: string; evidence_url: string | null; evidence_note: string | null }>;
  recent_topics: Array<{ content_id: string; topic: string; pillar: string; account_kind: string; status: string; created_at: string }>;
  pending_proposals: number;
}

export const entriesFor = (brain: BrandBrain, section: BrainSection) => brain.entries.filter((e) => e.section === section);

const textFor = (brain: BrandBrain, section: BrainSection) =>
  entriesFor(brain, section).map((e) => `### ${e.title}\n${e.body}`).join("\n\n");

/** Owner-approved context for prompts. Missing sections are marked UNKNOWN so models do not invent them. */
export function buildBrandContext(brain: BrandBrain, sections: BrainSection[] = [
  "identity", "positioning", "messaging", "icp", "audience_problems", "audience_language", "product",
  "pillars_goals", "prohibited", "communication_rules", "lessons",
]): string {
  return sections.map((s) => {
    const meta = SECTION_META.find((m) => m.section === s)!;
    const text = textFor(brain, s);
    return `## ${meta.label}\n${text || "UNKNOWN — not yet provided by the owner. Do not invent anything for this section."}`;
  }).join("\n\n");
}

export function voiceFor(brain: BrandBrain, kind: "company_page" | "founder_profile"): string | null {
  const text = textFor(brain, kind === "company_page" ? "voice_company" : "voice_founder");
  return text || null;
}

const listFrom = (brain: BrandBrain, field: string) =>
  entriesFor(brain, "prohibited").flatMap((e) => (Array.isArray(e.structured[field]) ? (e.structured[field] as unknown[]) : []))
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim());

export const prohibitedTerms = (brain: BrandBrain) => listFrom(brain, "terms");
export const prohibitedTopics = (brain: BrandBrain) => listFrom(brain, "topics");
