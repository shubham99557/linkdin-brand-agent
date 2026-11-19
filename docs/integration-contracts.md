# Integration Contracts

> **2026-11-19:** Superseded where they differ by the implemented migrations in `supabase/migrations/` and by
> [decisions/ADR-log.md](decisions/ADR-log.md) (notably ADR-002, 003, 004, 013). Original text preserved below.

_Draft v0.1 · 2026-11-18. Contracts between components. Field lists are proposals, finalized in Stage 7 migrations._

## 1. Data model (Supabase / Postgres)

Schema `brand` (content) and `crm` (leads). All tables: `id uuid pk`, `created_at`, `updated_at`. RLS enabled on
every table; service-role key used only by n8n server-side, never in a browser.

### Content side
| Table | Key columns | Notes |
|---|---|---|
| `social_accounts` | `kind` (`company_page`/`founder_profile`), `linkedin_urn` unique, `voice_profile`, `enabled bool`, `token_expires_at` | Tokens live in n8n credentials, **not** here |
| `claims` | `statement`, `evidence_url`, `evidence_note`, `category` (product/security/stat/customer/regulatory), `status` (verified/expired/rejected), `verified_by`, `expires_at` | The only source of factual claims |
| `content_items` | `account_id fk`, `pillar`, `brief`, `body`, `body_sha256`, `media jsonb`, `status` (draft→in_review→approved→scheduled→published/failed/rejected), `scheduled_for`, `linkedin_post_urn` unique, `utm_campaign` | |
| `content_claims` | `content_id fk`, `claim_id fk`, `quoted_span` | Every factual sentence ↔ claim |
| `approvals` | `subject_type` (content/reply/outreach), `subject_id`, `decision` (approved/rejected/changes_requested), `approver`, `approved_sha256`, `decided_at`, `note` | Immutable (no UPDATE/DELETE via RLS) |
| `post_metrics` | `content_id fk`, `captured_at`, `impressions`, `reactions`, `comments`, `reposts`, `clicks` | Aggregates only; retained ≤1 year |
| `comment_queue` | `content_id fk`, `comment_urn` unique, `text`, `fetched_at`, `reply_draft`, `status` | **Purged at fetched_at + 48h** by pg_cron; no author identity stored beyond URN needed to reply |

### Lead side
| Table | Key columns | Notes |
|---|---|---|
| `companies` | `name`, `domain` unique (nullable), `companies_house_no` unique (nullable), `entity_type` (ltd/plc/llp/sole_trader/partnership/unknown) | `entity_type` drives PECR rules |
| `people` | `email_normalized` unique, `full_name`, `job_title`, `company_id fk`, `source` (lead_magnet/lead_gen_form/inbound/manual), `lawful_basis` (consent/legitimate_interests), `consent_at`, `consent_text_version` | No LinkedIn-API-derived rows permitted (CHECK on `source`) |
| `suppression` | `email_hash` unique, `reason`, `created_at` | Hash so it survives erasure |
| `lead_magnets` | `slug` unique, `title`, `asset_path`, `active` | |
| `lead_events` | `person_id fk`, `event_type`, `occurred_at`, `utm jsonb`, `idempotency_key` unique | Intent evidence (first-party) |
| `score_rules` | `version`, `dimension` (fit/intent), `rule_key`, `points`, `active` | Versioned |
| `lead_evidence` | `person_id`, `rule_key`, `rule_version`, `points`, `source_ref`, `quoted_span` | One row per scoring point |
| `lead_scores` (view) | `fit`, `intent`, `fit_known_ratio` | NULL = unknown, distinct from 0 |
| `conversations`, `conversation_messages` | `channel` (email/linkedin_manual/meeting), `direction`, `body`, `status` (draft/approved/sent) | Trigger blocks `sent` without approval + suppression check |
| `meetings`, `opportunities` | from Atomic CRM `deals` pattern | |
| `attribution_events` | `person_id`, `content_id` nullable, `utm_*`, `touch` (first/last) | |

### Controls
| Table | Purpose |
|---|---|
| `control_flags` | `key` (`global_stop`, `stop:<account>`), `enabled`, `changed_by`, `changed_at` |
| `audit_events` | append-only: `actor`, `action`, `subject`, `request_hash`, `response_status`, `at` |
| `agent_runs` | model, prompt version, input refs, output ref, tokens, cost |

## 2. Drafting contract (Claude)

Input: `{account_kind, voice_profile_md, brief, allowed_claims:[{id, statement}], format: "text"|"document"}`
Output (structured JSON, validated): `{body, hook_variants[], claims_used:[{claim_id, quoted_span}], unsupported_statements:[string], visual_brief?}`
Rules: model receives only verified claims; any factual statement not mapped → `unsupported_statements` → item cannot
move to `in_review` until resolved. External text (comments, articles) passed inside delimited data blocks, never as
instructions; the model has **no tools** in drafting.

## 3. Approval contract

`approve(subject_id, approver, sha256)` succeeds only if `sha256 == content_items.body_sha256` and status is
`in_review`. Any edit after approval resets status to `in_review`. Founder-profile items require approver = founder.

## 4. Publisher contract (n8n)

Trigger: schedule (every 5 min) → select `status='scheduled' AND scheduled_for<=now()`.
Pre-checks in order: `global_stop` off → account stop off → account `enabled` → latest approval matches hash →
token not expired. Call: `POST https://api.linkedin.com/rest/posts`, headers `LinkedIn-Version: <pinned YYYYMM>`,
`X-Restli-Protocol-Version: 2.0.0`. Idempotency: `content_items.id` held in a row lock; on 201 store `x-restli-id`
→ `linkedin_post_urn`. Retry: 429/5xx exponential backoff ×3 then `failed` + alert. Every call → `audit_events`.

## 5. Render service contract

`POST /render` (internal network only) `{template_id, data, format: "png"|"pdf"}` → binary. Templates are
repo-controlled; `data` is text only; images only as data URIs from an allow-listed bucket; no remote fetch.

## 6. Lead capture contract

`POST /functions/v1/lead-capture` `{email, name, company, job_title, magnet_slug, consent: true, consent_text_version, utm}`
→ validates, checks suppression, upserts person by `email_normalized`, inserts `lead_events` with idempotency key,
triggers delivery email (transactional, so allowed). Rate-limited + bot check.
