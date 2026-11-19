// Readiness of the agent workflow for real (paid) models — exercised with fakes that report realistic usage.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockSpecialists, runBrandWorkflow, type Specialist, type Specialists } from "@lbe/agents";
import { MockDrafter, type Drafter } from "@lbe/drafting";
import { freshDb, type TestDb } from "../helpers/db.ts";

let t: TestDb;
let editor: string;
beforeAll(async () => { t = await freshDb(); editor = await t.login("editor"); });
afterAll(async () => t.db.close());

/** Wrap a mock specialist so it reports itself as a priced Claude model with the given usage. */
function priced<I>(s: Specialist<I>, inputTokens: number, outputTokens: number): Specialist<I> {
  return { role: s.role, provider: "anthropic", model: "claude-opus-5-5", promptVersion: s.promptVersion,
    run: async (i: I) => { const r = await s.run(i); return r.kind === "ok" ? { ...r, usage: { inputTokens, outputTokens } } : r; } };
}
const deps = (specialists: Specialists, writer: Drafter = new MockDrafter(), budgetUsd?: number) =>
  ({ db: t.db, session: editor, specialists, writer, budgetUsd });
const GOAL = "Build a one-week LinkedIn branding strategy for ActTrident aimed at UK businesses, focusing on phishing awareness.";

describe("budget enforcement", () => {
  it("stops before strategy when research alone exceeds the budget, and records the failure", async () => {
    const m = mockSpecialists();
    await expect(runBrandWorkflow(deps({ ...m, research: priced(m.research, 300_000, 10_000) }, undefined, 1), { goal: GOAL }))
      .rejects.toThrow(/budget of \$1 reached after research/);
    const [w] = await t.db.query<{ status: string }>("select status from lbe.agent_workflows order by created_at desc limit 1");
    expect(w!.status).toBe("failed");
  });

  it("stops creating drafts once the budget is reached, and reports estimated cost per step", async () => {
    const m = mockSpecialists();
    const writer = new MockDrafter();
    const pricedWriter: Drafter = { provider: "anthropic", model: "claude-opus-5-5",
      draft: async (i) => { const r = await writer.draft(i); return r.kind === "ok" ? { ...r, usage: { inputTokens: 100_000, outputTokens: 10_000 } } : r; } };
    // Each draft ≈ $0.60 → a $1.50 budget allows 3 drafts (≈ $1.80 spent, then stop).
    const { result } = await runBrandWorkflow(deps(m, pricedWriter, 1.5), { goal: GOAL, startDate: "2027-01-04", postCount: 4 });
    const r = result as { drafts: unknown[]; cost: { estimated_usd: number; budget_exhausted: boolean; by_step: Array<{ step: string }> }; warnings: string[] };
    expect(r.drafts.length).toBe(3);
    expect(r.cost.budget_exhausted).toBe(true);
    expect(r.cost.estimated_usd).toBeGreaterThanOrEqual(1.5);
    expect(r.cost.by_step.some((s) => s.step.startsWith("draft:"))).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/Budget of \$1.5 reached/);
  });
});

describe("evidence handling in drafts", () => {
  it("a draft that restates research without a verified claim is held back from review", async () => {
    const m = mockSpecialists();
    const writer: Drafter = { provider: "mock", model: "copycat", draft: async () => ({ kind: "ok", raw: {
      body: "Fast, blame-free reporting of suspicious emails shortens the time attackers have to act. Make reporting easy.",
      hook_variants: [], claims_used: [], unsupported_statements: [], notes_for_reviewer: "" } }) };
    const { result } = await runBrandWorkflow(deps(m, writer), { goal: GOAL, startDate: "2027-02-01" });
    const drafts = (result as { drafts: Array<{ status: string; unsupported: string[] }> }).drafts;
    expect(drafts.every((d) => d.status === "draft")).toBe(true);
    expect(drafts[0]!.unsupported.join(" ")).toMatch(/restates research from https:\/\/example.org\/mock\/reporting-guidance/);
  });

  it("contradicting sources are reported and excluded from evidence", async () => {
    const { result } = await runBrandWorkflow(deps(mockSpecialists()), { goal: "Ransomware readiness for UK firms", startDate: "2027-03-01" });
    const r = result as { research: { contradictions: Array<{ source_urls: string[] }>; summary: Array<{ source_url: string; flags: string[] }> } };
    expect(r.research.contradictions).toHaveLength(1);
    const contradicted = r.research.summary.filter((s) => s.flags.includes("contradicted")).map((s) => s.source_url);
    expect(contradicted.sort()).toEqual(["https://example.org/mock/contradicting-survey", "https://example.org/mock/uk-breaches-survey"]);
  });
});

describe("knowledge quality", () => {
  it("synthetic or placeholder Brand Brain knowledge is flagged as not production", async () => {
    const admin = await t.login("admin");
    await t.api("select lbe.brain_upsert_entry($1, 'identity', 'main', 'Who', '[SYNTHETIC] test identity', '{}'::jsonb, 'owner', null)", [admin]);
    await t.api("select lbe.brain_upsert_entry($1, 'voice_company', 'main', 'Voice', '> **Status: PLACEHOLDER — owner to complete.**', '{}'::jsonb, 'import', 'brand/voice/company.md')", [admin]);
    const { result } = await runBrandWorkflow(deps(mockSpecialists()), { goal: "Supplier security reviews", startDate: "2027-04-05" });
    const r = result as { brain: { non_production_knowledge: string[] }; warnings: string[] };
    expect(r.brain.non_production_knowledge).toEqual(expect.arrayContaining(["identity/main (synthetic)", "voice_company/main (imported_placeholder)"]));
    expect(r.brain.non_production_knowledge.some((x) => x.startsWith("claim: [SYNTHETIC]"))).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/NOT PRODUCTION KNOWLEDGE/);
  });
});
