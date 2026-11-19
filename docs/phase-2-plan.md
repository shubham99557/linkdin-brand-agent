# Phase 2 Plan — Live LinkedIn Publishing (proposal)

_2026-11-19 · Authorised scope: **planning only** (owner decision D-01). Nothing in this plan is enabled
until the owner approves the stage gates below._
_Evidence: `open-source-research/linkedin-brand-engine/research/raw-linkedin-phase2-implementation.md`
(official LinkedIn docs, checked 2026-11-19). "UNCONFIRMED" items must be verified before relying on them._

## 1. Goal

Publish **human-approved** posts to the founder profile and the company page through LinkedIn's official API.
The Phase 1 safety model stays as it is: hash-bound approvals, outbox, STOP, audit. Phase 2 adds
real credentials, a live provider and an explicit **live-enablement gate**.

## 2. Verified facts that shape the design

| Fact | Consequence |
|---|---|
| OAuth redirect URIs must be **HTTPS** (absolute, no fragment). PKCE is for native apps only | Connecting an account needs an HTTPS callback. Whether `https://localhost` is accepted is UNCONFIRMED → decision P2-D3 |
| Access tokens last **60 days**; refresh tokens only for approved Marketing partners; changing scopes invalidates tokens | Founder must re-connect every ~60 days → expiry monitoring + reconnect flow |
| Community Management (CM) must be requested on a **new app with no other products** | Two LinkedIn apps: founder app (Share on LinkedIn + OIDC) and company app (CM) |
| Post created → **201**, URN in `x-restli-id` header; **no idempotency** mechanism | Store the URN in the same transaction as "published"; anything else is ambiguous |
| Founder's own posts **cannot be read back** (`r_member_social` closed). Page posts can be found by author with `r_organization_social` | Founder ambiguity → human checks LinkedIn. Page ambiguity → automated "find by author" check to assist the admin |
| `commentary` reserved characters `\| { } @ [ ] ( ) < > # \ * _ ~` must be escaped | Escaping function + tests; preview shows the escaped text |
| `Linkedin-Version: 202611` supported until **16 Nov 2027**; missing → 400, sunset → 426 | Pin version; alert 90 days before sunset |
| Limits: Share on LinkedIn 150/member/day; CM Development 100/member, 500/app/day | Far above our volume; still enforce a daily cap |
| API Terms §3.1(26): do not "use the Content or the APIs to **automate posting**" | **Manual release** by default (P2-D1) |
| Test profiles allowed (≤5, labelled, no interaction with real members); **test companies forbidden** | Founder path can be tested on a test profile; the first company-page post will be real |
| §7.1(a) encryption in transit and at rest; §2.2 keep credentials secret; incidents reported to LinkedIn ≤24h | Encrypted credential store, no tokens in logs, incident runbook |

UNCONFIRMED and to be verified in Stage 2.2: whether a Share-on-LinkedIn-only token can call `/rest/posts` (its own
page documents only legacy `/v2/ugcPosts`); whether `urn:li:person:{sub}` is the person URN; max commentary length
(3,000 assumed); whether `https://localhost` redirects are accepted; founder media readiness polling.

## 3. Design changes

### 3.1 Release modes (addresses §3.1(26))
Per account: `release_mode = manual | scheduled`, constrained by the database to **manual** until a reviewed
migration changes it after legal clearance (P2-D1).
- **manual:** an approved, queued post is dispatched only when an approver clicks **Publish now**. That click goes
  through the outbox (same checks) and is audited. The schedule is shown as a planning date only.
- **scheduled:** the current Phase 1 behaviour; it stays mock-only until cleared.

### 3.2 Live-enablement gate (two keys)
Live publishing for an account requires **all** of the following:
1. Environment master switch `LBE_LIVE_PUBLISHING=on` (default `off`; config refuses `on` unless `LBE_ENV=staging`).
2. `social_accounts.publishing_mode = 'live'`, which a new migration allows only when `live_enabled_by` (an admin)
   and `live_enabled_at` are set and a valid, unexpired credential exists.
3. The account is not stopped and the global STOP is off (checked at claim and dispatch, as in Phase 1).
4. The outbox `provider` constraint is extended to `('mock', 'linkedin')`, and `linkedin` is allowed only for live accounts.

Turning any key off immediately reverts to "nothing is sent".

### 3.3 Credential store
- New table `lbe.linkedin_credentials(account_id, app, member_or_org_urn, scopes, access_token_ciphertext,
  expires_at, last_introspected_at, status)`.
- Tokens are encrypted with **AES-256-GCM in the worker process**. The key `LBE_TOKEN_ENC_KEY` lives in the
  environment or a secret manager and never in the database. The database holds only ciphertext.
- `lbe_api` cannot read the ciphertext. `lbe_worker` reads it through a definer function. The OAuth callback
  stores tokens through a definer function that requires an **admin** session.
- Tokens never appear in logs, the audit log or error messages (tested).
- Introspection job runs daily. The dashboard warns 14 and 3 days before expiry. A 401 from LinkedIn marks the
  credential `invalid` and **auto-stops the account**, with the reason recorded.

### 3.4 OAuth connect flow
Admin → *Accounts* → *Connect LinkedIn*. The server generates a single-use, 10-minute `state` bound to the
admin's session and account, then redirects to `https://www.linkedin.com/oauth/v2/authorization` with the
minimum scopes:
- founder: `openid profile w_member_social`
- company: `w_organization_social r_organization_social`

The callback validates `state`, exchanges the code at `/oauth/v2/accessToken` (server-side, client secret from
the environment), reads `/v2/userinfo` (founder), confirms the expected identity/page with the admin before
saving, and audits the connection without storing any token.

### 3.5 Live LinkedIn provider (`services/publishing/src/linkedin.ts`)
- `POST https://api.linkedin.com/rest/posts` with `Authorization: Bearer`, `Linkedin-Version: 202611`,
  `X-Restli-Protocol-Version: 2.0.0`.
- Body: `author`, escaped `commentary`, `visibility`, `distribution {feedDistribution: MAIN_FEED}`,
  `lifecycleState: PUBLISHED`, `isReshareDisabledByAuthor: false`.
- Fallback adapter to `/v2/ugcPosts` for the founder app, only if Stage 2.2 shows `/rest/posts` is refused.
- Outcome mapping (extends ADR-013):

| Response | Outcome | Extra action |
|---|---|---|
| 201 with `x-restli-id` | success | store URN |
| 201 without `x-restli-id` | **ambiguous** | — |
| 400 / 422 | rejected | show LinkedIn message to editor |
| 401 | rejected | credential invalid → auto-stop account |
| 403 | rejected | auto-stop account (permission problem) |
| 426 | rejected | version sunset → global alert |
| 429 | retryable | backoff; enforce daily cap |
| 409, 5xx, timeout, connection reset after send | **ambiguous** | reconciliation (never auto-retry) |
| DNS / connect failure before any byte sent | retryable | — |

- HTTP client: Node `fetch` with a 20 s timeout. No redirects followed. Host allow-list `api.linkedin.com` and
  `www.linkedin.com` only (SSRF guard).
- Reconciliation assist (company page only): `GET /rest/posts?author=…&q=author`, matching the commentary;
  the admin confirms. Founder: the admin checks the profile manually (no read access).

### 3.6 Media (Stage 2.4)
Render service using **Satori + resvg-js + pdfkit** (selected in research), internal only, no network egress,
data-URI images only. Documents API `initializeUpload` → PUT → poll for the company page (PDF carousel ≤100 MB,
≤300 pages, title required). Founder media is deferred until readiness checking is verified (images are
write-only for `w_member_social`).

## 4. Stages and gates

> **Status 2026-11-19:** Stage 2.1 **complete** (`phase-2.1-report.md`). Stage 2.2 **approved by owner** and
> **prepared** (`pilot-2.2-runbook.md`) — waiting on owner actions B–C (LinkedIn app, real users). Stages 2.3–2.5 not started.

| Stage | Scope | Needs credentials? | Exit criteria | Gate |
|---|---|---|---|---|
| **2.1 Build & contract-test** | Migrations (release mode, live gate, credentials), encryption, OAuth flow, live provider, escaping, outcome mapping, expiry monitoring, auto-stop, reconciliation assist, **fake LinkedIn server** implementing the documented contract | **No.** All tests run against the local fake | All tests pass; security review of token handling; no code path can reach `api.linkedin.com` with the master switch off (tested) | Owner approves start of 2.1 |
| **2.2 Founder pilot** | Owner creates founder app and HTTPS callback; connect a LinkedIn **test profile** first, verify the UNCONFIRMED items, then the founder profile; publish **one** founder-approved post by manual release, with the owner present | Founder app | Post visible on LinkedIn, URN stored, audit complete; UNCONFIRMED items resolved and documented; STOP and disconnect demonstrated | Owner approves each live post in the pilot |
| **2.3 Company page** | CM application (new app, privacy policy, page super-admin verification, screencast); after approval, connect the page; first real post by manual release | Company app (after LinkedIn review) | As 2.2, plus find-by-author reconciliation tested | Owner approval + LinkedIn CM approval |
| **2.4 Visuals** | Render service + PDF document posts (company page) | Company app | Approved carousel published; render tests (no egress) pass | Owner approval |
| **2.5 Scheduled release** | Switch `release_mode` to scheduled per account | — | Written legal clearance on §3.1(26) | Owner + legal |

**Rollback at any time:** set `LBE_LIVE_PUBLISHING=off`, press global STOP, and revoke the app's access in
LinkedIn settings. All three are independent.

## 5. Testing additions

- Contract tests against a fake LinkedIn server: headers and body shape, escaping, every outcome in §3.5,
  URN extraction, and timeouts.
- Security tests:
  - tokens absent from logs, audit log and API responses;
  - `lbe_api` cannot read credentials;
  - OAuth `state` replay, expiry and cross-session use are rejected;
  - no live call while the master switch is off or STOP is active;
  - outbound host allow-list.
- Concurrency tests on real PostgreSQL (needs Docker — still blocked).
- Pilot checklist executed manually with the owner (Stage 2.2), with results recorded in the report.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Duplicate public post after an ambiguous result | No auto-retry; human reconciliation; page find-by-author |
| Wrong account posts (founder vs page) | Separate apps and credentials; destination in approved package; identity confirmed at connect time |
| Token leak | Encryption at rest, key outside DB, no logging, least-privilege roles, 24h LinkedIn incident runbook |
| LinkedIn treats our use as automated posting | Manual release default; disclose workflow in CM application; legal review |
| CM review delay or refusal | Founder path proceeds independently; company page stays mock |
| API version sunset | Pinned 202611; alert 90 days before 16 Nov 2027 |
| Founder forgets 60-day reconnect | Dashboard warnings; publishing auto-stops on expiry (safe failure) |

## 7. Owner decisions for Phase 2

| # | Decision | Recommendation |
|---|---|---|
| P2-D1 | Release mode until legal clears §3.1(26) | **Manual release only** — accepted with the plan by owner, 2026-11-19 |
| P2-D2 | Approve starting Stage 2.1 (build + contract tests, no credentials) | **APPROVED by owner, 2026-11-19** ("continue with phase 2 plan") |
| P2-D3 | Where the HTTPS OAuth callback lives: try `https://localhost` (free, may be rejected) vs a small hosted staging server (costs money) | Try localhost first |
| P2-D4 | Create the founder LinkedIn app (Share on LinkedIn + OIDC) — owner action in LinkedIn Developer Portal | When 2.1 is done |
| P2-D5 | Create a separate company app and apply for Community Management (needs privacy policy URL, page super-admin) | Start early — review takes time |
| P2-D6 | Use a LinkedIn test profile for the first live founder-path test | Yes |
| P2-D7 | Token encryption key custody (local env file now; secret manager before any shared hosting) | Env now, secret manager later |
| P2-D8 | Install WSL2 so the real-PostgreSQL concurrency tests can run before any live post | **Satisfied 2026-11-19** via `embedded-postgres` (owner-approved): 9/9 pass with `npm run test:pg:embedded` |
