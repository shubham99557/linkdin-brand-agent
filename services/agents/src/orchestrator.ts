import { createHash } from "node:crypto";
import type { VerifiedClaim } from "@lbe/domain";
import { PROMPT_VERSION as DRAFT_PROMPT_VERSION, validateDraftOutput, type Drafter } from "@lbe/drafting";
import { buildBrandContext, entriesFor, nonProductionKnowledge, prohibitedTerms, prohibitedTopics, voiceFor, type BrandBrain } from "./brain.ts";
import type { Specialist, Specialists, SpecialistResult, StrategyItem } from "./schemas.ts";
import { Budget } from "./cost.ts";
import {
  checkBrandRules, findingRestatements, usableEvidence, validateCreative, validateExtraction, validatePerformance, validateResearch,
  validateStrategy, type ValidFinding,
} from "./validate.ts";

/**
 * Brand Orchestrator — a deterministic coordinator (runtime option A). It calls specialists in a fixed
 * order, validates everything they return, and writes ONLY through database functions available to the
 * `lbe_agent` role. That role cannot approve, release, publish, resume STOP, verify claims, or write
 * approved Brand Brain knowledge — the database enforces this, not this code.
 */
export interface AgentDb {
  tx<T>(role: "lbe_agent", fn: (q: { query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]> }) => Promise<T>): Promise<T>;
}

export interface AgentDeps {
  db: AgentDb;
  /** Raw session token of the human who asked for the work; the database resolves who they are. */
  session: string;
  specialists: Specialists;
  writer: Drafter;
  /** Fallback when a voice is not yet in the Brand Brain (Phase 1 brand/voice files). */
  readVoiceFile?: (profile: "company" | "founder") => Promise<string | null>;
  now?: () => Date;
  /** Hard ceiling on estimated model spend for one workflow (USD). Calls stop once reached. */
  budgetUsd?: number;
  /**
   * Called at each step boundary (durable job runner: heartbeat + progress). Returning "cancel" stops the
   * workflow before the next model call; work already saved (drafts, findings) is kept.
   */
  onProgress?: (p: WorkflowProgress) => Promise<void | "cancel">;
  /** Resume this existing workflow (P4-02): reuse saved research, strategy and drafts; never duplicate a draft. */
  resumeWorkflowId?: string;
  /** Estimated spend of earlier attempts (counts towards budgetUsd on resume). */
  priorSpentUsd?: number;
  /** Per-step time limits (ms). A step that runs over is aborted (the model request is cancelled) and handled as a failed step. */
  stepTimeoutsMs?: Partial<StepTimeouts>;
  /**
   * P5-03: render and attach the draft's visual BEFORE it is submitted, so the reviewer approves text and visual
   * together. Returns attached=false with a note when it cannot (e.g. brand colours not set yet).
   */
  attachVisual?: (contentId: string, brief: Record<string, unknown>) => Promise<{ attached: boolean; note?: string }>;
}

export interface StepTimeouts { research: number; strategy: number; draft: number; creative: number }
/**
 * Defaults sit above the SDK's own per-request timeout × retries for single calls, and allow for research's
 * multi-turn web search. They bound how long one stuck call can hold a job.
 */
export const DEFAULT_STEP_TIMEOUTS_MS: StepTimeouts = { research: 480_000, strategy: 240_000, draft: 240_000, creative: 180_000 };

/** Run one step with a time limit; on expiry abort it and return an error result instead of waiting for ever. */
async function withStepTimeout<R>(label: string, ms: number, run: (signal: AbortSignal) => Promise<R>,
                                  onTimeout: (message: string) => R): Promise<R> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<R>((resolve) => {
    // Settle with the timeout result FIRST, then abort: otherwise the aborted request's own error would win the race.
    timer = setTimeout(() => { resolve(onTimeout(`${label} timed out after ${Math.round(ms / 1000)}s`)); ac.abort(); }, ms);
  });
  try {
    return await Promise.race([run(ac.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stable id for "plan item i of workflow w" (stored as content_items.variant_group). A resumed run derives the
 * same id, finds the draft it already made, and continues it; the database allows only one draft per
 * (workflow, plan item, account).
 */
export function planItemGroup(workflowId: string, index: number): string {
  const h = createHash("sha256").update(`${workflowId}:plan-item:${index}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface SavedDraft {
  id: string; status: string; account_kind: Kind; pillar: string; topic: string | null; body: string | null; scheduled_for: string | null;
  variant_group: string | null; unsupported: string[] | null; visual_brief: Record<string, unknown> | null;
  citations: Array<{ claim_id: string; quoted_span: string }>;
}
interface Checkpoint {
  strategy: { summary: string; items: StrategyItem[] } | null;
  findings: Array<{ id: string; statement: string; source_url: string; source_title: string | null; publisher: string | null;
    published_at: string | null; confidence: "high" | "medium" | "low"; stale: boolean; flags: string[] }>;
  drafts: SavedDraft[];
}

export interface WorkflowProgress {
  stage: "started" | "research" | "strategy" | "drafting" | "finishing";
  workflowId: string;
  done?: number;
  total?: number;
  estimatedUsd?: number;
}

export class WorkflowCancelledError extends Error {
  constructor() { super("cancelled by user"); this.name = "WorkflowCancelledError"; }
}

export interface WorkflowInput {
  goal: string;
  startDate?: string;   // YYYY-MM-DD
  days?: number;
  postCount?: number;   // 3–5
  region?: string;
  audience?: string;
}

const KINDS = ["company_page", "founder_profile"] as const;
type Kind = (typeof KINDS)[number];

/** Drafts already decided by the pipeline (submitted for review, or held with blocking issues) — not touched again. */
const isSettled = (d: SavedDraft) => !!d.body && (d.status !== "draft" || (d.unsupported ?? []).length > 0);

function helpers(deps: AgentDeps) {
  const q = <R>(sql: string, params: unknown[] = []) => deps.db.tx("lbe_agent", (t) => t.query<R>(sql, params));
  const one = async <R>(sql: string, params: unknown[] = []) => {
    const rows = await q<Record<string, unknown>>(sql, params);
    return (rows[0] ? Object.values(rows[0])[0] : undefined) as R;
  };
  const recordRun = (purpose: string, s: { provider: string; model: string; promptVersion: string }, r: SpecialistResult,
                     startedAt: string, refs: Record<string, unknown>, output?: unknown, contentId?: string, statusOverride?: string) =>
    one("select lbe.record_agent_run($1, $2::jsonb)", [deps.session, JSON.stringify({
      purpose, provider: s.provider, model: s.model, prompt_version: s.promptVersion, content_id: contentId ?? null,
      input_refs: refs, started_at: startedAt,
      status: statusOverride ?? (r.kind === "ok" ? "succeeded" : r.kind === "refused" ? "refused" : "failed"),
      error: r.kind === "ok" ? null : r.kind === "refused" ? r.reason : r.message,
      output: output ?? null,
      input_tokens: r.kind === "ok" ? r.usage?.inputTokens ?? null : null,
      output_tokens: r.kind === "ok" ? r.usage?.outputTokens ?? null : null,
    })]);
  return { q, one, recordRun };
}

async function loadBrain(deps: AgentDeps): Promise<BrandBrain> {
  return helpers(deps).one<BrandBrain>("select lbe.brain_load($1)", [deps.session]);
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export async function runBrandWorkflow(deps: AgentDeps, input: WorkflowInput): Promise<{ workflowId: string; result: Record<string, unknown> }> {
  const { one, recordRun } = helpers(deps);
  const now = (deps.now ?? (() => new Date()))();
  const days = Math.min(Math.max(input.days ?? 7, 1), 31);
  const postCount = Math.min(Math.max(input.postCount ?? 4, 3), 5);
  const startDate = input.startDate ?? isoDate(new Date(now.getTime() + 86_400_000));
  const goal = input.goal.trim();
  const resuming = !!deps.resumeWorkflowId;
  const workflowId = deps.resumeWorkflowId ?? await one<string>("select lbe.workflow_create($1, $2, $3::jsonb)",
    [deps.session, goal, JSON.stringify({ startDate, days, postCount, region: input.region ?? "UK", audience: input.audience ?? null })]);
  const warnings: string[] = [];
  const budget = new Budget(deps.budgetUsd ?? null);
  budget.addPrior(deps.priorSpentUsd ?? 0);
  const limits: StepTimeouts = { ...DEFAULT_STEP_TIMEOUTS_MS, ...deps.stepTimeoutsMs };
  const asError = (message: string): SpecialistResult => ({ kind: "error", message });
  const checkpoint = async (stage: WorkflowProgress["stage"], extra: Partial<WorkflowProgress> = {}) => {
    if (!deps.onProgress) return;
    if ((await deps.onProgress({ stage, workflowId, estimatedUsd: budget.spentUsd, ...extra })) === "cancel") throw new WorkflowCancelledError();
  };

  try {
    await checkpoint("started");
    // 1. Brand Brain (org-scoped by the database)
    const brain = await loadBrain(deps);
    const brandContext = buildBrandContext(brain);
    if (brain.missing_sections.length) {
      warnings.push(`Brand Brain is missing: ${brain.missing_sections.join(", ")}. Drafts avoid these topics rather than inventing them.`);
    }
    const nonProduction = nonProductionKnowledge(brain);
    if (nonProduction.length) {
      warnings.push(`NOT PRODUCTION KNOWLEDGE: ${nonProduction.length} synthetic/placeholder Brand Brain item(s) were used — drafts are for testing only and must not be published.`);
    }
    const terms = prohibitedTerms(brain);
    const accounts = KINDS.map((k) => brain.accounts.find((a) => a.kind === k)).filter((a): a is BrandBrain["accounts"][number] => !!a);
    if (accounts.length === 0) throw new Error("no social accounts configured for this organization");

    // Resume (P4-02): load what earlier attempts already saved for this workflow.
    const saved: Checkpoint | null = resuming
      ? await one<Checkpoint>("select lbe.workflow_get($1, $2)", [deps.session, workflowId])
      : null;
    if (saved) {
      warnings.push(`Resumed after an interruption: reused ${saved.findings.length} saved finding(s), ${saved.strategy ? "the saved plan" : "no plan"} and ${saved.drafts.length} saved draft(s); nothing was duplicated.`);
    }

    // 2. Research (skipped on resume once findings or a plan were saved)
    await checkpoint("research");
    let findings: Array<ValidFinding & { id: string }> = [];
    let rejectedSources: Array<{ source_url: string; reason: string }> = [];
    let gaps: string[] = [];
    let contradictions: Array<{ source_urls: string[]; description: string }> = [];
    const reuseResearch = !!saved && (saved.findings.length > 0 || !!saved.strategy);
    if (reuseResearch) {
      findings = saved!.findings.map((f) => ({ ...f, source_title: f.source_title ?? "", relevance: "", flags: f.flags ?? [] }));
    }
    const researchStarted = new Date().toISOString();
    const research: SpecialistResult = reuseResearch ? { kind: "ok", raw: null } : await withStepTimeout("research", limits.research,
      (signal) => deps.specialists.research.run({
        goal, region: input.region ?? "UK", audience: input.audience ?? (entriesFor(brain, "icp")[0]?.body.slice(0, 500) ?? "UNKNOWN"),
        brandSummary: entriesFor(brain, "identity").map((e) => e.body).join(" ").slice(0, 1000) || "UNKNOWN", maxFindings: 8,
      }, { signal }), asError);
    if (!reuseResearch) budget.add("research", deps.specialists.research.model, research.kind === "ok" ? research.usage : undefined, deps.specialists.research.provider);
    if (reuseResearch) {
      // already recorded by the earlier attempt
    } else if (research.kind === "ok") {
      const v = validateResearch(research.raw, { allowedUrls: research.allowedUrls, now });
      if (v.ok) {
        rejectedSources = v.rejected;
        gaps = v.gaps;
        contradictions = v.contradictions;
        if (contradictions.length) warnings.push(`${contradictions.length} contradiction(s) between sources — those findings are excluded from evidence until reviewed.`);
        const retrievedAt = now.toISOString();
        const ids = await one<string[]>("select lbe.research_record($1, $2, $3::jsonb)", [deps.session, workflowId,
          JSON.stringify(v.accepted.map((f) => ({ ...f, query: goal, retrieved_at: retrievedAt })))]);
        findings = v.accepted.map((f, i) => ({ ...f, id: ids[i]! }));
        await recordRun("research", deps.specialists.research, research, researchStarted, { workflow_id: workflowId },
          { accepted: findings.length, rejected: rejectedSources, gaps });
      } else {
        warnings.push(`Research output rejected: ${v.error}`);
        await recordRun("research", deps.specialists.research, research, researchStarted, { workflow_id: workflowId }, { error: v.error }, undefined, "invalid_output");
      }
    } else {
      warnings.push(`Research unavailable (${research.kind === "refused" ? research.reason : research.message}); planning without new sources.`);
      await recordRun("research", deps.specialists.research, research, researchStarted, { workflow_id: workflowId });
    }
    const evidence = findings.filter(usableEvidence);

    // 3. Strategy (reused on resume once saved)
    let plan: { summary: string; items: StrategyItem[]; dropped: unknown[] };
    if (saved?.strategy) {
      plan = { summary: saved.strategy.summary, items: saved.strategy.items, dropped: [] };
    } else {
      plan = await planStrategy();
    }
    async function planStrategy(): Promise<{ summary: string; items: StrategyItem[]; dropped: unknown[] }> {
    if (budget.exhausted) throw new Error(`budget of $${budget.maxUsd} reached after research ($${budget.spentUsd}) — strategy not started`);
    await checkpoint("strategy");
    const recentTopics = brain.recent_topics.map((t) => t.topic);
    const strategyStarted = new Date().toISOString();
    const strategyRaw = await withStepTimeout("strategy", limits.strategy, (signal) => deps.specialists.strategy.run({
      goal, startDate, days, postCount, brandContext,
      accounts: accounts.map((a) => ({ kind: a.kind, pillars: a.pillars })),
      findings: evidence.map((f) => ({ id: f.id, statement: f.statement, source_url: f.source_url, confidence: f.confidence })),
      claims: brain.claims.map((c) => ({ id: c.id, statement: c.statement })),
      recentTopics, prohibitedTopics: prohibitedTopics(brain),
    }, { signal }), asError);
    budget.add("strategy", deps.specialists.strategy.model, strategyRaw.kind === "ok" ? strategyRaw.usage : undefined, deps.specialists.strategy.provider);
    if (strategyRaw.kind !== "ok") {
      await recordRun("strategy", deps.specialists.strategy, strategyRaw, strategyStarted, { workflow_id: workflowId });
      throw new Error(`strategy specialist failed: ${strategyRaw.kind === "refused" ? strategyRaw.reason : strategyRaw.message}`);
    }
    const sv = validateStrategy(strategyRaw.raw, {
      postCount, days, accounts: accounts.map((a) => ({ kind: a.kind, pillars: a.pillars })),
      findingIds: new Set(evidence.map((f) => f.id)), claimIds: new Set(brain.claims.map((c) => c.id)),
      recentTopics, prohibitedTopics: prohibitedTopics(brain),
    });
    if (!sv.ok) {
      await recordRun("strategy", deps.specialists.strategy, strategyRaw, strategyStarted, { workflow_id: workflowId }, { error: sv.error }, undefined, "invalid_output");
      throw new Error(sv.error);
    }
    warnings.push(...sv.warnings);
    await one("select lbe.strategy_save($1, $2, $3, $4::jsonb)", [deps.session, workflowId, sv.strategy.summary, JSON.stringify(sv.strategy.items)]);
    await recordRun("strategy", deps.specialists.strategy, strategyRaw, strategyStarted, { workflow_id: workflowId },
      { items: sv.strategy.items.length, dropped: sv.dropped });
    return { summary: sv.strategy.summary, items: sv.strategy.items, dropped: sv.dropped };
    }

    // 4–7. Draft each item in both voices, verify, brief visuals, submit clean drafts for review
    const voices: Record<Kind, { text: string; source: "brain" | "file" | "missing" }> = {} as never;
    for (const k of KINDS) {
      const fromBrain = voiceFor(brain, k);
      const fromFile = fromBrain ? null : await deps.readVoiceFile?.(k === "company_page" ? "company" : "founder") ?? null;
      voices[k] = fromBrain ? { text: fromBrain, source: "brain" }
        : fromFile ? { text: fromFile, source: "file" }
        : { text: "UNKNOWN voice — write plainly and conservatively.", source: "missing" };
      if (voices[k].source !== "brain") warnings.push(`${k} voice is not in the Brand Brain yet (using ${voices[k].source}).`);
    }
    const claimsById = new Map(brain.claims.map((c) => [c.id, c]));
    const drafts: Array<Record<string, unknown>> = [];
    const totalDrafts = plan.items.length * accounts.length;

    outer: for (const [index, item] of plan.items.entries()) {
      const group = planItemGroup(workflowId, index);
      const itemFindings = evidence.filter((f) => item.finding_ids.includes(f.id));
      const itemClaims: VerifiedClaim[] = item.claim_ids.map((id) => claimsById.get(id)!).map((c) => ({
        id: c.id, statement: c.statement, category: c.category as VerifiedClaim["category"], evidence_url: c.evidence_url, evidence_note: c.evidence_note,
      }));
      for (const acct of accounts) {
        const existing = saved?.drafts.find((d) => d.variant_group === group && d.account_kind === acct.kind);
        if (existing && isSettled(existing)) {
          drafts.push({ content_id: existing.id, account_kind: acct.kind, pillar: existing.pillar, topic: existing.topic ?? item.topic,
            status: existing.status, body: existing.body, scheduled_for: existing.scheduled_for, variant_group: group,
            citations: existing.citations ?? [], unsupported: existing.unsupported ?? [], visual_brief: existing.visual_brief, resumed: true });
          continue;
        }
        if (budget.exhausted) {
          warnings.push(`Budget of $${budget.maxUsd} reached ($${budget.spentUsd}); remaining drafts were not created.`);
          break outer;
        }
        await checkpoint("drafting", { done: drafts.length, total: totalDrafts });
        drafts.push(await draftOne(deps, { workflowId, item, acct, group, startDate, brandContext, voice: voices[acct.kind].text,
          itemFindings, allFindings: findings, itemClaims, terms, identity: entriesFor(brain, "identity").map((e) => e.body).join("\n"), budget,
          existing, limits }));
      }
    }

    // 8. Report
    await checkpoint("finishing", { done: drafts.length, total: totalDrafts });
    const used = new Map<string, number>();
    for (const d of drafts) for (const c of (d.citations as Array<{ claim_id: string }>)) used.set(c.claim_id, (used.get(c.claim_id) ?? 0) + 1);
    const result = {
      goal, startDate, days,
      brain: { organization: brain.organization.name, missing_sections: brain.missing_sections, entries_used: brain.entries.length,
               non_production_knowledge: nonProduction,
               voice_sources: { company_page: voices.company_page.source, founder_profile: voices.founder_profile.source } },
      research: {
        provider: deps.specialists.research.provider,
        accepted: findings.length, usable_as_evidence: evidence.length, stale: findings.filter((f) => f.stale).length,
        flagged: findings.filter((f) => f.flags.includes("possible_prompt_injection")).length, rejected: rejectedSources, gaps, contradictions,
        summary: findings.map((f) => ({ id: f.id, statement: f.statement, source_url: f.source_url, confidence: f.confidence,
          stale: f.stale, flags: f.flags, retrieved_at: now.toISOString() })),
      },
      strategy: { summary: plan.summary, items: plan.items, dropped: plan.dropped },
      drafts,
      claims_report: {
        verified_claims_used: [...used.entries()].map(([id, count]) => ({ claim_id: id, statement: claimsById.get(id)?.statement, count })),
        drafts_with_unsupported_statements: drafts.filter((d) => (d.unsupported as string[]).length > 0).length,
        submitted_for_review: drafts.filter((d) => d.status === "in_review").length,
        held_as_draft: drafts.filter((d) => d.status === "draft").length,
      },
      publishing: "Nothing was published. Drafts await human approval in the review queue.",
      cost: { estimated_usd: budget.spentUsd, budget_usd: budget.maxUsd, budget_exhausted: budget.exhausted, by_step: budget.byStep },
      warnings,
    };
    await one("select lbe.workflow_finish($1, $2, 'completed', $3::jsonb, null)", [deps.session, workflowId, JSON.stringify(result)]);
    return { workflowId, result };
  } catch (err) {
    const message = (err as Error).message;
    const status = err instanceof WorkflowCancelledError ? "cancelled" : "failed";
    if (err && typeof err === "object") (err as { estimatedUsd?: number }).estimatedUsd = budget.spentUsd;   // for the job's cost record
    await one("select lbe.workflow_finish($1, $2, $3, $4::jsonb, $5)", [deps.session, workflowId, status,
      JSON.stringify({ warnings, cost: { estimated_usd: budget.spentUsd } }), message]).catch(() => undefined);
    throw err;
  }
}

async function draftOne(deps: AgentDeps, p: {
  workflowId: string; item: StrategyItem; acct: BrandBrain["accounts"][number]; group: string; startDate: string;
  brandContext: string; voice: string; itemFindings: Array<ValidFinding & { id: string }>; itemClaims: VerifiedClaim[];
  allFindings: Array<ValidFinding & { id: string }>; terms: string[]; identity: string; budget: Budget;
  /** Resume: the draft an earlier attempt already created for this plan item and account (not yet settled). */
  existing?: SavedDraft;
  limits: StepTimeouts;
}): Promise<Record<string, unknown>> {
  const { one, recordRun } = helpers(deps);
  const pillar = p.existing?.pillar ?? p.item.pillars[p.acct.kind];
  const scheduled = new Date(`${p.startDate}T09:00:00Z`);
  scheduled.setUTCDate(scheduled.getUTCDate() + p.item.day - 1);
  const brief = [p.item.angle, "", `Topic: ${p.item.topic}`, `Objective: ${p.item.objective}`, `Audience problem: ${p.item.audience_problem}`,
    `Voice: ${p.acct.kind === "company_page" ? "company page (we)" : "founder (I)"}`].join("\n");
  const sourceMaterial = p.itemFindings.length
    ? p.itemFindings.map((f) => `- ${f.statement} (source: ${f.source_url}; confidence ${f.confidence})`).join("\n")
    : null;
  // Create the draft and link it to its plan item in ONE transaction (no orphan drafts after a crash). The
  // database refuses a second draft for the same (workflow, plan item, account).
  const contentId = p.existing?.id ?? await deps.db.tx("lbe_agent", async (t) => {
    const id = Object.values((await t.query<Record<string, string>>("select lbe.create_content($1, $2, $3, $4, $5, $6)",
      [deps.session, p.acct.id, pillar, brief, sourceMaterial, scheduled.toISOString()]))[0]!)[0]!;
    await t.query("select lbe.set_agent_metadata($1, $2, $3::jsonb)", [deps.session, id,
      JSON.stringify({ topic: p.item.topic, workflow_id: p.workflowId, variant_group: p.group, created_via: "agent" })]);
    return id;
  });

  let body: string;
  let citations: Array<{ claim_id: string; quoted_span: string }>;
  let unsupported: string[];
  let voiceWarnings: string[] = [];
  if (p.existing?.body) {
    // Resume: the writer already finished (and its output was checked and saved); continue from the creative step.
    body = p.existing.body;
    citations = p.existing.citations ?? [];
    unsupported = p.existing.unsupported ?? [];
  } else {
  // Writer (LinkedIn Writing Specialist = the existing drafter, now with Brand Brain context)
  const started = new Date().toISOString();
  const written = await withStepTimeout(`writing the ${p.acct.kind === "company_page" ? "company" : "founder"} draft`, p.limits.draft,
    (signal) => deps.writer.draft({
      accountKind: p.acct.kind, accountName: p.acct.display_name, voiceProfile: p.voice, pillar,
      allowedPillars: p.acct.pillars, brief, sourceMaterial, claims: p.itemClaims, brandContext: p.brandContext,
    }, { signal }), (message) => ({ kind: "error" as const, message }));
  const writerMeta = { provider: deps.writer.provider, model: deps.writer.model, promptVersion: DRAFT_PROMPT_VERSION };
  p.budget.add(`draft:${p.acct.kind}`, deps.writer.model, written.kind === "ok" ? written.usage : undefined, deps.writer.provider);
  const asSpecialist: SpecialistResult = written.kind === "ok" ? { kind: "ok", raw: written.raw, usage: written.usage }
    : written.kind === "refused" ? { kind: "refused", reason: written.reason } : { kind: "error", message: written.message };
  if (written.kind !== "ok") {
    await recordRun("draft_post", writerMeta, asSpecialist, started, { workflow_id: p.workflowId }, undefined, contentId);
    return { content_id: contentId, account_kind: p.acct.kind, topic: p.item.topic, status: "draft", citations: [], unsupported: [],
      error: written.kind === "refused" ? `writer declined: ${written.reason}` : written.message };
  }
  const v = validateDraftOutput(written.raw, p.itemClaims);
  if (!v.ok) {
    await recordRun("draft_post", writerMeta, asSpecialist, started, { workflow_id: p.workflowId }, { error: v.error }, contentId, "invalid_output");
    return { content_id: contentId, account_kind: p.acct.kind, topic: p.item.topic, status: "draft", citations: [], unsupported: [], error: v.error };
  }
  // Verify brand rules (prohibited terms block submission; voice issues are warnings)
  const rules = checkBrandRules(v.draft.body, { accountKind: p.acct.kind, prohibitedTerms: p.terms });
  // Claim-to-source verification: restating research without a verified claim blocks review.
  const restated = findingRestatements(v.draft.body, v.draft.citations.map((c) => c.quoted_span), p.allFindings);
  unsupported = [...v.draft.unsupported, ...rules.blocking, ...restated];
  body = v.draft.body;
  citations = v.draft.citations;
  voiceWarnings = rules.warnings;
  await one("select lbe.set_draft_output($1, $2, $3, $4::jsonb, $5::jsonb)",
    [deps.session, contentId, v.draft.body, JSON.stringify(v.draft.citations), JSON.stringify(unsupported)]);
  await recordRun("draft_post", writerMeta, asSpecialist, started, { workflow_id: p.workflowId, claim_ids: p.itemClaims.map((c) => c.id) },
    { body: v.draft.body, citations: v.draft.citations, unsupported, validation_notes: [...v.draft.validationNotes, ...rules.warnings],
      notes_for_reviewer: v.draft.notesForReviewer, hook_variants: v.draft.hookVariants }, contentId);
  }

  // Creative Brief Specialist (skipped once the budget is reached, or when a resumed draft already has one)
  let visualBrief: Record<string, unknown> | null = p.existing?.visual_brief ?? null;
  const creativeWarnings: string[] = [];
  if (!visualBrief) {
  const cStarted = new Date().toISOString();
  const creative: SpecialistResult = p.budget.exhausted
    ? { kind: "error", message: "skipped: budget reached" }
    : await withStepTimeout("visual brief", p.limits.creative, (signal) => deps.specialists.creative.run({ body, accountKind: p.acct.kind,
        topic: p.item.topic, visualIdentity: p.identity, prohibitedTerms: p.terms }, { signal }),
        (message): SpecialistResult => ({ kind: "error", message }));
  p.budget.add(`creative:${p.acct.kind}`, deps.specialists.creative.model, creative.kind === "ok" ? creative.usage : undefined, deps.specialists.creative.provider);
  if (creative.kind === "ok") {
    const cv = validateCreative(creative.raw, { body, prohibitedTerms: p.terms });
    if (cv.ok) {
      visualBrief = { ...cv.brief, warnings: cv.warnings };
      creativeWarnings.push(...cv.warnings);
      await one("select lbe.set_agent_metadata($1, $2, $3::jsonb)", [deps.session, contentId, JSON.stringify({ visual_brief: visualBrief })]);
    }
    await recordRun("creative_brief", deps.specialists.creative, creative, cStarted, { workflow_id: p.workflowId }, cv.ok ? cv.brief : { error: cv.error }, contentId, cv.ok ? undefined : "invalid_output");
  } else {
    await recordRun("creative_brief", deps.specialists.creative, creative, cStarted, { workflow_id: p.workflowId }, undefined, contentId);
  }
  }

  // Attach the rendered visual before review (P5-03), so the approval covers it. Failure never blocks the text.
  let visualAttached = false;
  if (visualBrief && visualBrief.format !== "text_only" && deps.attachVisual) {
    try {
      const r = await deps.attachVisual(contentId, visualBrief);
      visualAttached = r.attached;
      if (r.note) creativeWarnings.push(r.note);
    } catch (err) {
      creativeWarnings.push(`Visual could not be attached: ${(err as Error).message}`);
    }
  }

  // Submit for HUMAN review only if nothing blocks it. The agent never approves.
  let status = "draft";
  if (unsupported.length === 0) {
    await one("select lbe.submit_for_review($1, $2)", [deps.session, contentId]);
    status = "in_review";
  }
  return {
    content_id: contentId, account_kind: p.acct.kind, pillar, topic: p.item.topic, status, body,
    scheduled_for: scheduled.toISOString(), variant_group: p.group,
    citations, unsupported, voice_warnings: voiceWarnings, visual_brief: visualBrief, visual_attached: visualAttached,
    visual_warnings: creativeWarnings, findings_used: p.itemFindings.map((f) => f.source_url),
    ...(p.existing ? { resumed: true } : {}),
  };
}

/** Performance Analysis → learning PROPOSALS (never direct edits). */
export async function runLearningReview(deps: AgentDeps): Promise<{ observations: string[]; proposalIds: string[]; warnings: string[] }> {
  const { one, recordRun } = helpers(deps);
  const inputs = await one<{ decisions: Array<Record<string, string>>; publications: Array<Record<string, string>> }>(
    "select lbe.learning_inputs($1)", [deps.session]);
  const brain = await loadBrain(deps);
  const started = new Date().toISOString();
  const r = await deps.specialists.performance.run({
    decisions: inputs.decisions as never, publications: inputs.publications as never, metrics: "none_available",
    existingLessons: entriesFor(brain, "lessons").map((e) => e.title),
  });
  if (r.kind !== "ok") {
    await recordRun("performance_review", deps.specialists.performance, r, started, {});
    throw new Error(`performance analysis failed: ${r.kind === "refused" ? r.reason : r.message}`);
  }
  const known = new Set([...inputs.decisions, ...inputs.publications].map((d) => d.content_id!));
  const v = validatePerformance(r.raw, { knownContentIds: known });
  if (!v.ok) {
    await recordRun("performance_review", deps.specialists.performance, r, started, {}, { error: v.error }, undefined, "invalid_output");
    throw new Error(v.error);
  }
  const proposalIds: string[] = [];
  for (const p of v.output.proposals) {
    proposalIds.push(await one<string>("select lbe.brain_propose($1, $2, $3, $4, $5, '{}'::jsonb, $6, $7::jsonb, 'performance_analysis')",
      [deps.session, p.section, p.key, p.title, p.body, p.rationale, JSON.stringify(p.evidence_refs.map((id) => ({ type: "content", id })))]));
  }
  await recordRun("performance_review", deps.specialists.performance, r, started, {}, { observations: v.output.observations, proposals: proposalIds });
  return { observations: v.output.observations, proposalIds, warnings: v.warnings };
}

/** Onboarding ingestion: owner-supplied material → grounded PROPOSALS for the owner to accept/edit/reject. */
export async function ingestSourceMaterial(deps: AgentDeps, source: { name: string; text: string }):
  Promise<{ proposalIds: string[]; dropped: string[] }> {
  const { one, recordRun } = helpers(deps);
  const started = new Date().toISOString();
  const r = await deps.specialists.extraction.run({ sourceName: source.name, sourceText: source.text });
  if (r.kind !== "ok") {
    await recordRun("brand_extraction", deps.specialists.extraction, r, started, { source: source.name });
    throw new Error(`extraction failed: ${r.kind === "refused" ? r.reason : r.message}`);
  }
  const v = validateExtraction(r.raw, source.text);
  if (!v.ok) {
    await recordRun("brand_extraction", deps.specialists.extraction, r, started, { source: source.name }, { error: v.error }, undefined, "invalid_output");
    throw new Error(v.error);
  }
  const proposalIds: string[] = [];
  for (const p of v.output.proposals) {
    proposalIds.push(await one<string>("select lbe.brain_propose($1, $2, $3, $4, $5, '{}'::jsonb, $6, $7::jsonb, 'brand_orchestrator')",
      [deps.session, p.section, p.key, p.title, p.body, `Extracted from owner-supplied source "${source.name}".`,
       JSON.stringify([{ type: "source_quote", source: source.name, quote: p.source_quote }])]));
  }
  await recordRun("brand_extraction", deps.specialists.extraction, r, started, { source: source.name }, { proposals: proposalIds.length, dropped: v.dropped });
  return { proposalIds, dropped: v.dropped };
}

export type { Specialist };
