import { z } from "zod";

export const ROLES = ["admin", "approver", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ACCOUNT_KINDS = ["company_page", "founder_profile"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const CONTENT_STATUSES = [
  "draft", "in_review", "changes_requested", "approved", "rejected",
  "queued", "published", "failed", "needs_reconciliation",
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const OUTBOX_STATUSES = [
  "pending", "dispatching", "succeeded", "failed", "needs_reconciliation", "cancelled",
] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const CLAIM_CATEGORIES = [
  "product_capability", "security_effectiveness", "vulnerability_reference", "breach_statistic",
  "customer_outcome", "regulatory", "company_fact", "other",
] as const;
export type ClaimCategory = (typeof CLAIM_CATEGORIES)[number];

/** Canonical publication package (built and hashed by the database; this schema validates it in code). */
export const PublicationPackageSchema = z.object({
  schema: z.literal("lbe.publication.v1"),
  content_id: z.string(),
  destination: z.object({
    account_id: z.string(),
    kind: z.enum(ACCOUNT_KINDS),
    linkedin_urn: z.string().nullable(),
    publishing_mode: z.literal("mock"),
  }),
  body: z.string(),
  media_ids: z.array(z.string()),
  visibility: z.enum(["PUBLIC", "CONNECTIONS"]),
  scheduled_for: z.string().nullable(),
  claim_ids: z.array(z.string()),
});
export type PublicationPackage = z.infer<typeof PublicationPackageSchema>;

export interface VerifiedClaim {
  id: string;
  statement: string;
  category: ClaimCategory;
  evidence_url: string | null;
  evidence_note: string | null;
}

export interface Citation {
  claim_id: string;
  quoted_span: string;
}
