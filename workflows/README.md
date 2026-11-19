# Background workflows

Business rules do **not** live here (ADR-002). This folder documents job contracts so any scheduler can run them.

## publisher-tick

Runs one pass of the publication outbox: expires stale leases → claims due entries (respecting STOP) → re-checks
STOP → calls the configured provider (Phase 1: mock only) → records the outcome.

| Runner | How |
|---|---|
| In-process (default) | `LBE_RUN_WORKER=true` on the API (every `LBE_WORKER_INTERVAL_MS`) |
| Standalone worker | `npm run worker` (PostgreSQL only; `--once` for a single pass) |
| Dashboard (admin) | Outbox page → "Run publisher now" |
| External scheduler (n8n, cron) | `POST /api/internal/publisher-tick` with `Authorization: Bearer $LBE_INTERNAL_JOB_TOKEN` (endpoint disabled unless the token is set) |

Response: `{ expired, claimed, succeeded, retried, failed, ambiguous, released, errors[] }`.

Guarantees provided by the database regardless of runner: one live outbox entry per post, no double claim
(`FOR UPDATE SKIP LOCKED` + leases), no dispatch while stopped, ambiguous results never auto-retried.

No n8n workflow definitions are included in Phase 1.
