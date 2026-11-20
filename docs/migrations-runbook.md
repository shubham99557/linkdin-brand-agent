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
1. **Back up first** (see *Backups* below).
   - PGlite: stop the server, then `npm run db:backup` (development) or `npm run db:backup:staging`.
   - PostgreSQL / Supabase: `pg_dump --format=custom --file=backup-YYYYMMDD.dump <connection>`, or take a Supabase backup.
2. Rehearse on a copy: point a configuration at the copied data and run `npm run db:migrate`.
3. Run `npm run db:migrate` (or `npm run staging:init` for staging) and check the list it prints.
4. Run `npm run pilot:preflight` (staging) or the test suite (development).

## Rollback policy
- **Failed migration:** nothing to do. The transaction rolled back, and the database is still on the previous version.
- **Bad migration that succeeded:** prefer a *forward fix*, meaning a new migration that corrects it. If data is at risk, restore
  the backup from step 1. PGlite: `npm run db:restore` into a new folder, then point `LBE_PGLITE_DIR` at it.
  PostgreSQL: `pg_restore --clean --dbname=<db> backup.dump`.

## Backups (embedded database — verified by `tests/db/backup-restore.test.ts`)
- `npm run db:backup` / `npm run db:backup:staging` writes `backups/lbe-<env>-<timestamp>.tar.gz` and a `.json`
  manifest (archive SHA-256, migration list, row count per table). It refuses while the server port is in use.
- `npm run db:restore -- --manifest backups/<file>.json --target .data/<new-folder>` verifies the hash, refuses to
  overwrite any non-empty folder, loads the archive, checks migrations and row counts against the manifest, and
  clears all sessions and pending LinkedIn connections (everyone signs in again).
- **Backups are sensitive:** business data, password hashes and *encrypted* LinkedIn tokens. `backups/` is
  git-ignored. Copies kept off this machine must be encrypted. Restored LinkedIn credentials only work with the
  same `LBE_TOKEN_ENC_KEY`; keep that key backed up separately (never alongside the backup).
- Test a restore after every backup you intend to rely on (`--target .data/restore-check`, then delete the folder).
- **Automatic backups while the server runs (P9-04, ADR-034).** Every `LBE_AUTO_BACKUP_HOURS` (default 24) the
  server snapshots its embedded database into `backups/auto/<env>/`, restore-tests it in a separate process and only
  then writes the manifest (same format as above, so `db:restore` accepts it). The newest `LBE_AUTO_BACKUP_KEEP`
  (default 14) are kept. Status: `backups/auto/<env>/status.json`, the log (`auto_backup_ok` / `auto_backup_failed`)
  and the admin **Backups** page. Day-to-day guide: `docs/local-operations.md`.
- **Copy to a separate device (P0-07, owner decision D-13: everything stays on this PC).**
  `npm run backup:external -- --to E:\LBE-backups` writes a dated folder with `code.bundle` (whole Git history),
  `databases/` (every embedded database named in `.env` / `.env.staging`), `backup-set.json` (SHA-256 of every
  file) and `READ-ME-restore.txt`. It then restores the copy into a temporary folder (clone + database restore)
  and fails loudly if anything differs.
  - **Refuses:** a folder on the same *physical* disk as the project (checked with `Get-Partition`; on this laptop
    C: and D: are one disk) and a folder inside the project. A running server's database is taken from its newest
    automatic backup if that is at most 26 hours old; otherwise the command refuses and asks for the server to be
    stopped.
  - **Reminder:** each copy to a separate disk is recorded in `backups/last-external-copy.json` for the Backups
    page.
  - **Override:** `--same-disk-ok` allows the same disk; that copy protects against accidental deletion only.
  - **Check an old copy:** `npm run backup:verify -- --set <folder>` re-checks every checksum and restores again.
  - **Not copied:** secrets (`.env*`, `secrets/`); keep the token key separately, as above. Committed code only:
    the command warns about uncommitted changes.
- Down-migrations are intentionally not maintained. Business rules live in database functions, and hand-written
  reversals of replaced functions are error-prone. Backups plus forward fixes are the supported path.

## Version-specific notes
| Version | Notes |
|---|---|
| 0500 brand_brain | Adds organizations and assigns existing rows to the first organization. Replaces `admin_create_user` (adds an optional organization). |
| 0600 hardening | One-time backfill of `audit_events.organization_id`. The audit immutability trigger is disabled for the backfill only and re-enabled in the same transaction. Replaces `claim_outbox` (adds an optional organization filter). Splits STOP into platform, organization and account levels. |
