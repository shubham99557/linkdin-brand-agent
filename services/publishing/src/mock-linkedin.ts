import { randomUUID } from "node:crypto";
import { PublicationPackageSchema } from "@lbe/domain";
import type { PublishingProvider, PublishOutcome, PublishRequest } from "./provider.ts";

export interface MockPostRecord {
  mockPostUrn: string;
  idempotencyKey: string;
  author: string;
  commentary: string;
  visibility: string;
  payload: unknown;
}

/** Where the mock provider records what LinkedIn "received". */
export interface MockStore {
  record(post: MockPostRecord): Promise<void>;
}

/**
 * success              — post recorded, URN returned
 * rate_limited         — 429 before processing: nothing recorded (retryable)
 * server_error         — 500: nothing recorded, but a real API gives no such guarantee (ambiguous)
 * timeout_after_write  — post recorded, response lost (ambiguous — the dangerous case)
 * validation_error     — 422: nothing recorded (rejected)
 */
export type MockBehaviour = "success" | "rate_limited" | "server_error" | "timeout_after_write" | "validation_error";

export class MockLinkedInProvider implements PublishingProvider {
  readonly name = "mock" as const;

  constructor(
    private readonly store: MockStore,
    private readonly behaviour: (req: PublishRequest) => MockBehaviour = () => "success",
  ) {}

  async publish(req: PublishRequest): Promise<PublishOutcome> {
    // Never accept anything that is not explicitly a mock-mode package.
    const pkg = PublicationPackageSchema.safeParse(req.pkg);
    if (!pkg.success) return { kind: "rejected", error: "invalid publication package" };
    if (pkg.data.destination.publishing_mode !== "mock") return { kind: "rejected", error: "mock provider refuses non-mock packages" };
    if (pkg.data.body.trim().length === 0) return { kind: "rejected", error: "empty commentary" };

    const mode = this.behaviour(req);
    const author = pkg.data.destination.linkedin_urn ?? `urn:li:mock-${pkg.data.destination.kind}:${pkg.data.destination.account_id}`;
    const record = async (): Promise<string> => {
      const mockPostUrn = `urn:li:share:mock-${randomUUID()}`;
      await this.store.record({
        mockPostUrn,
        idempotencyKey: req.idempotencyKey,
        author,
        commentary: pkg.data.body,
        visibility: pkg.data.visibility,
        // Shape mirrors a Posts API request body (for future contract tests).
        payload: {
          author,
          commentary: pkg.data.body,
          visibility: pkg.data.visibility,
          distribution: { feedDistribution: "MAIN_FEED" },
          lifecycleState: "PUBLISHED",
        },
      });
      return mockPostUrn;
    };

    switch (mode) {
      case "success":
        return { kind: "success", providerRef: await record() };
      case "rate_limited":
        return { kind: "retryable", error: "mock 429 Too Many Requests", retryAfterSeconds: 60 };
      case "server_error":
        return { kind: "ambiguous", error: "mock 500 Internal Server Error" };
      case "timeout_after_write":
        await record();
        return { kind: "ambiguous", error: "mock timeout after request was sent" };
      case "validation_error":
        return { kind: "rejected", error: "mock 422 Unprocessable Entity" };
    }
  }
}
