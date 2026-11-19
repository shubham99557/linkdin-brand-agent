# Implementation Roadmap

_2026-11-18. Stages 1–6 complete on approval of this package. Stage 7 starts only after owner approval._

## Prerequisites (owner actions)

| # | Action | Needed for |
|---|---|---|
| P1 | Install git, Docker Desktop, Node.js LTS (`winget install Git.Git Docker.DockerDesktop OpenJS.NodeJS.LTS`) | Slice 1 |
| P2 | Create LinkedIn developer app for founder (Share on LinkedIn + OIDC) | Slice 1 (staging publish) |
| P3 | Apply for Community Management API with a **separate** app (legal entity, privacy policy, page super-admin verification, screencast for Standard tier) | Slice 2 — lead time weeks |
| P4 | Anthropic API key with spend limit | Slice 1 |
| P5 | Supabase project (staging) — free tier OK | Slice 1 staging |
| P6 | Write voice inputs (5–10 example posts each for company & founder) and seed 10 verified claims with evidence | Slice 1 |
| P7 | Legal: n8n SUL internal-use confirmation; LIA + privacy notice; LinkedIn API Terms review | Before production |

## Slices

| Slice | Scope | Exit criteria |
|---|---|---|
| **1 — Founder post, approved & published** (first milestone) | Repo scaffold, Docker stack, core schema (`social_accounts`, `claims`, `content_items`, `content_claims`, `approvals`, `control_flags`, `audit_events`, `agent_runs`), drafting via Claude with claims check, minimal approval UI, n8n publisher to **mock** then staging founder profile | Tests per testing-strategy pass; one human-approved post on a test profile; STOP demonstrated |
| 2 — Company page + visuals | CM app, page publishing, render service (Satori/resvg/pdfkit), document carousels | Approved PDF carousel on test page |
| 3 — Analytics & learning | Aggregate metrics ingest, weekly report, proposal-only voice updates | Weekly report generated from aggregates only |
| 4 — Lead magnet & CRM | Landing page, consent form, Umami, `people`/`companies`/`suppression`/`lead_events`, Atomic CRM-derived schema & UI | Test lead captured with consent, suppression honoured |
| 5 — Scoring & follow-ups | Rules engine + evidence, follow-up drafts, approval + suppression trigger, manual-send logging | pgTAP proves no send without approval |
| 6 — Replies | 48h comment queue, reply drafts, approved replies via API, purge job | Purge proven; injection tests pass |
| 7 — Attribution & meetings | UTM attribution views, Cal.com bookings → meetings/opportunities | Content → lead → meeting report |
| 8 — Optional | Lead Gen Forms (ads), Splink dedup, Evidence dashboards | Owner decision |
