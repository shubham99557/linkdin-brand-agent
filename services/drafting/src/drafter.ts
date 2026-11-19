import type { DraftInput } from "./prompt.ts";

export type DraftResult =
  | { kind: "ok"; raw: unknown; usage?: { inputTokens: number; outputTokens: number } }
  | { kind: "refused"; reason: string }
  | { kind: "error"; message: string };

/**
 * A drafter turns a brief into a candidate post. It has no tools and no access to the
 * database, approvals or publishing: its output is only ever stored as a draft.
 */
export interface Drafter {
  readonly provider: "mock" | "anthropic";
  readonly model: string;
  draft(input: DraftInput): Promise<DraftResult>;
}
