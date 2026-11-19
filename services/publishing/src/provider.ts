import type { PublicationPackage } from "@lbe/domain";

export interface PublishRequest {
  pkg: PublicationPackage;
  idempotencyKey: string;
}

/**
 * Outcome classification drives the outbox state machine:
 *  - success:   the provider confirmed the post and returned its reference
 *  - retryable: the provider DEFINITELY did not create the post (e.g. 429 before processing) — safe to retry
 *  - rejected:  permanent failure (validation, auth) — do not retry
 *  - ambiguous: the post may or may not exist (timeout, 5xx, malformed success) — human reconciliation, never auto-retry
 */
export type PublishOutcome =
  | { kind: "success"; providerRef: string }
  | { kind: "retryable"; error: string; retryAfterSeconds?: number }
  | { kind: "rejected"; error: string }
  | { kind: "ambiguous"; error: string };

export interface PublishingProvider {
  readonly name: "mock";
  publish(req: PublishRequest): Promise<PublishOutcome>;
}

export function createProvider(name: string, deps: { mock: () => PublishingProvider }): PublishingProvider {
  if (name === "mock") return deps.mock();
  throw new Error(
    `Publishing provider "${name}" is not available. Phase 1 allows only "mock"; ` +
      "live LinkedIn publishing requires owner approval and a reviewed Phase 2 implementation.",
  );
}
