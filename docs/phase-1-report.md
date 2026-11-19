# Phase 1 Report — LinkedIn Brand Engine

_2026-11-19 · Local development build · mock publishing only · stopped at the owner approval gate._

## 1. Summary

The first vertical slice works end to end on this machine:

**Brief → AI draft → claims validation → human review → approval → outbox → publisher → mock confirmation → audit log.**

Every check below was **executed** on 2026-11-19 on Windows 11, Node 26.13.1, PostgreSQL 18.6 (PGlite).
Nothing was sent to LinkedIn, no emails or DMs were sent, nothing was purchased, and no real personal data is stored.

## 2. Capability status

| Capability | Status | Evidence |
|---|---|---|
| Company + founder account configuration | ✅ Implemented & tested | Seeded accounts, separate approvers, per-account pillars/voice; founder content approvable only by founder (DB + API + e2e tests) |
| Separate brand voices | ✅ Implemented (placeholder content) | `brand/voice/company.md`, `founder.md`; loaded into drafting prompt; API test |
| Approved claims register | ✅ Implemented & tested | Draft → verified (approver, evidence required) → expired/rejected; verified claims immutable |
| Content calendar | ✅ Implemented | Dashboard calendar grouped by date with account filter (e2e) |
| AI-assisted drafting | ✅ Implemented & tested with mock; ⚠️ live Claude call **not executed** | `AnthropicDrafter` type-checks against SDK 1.6.0 (structured output, refusal handling, server-side fallback). No API key was provided, so no real model call was made |
| Unsupported-claim detection | ✅ Implemented & tested | Model self-report + verified-claim IDs + quoted-span check + deterministic detector; DB blocks submission while any remain |
| Prompt-injection handling | ✅ Tested (simulated) | Untrusted material delimited and tag-escaped; malicious model output rejected/flagged; model has no tools |
| Review & human approval | ✅ Implemented & tested | Approve / reject / request changes (note required), evidence view, final publication preview |
| Approval bound to whole package | ✅ Implemented & tested | Hash over destination, body, media, visibility, schedule, claim IDs; any edit invalidates; stale preview refused |
| Scheduling metadata | ✅ Implemented | `scheduled_for` in package; outbox `available_at` |
| Transactional outbox | ✅ Implemented & tested | One live entry per post; retry/backoff; ambiguous → reconciliation |
| Mock publishing | ✅ Implemented & tested | Mock LinkedIn records posts; simulates 429/500/timeout/422 |
| Global & account STOP | ✅ Implemented & tested | Enforced at claim, at dispatch (DB trigger, even for owner role) and re-checked before send |
| Audit records | ✅ Implemented & tested | Append-only, written by DB triggers for every state change |
| Authentication & dashboard | ✅ Implemented & tested | In-DB sessions, lockout, CSRF origin check, security headers; React dashboard |
| Real-PostgreSQL concurrency tests | ⛔ **Blocked** (written, skipped) | Docker engine cannot start: WSL2 not installed (needs admin + reboot) |
| Live LinkedIn API | ⏸ Deferred (approval gate) | Blocked in config, provider factory and two DB constraints |
| Visual rendering, analytics, leads, CRM, replies | ⏸ Deferred | Later phases per roadmap |

## 3. Test evidence (executed 2026-11-19)

| Suite | Command | Result |
|---|---|---|
| Type checks (backend + web) | `npm run typecheck` | ✅ 0 errors |
| Database access control | `tests/db/access-control.test.ts` | ✅ 20 passed |
| Approval integrity + bypass protection | `tests/db/approval-integrity.test.ts` | ✅ 27 passed |
| Outbox, duplicates, retry, ambiguity, STOP | `tests/db/outbox-and-stop.test.ts` | ✅ 19 passed |
| Claim detector | `tests/unit/claim-check.test.ts` | ✅ 19 passed |
| Drafting, prompt injection, output validation | `tests/unit/drafting.test.ts` | ✅ 10 passed |
| Config guards, provider factory, CSRF helpers | `tests/unit/config-and-provider.test.ts` | ✅ 7 passed |
| API vertical slice, authz, CSRF, AI safety, failure modes | `tests/integration/api-flow.test.ts` | ✅ 20 passed |
| **Total Vitest** | `npm test` | ✅ **122 passed**, 5 skipped |
| PostgreSQL concurrency (5 tests) | `npm run test:pg` | ⛔ **Not executed** — skipped, Docker blocked |
| Browser (Playwright, Chromium) | `npm run test:e2e` | ✅ **4 passed** |
| Secret scan | `npm run security:secrets` | ✅ passed (86 files) |
| Dependency audit | `npm audit` | ✅ 0 vulnerabilities |
| Mutation check | Removed DB STOP check | ✅ Suite failed as expected; file restored |
| Live demo | `npm run demo` against `npm start` | ✅ Published to mock, 12 audit events |

Race conditions covered **without** real PostgreSQL: double claim by two workers, stale approval after concurrent
edit, double enqueue, STOP pressed between claim and send, completion by the wrong worker, lease expiry. The
true multi-connection versions (row locks under load) are in `tests/pg/concurrency.test.ts` and still need to run.

## 4. Demo transcript (abridged, real output)

```
[1] Brief created for "ActTrident (company page) — DEV" (pillar: security-culture)
[2] AI draft generated (mock drafter — no network call) and validated against the claims register
    citations: 1 verified claim(s); unsupported statements: 0
[3] Submitted for human review
[4] Approver previews the exact publication package and approves it
    package sha256 932e2c7b8be8f118112a32308bcec9d12f1144e6d559b4f541edc4059b3ed9ba
[5] Approved package placed in the transactional outbox
[6] Publisher run (admin) → mock LinkedIn provider
    claimed 1, succeeded 1, released 0, ambiguous 0
[7] Mock confirmation
    status: published; mock post: urn:li:share:mock-c78cbc68-…
[8] Audit trail: content.created → ai.draft_post → content.decision → outbox.enqueued
    → outbox.dispatching → outbox.succeeded (+ content.updated at each step)
```

## 5. Architecture corrections (all 10 addressed)

| # | Requested correction | Where |
|---|---|---|
| 1 | Standalone vs SaaS deployment | ADR-001 |
| 2 | Replaceable orchestration (no n8n coupling) | ADR-002, `workflows/README.md` |
| 3 | Transactional outbox | ADR-003, migration 0200 |
| 4 | Approval bound to whole immutable package | ADR-004 |
| 5 | Service-role / RLS bypass protection | ADR-005, migrations 0200/0300 |
| 6 | Mock-first provider abstraction | ADR-006, `services/publishing` |
| 7 | Authenticated dashboard in milestone 1 | ADR-007, `apps/web` |
| 8 | Supported vs unverified capabilities | ADR-008, `packages/domain/src/capabilities.ts` |
| 9 | Latest verified dependencies, pinned | ADR-009 |
| 10 | Assumptions & owner decisions | ADR-010, `docs/owner-decisions.md` |

## 6. Environment changes made on this machine

| Change | How | Authorised |
|---|---|---|
| Installed Git 2.56.0.4 | winget (official, hash verified) | Owner, 2026-11-19 |
| Installed Node.js LTS 26.13.1 | winget (official, hash verified) | Owner, 2026-11-19 |
| Installed Docker Desktop | winget (official) — engine not running (WSL2 missing) | Owner, 2026-11-19 |
| Playwright Chromium + winldd | `npx playwright install chromium` (to `%LOCALAPPDATA%\ms-playwright`) | Part of approved browser testing |
| Git repository initialised | `linkdin-brand-engine/` (local only, no remote) | Brief §3 |
| Local `.env` with random dev passwords | `npm run setup:local` (git-ignored) | — |
| Local database | `.data/pglite` (git-ignored) | — |

Third-party research snapshots remain outside the product in `open-source-research/`. No third-party source
code was imported (see `THIRD_PARTY_NOTICES.md`).

## 7. Blocked items

| Item | Blocker | Action needed |
|---|---|---|
| PostgreSQL concurrency tests; Supabase CLI local stack | WSL2 not installed → Docker engine cannot start | Owner: admin PowerShell `wsl --install --no-distribution`, reboot, open Docker Desktop and accept its licence (confirm D-10) |
| Real AI drafting | No Anthropic API key | Owner decision D-06 |
| Supabase CLI | Depends on Docker | After the above |

## 8. Known limitations

- Voice profiles and claims are placeholders/synthetic.
- The deterministic claim detector is pattern-based; it errs on the side of flagging. The model's own report and
  human review remain the primary controls.
- Manual body edits replace the model-reported unsupported list with the detector's result (documented).
- Login rate limiting is per-process in memory, plus a per-account lockout in the database.
- Sessions are not yet bound to device/IP; no MFA (adopt SSO before production — D-05).
- Database superusers can still disable triggers (ADR-005 residual risk).
- Dashboard accessibility was not formally audited.

## 9. Approval gate

Phase 1 stops here. **No live LinkedIn operation is enabled.** Before Phase 2, the owner should review this
report and decide D-01 to D-12 in `docs/owner-decisions.md`.
