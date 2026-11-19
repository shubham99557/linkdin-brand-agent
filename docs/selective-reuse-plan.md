# Selective Reuse Plan

_2026-11-18 · Decisions: A reuse existing module · B external dependency · C adapt small licensed component ·
D reimplement design · E reject. (No internal modules exist, so there are no A decisions.)_

| Capability | Dec. | Source (pinned) | Exact files / package | License duty | Destination in our repo | Required changes | Security controls | Tests |
|---|---|---|---|---|---|---|---|---|
| Workflow engine | B | n8n CE `n8n@2.48.5` Docker image | `n8nio/n8n:2.48.5` | SUL internal use (LEGAL) | `infra/docker-compose.yml` | none | creds encrypted; no public Wait URLs; basic auth | workflow tests vs mock LinkedIn |
| LinkedIn publish | B+D | n8n LinkedIn node; design from Postiz (AGPL, no code) & LinkedIn docs | HTTP Request → `POST /rest/posts` | — | `workflows/publish.json` | pinned `LinkedIn-Version`; read `x-restli-id` | STOP + hash check + audit | idempotency, 429 retry |
| Drafting | B | `@anthropic-ai/sdk` (latest stable at build time) | Messages API, structured output | MIT | `services/drafting/` | — | no tools; delimited inputs | schema + injection fixtures |
| Two-stage brief→post prompt | D | social-media-agent `bc27973` `src/agents/generate-post/prompts/*` | design only | — | `prompts/draft-post.md` | add claims gate, voices, UK English | — | eval suite |
| Scheduling slots | C (optional) | social-media-agent `src/utils/schedule-date/*` + tests | MIT notice | `services/scheduler/` | replace LA TZ with Europe/London | — | port 35 tests |
| URL helpers | C | social-media-agent `src/agents/utils.ts` (`extractUrls`, `removeUrls`, `getUrlType`, `chunkArray`, `retryWithTimeout` only) | MIT notice | `packages/shared/` | — | — | unit tests |
| Human approval | D | social-media-agent `human-node.ts`; agent-inbox data model | design only | — | `approvals` table + `apps/admin` | hash-bound, immutable approvals | RLS; founder-only for founder posts | pgTAP |
| Brand voices | C | marketingskills `73573e9`: `skills/product-marketing/SKILL.md`, `references/brand-voice.md`, `skills/copy-editing/references/checklist.md`, `skills/social/SKILL.md` ("No AI Tells", drafts-first sections only) | MIT (+ upstream notice) | `brand/voice/company.md`, `brand/voice/founder.md`, `prompts/` | cybersecurity-specific; remove hook templates | — | voice rubric eval |
| Brand review | C | knowledge-work-plugins `e91a134` `marketing/skills/brand-review/SKILL.md` | Apache-2.0 + change statement + NOTICE | `prompts/brand-review.md` | add evidence/claims check, security-claim categories | — | fixture posts with bad claims |
| Claim verification | D | Loki (MIT) design | — | — | `claims` table + check step | deterministic mapping, not web search | — | unit + eval |
| Visual rendering | B | `satori`, `@resvg/resvg-js`, `pdfkit` (pin at build) | npm | MPL-2.0 unmodified / MIT | `services/render/` | templates ours | no egress; data URIs only | snapshot tests |
| CRM schema | D | Atomic CRM `832b07a` `supabase/schemas/*` | design only | — | `supabase/migrations/` | unique keys, consent, suppression, source CHECK, audit, deny-by-default RLS | pgTAP RLS tests | pgTAP |
| CRM auth helpers | C | Atomic CRM `supabase/functions/_shared/authentication.ts`, user-sync/invite/owner-stamp functions | MIT notice | `supabase/functions/` | signup disabled; strict CORS | — | unit |
| Admin UI | D | — | build minimal (approval queue, calendar, claims, leads) | — | `apps/admin/` | — | Supabase Auth, RLS | Playwright smoke |
| Web analytics | B | Umami `v3.5.0` image | Docker | MIT | `infra/` | — | own subdomain, cookieless | — |
| Lead scoring | D | n8n template 18772 idea | — | — | SQL rules + evidence | — | DB-side only | pgTAP |
| Dedup | B (later) | Splink v5.0.0 | pip | MIT | `jobs/dedup/` | — | — | — |
| Meetings | B (later) | Cal.com API | — | verify license | n8n workflow | — | webhook HMAC | — |

## Rejected for reuse (E)

social-media-agent: `upload-post/index.ts`, `auth-server.ts`, `slack-messaging/**`, `screenshot.ts`,
`find-and-generate-images/**`, `utils/supabase.ts`, curate-data, supervisor, generate-thread, repurposer, X/Reddit
clients; LangGraph as runtime (second scheduler). Atomic CRM: frontend, RLS & grants, Gravatar/favicon triggers,
MCP `mutate`, email import. marketingskills hook templates. KWP `content-creation`, `draft-content`, `.mcp.json`.
All candidates listed as rejected in `candidate-repositories.md`.
