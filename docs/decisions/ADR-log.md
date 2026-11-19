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
- Web-search pricing is an unverified assumption until checked against Anthropic's pricing page.
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
- A limit of 5 queued or running jobs per organization.
- "Sign out everywhere" and disabling a user also end that user's running jobs, by design.
- Accepted risk: `lbe_worker` can act as a job's requester for the life of the lease. It is limited to the
  requester's own permissions, and the agent role still cannot approve or publish.

## ADR-013 — Ambiguous publication results require reconciliation
**Decision.** Only results that prove the provider did *not* create the post (e.g. 429) are retried
automatically, with exponential backoff (30 s × 2ⁿ, max 1 h, max 5 attempts). Timeouts, 5xx, thrown errors,
malformed success responses and expired leases move the entry to `needs_reconciliation`. Only an admin can
resolve it (`confirmed_published` with the post reference, `confirmed_not_published` to re-queue, or
`abandon`), with a mandatory note, all audited. A late success reported after lease expiry is still recorded.
