import { splitSentences } from "@lbe/domain";
import { entriesFor, type BrandBrain } from "./brain.ts";
import { topicSimilarity, topicTokens } from "./validate.ts";

/**
 * Automated campaign checks. These can only find problems — they cannot certify quality. The verdict is
 * therefore NOT_READY or NEEDS_HUMAN_REVIEW, never "ready". Human scoring (scoring-sheet.md) decides.
 */
export interface Check { area: string; name: string; value: string; status: "pass" | "fail" | "warn" | "n/a"; note?: string }
export interface Evaluation { checks: Check[]; verdict: "NOT_READY" | "NEEDS_HUMAN_REVIEW"; blocking: string[] }

interface Draft { account_kind: string; topic: string; status: string; body: string; unsupported: string[]; citations: unknown[];
  voice_warnings?: string[]; visual_brief?: { format: string; warnings?: string[] } | null; variant_group: string }

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const trigrams = (s: string) => {
  const w = s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
};
const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
};

export function evaluateCampaign(result: Record<string, any>, brain: BrandBrain, expected = { posts: 4 }): Evaluation {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const drafts = (result.drafts ?? []) as Draft[];
  const research = result.research ?? {};
  const summary = (research.summary ?? []) as Array<{ source_url: string; confidence: string; retrieved_at: string; flags: string[]; stale: boolean }>;
  const items = (result.strategy?.items ?? []) as Array<{ topic: string }>;

  // ---- expected outputs
  add({ area: "outputs", name: "Research sources", value: String(summary.length), status: summary.length >= 3 ? "pass" : "fail" });
  add({ area: "outputs", name: "Strategy items", value: `${items.length} (expected ${expected.posts})`, status: items.length === expected.posts ? "pass" : "fail" });
  add({ area: "outputs", name: "Drafts (company + founder)", value: `${drafts.length} (expected ${expected.posts * 2})`, status: drafts.length === expected.posts * 2 ? "pass" : "fail" });
  const groups = new Map<string, string[]>();
  for (const d of drafts) groups.set(d.variant_group, [...(groups.get(d.variant_group) ?? []), d.account_kind]);
  add({ area: "outputs", name: "Both voices per post", value: `${[...groups.values()].filter((g) => g.length === 2).length}/${groups.size}`,
    status: [...groups.values()].every((g) => g.length === 2) ? "pass" : "fail" });
  add({ area: "outputs", name: "Visual briefs", value: `${drafts.filter((d) => d.visual_brief).length}/${drafts.length}`, status: drafts.every((d) => d.visual_brief) ? "pass" : "fail" });
  add({ area: "outputs", name: "In human review queue", value: `${drafts.filter((d) => d.status === "in_review").length}/${drafts.length}`,
    status: drafts.length > 0 && drafts.every((d) => d.status === "in_review") ? "pass" : "warn", note: "Drafts held back carry unsupported statements." });

  // ---- evidence
  const complete = summary.filter((s) => /^https:\/\//.test(s.source_url) && s.retrieved_at && s.confidence).length;
  add({ area: "evidence", name: "Source references complete (URL, retrieved, confidence)", value: `${complete}/${summary.length}`, status: complete === summary.length && summary.length > 0 ? "pass" : "fail" });
  const mock = summary.filter((s) => /example\.org\/mock/.test(s.source_url)).length;
  add({ area: "evidence", name: "Real (non-mock) sources", value: `${summary.length - mock}/${summary.length}`, status: mock === 0 ? "pass" : "fail",
    note: mock ? "Mock fixtures are not evidence." : undefined });
  const domains = new Set(summary.map((s) => { try { return new URL(s.source_url).hostname; } catch { return "?"; } }));
  add({ area: "evidence", name: "Distinct source domains", value: String(domains.size), status: domains.size >= 3 ? "pass" : "warn" });
  add({ area: "evidence", name: "Usable as evidence (not stale/contradicted/suspicious)", value: String(research.usable_as_evidence ?? 0), status: (research.usable_as_evidence ?? 0) >= 2 ? "pass" : "warn" });
  add({ area: "evidence", name: "Contradictions between sources", value: String((research.contradictions ?? []).length), status: (research.contradictions ?? []).length ? "warn" : "pass",
    note: "Contradicted findings need a human decision." });

  // ---- factual safety
  const unsupported = drafts.filter((d) => d.unsupported.length > 0).length;
  add({ area: "factual", name: "Drafts with unsupported statements", value: `${unsupported}/${drafts.length}`, status: unsupported === 0 ? "pass" : "warn" });
  add({ area: "factual", name: "Verified-claim citations", value: String(drafts.reduce((n, d) => n + d.citations.length, 0)), status: "n/a",
    note: "Citations are restricted to verified claims by the database; a human must still check each claim is relevant." });
  const kq = (result.brain?.non_production_knowledge ?? []) as string[];
  add({ area: "factual", name: "Brand Brain knowledge is owner-provided", value: kq.length ? `${kq.length} synthetic/placeholder item(s)` : "yes", status: kq.length ? "fail" : "pass" });
  add({ area: "factual", name: "Required Brand Brain sections present", value: brain.missing_sections.length ? `missing: ${brain.missing_sections.join(", ")}` : "all", status: brain.missing_sections.length ? "fail" : "pass" });

  // ---- brand voice & format
  const voiceWarn = drafts.reduce((n, d) => n + (d.voice_warnings?.length ?? 0), 0);
  add({ area: "voice", name: "Voice heuristic warnings", value: String(voiceWarn), status: voiceWarn === 0 ? "pass" : "warn" });
  const lengthOk = drafts.filter((d) => { const n = words(d.body); return n >= 120 && n <= 250; }).length;
  add({ area: "voice", name: "Length 120–250 words", value: `${lengthOk}/${drafts.length}`, status: lengthOk === drafts.length && drafts.length > 0 ? "pass" : "fail" });
  const hashtagOk = drafts.filter((d) => (d.body.match(/#\w+/g) ?? []).length <= 3).length;
  add({ area: "voice", name: "≤ 3 hashtags", value: `${hashtagOk}/${drafts.length}`, status: hashtagOk === drafts.length ? "pass" : "fail" });

  // ---- originality & duplication
  let maxSim = 0;
  for (let i = 0; i < drafts.length; i++) for (let j = i + 1; j < drafts.length; j++) {
    if (drafts[i]!.account_kind !== drafts[j]!.account_kind || drafts[i]!.variant_group === drafts[j]!.variant_group) continue;
    maxSim = Math.max(maxSim, jaccard(trigrams(drafts[i]!.body), trigrams(drafts[j]!.body)));
  }
  add({ area: "originality", name: "Max text overlap between different posts (same account)", value: maxSim.toFixed(2), status: maxSim <= 0.25 ? "pass" : "fail",
    note: "High overlap indicates template-like posts." });
  const openings = drafts.map((d) => splitSentences(d.body)[0]?.toLowerCase().split(/\s+/).slice(0, 4).join(" ") ?? "");
  const repeated = openings.filter((o, i) => o && openings.indexOf(o) !== i).length;
  add({ area: "originality", name: "Repeated opening phrases", value: String(repeated), status: repeated === 0 ? "pass" : "fail" });
  let topicSim = 0;
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) topicSim = Math.max(topicSim, topicSimilarity(items[i]!.topic, items[j]!.topic));
  add({ area: "originality", name: "Topic distinctness (max similarity within plan)", value: topicSim.toFixed(2), status: topicSim < 0.5 ? "pass" : "fail" });
  add({ area: "originality", name: "Duplicates of recent content dropped", value: String((result.strategy?.dropped ?? []).length), status: "n/a" });

  // ---- ICP relevance (proxy)
  // Buyer ICP, ideal follower (P2-09) and buyer problems: a post may be written for either audience.
  const icpText = [...entriesFor(brain, "icp"), ...entriesFor(brain, "ideal_follower"), ...entriesFor(brain, "audience_problems")].map((e) => e.body).join(" ");
  if (!icpText) {
    add({ area: "relevance", name: "ICP relevance", value: "cannot assess — ICP UNKNOWN", status: "fail" });
  } else {
    const icp = topicTokens(icpText);
    const relevant = drafts.filter((d) => [...topicTokens(d.body)].filter((w) => icp.has(w)).length >= 2).length;
    add({ area: "relevance", name: "Posts sharing ≥2 buyer/follower/problem terms (proxy)", value: `${relevant}/${drafts.length}`, status: relevant === drafts.length ? "pass" : "warn",
      note: "Lexical proxy only — a human must judge relevance." });
  }

  // ---- provider & cost
  add({ area: "run", name: "Research provider", value: String(research.provider ?? "?"), status: research.provider === "anthropic" ? "pass" : "fail",
    note: research.provider === "anthropic" ? undefined : "Mock run: validates the pipeline, not content quality." });
  add({ area: "run", name: "Estimated model cost (USD)", value: String(result.cost?.estimated_usd ?? 0), status: result.cost?.budget_exhausted ? "warn" : "n/a" });

  const blocking = checks.filter((c) => c.status === "fail").map((c) => `${c.area}: ${c.name} (${c.value})`);
  return { checks, verdict: blocking.length ? "NOT_READY" : "NEEDS_HUMAN_REVIEW", blocking };
}

export function scoringSheet(result: Record<string, any>): string {
  const drafts = (result.drafts ?? []) as Draft[];
  const lines = [
    "# Human scoring sheet",
    "",
    "Score 1 (poor) – 5 (excellent). Check every source link and claim yourself; automated checks cannot establish accuracy.",
    "",
    "| # | Account | Topic | Factual accuracy | ICP relevance | Brand voice | Originality | Usefulness | No duplication | Publish? (Y/N) | Notes |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...drafts.map((d, i) => `| ${i + 1} | ${d.account_kind === "company_page" ? "Company" : "Founder"} | ${d.topic} | | | | | | | | |`),
    "",
    "## Campaign level",
    "",
    "| Criterion | Score 1–5 | Notes |", "|---|---|---|",
    "| Research quality (reputable, current, relevant) | | |",
    "| Strategy fits goal and ICP | | |",
    "| Visual briefs usable by a designer | | |",
    "| Overall: ready for internal pilot? (Y/N) | | |",
  ];
  return lines.join("\n");
}
