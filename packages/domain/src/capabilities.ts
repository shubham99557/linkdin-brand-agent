/**
 * LinkedIn capability register.
 *
 * Distinguishes what this product implements from what LinkedIn documents as supported,
 * and from permissions we have NOT verified. Sources: docs/research (raw-linkedin-api-compliance.md,
 * evaluated 2026-11-18). "documented" means LinkedIn's official docs describe it — it does NOT
 * mean ActTrident has been granted access.
 */
export type CapabilityStatus =
  | "implemented_mock"            // works end-to-end in Phase 1 against the mock provider only
  | "contract_tested"             // built against LinkedIn's documented contract and tested with a local fake; NOT yet verified on LinkedIn
  | "documented_needs_access"     // LinkedIn documents it; requires an app/product grant we do not yet have
  | "unverified"                  // documentation unclear or conflicting; must be confirmed before design relies on it
  | "not_supported"               // LinkedIn does not offer it for this use case
  | "prohibited"                  // LinkedIn terms forbid it; the product must never do it
  | "deferred";                   // planned for a later phase

export interface Capability {
  id: string;
  label: string;
  companyPage: CapabilityStatus;
  founderProfile: CapabilityStatus;
  linkedinProduct: string;
  notes: string;
  source: string;
}

const POSTS_API = "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api";

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "publish_text_post",
    label: "Publish a text post",
    companyPage: "implemented_mock",
    founderProfile: "implemented_mock",
    linkedinProduct: "Company: Community Management API (w_organization_social). Founder: Share on LinkedIn (w_member_social).",
    notes: "Phase 1 publishes to the mock provider only. Live access requires owner approval and LinkedIn app grants.",
    source: POSTS_API,
  },
  {
    id: "live_text_post",
    label: "Live text post via Posts API (manual release)",
    companyPage: "contract_tested",
    founderProfile: "contract_tested",
    linkedinProduct: "POST /rest/posts, Linkedin-Version 202611",
    notes: "Stage 2.1: built and tested against a local fake only. Founder use of /rest/posts with only w_member_social is UNCONFIRMED (Stage 2.2 pilot).",
    source: POSTS_API,
  },
  {
    id: "oauth_connection",
    label: "Connect account via OAuth (encrypted token storage)",
    companyPage: "contract_tested",
    founderProfile: "contract_tested",
    linkedinProduct: "OAuth 2.0 authorization code flow; OIDC userinfo for the founder",
    notes: "HTTPS redirect required. 60-day tokens; reconnect needed (no refresh tokens assumed).",
    source: "https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow",
  },
  {
    id: "reconciliation_lookup",
    label: "Look up own recent posts to resolve ambiguous publishes",
    companyPage: "contract_tested",
    founderProfile: "not_supported",
    linkedinProduct: "GET /rest/posts?q=author (r_organization_social)",
    notes: "Founder posts cannot be read back (r_member_social closed) — a human checks the profile.",
    source: POSTS_API,
  },
  {
    id: "publish_document_carousel",
    label: "Publish a PDF document (carousel) post",
    companyPage: "deferred",
    founderProfile: "deferred",
    linkedinProduct: "Same as text posts + Documents API upload",
    notes: "Render service deferred to Phase 2. Organic image carousels are ads-only.",
    source: POSTS_API,
  },
  {
    id: "native_scheduling",
    label: "LinkedIn-native scheduling",
    companyPage: "not_supported",
    founderProfile: "not_supported",
    linkedinProduct: "—",
    notes: "Posts API creates PUBLISHED posts only; this product schedules via its own outbox.",
    source: POSTS_API,
  },
  {
    id: "automated_posting_policy",
    label: "Scheduled release of human-approved posts",
    companyPage: "unverified",
    founderProfile: "unverified",
    linkedinProduct: "API Terms §3.1(26)",
    notes: "Whether releasing a human-approved post at a scheduled time counts as 'automated posting' needs legal confirmation. Fallback: release on explicit click.",
    source: "https://www.linkedin.com/legal/l/api-terms-of-use",
  },
  {
    id: "aggregate_post_analytics",
    label: "Aggregate post analytics",
    companyPage: "documented_needs_access",
    founderProfile: "unverified",
    linkedinProduct: "Community Management API (organization share statistics / r_member_postAnalytics)",
    notes: "Founder-profile analytics scope availability for our app is unconfirmed.",
    source: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics",
  },
  {
    id: "read_comments",
    label: "Read comments on own posts (48h cache limit)",
    companyPage: "documented_needs_access",
    founderProfile: "unverified",
    linkedinProduct: "Community Management API",
    notes: "Member data may be cached ≤48h and never used for lead generation.",
    source: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api",
  },
  {
    id: "direct_messages",
    label: "Send DMs / InMail",
    companyPage: "not_supported",
    founderProfile: "not_supported",
    linkedinProduct: "Messages API is restricted to approved partners",
    notes: "Founder sends any message manually from an approved draft.",
    source: "https://learn.microsoft.com/en-us/linkedin/shared/integrations/communications/messages",
  },
  {
    id: "engagement_to_leads",
    label: "Turn people who engaged into leads / CRM records",
    companyPage: "prohibited",
    founderProfile: "prohibited",
    linkedinProduct: "—",
    notes: "API Terms forbid using member data to identify prospects or enrich a CRM.",
    source: "https://www.linkedin.com/legal/l/api-terms-of-use",
  },
  {
    id: "scraping_or_browser_automation",
    label: "Scraping, cookies or browser automation",
    companyPage: "prohibited",
    founderProfile: "prohibited",
    linkedinProduct: "—",
    notes: "User Agreement §8.2. Never implemented.",
    source: "https://www.linkedin.com/legal/user-agreement",
  },
] as const;
