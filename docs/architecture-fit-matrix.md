# Architecture Fit Matrix

_2026-11-18. Scores are provisional (research-agent scoring, 0–100) using: Architecture compatibility 25 ·
Usefulness 20 · Security/privacy 15 · Maintainability 15 · Integration simplicity 10 · Tests/docs 10 ·
Resource efficiency 5. Gates are mandatory and override scores._

| Target component | Selected | Score | Gates | Mode | Why it fits | Alternatives considered |
|---|---|---:|---|---|---|---|
| Workflow automation | n8n CE (self-hosted) | 90 | SUL → legal FLAG | Dependency | Native LinkedIn, Supabase, Postgres, Wait/approval nodes | — |
| Publishing | n8n LinkedIn node + HTTP `rest/posts` | 84 | PASS | Dependency | Official API; person & organization | Postiz (AGPL, reference) |
| Drafting / HITL | Direct Anthropic Messages API; Pydantic AI only if agentic tool use is needed | 85 | PASS | Dependency (optional) | Small, deterministic approval primitives | LangGraph 82, CrewAI 71 |
| Drafting patterns | social-media-agent | 72–75 | PASS* | Reference / small adapt | Human-review interrupt, person/org switch | — |
| Brand voice & review | marketingskills + KWP marketing | 82 / 80 | PASS | Adapt (C) | Markdown context + review checklist fits repo-stored voices | Basic Memory (AGPL) |
| Claim verification | Loki design | 61 | PASS | Reimplement (D) | 5-step claim pipeline maps onto claims register | MiniCheck (rejected) |
| Visuals | Satori + resvg-js + pdfkit | 90 | PASS (MPL unmodified) | Dependency | No browser, small container, PDF carousels | Gotenberg 85, Takumi 83 |
| CRM / system of record | Supabase, schema redesigned from Atomic CRM | 72 (post-review) | PASS | Reimplement (D) + small adapt (C) | Same DB → one place for erasure, suppression, audit | Twenty 77 (AGPL, 2nd DB) |
| Lead scoring | Built in Postgres | — | — | Build | No mature OSS; need explainable evidence | n8n template 18772 (reference) |
| Dedup | Postgres constraints; Splink later | 81 | PASS | Optional dependency | Volume is low initially | dedupe 67 |
| Web analytics / UTM | Umami | 75–89 | PASS | Dependency (service) | Postgres-only, MIT, attribution reports | PostHog 68, Plausible (AGPL) |
| Reporting | SQL views (+ Evidence optional) | 81 | PASS | Optional | Lightweight | Metabase 83 (AGPL FLAG) |
| Meetings | Cal.com API (later) | 75 | verify license | API integration | Booking webhooks → meetings | Google Calendar |

## Duplicated functionality avoided

- One orchestrator (n8n). Pydantic AI and LangGraph are mutually exclusive, and neither is required for the first slice.
- One database (Supabase). External CRMs rejected.
- One analytics tool (Umami); Metabase, Plausible, PostHog not added.
