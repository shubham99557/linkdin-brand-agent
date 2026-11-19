import { PublicationPackageSchema } from "@lbe/domain";
import type { PublishingProvider, PublishOutcome, MockStore } from "@lbe/publishing";
import type { Db } from "../db.ts";

interface OutboxRow {
  id: string;
  account_id: string;
  package: unknown;
  idempotency_key: string;
}

export interface TickSummary {
  expired: number;
  claimed: number;
  succeeded: number;
  retried: number;
  failed: number;
  ambiguous: number;
  released: number;
  errors: string[];
}

export interface PublisherOptions {
  workerId: string;
  batchSize?: number;
  leaseSeconds?: number;
  /** Provider calls taking longer than this are treated as ambiguous. */
  providerTimeoutMs?: number;
}

const withTimeout = async (p: Promise<PublishOutcome>, ms: number): Promise<PublishOutcome> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<PublishOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "ambiguous", error: `provider call exceeded ${ms}ms` }), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * One publisher pass. Orchestrator-agnostic: run it from the in-process timer, the worker
 * CLI, or an external scheduler (n8n, cron) via the authenticated internal endpoint.
 * All state transitions go through database functions running as `lbe_worker`.
 */
export async function runPublisherTick(db: Db, provider: PublishingProvider, opts: PublisherOptions): Promise<TickSummary> {
  const s: TickSummary = { expired: 0, claimed: 0, succeeded: 0, retried: 0, failed: 0, ambiguous: 0, released: 0, errors: [] };
  const worker = opts.workerId;
  const leaseSeconds = opts.leaseSeconds ?? 120;
  const timeoutMs = opts.providerTimeoutMs ?? Math.floor((leaseSeconds * 1000) / 2);

  const expired = await db.tx("lbe_worker", (q) =>
    q.query<{ n: number }>("select lbe.expire_stale_dispatches($1) as n", [worker]));
  s.expired = expired[0]?.n ?? 0;

  const claimed = await db.tx("lbe_worker", (q) =>
    q.query<OutboxRow>("select id, account_id, package, idempotency_key from lbe.claim_outbox($1, $2, $3)",
      [worker, opts.batchSize ?? 5, leaseSeconds]));
  s.claimed = claimed.length;

  for (const row of claimed) {
    const complete = (outcome: string, ref: string | null, error: string | null, retryAfter: number | null = null) =>
      db.tx("lbe_worker", (q) =>
        q.query("select lbe.complete_outbox($1, $2, $3, $4, $5, $6)", [row.id, worker, outcome, ref, error, retryAfter]));
    try {
      // Re-check STOP immediately before the external call (STOP may have been pressed after claiming).
      const stopped = await db.tx("lbe_worker", (q) =>
        q.query<{ stopped: boolean }>("select lbe.is_stopped($1) as stopped", [row.account_id]));
      if (stopped[0]?.stopped !== false) {
        await complete("released", null, "publishing stopped before send");
        s.released++;
        continue;
      }
      const pkg = PublicationPackageSchema.safeParse(row.package);
      if (!pkg.success) {
        await complete("rejected", null, "stored package failed validation");
        s.failed++;
        continue;
      }
      let outcome: PublishOutcome;
      try {
        outcome = await withTimeout(provider.publish({ pkg: pkg.data, idempotencyKey: row.idempotency_key }), timeoutMs);
      } catch (err) {
        // An exception after the request may have been sent is ambiguous by definition.
        outcome = { kind: "ambiguous", error: `provider threw: ${(err as Error).message}` };
      }
      switch (outcome.kind) {
        case "success":
          await complete("success", outcome.providerRef, null);
          s.succeeded++;
          break;
        case "retryable":
          await complete("retryable", null, outcome.error, outcome.retryAfterSeconds ?? null);
          s.retried++;
          break;
        case "rejected":
          await complete("rejected", null, outcome.error);
          s.failed++;
          break;
        case "ambiguous":
          await complete("ambiguous", null, outcome.error);
          s.ambiguous++;
          break;
      }
    } catch (err) {
      // If recording the outcome fails, the lease will expire and the entry will be
      // moved to reconciliation — it is never silently retried.
      s.errors.push(`${row.id}: ${(err as Error).message}`);
    }
  }
  return s;
}

/** MockStore backed by the lbe_mock schema (written as lbe_worker). */
export function dbMockStore(db: Db): MockStore {
  return {
    async record(post) {
      await db.tx("lbe_worker", (q) =>
        q.query(
          `insert into lbe_mock.linkedin_posts(mock_post_urn, idempotency_key, author, commentary, visibility, payload)
           values ($1, $2, $3, $4, $5, $6)`,
          [post.mockPostUrn, post.idempotencyKey, post.author, post.commentary, post.visibility, JSON.stringify(post.payload)],
        ));
    },
  };
}
