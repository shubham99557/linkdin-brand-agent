// P4-05: pipelined drafting — faster, same results as one-at-a-time drafting, budget decisions unchanged, and
// nothing left running when a workflow ends (finished, cancelled or failed).
import { afterEach, describe, expect, it } from "vitest";
import { mockSpecialists, runBrandWorkflow, worstCaseCallUsd, type Specialist, type Specialists, type CreativeInput } from "@lbe/agents";
import { MockDrafter, type Drafter, type DraftInput } from "@lbe/drafting";
import { freshDb, type TestDb } from "../helpers/db.ts";

const GOAL = "Build a one-week LinkedIn branding strategy for ActTrident aimed at UK businesses, focusing on phishing awareness.";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const open: TestDb[] = [];
afterEach(async () => { while (open.length) await open.pop()!.db.close(); });

/** Instrumented slow writer + creative specialist: records inputs and how many calls overlap. */
function harness(opts: { writerMs?: number; creativeMs?: number; priced?: { writer: [number, number]; creative: [number, number] };
                       creativeThrowsOn?: number } = {}) {
  const state = { active: 0, maxActive: 0, creativeActive: 0, overlapSeen: false, writerInputs: [] as DraftInput[], creativeCalls: 0 };
  const enter = () => { state.active++; state.maxActive = Math.max(state.maxActive, state.active); };
  const real = new MockDrafter();
  const writer: Drafter = {
    provider: opts.priced ? "anthropic" : "mock", model: opts.priced ? "claude-opus-5-5" : "mock-drafter-v1",
    draft: async (i) => {
      enter(); state.writerInputs.push(i);
      if (state.creativeActive > 0) state.overlapSeen = true;
      try {
        await pause(opts.writerMs ?? 0);
        const r = await real.draft(i);
        return r.kind === "ok" && opts.priced ? { ...r, usage: { inputTokens: opts.priced.writer[0], outputTokens: opts.priced.writer[1] } } : r;
      } finally { state.active--; }
    },
  };
  const m = mockSpecialists();
  const creative: Specialist<CreativeInput> = {
    role: m.creative.role, promptVersion: m.creative.promptVersion,
    provider: opts.priced ? "anthropic" : "mock", model: opts.priced ? "claude-opus-5-5" : m.creative.model,
    run: async (i, o) => {
      enter(); state.creativeActive++; state.creativeCalls++;
      try {
        if (opts.creativeThrowsOn === state.creativeCalls) throw new Error("creative service exploded");
        await pause(opts.creativeMs ?? 0);
        const r = await m.creative.run(i, o);
        return r.kind === "ok" && opts.priced ? { ...r, usage: { inputTokens: opts.priced.creative[0], outputTokens: opts.priced.creative[1] } } : r;
      } finally { state.active--; state.creativeActive--; }
    },
  };
  const specialists: Specialists = { ...m, creative };
  return { state, writer, specialists };
}

async function run(parallelDrafts: number, h: ReturnType<typeof harness>, extra: { budgetUsd?: number; onProgress?: Parameters<typeof runBrandWorkflow>[0]["onProgress"] } = {}) {
  const t = await freshDb();
  open.push(t);
  const session = await t.login("editor");
  const started = performance.now();
  const out = await runBrandWorkflow({ db: t.db, session, specialists: h.specialists, writer: h.writer, parallelDrafts,
    now: () => new Date("2026-11-19T09:00:00Z"), ...extra }, { goal: GOAL, startDate: "2027-01-04", postCount: 4 });
  return { t, ms: performance.now() - started, result: out.result as { drafts: Array<Record<string, unknown>>; cost: { estimated_usd: number; budget_exhausted: boolean }; warnings: string[] } };
}

/** What a reviewer sees of each draft — everything except database ids. */
const comparable = (drafts: Array<Record<string, unknown>>) => drafts.map((d) => ({
  account_kind: d.account_kind, pillar: d.pillar, topic: d.topic, status: d.status, body: d.body, scheduled_for: d.scheduled_for,
  unsupported: d.unsupported, voice_warnings: d.voice_warnings, visual_brief: d.visual_brief,
  citations: (d.citations as Array<{ quoted_span: string }>).map((c) => c.quoted_span),
}));

describe("pipelined drafting (P4-05)", () => {
  it("produces exactly the same drafts as one-at-a-time drafting, with the same writer inputs, faster", async () => {
    const seq = harness({ writerMs: 80, creativeMs: 80 });
    const par = harness({ writerMs: 80, creativeMs: 80 });
    const a = await run(1, seq);
    const b = await run(3, par);

    expect(b.result.drafts).toHaveLength(8);
    expect(comparable(b.result.drafts)).toEqual(comparable(a.result.drafts));
    // Every writer saw the same earlier openings in the same order (P3-03 originality input is unchanged).
    expect(par.state.writerInputs.map((i) => i.otherOpenings)).toEqual(seq.state.writerInputs.map((i) => i.otherOpenings));
    expect(par.state.writerInputs.map((i) => i.brief)).toEqual(seq.state.writerInputs.map((i) => i.brief));
    // One-at-a-time never overlaps; pipelined overlaps a visual brief with the next writer, never two writers.
    expect(seq.state.maxActive).toBe(1);
    expect(par.state.overlapSeen).toBe(true);
    expect(par.state.maxActive).toBeGreaterThan(1);
    expect(par.state.maxActive).toBeLessThanOrEqual(3);
    expect(b.ms).toBeLessThan(a.ms);
    console.info(`P4-05 timing (8 drafts, 80 ms writer + 80 ms visual brief): one-at-a-time ${Math.round(a.ms)} ms, pipelined ${Math.round(b.ms)} ms`);
  });

  it("budget: a paid-like run makes the same decisions and spends the same as one-at-a-time drafting", async () => {
    // Writer ≈ $0.60 per draft, visual brief ≈ $0.12 (slow). One at a time: W1 .60, C1 .72, W2 1.32, C2 1.44 → the
    // $1.40 budget is exhausted and drafting stops. Only the in-flight visual brief's cost crosses the line, so a
    // pipeline that ignored work in flight would start a third writer at $1.32 — this test catches that.
    const priced = { writer: [100_000, 10_000] as [number, number], creative: [20_000, 2_000] as [number, number] };
    const seq = harness({ priced, writerMs: 10, creativeMs: 100 });
    const par = harness({ priced, writerMs: 10, creativeMs: 100 });
    const a = await run(1, seq, { budgetUsd: 1.4 });
    const b = await run(3, par, { budgetUsd: 1.4 });
    expect(a.result.drafts).toHaveLength(2);
    expect(a.result.cost.budget_exhausted).toBe(true);
    expect(b.result.cost.budget_exhausted).toBe(true);
    expect(b.result.cost.estimated_usd).toBe(a.result.cost.estimated_usd);
    expect(comparable(b.result.drafts)).toEqual(comparable(a.result.drafts));
    expect(par.state.creativeCalls).toBe(seq.state.creativeCalls);
    expect(b.result.warnings.filter((w) => /Budget/.test(w))).toEqual(a.result.warnings.filter((w) => /Budget/.test(w)));
  });

  it("budget: with plenty of headroom the paid-like run still overlaps, and spends the same", async () => {
    const priced = { writer: [100_000, 10_000] as [number, number], creative: [20_000, 2_000] as [number, number] };
    const seq = harness({ priced, writerMs: 30, creativeMs: 30 });
    const par = harness({ priced, writerMs: 30, creativeMs: 30 });
    const a = await run(1, seq, { budgetUsd: 50 });
    const b = await run(3, par, { budgetUsd: 50 });
    expect(par.state.overlapSeen).toBe(true);
    expect(b.result.cost.budget_exhausted).toBe(false);
    expect(b.result.cost.estimated_usd).toBe(a.result.cost.estimated_usd);
    expect(comparable(b.result.drafts)).toEqual(comparable(a.result.drafts));
  });

  it("cancel: work in flight finishes before the workflow stops; nothing keeps running afterwards", async () => {
    const h = harness({ writerMs: 20, creativeMs: 120 });
    let checkpoints = 0;
    let activeAtStop = -1;
    await expect(run(3, h, { onProgress: async (p) => (p.stage === "drafting" && ++checkpoints === 3 ? "cancel" : undefined) }))
      .rejects.toThrow(/cancelled/);
    activeAtStop = h.state.active;
    expect(activeAtStop).toBe(0);
    // Every draft whose text was written also got its visual brief (none abandoned half-way).
    expect(h.state.writerInputs.length).toBe(2);
    expect(h.state.creativeCalls).toBe(2);
    const t = open[open.length - 1]!;
    const [w] = await t.db.query<{ status: string }>("select status from lbe.agent_workflows order by created_at desc limit 1");
    expect(w!.status).toBe("cancelled");
  });

  it("an error in background work fails the workflow (like one-at-a-time), after in-flight work has settled", async () => {
    const h = harness({ writerMs: 10, creativeMs: 40, creativeThrowsOn: 2 });
    await expect(run(3, h)).rejects.toThrow(/creative service exploded/);
    expect(h.state.active).toBe(0);
    const t = open[open.length - 1]!;
    const [w] = await t.db.query<{ status: string; error: string }>("select status, error from lbe.agent_workflows order by created_at desc limit 1");
    expect(w!.status).toBe("failed");
    expect(w!.error).toMatch(/creative service exploded/);
  });
});

describe("worstCaseCallUsd", () => {
  it("is an upper bound for any single call, priced at the dearer of the model and the fallback, twice", () => {
    // Opus 5.5 ($4/$20) vs fallback Opus 4.8 ($5/$25) → $5/$25; 1,000 bytes of input + 20,000 overhead, 16,000 out.
    expect(worstCaseCallUsd("claude-opus-5-5", "anthropic", 1_000)).toBeCloseTo(2 * (21_000 * 5 + 16_000 * 25) / 1e6, 10);
    expect(worstCaseCallUsd("anything", "mock", 1_000_000)).toBe(0);
    expect(worstCaseCallUsd("unknown-model", "anthropic", 10)).toBe(Number.POSITIVE_INFINITY);
  });
});
