import type { PublicationPackage } from "@lbe/domain";

export interface PublishRequest {
  pkg: PublicationPackage;
  idempotencyKey: string;
}

/** Side effects the worker must apply (all of them only ever STOP things, never resume). */
export type PublishAlert =
  | { kind: "credential_invalid"; detail: string }   // 401 / missing token → mark credential invalid + stop account
  | { kind: "permission_denied"; detail: string }    // 403 → stop account
  | { kind: "version_sunset"; detail: string };      // 426 → stop everything until the API version is updated

/**
 * Outcome classification drives the outbox state machine:
 *  - success:   the provider confirmed the post and returned its reference
 *  - retryable: the provider DEFINITELY did not create the post (e.g. 429, connection refused) — safe to retry
 *  - rejected:  permanent failure (validation, auth) — do not retry
 *  - ambiguous: the post may or may not exist (timeout, 5xx, 409, malformed success) — human reconciliation, never auto-retry
 */
export type PublishOutcome =
  | { kind: "success"; providerRef: string }
  | { kind: "retryable"; error: string; retryAfterSeconds?: number }
  | { kind: "rejected"; error: string; alert?: PublishAlert }
  | { kind: "ambiguous"; error: string };

export type ProviderName = "mock" | "linkedin";

export interface PublishingProvider {
  readonly name: ProviderName;
  publish(req: PublishRequest): Promise<PublishOutcome>;
}

export type ProviderRegistry = Partial<Record<ProviderName, PublishingProvider>>;

export function createProvider(name: string, deps: { mock: () => PublishingProvider }): PublishingProvider {
  if (name === "mock") return deps.mock();
  throw new Error(
    `Publishing provider "${name}" is not available as the default provider. The live LinkedIn provider is ` +
      "registered separately and only when LBE_LIVE_PUBLISHING=on (owner-approved stages only).",
  );
}
