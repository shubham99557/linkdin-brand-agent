import { findUnsupportedStatements, type Citation, type VerifiedClaim } from "@lbe/domain";
import { DraftOutputSchema } from "./schema.ts";

export interface ValidatedDraft {
  body: string;
  citations: Citation[];
  unsupported: string[];
  hookVariants: string[];
  notesForReviewer: string;
  /** Problems found in the model's own output (shown to the reviewer). */
  validationNotes: string[];
}

export type ValidationResult = { ok: true; draft: ValidatedDraft } | { ok: false; error: string };

const MAX_BODY = 3000;

/**
 * Validate untrusted model output before it is stored as a draft.
 * The model's self-report is never trusted on its own:
 *  - citations to claims that were not supplied (or not verified) are dropped and flagged,
 *  - citations whose quoted span is not in the body are dropped and flagged,
 *  - a deterministic detector adds any uncited factual-looking sentence to `unsupported`.
 */
export function validateDraftOutput(raw: unknown, allowedClaims: readonly VerifiedClaim[]): ValidationResult {
  const parsed = DraftOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: `model output failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  }
  const out = parsed.data;
  const body = out.body.trim();
  if (body.length === 0) return { ok: false, error: "model returned an empty post" };
  if (body.length > MAX_BODY) return { ok: false, error: `post exceeds ${MAX_BODY} characters` };

  const allowed = new Set(allowedClaims.map((c) => c.id));
  const validationNotes: string[] = [];
  const unsupported = new Set(out.unsupported_statements.map((s) => s.trim()).filter(Boolean));
  const citations: Citation[] = [];
  const seen = new Set<string>();

  for (const c of out.claims_used) {
    const span = c.quoted_span.trim();
    if (!allowed.has(c.claim_id)) {
      validationNotes.push(`Dropped citation to unknown or unverified claim id "${c.claim_id}".`);
      if (span) unsupported.add(span);
      continue;
    }
    if (!span || !body.includes(span)) {
      validationNotes.push(`Dropped citation for claim ${c.claim_id}: quoted text not found in the post.`);
      continue;
    }
    if (seen.has(c.claim_id)) continue;   // one citation per claim (DB primary key)
    seen.add(c.claim_id);
    citations.push({ claim_id: c.claim_id, quoted_span: span });
  }

  for (const f of findUnsupportedStatements(body, citations.map((c) => c.quoted_span))) {
    if (![...unsupported].some((u) => u.includes(f.sentence) || f.sentence.includes(u))) {
      unsupported.add(f.sentence);
      validationNotes.push(`Detector flagged an uncited factual statement (${f.reasons.join(", ")}).`);
    }
  }

  return {
    ok: true,
    draft: {
      body,
      citations,
      unsupported: [...unsupported],
      hookVariants: out.hook_variants.slice(0, 3),
      notesForReviewer: out.notes_for_reviewer.slice(0, 2000),
      validationNotes,
    },
  };
}
