# LinkedIn Brand Engine

Standalone tool that helps ActTrident plan, draft, review and publish LinkedIn content for its **company page**
and an **authorised founder profile** — with evidence-backed claims, human approval and STOP controls.

> **Phase 1 status:** local development build. Publishing goes to a **mock** LinkedIn only.
> No real posts, messages or emails are sent. Not approved for production.

- **Start here:** [docs/setup.md](docs/setup.md)
- **What was built and tested:** [docs/phase-1-report.md](docs/phase-1-report.md)
- **Architecture decisions:** [docs/decisions/ADR-log.md](docs/decisions/ADR-log.md)
- **Decisions needed from the owner:** [docs/owner-decisions.md](docs/owner-decisions.md)
- **Research (2026-11-18):** `docs/*.md`

## Layout

| Path | What |
|---|---|
| `apps/web` | Authenticated dashboard (React + Vite) |
| `services/api` | HTTP API, publisher job, CLI tools |
| `services/drafting` | Claude drafting (+ offline mock), prompt, output validation |
| `services/publishing` | Provider interface + mock LinkedIn provider |
| `packages/domain` | Shared types, LinkedIn capability register, claim detector |
| `packages/security` | Session cookie, CSRF origin check, token compare |
| `supabase/migrations` | Schema, business rules (triggers/functions), privileges |
| `brand/voice` | Owner-controlled voice profiles |
| `workflows` | Background job contracts (scheduler-agnostic) |
| `tests` | unit · db · integration · pg (concurrency) · e2e |
