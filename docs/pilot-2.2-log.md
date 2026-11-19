# Stage 2.2 Pilot Log

_Fill in during the pilot. Do not paste tokens, client secrets or passwords here._

## Preconditions

| Item | Value | By / date |
|---|---|---|
| P2-D8 concurrency tests | ☐ run (result: ___ ) ☐ waived for founder pilot | |
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

_None yet._

## Outcome

☐ Pilot passed — proceed to Stage 2.3 planning  ☐ Pilot failed — see issues
Owner sign-off: ______________________  Date: __________
