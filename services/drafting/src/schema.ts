import { z } from "zod";

/** Structured output contract for the drafting model. Unknown keys are rejected. */
export const DraftOutputSchema = z
  .object({
    body: z.string().describe("The LinkedIn post text, ready for human review. Max ~3000 characters."),
    hook_variants: z.array(z.string()).describe("Up to 3 alternative opening lines."),
    claims_used: z
      .array(
        z
          .object({
            claim_id: z.string().describe("ID of a claim from the APPROVED CLAIMS list. Never invent IDs."),
            quoted_span: z.string().describe("Exact substring of `body` that relies on this claim."),
          })
          .strict(),
      )
      .describe("Every place the body relies on an approved claim."),
    unsupported_statements: z
      .array(z.string())
      .describe("Every sentence in `body` that states a fact NOT backed by an approved claim. Empty only if none."),
    notes_for_reviewer: z.string().describe("Short notes for the human reviewer: assumptions, gaps, suggested evidence."),
  })
  .strict();

export type DraftOutput = z.infer<typeof DraftOutputSchema>;
