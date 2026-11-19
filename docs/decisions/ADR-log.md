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

## ADR-013 — Ambiguous publication results require reconciliation
**Decision.** Only results that prove the provider did *not* create the post (e.g. 429) are retried
automatically, with exponential backoff (30 s × 2ⁿ, max 1 h, max 5 attempts). Timeouts, 5xx, thrown errors,
malformed success responses and expired leases move the entry to `needs_reconciliation`. Only an admin can
resolve it (`confirmed_published` with the post reference, `confirmed_not_published` to re-queue, or
`abandon`), with a mandatory note, all audited. A late success reported after lease expiry is still recorded.
