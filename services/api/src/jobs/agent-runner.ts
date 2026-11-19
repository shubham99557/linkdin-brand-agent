// Durable agent job runner (P4-01). Claims one queued job at a time, runs the Branding Agent workflow as the
// requesting user via a database-minted JOB SESSION, keeps its lease alive with heartbeats, records progress,
// honours cancellation at step boundaries, and always finishes the job (succeeded / failed / cancelled).
// If this process dies, the lease expires and job_recover_expired() marks the job 'interrupted'.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runBrandWorkflow, WorkflowCancelledError, type Specialists, type StepTimeouts, type WorkflowProgress } from "@lbe/agents";
import type { Drafter } from "@lbe/drafting";
import { redactForLog } from "@lbe/security";
import type { Db } from "../db.ts";

export interface AgentRunnerDeps {
  db: Db;
  specialists: Specialists;
  writer: Drafter;
  voiceDir: string;
  workerId: string;
  leaseSeconds?: number;
  /** Background heartbeat while a single model call is in progress. */
  heartbeatMs?: number;
  budgetUsd?: number;
  /** Per-step time limits (defaults: DEFAULT_STEP_TIMEOUTS_MS in @lbe/agents). */
  stepTimeoutsMs?: Partial<StepTimeouts>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface AgentTickResult {
  recovered: number;
  job: null | { id: string; status: "succeeded" | "failed" | "cancelled"; workflowId: string | null; error?: string };
}

interface Claim {
  id: string; kind: "brand_workflow"; session: string; params: { goal: string; start_date?: string; days?: number; post_count?: number };
  /** Set when an earlier attempt already started this job's workflow → resume it (P4-02). */
  workflow_id: string | null;
  spent_usd: number;
}

export async function runAgentJobTick(deps: AgentRunnerDeps): Promise<AgentTickResult> {
  const worker = async <T>(sql: string, params: unknown[] = []) =>
    deps.db.tx("lbe_worker", async (q) => Object.values((await q.query<Record<string, unknown>>(sql, params))[0] ?? {})[0] as T);
  const lease = deps.leaseSeconds ?? 120;
  const recovered = await worker<number>("select lbe.job_recover_expired()");
  const claim = await worker<Claim | null>("select lbe.job_claim($1, $2)", [deps.workerId, lease]);
  if (!claim) return { recovered, job: null };

  let workflowId: string | null = claim.workflow_id;
  let lastProgress: Record<string, unknown> = { stage: claim.workflow_id ? "resuming" : "starting" };
  let cancel = false;
  const beat = async () => {
    const r = await worker<{ ok: boolean; cancel: boolean }>("select lbe.job_heartbeat($1, $2, $3::jsonb, $4, $5)",
      [deps.workerId, claim.id, JSON.stringify(lastProgress), workflowId, lease]);
    if (!r.ok || r.cancel) cancel = true;
  };
  const timer = setInterval(() => { beat().catch(() => undefined); }, deps.heartbeatMs ?? Math.max(5_000, (lease * 1000) / 4));

  let status: "succeeded" | "failed" | "cancelled" = "succeeded";
  let error: string | undefined;
  let finalUsd: number | undefined;
  try {
    const out = await runBrandWorkflow({
      db: deps.db, session: claim.session, specialists: deps.specialists, writer: deps.writer, budgetUsd: deps.budgetUsd,
      resumeWorkflowId: claim.workflow_id ?? undefined, priorSpentUsd: Number(claim.spent_usd) || 0,
      readVoiceFile: async (profile) => readFile(path.join(deps.voiceDir, `${profile}.md`), "utf8").catch(() => null),
      onProgress: async (p: WorkflowProgress) => {
        workflowId = p.workflowId;
        lastProgress = { stage: p.stage, done: p.done ?? null, total: p.total ?? null, estimated_usd: p.estimatedUsd ?? 0, at: new Date().toISOString() };
        await beat();
        return cancel ? "cancel" : undefined;
      },
      stepTimeoutsMs: deps.stepTimeoutsMs,
    }, { goal: claim.params.goal, startDate: claim.params.start_date, days: claim.params.days, postCount: claim.params.post_count });
    finalUsd = (out.result.cost as { estimated_usd?: number } | undefined)?.estimated_usd;
  } catch (err) {
    finalUsd = (err as { estimatedUsd?: number }).estimatedUsd;
    status = err instanceof WorkflowCancelledError ? "cancelled" : "failed";
    error = status === "cancelled" ? "cancelled by user" : redactForLog(err);
  } finally {
    clearInterval(timer);
  }
  try {
    lastProgress = { ...lastProgress, stage: status, ...(finalUsd !== undefined ? { estimated_usd: finalUsd } : {}) };
    await beat().catch(() => undefined);
    await worker("select lbe.job_finish($1, $2, $3, $4)", [deps.workerId, claim.id, status, error ?? null]);
  } catch (err) {
    // Lease lost (e.g. this runner was too slow and the job was marked interrupted). Nothing else to do.
    deps.log?.("agent_job_finish_failed", { job_id: claim.id, error: redactForLog(err) });
  }
  deps.log?.("agent_job", { job_id: claim.id, status, workflow_id: workflowId });
  return { recovered, job: { id: claim.id, status, workflowId, ...(error ? { error } : {}) } };
}

/** Run ticks on an interval in this process (skips while a job is still running). Returns a stop function. */
export function startAgentRunner(deps: AgentRunnerDeps & { intervalMs: number }): () => void {
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      // Drain the queue: keep going while jobs are available.
      for (;;) {
        const r = await runAgentJobTick(deps);
        if (!r.job) break;
      }
    } catch (err) {
      deps.log?.("agent_job_tick_failed", { error: redactForLog(err) });
    } finally {
      busy = false;
    }
  }, deps.intervalMs);
  return () => clearInterval(t);
}
