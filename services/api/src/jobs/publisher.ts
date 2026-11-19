import { PublicationPackageSchema } from "@lbe/domain";
import type { MockStore, ProviderName, ProviderRegistry, PublishingProvider, PublishOutcome } from "@lbe/publishing";
import { decryptToken } from "@lbe/security";
import type { Db } from "../db.ts";

interface OutboxRow {
  id: string;
  account_id: string;
  provider: ProviderName;
  package: unknown;
  idempotency_key: string;
}

export interface TickSummary {
  expired: number;
  credentialsExpired: number;
  claimed: number;
  succeeded: number;
  retried: number;
  failed: number;
  ambiguous: number;
  released: number;
  autoStops: number;
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

const toRegistry = (p: PublishingProvider | ProviderRegistry): ProviderRegistry =>
  "publish" in p ? { [(p as PublishingProvider).name]: p as PublishingProvider } : (p as ProviderRegistry);

/**
 * One publisher pass. Orchestrator-agnostic: run it from the in-process timer, the worker
 * CLI, or an external scheduler via the authenticated internal endpoint.
 * Only outbox rows whose provider is present in the registry are claimed, so a worker without
 * the live LinkedIn provider can never pick up (or fail) live publications.
 */
export async function runPublisherTick(
  db: Db, providers: PublishingProvider | ProviderRegistry, opts: PublisherOptions,
): Promise<TickSummary> {
  const registry = toRegistry(providers);
  const names = Object.keys(registry) as ProviderName[];
  const s: TickSummary = { expired: 0, credentialsExpired: 0, claimed: 0, succeeded: 0, retried: 0, failed: 0,
    ambiguous: 0, released: 0, autoStops: 0, errors: [] };
  const worker = opts.workerId;
  const leaseSeconds = opts.leaseSeconds ?? 120;
  const timeoutMs = opts.providerTimeoutMs ?? Math.floor((leaseSeconds * 1000) / 2);
  const w = <T>(sql: string, params: unknown[]) => db.tx("lbe_worker", (q) => q.query<T>(sql, params));

  s.expired = (await w<{ n: number }>("select lbe.expire_stale_dispatches($1) as n", [worker]))[0]?.n ?? 0;
  s.credentialsExpired = (await w<{ n: number }>("select lbe.expire_credentials($1) as n", [worker]))[0]?.n ?? 0;
  if (names.length === 0) return s;

  const claimed = await w<OutboxRow>(
    "select id, account_id, provider, package, idempotency_key from lbe.claim_outbox($1, $2, $3, $4)",
    [worker, opts.batchSize ?? 5, leaseSeconds, names]);
  s.claimed = claimed.length;

  for (const row of claimed) {
    const complete = (outcome: string, ref: string | null, error: string | null, retryAfter: number | null = null) =>
      w("select lbe.complete_outbox($1, $2, $3, $4, $5, $6)", [row.id, worker, outcome, ref, error, retryAfter]);
    try {
      const provider = registry[row.provider];
      if (!provider) {
        await complete("released", null, `provider ${row.provider} unavailable in this worker`);
        s.released++;
        continue;
      }
      // Re-check STOP immediately before the external call (STOP may have been pressed after claiming).
      const stopped = await w<{ stopped: boolean }>("select lbe.is_stopped($1) as stopped", [row.account_id]);
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
          if (outcome.alert) {
            s.autoStops++;
            if (outcome.alert.kind === "credential_invalid") {
              await w("select lbe.worker_mark_credential($1, $2, 'invalid', $3)", [worker, row.account_id, outcome.alert.detail]);
            } else if (outcome.alert.kind === "permission_denied") {
              await w("select lbe.worker_auto_stop($1, $2, $3)", [worker, `account:${row.account_id}`, outcome.alert.detail]);
            } else {
              await w("select lbe.worker_auto_stop($1, 'global', $2)", [worker, outcome.alert.detail]);
            }
          }
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

/** Token source for the live provider: ciphertext from the DB (worker role), decrypted in-process. */
export function dbTokenSource(db: Db, workerId: string, key: Buffer): (accountId: string) => Promise<string | null> {
  return async (accountId) => {
    const rows = await db.tx("lbe_worker", (q) =>
      q.query<{ c: { ciphertext: string } | null }>("select lbe.worker_get_credential($1, $2) as c", [workerId, accountId]));
    const c = rows[0]?.c;
    if (!c) return null;
    try {
      return decryptToken(key, accountId, c.ciphertext);
    } catch {
      return null;   // wrong key or tampered ciphertext → treated as no credential (fails closed)
    }
  };
}
