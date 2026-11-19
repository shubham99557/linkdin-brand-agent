# Testing Strategy

_2026-11-18. No integration is "complete" until its tests pass in the isolated local stack._

## Environments

| Env | Contents | LinkedIn |
|---|---|---|
| Local (Docker) | Supabase local, n8n, render service, Umami | **Mock LinkedIn server** (records requests) — no real calls |
| Staging | Same images, separate Supabase project | Real API against a **test LinkedIn page** owned by ActTrident, Development tier |
| Production | — | Real accounts, after owner approval |

## Test layers

| Layer | Tooling | What is tested |
|---|---|---|
| DB | pgTAP (via `supabase test db`) | RLS per role; `approvals` immutability; trigger blocks `sent` without approval/suppression; `people.source` CHECK; 48h purge job; NULL-vs-0 scoring; unique/idempotency constraints |
| Unit (TS) | Vitest | Drafting JSON-schema validation; hash function; scoring rule evaluation; UTM builder; template rendering |
| Prompt/eval | Vitest + recorded fixtures; Claude calls mocked in CI, live eval suite run manually | No unsupported claims accepted; injection fixtures in comments ("ignore previous instructions…") never change behaviour; voice adherence rubric |
| Workflow | n8n workflows exported as JSON in repo; run against mock LinkedIn | Publisher: STOP on → zero calls; hash mismatch → zero calls; 429 → retry/backoff; duplicate run → single post |
| Render | Vitest snapshot | PNG/PDF produced; remote URL in data rejected |
| Security | gitleaks, `npm audit`, Semgrep, Trivy on images | Secrets, vulnerable deps, image CVEs |
| E2E (staging) | Manual checklist | One approved post to test page; analytics pulled; reply flow |

## Release gate for each slice

1. All automated tests green. 2. Security scans: no high/critical. 3. Owner reviews audit log of a staging run.
4. STOP switch demonstrated.
