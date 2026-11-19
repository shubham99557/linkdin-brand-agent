# Hardening & Readiness Report — Release Decision

_2026-11-19 · Local development and staging only · live publishing **disabled** · no LinkedIn connection, no
credentials changed, no messages sent, nothing deployed, no paid API calls._

## Decision

**Not ready for ActTrident's first internal evaluation of content quality.** The platform and agent layer are
now technically sound: security findings are fixed, tenant isolation is verified route by route, and the gates
are proven by tests. But three prerequisites are missing:
1. **No real Brand Brain knowledge.** Staging is empty, and development is 100% synthetic.
2. **No authorized real-model run.** There is no key, budget or authorization, so content quality is unmeasured.
3. ~~The real-PostgreSQL concurrency tests are not executed.~~ **Resolved: 9/9 pass on real PostgreSQL 18.6** (see §3).

**Ready now:** completing the Brand Brain in staging, and the free mock evaluation pipeline.

---

## 1. Verified implemented capabilities
| Capability | Evidence |
|---|---|
| Brand Brain (versioned, owner-approved, organization-scoped) | 23 integration tests; immutability tested even for the database owner |
| Agent workflow (research → strategy → 2 voices → visual briefs → checks → review queue) | Integration and browser tests; mock evaluation produced 4 items / 8 drafts / 8 briefs |
| Human approval, outbox, STOP, audit (unchanged by the agent layer) | 87 database tests |
| Live LinkedIn path (contract-tested against a fake only; switched off) | 41 tests including a browser test |
| Evaluation harness with gated paid runs | Refusal verified; 2 mock runs; 3 unit tests |

## 2. Security findings and fixes
13 weaknesses were **confirmed by failing regression tests before the fix**, and all of them pass now
(`tests/integration/tenant-isolation.test.ts`).

| # | Finding | Severity | Fix |
|---|---|---|---|
| S1 | Audit log readable across organizations | High | `audit_events.organization_id` (derived from the subject, backfilled); API filters by organization |
| S2 | Mock LinkedIn posts readable across organizations | Medium | API filters by organization via the outbox link |
| S3 | Controls list showed other organizations' accounts | Medium | Scoped list |
| S4 | **STOP was platform-wide**: org B's editor could stop org A, and org B's admin could resume it | High | Platform / organization / account levels (ADR-022) |
| S5 | `set_stop` on another organization's account key | High | Organization check |
| S6 | `cancel_publication` with no organization check; any approver could cancel any account | High | Organization check, plus account approver or admin |
| S7 | `reconcile_publication` with no organization check | High | Organization check |
| S8 | `begin_oauth`, `set_live_publishing`, `revoke_linkedin_credential` with no organization check (could connect or switch another org's account) | **Critical for SaaS** | Organization checks |
| S9 | `/content/:id/draft` sent another organization's brief to the AI before the write failed | High | Organization filter before any model call |
| S10 | `/accounts/:id/voice` cross-org read; LinkedIn-candidates cross-org; claim-span read | Medium | Organization filters |
| S11 | An admin's manual publisher run processed every organization | Medium | Organization-scoped `claim_outbox` |
| S12 | `record_agent_run` accepted another organization's workflow ID | Low | Organization check |
| S13 | Login rate limit keyed on a spoofable `X-Forwarded-For` header | Medium | Keyed on the TCP peer address |
| S14 | bcrypt silently truncates passwords over 72 bytes | Low | Refused at creation |
| S15 | `public` schema creation not explicitly revoked (three definer functions include `public` for pgcrypto) | Low | `revoke create on schema public from public` and a test |

**Verified as sound:**
- All definer functions pin `search_path` with `pg_temp` last.
- Execute grants match reviewed allowlists, enforced by a snapshot test.
- No application role can write any table.
- The agent role cannot read any table or reach approve, release, publish, resume, claim-verification or live functions.
- Approvals and Brand Brain entries stay immutable.

**Authentication review:**
- Sessions are database-resolved: 256-bit tokens, only their hash stored, 12-hour absolute expiry, revoked on logout.
- Expired sessions and disabled users are rejected (tested).
- Lockout after 5 failures. This is a deliberate trade-off: someone could lock an account on purpose.
- Remaining recommendations before multi-user production: SSO or MFA, an idle timeout, "sign out everywhere",
  and a password-change flow (admin CLI only today).

**Mutation checks:**
- Removing the organization check from proposal decisions failed the cross-tenant test.
- Removing the organization STOP failed 5 tests.
- Removing manual release failed 5 tests.

## 3. PostgreSQL concurrency results
_Updated 2026-11-19 after owner authorization of `embedded-postgres` and the Microsoft VC++ runtime._

| | |
|---|---|
| Status | ✅ **9 / 9 passed**, three consecutive clean runs |
| Command | `npm run test:pg:embedded` |
| Server | Temporary PostgreSQL 18.6 (x86_64-windows, msvc-19.44) from `embedded-postgres` 18.6.0-beta.19. Bound to 127.0.0.1, random port, random password, SCRAM authentication, throwaway data folder deleted after the run (verified: no leftover process or folder) |
| Scenarios | multiple workers claiming the same jobs; approve vs edit (15 races); two approvers; double enqueue; STOP after commit; STOP racing claims of pending jobs; duplicate provider responses; recovery after ambiguous outcomes (concurrent reconciliation); cross-organization requests in parallel |
| Proof the tests exercise real concurrency | Mutation: removing `FOR UPDATE SKIP LOCKED` from `claim_outbox` made **4 tests fail** (double claim, STOP race, duplicate responses, recovery race); restored → 9/9 |
| Supply-chain notes | npm registry signatures verified (`npm audit signatures`: 83 verified). `postgres.exe` is **not Authenticode-signed** (SHA-256 `AF5B897C…2451A0`). Development-only dependency; never used at runtime |
| Prerequisite installed | Microsoft Visual C++ Redistributable x64 14.52.37029.0 (winget, installer hash verified), owner-approved |
| Docker path | Still blocked (WSL2 not installed); no longer needed for these tests |

## 4. Tenant-isolation status
**Verified for all 48 API routes and all definer functions.** Every read path is filtered by organization, every
ID-based write is checked inside the database, and memory tables are definer-only. This is **not complete for SaaS**: the six remaining gaps are listed in ADR-023, the main one being that organization row-level security is not yet a second layer under the API queries.

## 5. Brand Brain completeness
| Database | Required sections | Claims | Quality |
|---|---|---|---|
| Staging (pilot) | 0 / 10 — all UNKNOWN | 0 | Correct: empty, nothing invented |
| Development | 10 / 10 present | 3 verified + 1 draft | **100% `[SYNTHETIC]`** (demo data), flagged everywhere and never promoted |

Checklist for real knowledge: `docs/brand-onboarding-checklist.md`. Staging pre-flight now **fails** if synthetic
knowledge appears there.

## 6. Real AI evaluation readiness
| Check | Status |
|---|---|
| Model compatibility (`claude-opus-5-5`: structured outputs, adaptive thinking default, server-side fallback beta) | ✅ per reference; not exercised live |
| Structured-output schemas | ✅ all 6 compile to API-compatible JSON Schema (tested) |
| Error handling (refusal, max_tokens, auth, rate limit, connection, invalid output) | ✅ mapped and recorded per run |
| Token and cost logging | ✅ tokens per run, plus estimated cost per step; ⚠ web-search price unverified |
| Hard budget | ✅ stops before strategy or mid-drafting (tested) |
| Timeouts and rate limits | ✅ SDK timeouts (120–300 s) and 2 retries; ⚠ workflows are synchronous (fine for the CLI evaluation; needs a job queue before UI use with real models) |
| Source retrieval and attribution | ✅ only URLs the search tool returned; HTTPS; retrieval time; confidence (tested with a fake client) |
| Claim-to-source verification | ✅ restated findings block review (new) |
| Contradictory and outdated evidence | ✅ contradictions and stale sources excluded from evidence (new) |
| Prompt injection | ✅ untrusted blocks; injection flagged; strict schemas; no client tools |
| Missing Brand Brain data | ✅ UNKNOWN markers; synthetic knowledge flagged |
| **Executed with a real model** | ❌ needs a key, a budget and your authorization |

## 7. LinkedIn pilot blockers (unchanged; live publishing stays off)
1. Founder LinkedIn app not created; client ID and secret not in `.env.staging`.
2. No real staging admin or founder approver user.
3. ~~P2-D8: concurrency tests~~ — satisfied (§3). Re-run `npm run test:pg:embedded` before the pilot.

## 8. Updated architecture decisions
ADR-022 (STOP levels), ADR-023 (tenant isolation status and gaps), ADR-024 (migration policy), ADR-025 (evidence
integrity), ADR-026 (evaluation policy). New runbooks: `docs/migrations-runbook.md`, `docs/evaluation-plan.md`.

## 9. Recommended next milestone — "First internal evaluation"
1. **You:** complete the real Brand Brain in staging (checklist items 1–11) and verify 3–5 phishing-relevant claims.
2. ~~Unblock the concurrency tests~~ — done (§3).
3. **You:** authorize one paid evaluation run with a budget (suggested $5) and provide an API key.
4. **Me:** run the paid evaluation from the staging snapshot; you score `scoring-sheet.md`.
5. Decide from the scores whether to tune prompts or proceed to the founder LinkedIn pilot (Stage 2.2).

## Test evidence (executed 2026-11-19)
| Suite | Result |
|---|---|
| Vitest | **276 passed**, 0 failed, 9 skipped (PostgreSQL) — 19 files |
| PostgreSQL concurrency (`npm run test:pg:embedded`) | **9 passed** ×3 runs; row-lock mutation → 4 failures |
| — new this round | tenant-isolation 15, function-security 11, migration-upgrade 3, agent-readiness 5 + 12 unit, evaluate 3 |
| Playwright | **6 passed** |
| Type check / secret scan / npm audit | ✅ / ✅ 147 files / ✅ 0 vulnerabilities |
| Evaluation (mock) | 2 runs, both NOT_READY for the expected reasons (§5, `docs/evaluation-plan.md`) |
