# Owner Decisions and Development Assumptions

_Updated 2026-11-19 (Phase 1)._

## A. Development assumptions (made so Phase 1 could proceed — please confirm or correct)

| # | Assumption | Where it matters |
|---|---|---|
| A-01 | The product serves ActTrident's own company page and one founder profile only (Mode A, ADR-001). | Whole design |
| A-02 | Two account approval domains: company posts approved by marketing approver(s) or admin; founder posts approved **only** by the founder. | `account_approvers` seed |
| A-03 | The same person may draft and approve (no four-eyes rule). | `decide_content` |
| A-04 | Anyone who can work on content may press STOP; only an admin may resume. | `set_stop` |
| A-05 | Only an admin may reconcile ambiguous publications. | `reconcile_publication` |
| A-06 | Posts are UK English, 120–250 words, ≤3 hashtags by default. | Drafting prompt |
| A-07 | Content pillars per account are as seeded (placeholders). | `social_accounts.pillars` |
| A-08 | Sessions last 12 hours; 5 failed logins lock an account for 15 minutes. | `lbe.login` |
| A-09 | The default AI model is `claude-opus-5-5` at `medium` effort, with server-side refusal fallback enabled. | `AnthropicDrafter` |
| A-10 | All seeded users, accounts and claims are synthetic (`*.test` emails, `[SYNTHETIC]` claims). | `seed.ts` |

## B. Decisions requiring owner approval

| # | Decision | Recommendation | Blocks |
|---|---|---|---|
| D-01 | Approve Phase 1 results and allow Phase 2 planning (real LinkedIn API). | **APPROVED by owner, 2026-11-19.** Scope: Phase 1 accepted; Phase 2 *planning* authorised. Does **not** authorise live LinkedIn calls, credentials, spending or account-permission changes. | — |
| D-01b | Phase 2: Stage 2.1 build (P2-D2) and manual release (P2-D1) | **APPROVED by owner, 2026-11-19** | — |
| D-01c | Stage 2.2 founder pilot | **APPROVED by owner, 2026-11-19** ("continue with stage 2.2"). Each live post still requires the owner present and an explicit release (runbook step G). | — |
| D-02 | Create LinkedIn developer apps (founder: Share on LinkedIn + OIDC; company: separate app for Community Management API review). | Yes, when ready for Phase 2 | Live publishing |
| D-03 | Legal: does scheduled release of a human-approved post count as "automated posting" under LinkedIn API Terms §3.1(26)? | Ask counsel; fallback = release on explicit click | Live scheduling |
| D-04 | Mode A only, or plan for SaaS (Mode B)? | Stay Mode A until product–market fit | Tenancy, licensing |
| D-05 | Keep in-database auth, or adopt Supabase Auth / SSO before production? | Adopt SSO/Supabase Auth before multi-user production | Production |
| D-06 | Provide an Anthropic API key with a spend limit to enable real AI drafting (currently mock). | Yes, with a monthly cap | Real drafts |
| D-07 | Replace placeholder voice profiles and seed real verified claims with evidence. | Founder + marketing to write | Real content |
| D-08 | Should rescheduling an approved post require re-approval? (Current: yes — schedule is part of the package.) | Keep yes | — |
| D-09 | Hosting choice for any shared environment (local only today). | Decide at Phase 2 | Staging |
| D-10 | Docker Desktop licence: free only for organisations under 250 staff and $10M revenue. Confirm eligibility. | Confirm | Local Postgres |
| D-11 | Privacy: approve LIA, privacy notice and retention policy before any personal data is processed (Phase 4 leads). | Required by law | Lead features |
| D-12 | Spending money or changing LinkedIn account permissions — always owner-only. | Standing rule | — |
