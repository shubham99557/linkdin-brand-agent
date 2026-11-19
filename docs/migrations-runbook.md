# Database Migrations — Upgrade & Rollback Runbook

## How migrations behave (verified by `tests/db/migration-upgrade.test.ts`)
- Files in `supabase/migrations/` are applied in name order, **each in a single transaction**. A failure rolls the
  whole file back: no partial objects, and no version recorded.
- Applied files are checksummed in `public.lbe_schema_migrations`. Editing an applied file makes `migrate` refuse
  to run. **Never edit an applied migration; add a new one.**
- Upgrading a populated 0400 database to the latest schema:
  - preserves all rows;
  - assigns them to the first organization;
  - leaves publication-package hashes unchanged, so existing approvals stay valid;
  - attributes audit events to their organization;
  - creates organization STOP flags.

## Upgrade procedure
1. **Back up first.**
   - PGlite: stop the server, then copy the data folder (`.data/pglite` or `.data/staging`) somewhere safe.
   - PostgreSQL / Supabase: `pg_dump --format=custom --file=backup-YYYYMMDD.dump <connection>`, or take a Supabase backup.
2. Rehearse on a copy: point a configuration at the copied data and run `npm run db:migrate`.
3. Run `npm run db:migrate` (or `npm run staging:init` for staging) and check the list it prints.
4. Run `npm run pilot:preflight` (staging) or the test suite (development).

## Rollback policy
- **Failed migration:** nothing to do. The transaction rolled back, and the database is still on the previous version.
- **Bad migration that succeeded:** prefer a *forward fix*, meaning a new migration that corrects it. If data is at risk, restore
  the backup from step 1. PGlite: replace the data folder. PostgreSQL: `pg_restore --clean --dbname=<db> backup.dump`.
- Down-migrations are intentionally not maintained. Business rules live in database functions, and hand-written
  reversals of replaced functions are error-prone. Backups plus forward fixes are the supported path.

## Version-specific notes
| Version | Notes |
|---|---|
| 0500 brand_brain | Adds organizations and assigns existing rows to the first organization. Replaces `admin_create_user` (adds an optional organization). |
| 0600 hardening | One-time backfill of `audit_events.organization_id`. The audit immutability trigger is disabled for the backfill only and re-enabled in the same transaction. Replaces `claim_outbox` (adds an optional organization filter). Splits STOP into platform, organization and account levels. |
