# Architecture Decision Log

The 12 research documents in `docs/` (2026-11-18) are preserved unchanged as the research record.
This log records corrections and Phase 1 decisions. Where an ADR conflicts with an earlier document,
**the ADR wins**. Status values: Accepted · Proposed (needs owner approval) · Superseded.

| ADR | Title | Status | Corrects |
|---|---|---|---|
| 001 | Standalone deployment vs potential SaaS | Accepted (SaaS: Proposed) | target-architecture §1, license-review (n8n) |
| 002 | Replaceable orchestration | Accepted | target-architecture §2 #6, integration-contracts §4 |
| 003 | Transactional outbox for external actions | Accepted | integration-contracts §4 |
| 004 | Approval bound to the immutable publication package | Accepted | integration-contracts §3 |
| 005 | Protection against service-role / RLS bypass | Accepted | security-review §E |
| 006 | Mock-first publishing provider | Accepted | implementation-roadmap Slice 1 |
| 007 | Authenticated dashboard in milestone 1; in-database sessions | Accepted (Supabase Auth: Proposed) | implementation-roadmap Slice 1 |
| 008 | Supported vs unverified LinkedIn capabilities | Accepted | target-architecture §4 |
| 009 | Dependency selection and pinning policy | Accepted | selective-reuse-plan ("pin at build") |
| 010 | Assumptions and owner decisions register | Accepted | — |
| 011 | Embedded PostgreSQL for development; schema `lbe` | Accepted | integration-contracts §1 |
| 012 | Single-tenant data model | Accepted | — |
| 013 | Ambiguous publication results require reconciliation | Accepted | integration-contracts §4 (retry policy) |
| 014 | Live publishing gate and manual release (Stage 2.1) | Accepted | ADR-006 (extends) |
| 015 | LinkedIn credentials: encryption and identity binding | Accepted | security-review §E |
| 016 | OAuth callback hand-off through the dashboard | Accepted | — |
| 017 | Founder endpoint and pilot environment (Stage 2.2) | Accepted | ADR-014, phase-2-plan §3.5 |
| 018 | Brand Brain as versioned, owner-approved memory in PostgreSQL | Accepted | target-architecture "Brand OS" |
| 019 | Organizations and memory isolation (partial tenancy) | Accepted | ADR-012 (partially superseded) |
| 020 | Agent runtime: Messages API + deterministic coordinator | Accepted | target-architecture §2 |
| 021 | `lbe_agent` database role and proposal-only memory write-back | Accepted | ADR-005 (extends) |
| 022 | STOP levels: platform / organization / account | Accepted | ADR-005, earlier "global STOP" wording |
| 023 | Tenant isolation verified on every route; remaining gaps | Accepted | ADR-019 (updates) |
| 024 | Migration upgrade & rollback policy | Accepted | — |
| 025 | Evidence integrity: contradictions and claim-to-source checks | Accepted | ADR-020 (extends) |
| 026 | Evaluation policy: no automatic "ready", gated paid runs, hard budget | Accepted | — |
| 027 | Internal-first (Customer Zero), SaaS later; plan.md is the execution plan | Accepted (owner) | implementation-roadmap phase numbering |
| 028 | Durable agent jobs with job sessions; resume, retry, step time limits | Accepted | ADR-020 (extends) |
| 029 | Render dependencies: satori, resvg-wasm, pdfkit, Inter (P5-00 gate) | Accepted | selective-reuse-plan "resvg-js" → resvg-wasm |
| 030 | Visuals are part of the approved publication package | Accepted | ADR-005 (extends) |
| 031 | Monthly campaigns are sequential weekly agent jobs | Accepted | ADR-028 (extends) |

---

## ADR-001 — Standalone deployment vs potential commercial SaaS
**Context.** The owner made this a standalone product. The research assumed internal use by ActTrident only.
A future SaaS offering changes licensing, security and LinkedIn obligations.

**Decision.** Phase 1 targets **Mode A: single-organisation, self-hosted** (ActTrident's own company page and
founder profile). **Mode B: multi-tenant SaaS** is *not built* and is recorded as an option needing owner approval.

| Concern | Mode A (now) | Mode B (if approved later) |
|---|---|---|
| Tenancy | One organisation | Tenant isolation in every table + RLS by tenant, per-tenant keys |
| LinkedIn apps | ActTrident's own apps | Per-customer authorisation; LinkedIn partner review for multi-customer use; customer is data controller, we are processor |
| n8n licence | Internal use permitted (SUL) | Hosting n8n for customers is **not** permitted without a commercial licence → ADR-002 keeps n8n optional |
| Legal | ActTrident privacy notice, LIA | DPA, sub-processor list, terms of service, DPIA |
| Ops | Local / single VM | SLOs, backups per tenant, incident response, billing |

**Consequence.** Code is organised by module (domain, security, drafting, publishing, api, web) so tenancy can
be added later, but no tenant columns exist (ADR-012).

## ADR-002 — Replaceable orchestration
**Context.** The research placed publishing logic inside n8n workflows, coupling business rules to a tool whose
licence restricts SaaS use.

**Decision.** All business rules live in PostgreSQL functions/triggers and TypeScript modules. Background work is
a plain function, `runPublisherTick()` (`services/api/src/jobs/publisher.ts`), which any scheduler can run:
the in-process timer (default), the standalone worker (`npm run worker`), or an external orchestrator (n8n, cron,
cloud scheduler) via `POST /api/internal/publisher-tick` with a bearer token. **n8n is not used in Phase 1.**
`workflows/README.md` documents the contract.

## ADR-003 — Transactional outbox
**Decision.** External actions are never performed inside a user request. `lbe.enqueue_publication()` creates a
`publication_outbox` row and sets the content to `queued` **in one transaction**, only if the latest approval
matches the current package. A worker claims rows with `FOR UPDATE SKIP LOCKED`, calls the provider outside the
transaction, and records the outcome with `lbe.complete_outbox()`. A partial unique index allows only one live
outbox row per content item; `idempotency_key = content_id:package_hash`.

## ADR-004 — Approval bound to the immutable publication package
**Context.** The research bound approvals to the post body hash only.

**Decision.** The database builds a canonical package (`lbe.build_package`) and its SHA-256 on every write:
`schema, content_id, destination{account_id, kind, linkedin_urn, publishing_mode}, body, media_ids, visibility,
scheduled_for (UTC, second precision), claim_ids (sorted)`. Approvals store the hash **and a snapshot of the
package taken by the database**. Any change to a package field — including destination URN, citations or
schedule — resets the content to `draft` and the old approval no longer matches. The reviewer's client sends the
hash it displayed; a mismatch is refused (stale review). The outbox stores the approved snapshot, and the
publisher sends exactly that snapshot.

**Open point (owner).** Including `scheduled_for` means rescheduling requires re-approval. This is the safe
default; see `owner-decisions.md` D-08.

## ADR-005 — Protection against service-role and RLS bypass
**Decision.** Three layers:
1. **Invariants in triggers** that apply to every role, including `service_role` and the table owner: content
   state machine, approval validation and immutability, outbox creation/transition rules, STOP check on
   dispatch, append-only audit, immutable verified claims, `publishing_mode = 'mock'` constraint.
2. **No direct write privileges** for application roles. `lbe_api` can only SELECT and EXECUTE specific
   `SECURITY DEFINER` functions; `lbe_worker` can only run outbox functions. No access to `sessions` or password hashes.
3. **Identity resolved in the database.** Privileged functions take the raw session token and resolve the user
   and role inside PostgreSQL (`lbe.require_user`). A compromised API process cannot act as an approver
   without a valid approver session. Passwords are bcrypt-hashed by pgcrypto inside the database.

**Residual risk.** A database superuser can disable triggers or replace functions. Mitigations: migrations are
reviewed and checksummed (`lbe_schema_migrations`), production must use non-superuser login roles that are
members of `lbe_api` / `lbe_worker` only, and audit events record every state change.

## ADR-006 — Mock-first publishing provider
**Decision.** `PublishingProvider` interface with outcome classes `success | retryable | rejected | ambiguous`.
Only `MockLinkedInProvider` exists. Live publishing is blocked in four places: config schema
(`LBE_PUBLISHING_PROVIDER` must be `mock`), provider factory, outbox `provider = 'mock'` constraint, and
`social_accounts.publishing_mode = 'mock'` constraint. Enabling live publishing therefore requires a reviewed
migration and code change. The mock can simulate success, 429, 500, timeout-after-write and 422.

## ADR-007 — Authenticated dashboard in the first milestone; in-database sessions
**Decision.** Milestone 1 includes the dashboard. Authentication uses database-managed sessions (random 256-bit
token, only its SHA-256 stored, 12-hour expiry, HttpOnly + SameSite=Strict cookie, lockout after 5 failures,
Origin check for CSRF). Users are created by an administrator CLI — no sign-up, no emails.

**Why not Supabase Auth now.** It would require Docker for local work, sends emails by default, and would move
identity outside the database checks in ADR-005. **Proposed:** adopt Supabase Auth (or SSO) before any
multi-user production use, mapping its JWT subject to `app_users` (owner decision D-05).

## ADR-008 — Supported vs unverified LinkedIn capabilities
**Decision.** `packages/domain/src/capabilities.ts` is the single register, shown in the dashboard. Statuses:
`implemented_mock`, `documented_needs_access`, `unverified`, `not_supported`, `prohibited`, `deferred`.
"Documented" never implies ActTrident has access. Notable corrections: founder-profile analytics and comment
reading are **unverified**; whether scheduled release of approved posts counts as "automated posting" is
**unverified** (legal).

## ADR-009 — Dependency selection and pinning
**Decision.** Exact versions (`--save-exact`), lockfile committed. Policy: newest stable release that is at least
14 days old at selection time (supply-chain cooldown), licence checked, `npm audit` must report no high/critical.
npm 11 blocks dependency install scripts by default; none are approved (esbuild's optional postinstall is not
needed). Selected on 2026-11-19:

| Package | Version | Licence |
|---|---|---|
| typescript | 7.0.2 | Apache-2.0 |
| tsx | 4.23.15 | MIT |
| vitest | 5.1.0 | MIT |
| @playwright/test | 1.65.0 | Apache-2.0 |
| @electric-sql/pglite | 0.5.15 | Apache-2.0 |
| pg | 8.23.1 | MIT |
| hono / @hono/node-server | 4.13.16 / 2.1.6 | MIT |
| zod | 4.6.7 | MIT |
| @anthropic-ai/sdk | 1.6.0 | Apache-2.0 |
| react / react-dom | 19.3.1 | MIT |
| vite / @vitejs/plugin-react | 8.3.6 / 6.2.1 | MIT |
| Docker image postgres | 18.6-alpine3.23 | PostgreSQL |
| embedded-postgres (dev only, added 2026-11-19 with owner approval) | 18.6.0-beta.19 | MIT (bundles PostgreSQL binaries; `postgres.exe` unsigned — registry signature verified) |
| Microsoft VC++ Redistributable x64 (system, owner-approved) | 14.52.37029.0 | Microsoft licence |
| satori / @resvg/resvg-wasm / pdfkit / @fontsource/inter (approved 2026-11-19 for P5-01, see ADR-029) | 0.63.2 / 2.6.2 / 0.20.2 / 5.3.0 (+ fflate 0.7.5 override) | MPL-2.0 / MPL-2.0 / MIT / OFL-1.1 |
| @axe-core/playwright (dev only, P5-06) | 4.14.0 (released 2026-10-15) with `axe-core` pinned to 4.14.0 (released 2026-10-05). axe-core 4.14.1 (2026-11-16) is inside the cooldown, so it is overridden. No install scripts; registry signatures verified | MPL-2.0 (unmodified) |

Newer releases existed (e.g. vitest 5.1.1, @anthropic-ai/sdk 1.10.0) but were inside the cooldown window.

## ADR-010 — Assumptions and owner decisions
**Decision.** Maintained in `docs/owner-decisions.md`. Development assumptions are listed there separately
from decisions that require owner approval.

## ADR-011 — Embedded PostgreSQL for development; schema `lbe`
**Decision.** Development and the main test suite use PGlite (PostgreSQL 18.6 compiled to WebAssembly, in
process) so the product runs without Docker. Migrations are plain SQL in `supabase/migrations` and run
unchanged on PostgreSQL/Supabase. Concurrency tests (`tests/pg`) need a real multi-connection server (Docker).
Tables live in schema `lbe` (not `public`) so Supabase's auto-generated REST API does not expose them; Supabase
`anon`/`authenticated` roles are explicitly revoked.

## ADR-012 — Single-tenant data model
**Decision.** No `tenant_id` columns. If Mode B is approved, add a `tenants` table and a `tenant_id` foreign key
to `social_accounts`, `claims`, `content_items`, `app_users` and propagate through functions; RLS policies by
tenant. Estimated as a dedicated migration plus function changes, not a rewrite.

## ADR-014 — Live publishing gate and manual release (Stage 2.1)
**Context.** LinkedIn API Terms §3.1(26) forbid using the APIs "to automate posting"; legal has not yet ruled on
human-approved scheduled release (P2-D1). ADR-006 blocked live publishing completely.

**Decision.** Live publishing becomes possible only when **all** of these hold. Any one switched off means nothing is sent:
1. `LBE_LIVE_PUBLISHING=on`, which config refuses unless `LBE_ENV=staging`. When it is off, the live provider is not
   constructed, the API refuses to enable live accounts or release live jobs, and workers do not claim `linkedin` rows.
2. An admin ran `set_live_publishing` (records `live_enabled_by/at`; database constraint).
3. A valid, unexpired credential exists (database trigger; `is_stopped` treats a live account without one as stopped).
4. Global and account STOP are off.

Live accounts are forced to `release_mode = 'manual'` by a check constraint. A live outbox row has
`requires_release = true` and cannot be claimed or dispatched until an approver of that account calls
`release_publication` ("Publish now"). The API additionally requires `confirm_public_post: true`.

The outbox `provider` is derived from the **approved package's** destination, so mock approvals never go live.
Switching an account between mock and live changes every unpublished package hash, which invalidates prior
approvals. Workers claim only providers they have (`claim_outbox(..., p_providers)`).

There is a daily cap of 25 dispatches per account (UTC day), far below LinkedIn's limits.

## ADR-015 — LinkedIn credentials: encryption and identity binding
**Decision.**
- Access tokens are encrypted with **AES-256-GCM in the application**, using a key from `LBE_TOKEN_ENC_KEY`
  (never stored in the database). The additional authenticated data binds each ciphertext to its account.
- `lbe_api` can read credential metadata but not the ciphertext column. Only `lbe_worker` receives ciphertext,
  through a definer function, and only for live accounts with a valid credential.
- Provider responses map to alerts that only ever **stop** things: 401 → credential invalid + account stopped;
  403 → account stopped; 426 → global stop. Workers cannot resume.
- Expired credentials are detected every tick.
- Error text is sanitised. Tests assert that no token or client secret appears in API responses, audit events
  or logs.
- Minimum scopes: founder `openid profile w_member_social`; company `w_organization_social r_organization_social`.

## ADR-016 — OAuth callback hand-off through the dashboard
**Context.** LinkedIn redirects the browser cross-site, so the `SameSite=Strict` session cookie is not sent to
the callback.

**Decision.** `GET /api/oauth/linkedin/callback` performs no work. It redirects to
`/#/oauth/complete?code&state`. Fragments are not sent to servers, and `Referrer-Policy: no-referrer` applies.
The dashboard then POSTs the code and state with the admin's session. The database accepts the state only for
the **same admin** who started the flow, only once, and within 10 minutes. Storing the credential requires the
consumed state. HTTPS redirect URIs are enforced by config. Local HTTPS is supported through `LBE_TLS_PFX`.

## ADR-017 — Founder endpoint and pilot environment (Stage 2.2)
**Context.** The plan targeted `/rest/posts` with a fallback to `/v2/ugcPosts`. The official Share on LinkedIn page,
checked 2026-11-19 (page updated 2023-12-14), documents **only** `POST /v2/ugcPosts`
(`X-Restli-Protocol-Version: 2.0.0`, `specificContent.com.linkedin.ugc.ShareContent.shareCommentary.text`,
`201` with `X-RestLi-Id`). Its examples send hashtags unescaped.

**Decision.**
- Person authors default to the documented `/v2/ugcPosts`, with plain-text commentary.
  `LBE_LINKEDIN_MEMBER_ENDPOINT=posts` switches to `/rest/posts`, but only after the pilot confirms it works.
- Organization authors always use `/rest/posts`.
- The pilot runs on a **separate** configuration (`.env.staging`), a separate database (`.data/staging`),
  HTTPS on `localhost:8443` with a self-signed certificate, the background worker **off** (an admin runs the
  publisher deliberately), and no synthetic users.
- Tooling: `setup:staging`, `staging:init`, `staging:user`, `start:staging`; `pilot:preflight` (no LinkedIn
  calls); `pilot:verify` (read-only userinfo + introspection, explicit flag required).

## ADR-018 — Brand Brain as versioned, owner-approved memory in PostgreSQL
**Decision.**
- Brand knowledge lives in `lbe.brand_entries`: 13 sections, keyed and versioned. Exactly one approved version
  exists per key, approved text is immutable, and entries are never deleted.
- Only an admin (owner) writes approved knowledge, either directly (onboarding) or by accepting a proposal.
  The owner can edit a proposal before accepting it.
- Missing required sections are reported, and prompts label them UNKNOWN.
- The `brand/voice` files become an import source with a read-only fallback, avoiding two sources of truth.
- No Claude Code memory is used, which keeps the Brand Brain portable to a SaaS runtime.

## ADR-019 — Organizations and memory isolation (partial tenancy)
**Decision.** An `organizations` table is added. `organization_id` is added to `app_users`, `social_accounts`
and `claims`; existing rows go to the ActTrident organization.

Memory isolation:
- All Brand Brain, proposal, research and workflow access goes through `SECURITY DEFINER` functions that scope
  to the caller's organization.
- No application role has table privileges on these tables.
- Objects belonging to another organization return *not found*.

Write-path isolation:
- Content creation, claim citation and claim status changes check the organization.
- Approvers can only be attached to accounts in their own organization.

The main API read views (accounts, claims, content, outbox) filter by organization.

**Not yet done** (SaaS plan §7): organization-level row-level security on the remaining tables and views,
multi-organization membership, and removing the default-org convenience.

## ADR-020 — Agent runtime: Messages API + deterministic coordinator
**Decision.** Specialists are single structured-output Messages API calls with no client tools. Research uses
the server-side `web_search` tool, and its URLs are checked against the URLs the tool actually returned. A
TypeScript coordinator sequences them.

Not chosen:
- The Claude Agent SDK, which brings filesystem and shell tools into a web service.
- Claude Managed Agents, which is beta, keeps session history outside our database, and adds a second
  control plane.

LangGraph, CrewAI and n8n were not added. Claude Code is used for prototyping only (`.claude/agents`).
Mock specialists are the default (`LBE_AGENTS=mock`); `anthropic` requires an API key and costs money.

## ADR-021 — `lbe_agent` database role and proposal-only memory write-back
**Decision.** Agent code runs as the `lbe_agent` role. It can read the Brand Brain, record research, workflows
and strategies, create drafts, submit them for review, and **propose** knowledge changes.

It has **no** grant to approve, enqueue, release, resume STOP, verify claims, enable live publishing, or write
or decide Brand Brain entries. It also has no direct table reads.

Prompt injection or a compromised specialist therefore cannot bypass the approval gates. The database refuses,
and tests prove it.

## ADR-022 — STOP levels: platform / organization / account
**Context.** The audit found that the single "global" STOP flag was platform-wide. An editor in one organization
could stop publishing for every organization, and another organization's admin could lift it.

**Decision.** There are three levels, and the database checks all three when claiming and dispatching (fail closed):
- **Platform** (`global` row): changed only by operators (`lbe.platform_set_stop`, no application grant) or by
  automatic safety stops such as an API-version sunset.
- **Organization** (`org:<id>`): the dashboard's "Stop all publishing". Any editor or approver in that organization
  can stop it; only an admin of that organization can resume.
- **Account** (`account:<id>`): only for accounts of the caller's organization.

The API keys `global` and `organization` both mean "my organization".

## ADR-023 — Tenant isolation verified on every route; remaining gaps
**Decision and status.** All 48 API routes and every `SECURITY DEFINER` function were reviewed. Isolation is
enforced in three ways:
- organization filters in API read queries (accounts, claims, content, outbox, mock posts, audit, controls, voice);
- organization checks inside every function that acts on an object ID;
- definer-only access to memory tables.

A privilege snapshot test (`tests/db/function-security.test.ts`) fails on any new grant.

**Remaining gaps (accepted for Mode A, required before SaaS):**
1. `lbe_api` has table-level SELECT across organizations. Isolation depends on every API query filtering
   correctly. Add organization row-level security (a session-bound organization setting) as a second layer.
2. Users belong to one organization; there is no membership table.
3. The `default_org_id()` convenience default still exists.
4. `agent_runs` has no organization column. It is only exposed through organization-checked content.
5. The token-protected `/api/internal/publisher-tick` is platform-wide by design.
6. The login rate limiter is in-memory and per process.

## ADR-024 — Migration upgrade & rollback policy
**Decision.** Migrations are forward-only, transactional per file, and checksummed. Rollback means a backup taken
before the migration, or a forward fix. No down-migrations are maintained. Upgrade preservation and atomicity
are covered by tests. Procedure: `docs/migrations-runbook.md`.

## ADR-025 — Evidence integrity: contradictions and claim-to-source checks
**Decision.**
- Research output includes `conflicts`. Contradicted findings are flagged, set to low confidence, excluded from
  evidence and reported.
- A draft sentence that restates a research finding (topic similarity ≥ 0.5) without a verified-claim citation
  is treated as unsupported, so it can't reach review.
- Findings become claims only when a human creates a draft claim and an approver verifies it.

## ADR-026 — Evaluation policy
**Decision.**
- Automated evaluation returns `NOT_READY` or `NEEDS_HUMAN_REVIEW`, never "ready"; human scoring decides.
- Paid Claude runs require an API key, an explicit budget and an explicit authorization flag.
- The workflow enforces a hard budget on estimated spend. Unknown models are priced as infinite, never free.
- ~~Web-search pricing is an unverified assumption~~. **Verified 2026-11-19 (P3-01)** against
  https://platform.claude.com/docs/en/about-claude/pricing. Prices per million tokens (input/output):
  - Opus 5.5: $4 / $20.
  - Sonnet 5.5: $2 / $10.
  - Fable 5.2: $8 / $40.
  - Haiku 5.5: $0.10 / $0.50 for prompts up to 100k tokens, $0.50 / $2.50 above. **The budget uses the higher
    tier.**
  - Web search: $10 per 1,000 searches; search results are also billed as input tokens.
  - Opus 4.8 (fallback target): $5 / $25.
- **Server-side fallbacks.** We send `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta, and
  that pairing is valid. Cyber-category refusals, which fit our domain, are re-run on **Claude Opus 4.8** and
  billed at its rates. Each Claude adapter now reports the serving model (`response.model`). When a fallback
  ran, the estimate charges the dearer price twice, once for the declined attempt and once for the rescue,
  as an upper bound.
- **Not used:** US-only routing (`inference_geo: "us"`, 1.1×), fast mode, prompt caching and batch. Estimates
  count all input at full price, so they err high.
- **Model availability:** `claude-opus-5-5` is current and will not be retired before 22 Sep 2027.
  `web_search_20260209` is the right tool version for it.
- Synthetic or placeholder knowledge is flagged in every workflow result and fails staging pre-flight.

## ADR-027 — Internal-first (Customer Zero), commercial SaaS later; plan.md is the execution plan
**Decision (owner, 2026-11-19).** ActTrident is Customer Zero. Build for internal production launch first
(Mode A, ADR-001); keep SaaS boundaries (organizations, isolation, budgets, STOP levels) but defer RLS,
memberships, billing, customer onboarding and per-tenant apps to Phase 10. No integration with the older
`ai-social-media-team`. Root `plan.md` is the single execution plan; ADRs remain the architectural record.
Supersedes the phase numbering in `docs/implementation-roadmap.md` (kept for history).

## ADR-028 — Durable agent jobs with database-minted job sessions (P4-01)
**Decision.** Branding Agent workflows run as durable jobs (`lbe.agent_jobs`), not inside HTTP requests. The API
enqueues (`job_enqueue`, editor+), and a runner (`lbe_worker`) claims a job with `FOR UPDATE SKIP LOCKED` and a
lease, heartbeats progress, and finishes it. At claim time the database mints a **job session** for the
requesting user. Only its hash is stored. It expires with the lease and is revoked at finish or interruption.
`require_user` accepts job sessions, so every role and organization rule applies unchanged, and the
orchestrator still runs as `lbe_agent`. `whoami` refuses them, so a job session can never sign in to the
dashboard or API. No browser session is ever stored or handed to a runner.

**Consequences.**
- A runner that dies leaves an expired lease. **Updated by P4-02 (migration 1300).** Its job session is revoked
  first, then the job is re-queued and **resumes the same workflow**. Saved findings and the saved plan are
  reused. Each draft is identified by a deterministic id, `planItemGroup(workflow, index)`, so an existing draft
  is continued rather than created again. A database unique index allows only one draft per (workflow, plan
  item, account), which also stops a late write from a zombie runner. Estimated spend from earlier attempts
  counts towards the budget. After 3 lost leases the job becomes `interrupted`, and the requester or an admin
  can resume it.
- Cancellation: a queued job is cancelled at once; a running job stops at the next step boundary, and work
  already saved is kept.
- **Per-step time limits (P4-03).** Defaults: research 480 s, strategy 240 s, each draft 240 s, each visual
  brief 180 s (`DEFAULT_STEP_TIMEOUTS_MS`). When a step runs over, its model request is **aborted** through
  an `AbortSignal` passed to the Anthropic SDK, so no further cost accrues. The overrun is then handled like
  a failed step:
  - research: plan without new sources;
  - strategy: the job fails;
  - a draft: it is held as a draft with the reason;
  - a visual brief: it is skipped.
- **Retry (P4-03, migration 1400).** A failed or cancelled job can be retried once. The retry is a new, linked
  job with a fresh workflow, and it runs with the permissions of whoever pressed Retry. The original run and
  its drafts stay as they were. Interrupted jobs use Resume instead. The estimated cost is recorded on every
  job, including failed and cancelled ones.
- A limit of 5 queued or running jobs per organization.
- "Sign out everywhere" and disabling a user also end that user's running jobs, by design.
- Accepted risk: `lbe_worker` can act as a job's requester for the life of the lease. It is limited to the
  requester's own permissions, and the agent role still cannot approve or publish.

## ADR-029 — Render dependencies for the Creative Studio (P5-00 gate)
**Decision (2026-11-19).** Approved for P5-01, with exact pins:

| Package | Version | Released | Licence | Notes |
|---|---|---|---|---|
| satori | 0.63.2 | 2026-10-20 | MPL-2.0 | Vercel; active (frequent 0.x releases). Used unmodified (MPL file-level copyleft is not triggered) |
| @resvg/resvg-wasm | 2.6.2 | 2024-03-26 | MPL-2.0 | **Chosen over the native `@resvg/resvg-js`** |
| pdfkit | 0.20.2 | 2026-08-30 | MIT | Maintained (foliojs) |
| @fontsource/inter | 5.3.0 | 2026-07-19 | OFL-1.1 | Default font until the brand font is known. Satori needs WOFF/TTF (not WOFF2); the WOFF files are present |
| fflate (override under satori) | 0.7.5 | 2026-07-20 | MIT | Patched version, see below |

Why `@resvg/resvg-wasm` over the native `@resvg/resvg-js`: it runs as WebAssembly, so it is memory-sandboxed and ships
no platform binary. The native package would add an unsigned `.node` binary per platform. Performance is
adequate for 1–10 slides.

**Evidence.** The packages were trial-installed in an isolated scratch folder outside the repository with
`--ignore-scripts`, and nothing was executed:
- 41 packages in total, **no install scripts**.
- Licences: 33 MIT, 4 MPL-2.0, 1 Apache-2.0, 1 ISC, 1 OFL-1.1. `png-js` declares no licence in package.json,
  but its LICENSE file is MIT.
- `npm audit signatures`: 41 of 41 have verified registry signatures.
- `npm audit`: 2 moderate findings before the override, both GHSA-px8p-9vwx-vf98. Satori pins fflate 0.7.3,
  which has an infinite loop in `unzipSync` on malformed ZIP64 archives. Satori's bundle imports only
  `inflateSync` (WOFF font decompression), so the issue is unreachable in our use. We still add
  `overrides: { satori: { fflate: "0.7.5" } }`, which brings `npm audit` to 0.
- Every version is more than 14 days old (cooldown).

**Risks and conditions for P5-01 (render service).**
1. **Maintenance.** resvg's last stable release is from 2024; only alphas since (2.7.0-alpha, 2026-01). Keep the
   rasteriser behind an interface. Fallback options are `sharp` (Apache-2.0, bundles LGPL libvips) or newer
   resvg releases after review.
2. **No network or file access while rendering (SSRF).** Satori fetches `<img src>` and emoji assets over HTTP
   if given URLs. Templates may only use `data:` URIs. The renderer rejects any other `src`, provides no
   `loadAdditionalAsset` network hook, and tests assert that no `fetch` happens during rendering. pdfkit is
   given Buffers only, never paths or URLs.
3. **Untrusted text.** Draft text is passed as text nodes, never as markup. Length and slide-count limits apply
   (LinkedIn documents: ≤ 300 pages, ≤ 100 MB).
4. **Notices.** Add the MPL-2.0 (satori, resvg) and OFL-1.1 (Inter) notices to `THIRD_PARTY_NOTICES.md` when
   installing.
5. **Deterministic output.** Embedded fonts only, no system fonts. Snapshot tests compare rendered output.

**Implementation note (P5-01).** A probe found that, for a non-data image, Satori first does a **DNS lookup**
(its own SSRF screening) and keeps its own reference to `fetch`. Spying on `fetch` therefore cannot prove "no
network". The guarantee is structural, with two independent checks, each covered by a mutation-tested test:
1. Input validation: the logo must be a `data:` URI, and an SVG logo may not contain external references.
2. `assertNoExternalResources(tree)`, run on the final element tree immediately before Satori is called.

Draft text is always a text node, so markup in drafts can never become an image.

**PDF approach.** Each slide is rendered to PNG (Satori → SVG → resvg) and placed one per page with pdfkit.
The text in the PDF is not selectable. Accessibility comes from the post's alt text and description
(P5-06). A vector SVG-to-PDF path can be revisited later.

## ADR-030 — Visuals are part of the approved publication package (P5-03)
**Decision.**
- A post carries at most one visual: a PNG for a single image, or a PDF for a document carousel.
- The visual is stored in `lbe.media_assets`. The database computes the bytes' SHA-256 and checks the file
  signature. Rows are immutable, even for the database owner.
- The asset id goes into `media_ids` and therefore into the publication package. The existing hash-bound
  approval covers it, so attaching, replacing or removing a visual sends the post back to draft for a new approval.
- `media_ids` may only reference assets of the same post. A trigger closes the old free-text gap.
- Placeholder-branded visuals are never attached. The API refuses with 409, and the agent skips with a warning.
- With real brand colours, the agent attaches the visual **before** submitting for review, so the reviewer
  approves text and visual together.

**Consequences.**
- The live LinkedIn provider still rejects posts that have media until media upload exists (P6-04). A post with
  a visual can be published to the mock provider only; for a live text-only post, remove the visual.
- Assets accumulate (they are never deleted); a retention job comes with P9-06.
- **Alt text (P5-06, migration 1800).** The alt text is published with the image, so it is approved with it.
  - Editing it attaches a new immutable copy with the same bytes and the new description, which sends the
    post back to draft.
  - A post with a visual cannot enter review until its alt text is real: at least 15 characters and not the
    generic placeholder. The database enforces this with `lbe.alt_text_problem`.
  - An agent draft that fails this check is held as a draft with a note; the run itself does not fail.
- Bytes are stored in PostgreSQL. Moving them to object storage is a Phase 9/10 option.

## ADR-031 — Monthly campaigns are sequential weekly agent jobs (P5-05)
**Decision.** A campaign (name, objective, goal, 1–5 weeks, 3–5 posts a week) creates one durable job per week.
We did not use one large planning call. This reuses resume, cancel, retry, budgets, time limits and the
duplicate-topic rule unchanged.
- `job_claim` never hands out week k while an earlier week of the same campaign is queued or running. This
  holds with several runners, and is tested on real PostgreSQL.
- Each week's strategy therefore sees all earlier weeks' drafts, which feed into the recent-topics check, and
  the duplicate rule (topic similarity ≥ 0.5 is dropped) covers the whole month.
- Week focus rotates through the company page's pillars. The objective is written into each week's goal.
- One active campaign per organization. Campaign weeks don't count towards the 5 ad-hoc job limit.
- A failed week doesn't block later weeks. The campaign is then honestly reported as "partially completed",
  and the week can be retried in place.

**Consequence.** A month's plan is produced over several runs rather than all at once. That makes it slower,
but each step is resumable and cheaper to retry.

## ADR-032 — Document upload; PDF text extraction dependency (P2-03) — PDF part PROPOSED, awaiting owner approval
**Decision (2026-11-19).**
- **Done, no new dependency:** `.txt` and `.md` uploads become plain text (`services/api/src/documents.ts`). The
  user reviews the text in the paste box, and it then goes through the existing ingest. Every proposal must quote
  the text word for word, so proposals stay grounded.
- **Rules for uploads:**
  - The 256 KB API limit applies, and the text is capped at the ingest limit of 50,000 characters, cut at a
    paragraph boundary with a visible warning.
  - Decoding is strict: UTF-8 with any BOM removed, UTF-16 with a BOM, otherwise Windows-1252 with a warning.
  - Files containing NUL bytes are refused as binary.
  - Control characters, invisible characters and stray BOMs are removed.
  - Only a safe base name is kept; nothing is stored, and the file name is not logged.
- **PDF is not switched on.** A PDF upload gets a clear message suggesting copy and paste or a `.txt` file.

**Proposed PDF dependency: `unpdf` 2.1.0.**
- **Package:** MIT licence, from the unjs organisation, with one maintainer. It is a single package with no
  dependencies; it bundles Mozilla pdf.js (Apache-2.0) with its JBIG2 (Apache-2.0) and OpenJPEG (BSD-2)
  decoders.
- **Version:** released 2026-10-30, which passes the 14-day cooldown. 2.2.x is newer but too recent.
- **Static review** (trial install in the scratch folder with `--ignore-scripts`, outside the repository):
  - 1 package;
  - **no install scripts**;
  - **no native binaries**: the optional `@napi-rs/canvas` peer is *not* installed, unlike `pdfjs-dist`, which
    installs it by default;
  - verified registry signature **and** provenance attestation;
  - `npm audit` 0.
- Chosen over `pdfjs-dist`, which adds a native canvas binary as an optional dependency, and over `pdf-parse`
  1.x, which bundles a 2018 pdf.js older than the CVE-2024-4367 fix.
- **Not yet done:** running the package. Executing the newly downloaded code was refused by this session's
  permission check, so the owner decides (OA-10).

**Conditions if approved (the implementation must meet all of them):**
1. **Parse in a worker thread with limits:** `resourceLimits`, roughly 256 MB heap, and a 15 s timeout with
   `terminate()`. A malicious or huge PDF can then never stall or crash the API.
2. **Bytes only, no network or file access:** no URL options (`cMapUrl`, `standardFontDataUrl`, `wasmUrl`), with
   `isEvalSupported: false`, `useSystemFonts: false` and `disableFontFace: true`. A test asserts no network
   attempt.
3. **Limits:** at most 5 MB and 50 pages, via a route-specific body limit for this endpoint only. Must start
   with `%PDF-`. Encrypted PDFs are refused. A PDF with no text layer (a scan) gets "no readable text, paste
   instead".
4. **Same review step and grounding as text uploads:** the extracted text is shown for review, then goes through
   the normal ingest.
5. **Notices:** pdf.js, JBIG2 and OpenJPEG notices go in `THIRD_PARTY_NOTICES.md`; the exact pin and `npm audit`
   stay at 0.

**Alternative without a dependency:** the owner copies text out of the PDF (or saves it as `.txt`) and uploads or
pastes it. This works today.

## ADR-033 — Pipelined drafting: faster, with the same results and budget decisions (P4-05)
**Decision (2026-11-19).** Drafting is pipelined, not fully parallel.
- **Writer calls stay one at a time and in plan order.** Each writer must see the openings of every earlier post
  (P3-03, the originality check). Parallel writers would get different inputs and so different results.
- **What overlaps:** each draft's visual brief, rendered visual and review submission run in the background while
  the next writer call runs.
- **How much:** at most 3 drafts are in progress at once (`parallelDrafts`, range 1–4; 1 means strictly one at a
  time).

**Budget.** Every budget decision ("start the next writer?", "run this visual brief?") comes out exactly as in a
one-at-a-time run:
- **When decisions are taken:** a visual brief's decision is taken as soon as its draft's text is written, before
  the next writer starts.
- **Reservations:** work still in flight carries a reservation of its worst-case cost (`worstCaseCallUsd`). That
  is twice `max_tokens` at the dearer of the model and the fallback price, plus input bounded by its UTF-8 bytes
  and a 20,000-token prompt allowance. `max_tokens` now comes from one shared constant in `cost.ts`.
- **When work is left running:** only if even its worst case could not exhaust the budget. Otherwise the decision
  waits for it.
- **Effect:**
  - mock runs reserve nothing and always overlap;
  - near the limit, a paid run falls back to one at a time;
  - unknown models reserve "infinite" and never overlap.

**Safety.**
- **Exit paths:** every exit (finished, budget reached, cancelled, failed) first waits for in-flight work. Nothing
  is still writing when the workflow is marked finished or the job lease is released.
- **Background errors:** a background error stops new work and fails the workflow, as before. The one difference
  is that the next draft's writer may already have finished; that draft is saved and picked up by resume (P4-02).
- **Database:** concurrent transactions are isolated. PGlite serializes them (proven by a test); PostgreSQL uses
  one pooled connection per transaction.

**Evidence.** `tests/integration/parallel-drafting.test.ts`:
- 8 drafts identical to a one-at-a-time run, with identical writer inputs;
- overlap observed, never two writers at once;
- in a simulation with 80 ms writer and 80 ms visual brief calls: **1,648 ms → 1,003 ms**;
- paid-like runs spend the same and make the same budget decisions, both near the limit and with headroom;
- cancel and failure leave nothing running;
- mutations caught: without the budget guard → fail, without waiting on exit → 4 fail.

Also `tests/db/concurrent-tx.test.ts`.

**Consequence.** `cost.by_step` lists steps in completion order, which can differ from one-at-a-time order. The
totals are identical.

## ADR-013 — Ambiguous publication results require reconciliation
**Decision.** Only results that prove the provider did *not* create the post (e.g. 429) are retried
automatically, with exponential backoff (30 s × 2ⁿ, max 1 h, max 5 attempts). Timeouts, 5xx, thrown errors,
malformed success responses and expired leases move the entry to `needs_reconciliation`. Only an admin can
resolve it (`confirmed_published` with the post reference, `confirmed_not_published` to re-queue, or
`abandon`), with a mandatory note, all audited. A late success reported after lease expiry is still recorded.
