import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Drafter, DraftResult } from "./drafter.ts";
import { buildSystemPrompt, buildUserPrompt, type DraftInput } from "./prompt.ts";
import { DraftOutputSchema } from "./schema.ts";

export interface AnthropicDrafterOptions {
  apiKey: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
}

/**
 * Claude-backed drafter. Single Messages API call with a structured (Zod) output format.
 * No tools are provided, so the model cannot take any action — it only returns text.
 */
export class AnthropicDrafter implements Drafter {
  readonly provider = "anthropic" as const;
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: NonNullable<AnthropicDrafterOptions["effort"]>;

  constructor(opts: AnthropicDrafterOptions) {
    this.model = opts.model ?? "claude-opus-5-5";
    this.effort = opts.effort ?? "medium";
    this.client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 120_000, maxRetries: 2 });
  }

  async draft(input: DraftInput, opts?: { signal?: AbortSignal }): Promise<DraftResult> {
    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        // Cybersecurity content can trip safety classifiers; let the API retry on a fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: buildSystemPrompt(input),
        messages: [{ role: "user", content: buildUserPrompt(input) }],
        output_config: { effort: this.effort, format: zodOutputFormat(DraftOutputSchema) },
      }, { signal: opts?.signal });
      if (response.stop_reason === "refusal") {
        const details = response.stop_details;
        return { kind: "refused", reason: details ? `${details.category ?? "unspecified"}: ${details.explanation ?? ""}` : "refused" };
      }
      if (response.stop_reason === "max_tokens") {
        return { kind: "error", message: "model output was truncated (max_tokens)" };
      }
      if (!response.parsed_output) {
        return { kind: "error", message: "model output did not match the schema" };
      }
      return {
        kind: "ok",
        raw: response.parsed_output,
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      };
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) return { kind: "error", message: "Anthropic API key rejected" };
      if (err instanceof Anthropic.RateLimitError) return { kind: "error", message: "Anthropic rate limit — try again shortly" };
      if (err instanceof Anthropic.APIConnectionError) return { kind: "error", message: "could not reach the Anthropic API" };
      if (err instanceof Anthropic.APIError) return { kind: "error", message: `Anthropic API error ${err.status ?? ""}`.trim() };
      return { kind: "error", message: (err as Error).message };
    }
  }
}
