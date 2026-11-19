# Candidate Repositories

_Evaluation date: 2026-11-18. Metadata verified via GitHub API / repo pages by research agents; fields they could
not verify are marked "unverified" in the raw notes. Full per-candidate evidence:_
`C:\Users\X1 Extreme Gen3\open-source-research\linkedin-brand-engine\research\raw-*.md`

Gates: **C** = commercial-use license, **P** = LinkedIn platform policy. PASS / FLAG (legal review) / FAIL / n/a.

## Shortlist by category

| Cat | Candidate | URL | License | C | P | Score | Mode |
|---|---|---|---|---|---|---:|---|
| A | Pydantic AI | https://github.com/pydantic/pydantic-ai | MIT | PASS | PASS | 85 | Optional dependency (deferred tool approval) |
| A | LangGraph | https://github.com/langchain-ai/langgraph | MIT | PASS | PASS | 82 | Alternative to Pydantic AI — not both |
| A | social-media-agent | https://github.com/langchain-ai/social-media-agent | MIT | PASS | PASS* | 72–75 | Reference + small source components (**cloned**) |
| B | n8n LinkedIn node + HTTP `rest/posts` | https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.linkedin/ | SUL | FLAG | PASS | 84 | Dependency |
| B | Postiz LinkedIn providers | https://github.com/gitroomhq/postiz-app | AGPL-3.0 | FLAG | PASS | 70 | Design reference only — no code copied |
| C | marketingskills | https://github.com/coreyhaines31/marketingskills | MIT | PASS | PASS | 82 | Adapt context-file pattern (**cloned**) |
| C | knowledge-work-plugins / marketing | https://github.com/anthropics/knowledge-work-plugins | Apache-2.0 | PASS | PASS | 80 | Adapt brand-review skill (**cloned**) |
| C | OpenFactVerification (Loki) | https://github.com/Libr-AI/OpenFactVerification | MIT | PASS | PASS | 61 | Reimplement claim-check design |
| D | Umami | https://github.com/umami-software/umami | MIT | PASS | PASS | 75–89 | Dependency (self-hosted analytics, UTM) |
| D | PostHog (Cloud EU) | https://github.com/PostHog/posthog | MIT exc. `ee/` | PASS | PASS | 68 | Optional, not selected |
| E | Splink | https://github.com/moj-analytical-services/splink | MIT | PASS | n/a | 81 | Optional later (batch dedup) |
| E | n8n templates 14362 / 18772 / 13746 | https://n8n.io/workflows/18772 | unverified | FLAG | PASS | 67 | Reference only |
| F | Atomic CRM | https://github.com/marmelab/atomic-crm | MIT | PASS | n/a | 87→72 after code review | Redesign schema (D); adapt auth helpers (C) — permissive RLS, no dedup/consent (**cloned**) |
| F | Twenty | https://github.com/twentyhq/twenty | AGPL-3.0 + Enterprise | FLAG | n/a | 77 | Rejected (second DB, duplicate PII) |
| F | Cal.com | https://github.com/calcom/cal.com | MIT? (verify) | PASS? | n/a | 75 | API integration later (meetings) |
| G | Metabase OSS | https://github.com/metabase/metabase | AGPL-3.0 | FLAG | n/a | 83 | Deferred; prefer SQL views / Evidence |
| G | Evidence | https://github.com/evidence-dev/evidence | MIT | PASS | n/a | 81 | Optional reporting |
| H | Satori (+ resvg-js, pdfkit) | https://github.com/vercel/satori | MPL-2.0 / MPL-2.0 / MIT | PASS | n/a | 90 | Dependency |
| H | Gotenberg | https://github.com/gotenberg/gotenberg | MIT | PASS | n/a | 85 | Fallback HTML→PDF (hardened) |
| H | Takumi | https://github.com/kane50613/takumi | Apache-2.0 | PASS | n/a | 83 | Trial alternative |
| I | n8n Community Edition | https://github.com/n8n-io/n8n (n8n@2.48.5) | Sustainable Use License | FLAG | PASS | 90 | Dependency (self-hosted, internal use) |
| I | n8n templates 18689 / 19735 | https://n8n.io/workflows/18689 | unverified | FLAG | PASS | 68–71 | Reference; rebuild |

\* social-media-agent passes only with our own LinkedIn app, Arcade unused, and no FireCrawl on linkedin.com.

## Rejected

| Candidate | Reason |
|---|---|
| eracle/OpenOutreach | Stealth Playwright LinkedIn automation — **P FAIL** |
| stickerdaniel/linkedin-mcp-server | Uses `li_at` session cookie — **P FAIL** |
| tomquirk/linkedin-api | Unofficial Voyager API (repo now 404) — **P FAIL** |
| scrapin-io, Proxycurl-style vendors | Scraped LinkedIn data — **P FAIL** |
| gooseworks-ai/goose-skills | Includes Apify LinkedIn scraper — **P FAIL** |
| n8n template 8398 | Publishes through GetLate third-party — P FAIL (not official API) |
| n8n "LinkedIn outreach"/group bulk-post templates | Account automation — P FAIL |
| browserless | SSPL / commercial — **C FAIL** |
| supabase-community/chatgpt-your-files | No license — **C FAIL** (rebuild from Supabase docs) |
| LeadRadar and similar scoring repos | No license / 0 stars |
| Zie619/n8n-workflows, awesome-n8n-templates | Unclear provenance of workflows |
| langchain-ai/agent-inbox | Archived 2026-09-20 (data model noted) |
| humanlayer | Pivoted; approval SDK status unverified |
| CrewAI | LLM-interpreted approval feedback — not deterministic enough for a publish gate |
| Mixpost Lite | No LinkedIn in free edition |
| OpenPost, TryPost, Post for Me | AGPL / immature / off-stack |
| Zingg, Odoo, Frappe, SuiteCRM, RudderStack | License or weight/fit |
| Plausible CE, Grafana, Matomo, Lightdash | AGPL/heavy; Umami covers need |
| Apache Superset | Heavy (Redis, Celery) — fallback only |
| LinkedIn official py/js clients | Proprietary licence, stale since 2024 — API reference only |
| MiniCheck | Model licensing unclear, needs GPU |
| pdf-lib | Unmaintained since 2024-07 |
