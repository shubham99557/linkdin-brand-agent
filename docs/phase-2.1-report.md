# Stage 2.1 Report — Live LinkedIn path, built and contract-tested

_2026-11-19 · Approved scope: P2-D2 (build + contract tests, no credentials) and P2-D1 (manual release only).
**No request was made to LinkedIn.** All live-path tests ran against a local fake LinkedIn server._

## 1. What was built

| Item | Where |
|---|---|
| Live gate (master switch + admin enablement + valid credential + STOP), manual release enforced in DB | migration `0400`, ADR-014 |
| "Publish now" release with public-post confirmation | `lbe.release_publication`, `POST /api/outbox/:id/release`, dashboard |
| Encrypted credential store (AES-256-GCM, key outside DB, account-bound) | `packages/security/src/token-crypto.ts`, ADR-015 |
| OAuth connect flow (state bound to admin, single use, 10 min; fragment hand-off) | `services/publishing/src/linkedin-oauth.ts`, API routes, ADR-016 |
| Live provider: Posts API, `Linkedin-Version: 202611`, little-text escaping, full outcome mapping | `services/publishing/src/linkedin.ts` |
| Outbound host allow-list (HTTPS `api.linkedin.com` / `www.linkedin.com` only) | `services/publishing/src/http-guard.ts` |
| Auto-stop on 401/403/426, credential expiry detection | worker functions, `runPublisherTick` |
| Reconciliation assist (company page find-by-author; founder → manual check) | `GET /api/outbox/:id/linkedin-candidates` |
| Daily cap (25 per account per UTC day) | `claim_outbox` |
| Optional local HTTPS (`LBE_TLS_PFX`) for the OAuth callback | `main.ts`, setup guide §8 |
| Dashboard: LIVE banner, credential expiry warnings, connect/disconnect/enable live, release button | `apps/web` |
| Capability register updated (`contract_tested` ≠ verified on LinkedIn) | `capabilities.ts` |

## 2. Test evidence (executed 2026-11-19)

| Suite | Result |
|---|---|
| Type checks (backend + web) | ✅ 0 errors |
| `tests/db/live-gate.test.ts` (new) | ✅ 21 passed |
| `tests/integration/live-flow.test.ts` (new, fake LinkedIn) | ✅ 10 passed |
| `tests/unit/linkedin-provider.test.ts` (new: contract, escaping, OAuth, crypto, host guard, config) | ✅ 31 passed |
| Phase 1 suites (db, unit, integration) | ✅ 122 passed (2 updated for intended changes) |
| **Total Vitest** | ✅ **184 passed**, 5 skipped (PostgreSQL concurrency — Docker still blocked) |
| Playwright (incl. new live OAuth → publish browser test against fake) | ✅ **5 passed** |
| Secret scan | ✅ 101 files |
| npm audit | ✅ 0 vulnerabilities (no new dependencies added) |
| Mutation check: removed "manual release required" from claim | ✅ 5 tests failed as expected; restored |

Key behaviours proven:
- Nothing reaches the (fake) LinkedIn until an approver releases the post with confirmation.
- A mock-only worker never claims live jobs.
- 500, 503 and timeout results go to reconciliation and are never retried.
- A 401 response marks the credential invalid and auto-stops the account.
- Switching the master switch off blocks enabling, releasing and sending.
- Tokens and client secrets appear in no API response, audit event or log line.

## 3. Changes to Phase 1 behaviour

- Two tests were updated for intended changes. Live mode is now refused by the credential gate instead of a
  blanket constraint, and the provider-factory error text changed.
- `claim_outbox` now takes a provider list (signature change, migration `0400`).
- Existing mock accounts keep scheduled release, so Phase 1 behaviour is unchanged.

## 4. Still UNCONFIRMED (to verify in Stage 2.2, with the owner present)

- Whether a token with only `w_member_social` may call `/rest/posts` (a fallback to `/v2/ugcPosts` may be needed).
- Whether `urn:li:person:{sub}` from OIDC is the correct author URN.
- Whether LinkedIn accepts `https://localhost` redirect URIs.
- The commentary length limit under the Posts API (3,000 is assumed).
- Hashtag and mention markup (currently escaped as plain text).
- The `X-RestLi-Method: FINDER` header for find-by-author.

## 5. Blocked

| Item | Blocker |
|---|---|
| PostgreSQL concurrency tests | WSL2 not installed → Docker engine cannot start (owner action P2-D8) |
| Stage 2.2 founder pilot | Owner must create the founder LinkedIn app (P2-D4) and approve the pilot |
| Stage 2.3 company page | Separate company app + Community Management review (P2-D5) |

## 6. Gate

Stage 2.1 is complete. **Live publishing remains off** (`LBE_LIVE_PUBLISHING=off`, no LinkedIn apps configured).
Next gate: owner approval for **Stage 2.2 — founder pilot**.
