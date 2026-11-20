# Stage 2.2 Pilot Log

_Fill in during the pilot. Do not paste tokens, client secrets or passwords here._

## Preconditions

| Item | Value | By / date |
|---|---|---|
| P2-D8 concurrency tests | ☑ run (result: 9/9 passed, `npm run test:pg:embedded`, 3 runs) ☐ waived for founder pilot | 2026-11-19 |
| P2-D8 re-run before connecting | ☑ 11/11 passed (`npm run test:pg:embedded`) | Claude, 2026-11-20 |
| Profile to connect | ☑ **founder's normal LinkedIn account, no test profile** (owner: "i want to use normal linkdin account") | owner, 2026-11-20 |
| Founder app created (products: Share on LinkedIn + OIDC only) | ☐ | |
| Redirect URL registered: `https://localhost:8443/api/oauth/linkedin/callback` | ☐ accepted by LinkedIn ☐ rejected | |
| `npm run pilot:preflight` → no blocking failures | ☐ | |

## Verification of unconfirmed items

| # | Question (from phase-2.1-report §4) | Result | Evidence |
|---|---|---|---|
| U1 | LinkedIn accepts `https://localhost` redirect URIs | | |
| U2 | `urn:li:person:{sub}` from OIDC is the correct author URN | | `pilot:verify` output; post appears on the right profile |
| U3 | Share on LinkedIn token works with `/v2/ugcPosts` (documented) | | provider ref |
| U4 | (optional) the same token works with `/rest/posts` (`LBE_LINKEDIN_MEMBER_ENDPOINT=posts`) | | |
| U5 | Hashtags in UGC plain text render as hashtags | | |
| U6 | Token TTL and scopes reported by introspection | | |

## Live posts

| # | Profile (test / founder) | Approved by | Released by | Time (UTC) | Stored URN | Visible on LinkedIn? | Notes |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |

## STOP and switch-off demonstrated

| Check | Result |
|---|---|
| Global STOP blocks publishing | |
| `LBE_LIVE_PUBLISHING=off` after pilot | |

## Issues / reconciliations

- **2026-11-20, before any LinkedIn call:** the pre-flight was run while the staging server was running, so two programs had the embedded staging database open at once. No requests reached the server in that window and no automatic backup ran. Action: the server was stopped and the database **restored from the backup taken 2 minutes earlier** (verified: 21 migrations, 17 rows match). The suspect copy is kept at `.data/staging-suspect-20261120-113852`. Root cause fixed: every program now takes a lock file before opening an embedded database, and a second one is refused (`services/api/src/pglite-lock.ts`, 6 tests incl. a real second process). Re-checked on staging: the pre-flight now refuses while the server runs. Nothing was sent to LinkedIn.

## Outcome

☐ Pilot passed — proceed to Stage 2.3 planning  ☐ Pilot failed — see issues
Owner sign-off: ______________________  Date: __________
