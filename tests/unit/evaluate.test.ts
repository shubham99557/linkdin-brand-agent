import { describe, expect, it } from "vitest";
import { evaluateCampaign, scoringSheet, type BrandBrain } from "@lbe/agents";

const brain = (over: Partial<BrandBrain> = {}): BrandBrain => ({
  organization: { id: "o", name: "X", slug: "x" }, entries: [
    { id: "1", section: "icp", key: "main", title: "ICP", body: "UK SMEs operations leads finance teams phishing training reporting", structured: {}, version: 1, source: "owner", source_ref: null, approved_at: "" },
  ], missing_sections: [], accounts: [], claims: [], recent_topics: [], pending_proposals: 0, ...over,
});
const words = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(" ");
const draft = (kind: string, group: string, body: string) => ({ account_kind: kind, topic: group, status: "in_review", body, unsupported: [], citations: [],
  voice_warnings: [], visual_brief: { format: "single_image" }, variant_group: group });
const goodResult = () => ({
  research: { provider: "anthropic", usable_as_evidence: 3, contradictions: [], summary: ["a", "b", "c"].map((d) => ({
    source_url: `https://${d}.gov.uk/x`, confidence: "high", retrieved_at: "2026-11-19", flags: [], stale: false })) },
  strategy: { items: ["Phishing reporting", "MFA basics", "First hour response", "Simulation ethics"].map((topic) => ({ topic })), dropped: [] },
  drafts: ["g1", "g2", "g3", "g4"].flatMap((g) => [
    draft("company_page", g, `Opening${g} for UK SMEs operations leads on phishing reporting ${words(130, `c${g}w`)}`),
    draft("founder_profile", g, `Lesson${g} finance teams taught me about phishing training ${words(130, `f${g}w`)}`)]),
  brain: { non_production_knowledge: [] }, cost: { estimated_usd: 1.2 },
});

describe("evaluateCampaign", () => {
  it("never returns a 'ready' verdict — at best NEEDS_HUMAN_REVIEW", () => {
    const e = evaluateCampaign(goodResult(), brain());
    expect(e.verdict).toBe("NEEDS_HUMAN_REVIEW");
    expect(e.blocking).toEqual([]);
  });
  it("blocks mock providers, synthetic knowledge, missing ICP, short and template-like posts", () => {
    const r = goodResult();
    r.research.provider = "mock";
    r.brain.non_production_knowledge = ["identity/main (synthetic)"] as never;
    r.drafts = r.drafts.map((d) => ({ ...d, body: "We've been thinking about security. Same template text here for every post." }));
    const e = evaluateCampaign(r, brain({ entries: [], missing_sections: ["icp"] as never }));
    expect(e.verdict).toBe("NOT_READY");
    const text = e.blocking.join(" | ");
    for (const s of ["Research provider (mock)", "owner-provided", "ICP relevance", "Length 120–250", "Repeated opening phrases", "Max text overlap"]) {
      expect(text).toContain(s);
    }
  });
  it("produces a human scoring row per draft", () => {
    const sheet = scoringSheet(goodResult());
    expect(sheet.split("\n").filter((l) => /^\| \d+ \|/.test(l))).toHaveLength(8);
  });
});
