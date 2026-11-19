import { findUnsupportedStatements, splitSentences } from "@lbe/domain";
import {
  CreativeOutputSchema, ExtractionOutputSchema, PerformanceOutputSchema, ResearchOutputSchema, StrategyOutputSchema,
  type CreativeOutput, type ExtractionOutput, type PerformanceOutput, type StrategyItem, type StrategyOutput,
} from "./schemas.ts";

const first = (e: { issues: Array<{ message: string; path: PropertyKey[] }> }) =>
  `${e.issues[0]?.path.join(".") ?? ""}: ${e.issues[0]?.message ?? "invalid"}`;

// ---------------------------------------------------------------- research
export interface ValidFinding {
  statement: string; source_url: string; source_title: string; publisher: string | null;
  published_at: string | null; confidence: "high" | "medium" | "low"; stale: boolean; flags: string[]; relevance: string;
}

/** Text in web content that looks like instructions to an AI. Kept as data, flagged, and never used as evidence. */
const INJECTION = /\b(ignore (all |any )?(previous|prior|above) (instructions|prompts)|system prompt|you are now|disregard (the )?(rules|instructions)|(approve|publish) (this|it|immediately|now)|auto-?approve)\b/i;

export function validateResearch(raw: unknown, opts: { allowedUrls?: string[]; now: Date; staleAfterMonths?: number }):
  { ok: true; accepted: ValidFinding[]; rejected: Array<{ source_url: string; reason: string }>; gaps: string[];
    contradictions: Array<{ source_urls: string[]; description: string }> } | { ok: false; error: string } {
  // Older/other producers may omit `conflicts`; treat as none.
  const withDefaults = raw && typeof raw === "object" && !("conflicts" in raw) ? { ...(raw as object), conflicts: [] } : raw;
  const parsed = ResearchOutputSchema.safeParse(withDefaults);
  if (!parsed.success) return { ok: false, error: `research output failed validation (${first(parsed.error)})` };
  const allowed = opts.allowedUrls ? new Set(opts.allowedUrls.map(normaliseUrl)) : null;
  const staleBefore = new Date(opts.now);
  staleBefore.setMonth(staleBefore.getMonth() - (opts.staleAfterMonths ?? 24));
  const accepted: ValidFinding[] = [];
  const rejected: Array<{ source_url: string; reason: string }> = [];
  const seen = new Set<string>();
  // Contradicting findings stay visible but are never used as evidence until a human resolves them.
  const contradicted = new Set<number>();
  const contradictions = parsed.data.conflicts.map((c) => {
    for (const i of c.finding_indexes) contradicted.add(i);
    return { source_urls: c.finding_indexes.map((i) => parsed.data.findings[i]?.source_url).filter((u): u is string => !!u), description: c.description };
  });
  for (const [index, f] of parsed.data.findings.entries()) {
    let url: URL;
    try { url = new URL(f.source_url); } catch { rejected.push({ source_url: f.source_url, reason: "not a valid URL" }); continue; }
    if (url.protocol !== "https:") { rejected.push({ source_url: f.source_url, reason: "source must use HTTPS" }); continue; }
    if (url.username || url.password) { rejected.push({ source_url: f.source_url, reason: "credentials in URL" }); continue; }
    if (allowed && !allowed.has(normaliseUrl(f.source_url))) {
      rejected.push({ source_url: f.source_url, reason: "URL was not returned by the search tool (possible fabrication)" });
      continue;
    }
    const dedupe = `${normaliseUrl(f.source_url)}|${f.statement.trim().toLowerCase()}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const flags: string[] = [];
    let confidence = f.confidence;
    let stale = false;
    let published: string | null = null;
    if (f.published_date) {
      const m = /^(\d{4})(?:-(\d{2})-(\d{2}))?$/.exec(f.published_date.trim());
      if (!m) { flags.push("unparseable_date"); confidence = "low"; }
      else {
        published = m[2] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-01-01`;
        const d = new Date(`${published}T00:00:00Z`);
        if (d.getTime() > opts.now.getTime() + 86_400_000) { rejected.push({ source_url: f.source_url, reason: "publication date is in the future" }); continue; }
        if (d < staleBefore) { stale = true; flags.push("stale"); confidence = "low"; }
      }
    } else {
      flags.push("undated");
      if (confidence === "high") confidence = "medium";
    }
    if (INJECTION.test(f.statement) || INJECTION.test(f.source_title)) { flags.push("possible_prompt_injection"); confidence = "low"; }
    if (contradicted.has(index)) { flags.push("contradicted"); confidence = "low"; }
    accepted.push({ statement: f.statement.trim(), source_url: f.source_url, source_title: f.source_title, publisher: f.publisher,
      published_at: published, confidence, stale, flags, relevance: f.relevance });
  }
  return { ok: true, accepted, rejected, gaps: parsed.data.gaps, contradictions };
}

/** Findings usable as evidence in strategy: not stale, not suspicious, not contradicted, not low confidence. */
export const usableEvidence = (f: { stale: boolean; flags: string[]; confidence: string }) =>
  !f.stale && !f.flags.includes("possible_prompt_injection") && !f.flags.includes("contradicted") && f.confidence !== "low";

/**
 * Claim-to-source verification: a draft sentence that restates a research finding is a factual claim.
 * Unless it is covered by a verified-claim citation, it must not reach review.
 */
export function findingRestatements(body: string, citedSpans: string[], findings: Array<{ statement: string; source_url: string }>, threshold = 0.5):
  string[] {
  const out: string[] = [];
  for (const sentence of splitSentences(body)) {
    if (citedSpans.some((s) => s && (sentence.includes(s) || s.includes(sentence)))) continue;
    const match = findings.find((f) => topicSimilarity(sentence, f.statement) >= threshold);
    if (match) out.push(`${sentence} [restates research from ${match.source_url} — create and verify a claim before using it]`);
  }
  return out;
}

function normaliseUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    return x.toString().replace(/\/$/, "");
  } catch { return u; }
}

// ---------------------------------------------------------------- topic similarity (duplicate detection)
const STOP = new Set(["the", "and", "for", "with", "your", "you", "our", "are", "how", "what", "why", "that", "this", "from", "into",
  "about", "when", "who", "uk", "businesses", "business", "teams", "team", "post", "linkedin", "week"]);
export function topicTokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/)
    .map((w) => w.replace(/(ing|es|s)$/, "")).filter((w) => w.length >= 3 && !STOP.has(w)));
}
export function topicSimilarity(a: string, b: string): number {
  const x = topicTokens(a), y = topicTokens(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

// ---------------------------------------------------------------- strategy
export function validateStrategy(raw: unknown, ctx: {
  postCount: number; days: number;
  accounts: Array<{ kind: "company_page" | "founder_profile"; pillars: string[] }>;
  findingIds: Set<string>; claimIds: Set<string>;
  recentTopics: string[]; prohibitedTopics: string[];
  duplicateThreshold?: number;
}): { ok: true; strategy: StrategyOutput; warnings: string[]; dropped: Array<{ topic: string; reason: string }> } | { ok: false; error: string } {
  const parsed = StrategyOutputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `strategy output failed validation (${first(parsed.error)})` };
  const threshold = ctx.duplicateThreshold ?? 0.5;
  const warnings: string[] = [];
  const dropped: Array<{ topic: string; reason: string }> = [];
  const kept: StrategyItem[] = [];
  for (const item of parsed.data.items) {
    const recent = ctx.recentTopics.find((t) => topicSimilarity(t, item.topic) >= threshold);
    if (recent) { dropped.push({ topic: item.topic, reason: `duplicates recent content: "${recent}"` }); continue; }
    const inPlan = kept.find((k) => topicSimilarity(k.topic, item.topic) >= threshold);
    if (inPlan) { dropped.push({ topic: item.topic, reason: `duplicates another item in this plan: "${inPlan.topic}"` }); continue; }
    const banned = ctx.prohibitedTopics.find((t) => `${item.topic} ${item.angle}`.toLowerCase().includes(t.toLowerCase()));
    if (banned) { dropped.push({ topic: item.topic, reason: `prohibited topic: "${banned}"` }); continue; }
    const pillars = { ...item.pillars };
    for (const acct of ctx.accounts) {
      if (!acct.pillars.includes(pillars[acct.kind])) {
        warnings.push(`"${item.topic}": pillar "${pillars[acct.kind]}" is not approved for ${acct.kind}; using "${acct.pillars[0]}"`);
        pillars[acct.kind] = acct.pillars[0] ?? pillars[acct.kind];
      }
    }
    const badFindings = item.finding_ids.filter((id) => !ctx.findingIds.has(id));
    const badClaims = item.claim_ids.filter((id) => !ctx.claimIds.has(id));
    if (badFindings.length) warnings.push(`"${item.topic}": ignored ${badFindings.length} unknown/unusable finding reference(s)`);
    if (badClaims.length) warnings.push(`"${item.topic}": ignored ${badClaims.length} claim reference(s) that are not verified`);
    kept.push({
      ...item,
      day: Math.min(Math.max(item.day, 1), ctx.days),
      pillars,
      finding_ids: item.finding_ids.filter((id) => ctx.findingIds.has(id)),
      claim_ids: item.claim_ids.filter((id) => ctx.claimIds.has(id)),
    });
    if (kept.length === ctx.postCount) break;
  }
  if (kept.length === 0) return { ok: false, error: `no usable strategy items (${dropped.map((d) => d.reason).join("; ") || "empty"})` };
  return { ok: true, strategy: { summary: parsed.data.summary, items: kept }, warnings, dropped };
}

// ---------------------------------------------------------------- brand rules on drafts
export function checkBrandRules(body: string, ctx: { accountKind: "company_page" | "founder_profile"; prohibitedTerms: string[] }):
  { blocking: string[]; warnings: string[] } {
  const blocking: string[] = [];
  const warnings: string[] = [];
  const lower = body.toLowerCase();
  for (const term of ctx.prohibitedTerms) {
    if (term && lower.includes(term.toLowerCase())) blocking.push(`Prohibited by brand rules: "${term}"`);
  }
  if (ctx.accountKind === "company_page" && /\b(I|I'm|I've|I'd|my|me)\b/.test(body)) {
    warnings.push("Company page post uses first-person singular (I/my) — company voice is 'we'.");
  }
  if (ctx.accountKind === "founder_profile" && /\b(we at|our company|the company)\b/i.test(body)) {
    warnings.push("Founder post sounds like the company page — founder voice is personal ('I').");
  }
  return { blocking, warnings };
}

// ---------------------------------------------------------------- creative brief
export function validateCreative(raw: unknown, ctx: { body: string; prohibitedTerms: string[] }):
  { ok: true; brief: CreativeOutput; warnings: string[] } | { ok: false; error: string } {
  const parsed = CreativeOutputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `creative brief failed validation (${first(parsed.error)})` };
  const warnings: string[] = [];
  const brief = parsed.data;
  // Visuals must not introduce factual claims that are not already in the (validated) post.
  const texts = [brief.headline, ...brief.slides.map((s) => `${s.title}. ${s.text}`)];
  for (const t of texts) {
    for (const f of findUnsupportedStatements(t, splitSentences(ctx.body))) {
      warnings.push(`Visual text adds a factual claim not in the post: "${f.sentence}"`);
    }
  }
  for (const term of ctx.prohibitedTerms) {
    if (texts.join(" ").toLowerCase().includes(term.toLowerCase())) warnings.push(`Visual text contains prohibited term "${term}"`);
  }
  return { ok: true, brief, warnings };
}

// ---------------------------------------------------------------- performance proposals
export function validatePerformance(raw: unknown, ctx: { knownContentIds: Set<string> }):
  { ok: true; output: PerformanceOutput; warnings: string[] } | { ok: false; error: string } {
  const parsed = PerformanceOutputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `performance output failed validation (${first(parsed.error)})` };
  const warnings: string[] = [];
  const proposals = parsed.data.proposals.filter((p) => {
    if (!/^[a-z0-9_-]{1,60}$/.test(p.key)) { warnings.push(`dropped proposal with invalid key "${p.key}"`); return false; }
    if (p.evidence_refs.length === 0 || p.evidence_refs.some((r) => !ctx.knownContentIds.has(r))) {
      warnings.push(`dropped proposal "${p.title}": evidence must reference real approval/publication records`);
      return false;
    }
    return true;
  });
  return { ok: true, output: { observations: parsed.data.observations, proposals }, warnings };
}

// ---------------------------------------------------------------- onboarding extraction
const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
export function validateExtraction(raw: unknown, sourceText: string):
  { ok: true; output: ExtractionOutput; dropped: string[] } | { ok: false; error: string } {
  const parsed = ExtractionOutputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `extraction output failed validation (${first(parsed.error)})` };
  const src = squash(sourceText);
  const dropped: string[] = [];
  const proposals = parsed.data.proposals.filter((p) => {
    if (!/^[a-z0-9_-]{1,60}$/.test(p.key)) { dropped.push(`${p.title}: invalid key`); return false; }
    if (p.source_quote.trim().length < 10 || !src.includes(squash(p.source_quote))) {
      dropped.push(`${p.title}: quote not found in the source (not grounded)`);
      return false;
    }
    return true;
  });
  return { ok: true, output: { proposals }, dropped };
}
