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

/**
 * Owner-approved context for prompts. Missing sections are marked UNKNOWN so models do not invent them.
 * Sections with a `contextNote` (the buyer ICP and the ideal follower, P2-09) carry it under the heading, so the
 * two audiences are never read as one.
 */
export function buildBrandContext(brain: BrandBrain, sections: BrainSection[] = [
  "identity", "positioning", "messaging", "icp", "ideal_follower", "audience_problems", "audience_language", "product",
  "pillars_goals", "prohibited", "communication_rules", "lessons",
]): string {
  return sections.map((s) => {
    const meta = SECTION_META.find((m) => m.section === s)!;
    const text = textFor(brain, s);
    const note = meta.contextNote ? `_${meta.contextNote}_\n` : "";
    return `## ${meta.label}\n${note}${text || "UNKNOWN — not yet provided by the owner. Do not invent anything for this section."}`;
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

/** Knowledge quality classes used by the audit, the workflow and the pilot pre-flight. */
export type KnowledgeQuality = "SYNTHETIC" | "PLACEHOLDER" | "IMPORTED_PLACEHOLDER" | "AGENT_DERIVED" | "OWNER_PROVIDED";

export function entryQuality(e: { body: string; source: string }): KnowledgeQuality {
  if (/\[SYNTHETIC\]/i.test(e.body)) return "SYNTHETIC";
  const placeholder = /PLACEHOLDER|owner to complete|_?Example post \d|_Owner to |must complete and approve this file/i.test(e.body);
  if (placeholder && e.source === "import") return "IMPORTED_PLACEHOLDER";
  if (placeholder) return "PLACEHOLDER";
  if (e.source === "agent_proposal") return "AGENT_DERIVED";
  return "OWNER_PROVIDED";
}

export const claimIsSynthetic = (c: { statement: string; evidence_note?: string | null }) =>
  /\[SYNTHETIC\]|synthetic development claim|UNVERIFIED example/i.test(`${c.statement} ${c.evidence_note ?? ""}`);

/** Entries/claims that are not real owner knowledge. Never silently treated as production-ready. */
export function nonProductionKnowledge(brain: BrandBrain): string[] {
  return [
    ...brain.entries.filter((e) => ["SYNTHETIC", "PLACEHOLDER", "IMPORTED_PLACEHOLDER"].includes(entryQuality(e)))
      .map((e) => `${e.section}/${e.key} (${entryQuality(e).toLowerCase()})`),
    ...brain.claims.filter(claimIsSynthetic).map((c) => `claim: ${c.statement.slice(0, 60)}`),
  ];
}
export const prohibitedTopics = (brain: BrandBrain) => listFrom(brain, "topics");
