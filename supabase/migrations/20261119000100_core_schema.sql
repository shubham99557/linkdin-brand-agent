-- LinkedIn Brand Engine — Phase 1 core schema
-- Non-destructive: creates objects only. Safe to run on an empty database.
-- All application tables live in schema `lbe` (not exposed through Supabase PostgREST's default `public`).

create extension if not exists pgcrypto;

create schema if not exists lbe;
create schema if not exists lbe_mock;

-- Application roles (no login). Real deployments connect with a login role that is a member of exactly one.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'lbe_api') then
    create role lbe_api nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'lbe_worker') then
    create role lbe_worker nologin;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Users & sessions (identity is resolved inside the database; see 0200)
-- ---------------------------------------------------------------------------
create table lbe.app_users (
  id              uuid primary key default gen_random_uuid(),
  email           text not null unique check (email = lower(email) and position('@' in email) > 1),
  display_name    text not null check (length(display_name) between 1 and 120),
  role            text not null check (role in ('admin', 'approver', 'editor', 'viewer')),
  password_hash   text not null,
  disabled        boolean not null default false,
  failed_logins   int not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now()
);

create table lbe.sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references lbe.app_users(id),
  token_hash      text not null unique,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  revoked_at      timestamptz
);
create index sessions_user_idx on lbe.sessions(user_id);

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
create table lbe.social_accounts (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('company_page', 'founder_profile')),
  display_name     text not null,
  -- LinkedIn URN is UNVERIFIED until an authorized app confirms it (Phase 2+).
  linkedin_urn     text unique,
  voice_profile    text not null check (voice_profile ~ '^[a-z0-9_-]{1,40}$'),
  pillars          text[] not null default '{}',
  enabled          boolean not null default true,
  -- Phase 1 guard: live publishing is impossible without a new, reviewed migration.
  publishing_mode  text not null default 'mock' check (publishing_mode = 'mock'),
  created_at       timestamptz not null default now()
);

create table lbe.account_approvers (
  account_id  uuid not null references lbe.social_accounts(id),
  user_id     uuid not null references lbe.app_users(id),
  primary key (account_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Claims register
-- ---------------------------------------------------------------------------
create table lbe.claims (
  id             uuid primary key default gen_random_uuid(),
  statement      text not null check (length(statement) between 3 and 1000),
  category       text not null check (category in (
                   'product_capability', 'security_effectiveness', 'vulnerability_reference',
                   'breach_statistic', 'customer_outcome', 'regulatory', 'company_fact', 'other')),
  evidence_url   text check (evidence_url is null or evidence_url ~ '^https://'),
  evidence_note  text,
  status         text not null default 'draft' check (status in ('draft', 'verified', 'rejected', 'expired')),
  verified_by    uuid references lbe.app_users(id),
  verified_at    timestamptz,
  expires_at     timestamptz,
  created_by     uuid not null references lbe.app_users(id),
  created_at     timestamptz not null default now(),
  constraint claims_verified_has_evidence check (
    status <> 'verified' or (verified_by is not null and verified_at is not null
                             and (evidence_url is not null or coalesce(length(evidence_note), 0) > 0)))
);

-- ---------------------------------------------------------------------------
-- Content
-- ---------------------------------------------------------------------------
create table lbe.content_items (
  id                      uuid primary key default gen_random_uuid(),
  account_id              uuid not null references lbe.social_accounts(id),
  pillar                  text not null,
  brief                   text not null check (length(brief) between 1 and 4000),
  -- Untrusted external material supplied by the user (articles, notes). Never treated as instructions.
  source_material         text check (source_material is null or length(source_material) <= 20000),
  body                    text not null default '' check (length(body) <= 3000),
  media_ids               text[] not null default '{}',
  visibility              text not null default 'PUBLIC' check (visibility in ('PUBLIC', 'CONNECTIONS')),
  scheduled_for           timestamptz,
  unsupported_statements  jsonb not null default '[]'::jsonb check (jsonb_typeof(unsupported_statements) = 'array'),
  status                  text not null default 'draft' check (status in (
                            'draft', 'in_review', 'changes_requested', 'approved', 'rejected',
                            'queued', 'published', 'failed', 'needs_reconciliation')),
  -- Canonical immutable publication package and its SHA-256, maintained by trigger (see 0200).
  package                 jsonb not null default '{}'::jsonb,
  package_hash            text not null default '',
  version                 int not null default 1,
  provider_post_ref       text unique,
  published_at            timestamptz,
  created_by              uuid not null references lbe.app_users(id),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index content_items_account_sched_idx on lbe.content_items(account_id, scheduled_for);
create index content_items_status_idx on lbe.content_items(status);

create table lbe.content_claims (
  content_id   uuid not null references lbe.content_items(id),
  claim_id     uuid not null references lbe.claims(id),
  quoted_span  text not null check (length(quoted_span) between 1 and 1000),
  primary key (content_id, claim_id)
);

create table lbe.content_approvals (
  id            uuid primary key default gen_random_uuid(),
  content_id    uuid not null references lbe.content_items(id),
  decision      text not null check (decision in ('approved', 'rejected', 'changes_requested')),
  package_hash  text not null,
  package       jsonb not null,
  approver_id   uuid not null references lbe.app_users(id),
  note          text check (note is null or length(note) <= 2000),
  created_at    timestamptz not null default clock_timestamp()
);
create index content_approvals_content_idx on lbe.content_approvals(content_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Transactional outbox for external actions
-- ---------------------------------------------------------------------------
create table lbe.publication_outbox (
  id                uuid primary key default gen_random_uuid(),
  content_id        uuid not null references lbe.content_items(id),
  account_id        uuid not null references lbe.social_accounts(id),
  approval_id       uuid not null references lbe.content_approvals(id),
  package           jsonb not null,
  package_hash      text not null,
  idempotency_key   text not null unique,
  provider          text not null default 'mock' check (provider = 'mock'),
  status            text not null default 'pending' check (status in (
                      'pending', 'dispatching', 'succeeded', 'failed', 'needs_reconciliation', 'cancelled')),
  available_at      timestamptz not null default now(),
  attempts          int not null default 0 check (attempts >= 0),
  max_attempts      int not null default 5 check (max_attempts between 1 and 20),
  lease_owner       text,
  lease_expires_at  timestamptz,
  last_error        text,
  provider_ref      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz
);
-- At most one live outbox entry per content item.
create unique index publication_outbox_one_active_idx on lbe.publication_outbox(content_id)
  where status in ('pending', 'dispatching', 'needs_reconciliation');
create index publication_outbox_due_idx on lbe.publication_outbox(status, available_at);

-- ---------------------------------------------------------------------------
-- Controls, audit, AI runs
-- ---------------------------------------------------------------------------
create table lbe.control_flags (
  key         text primary key check (key = 'global' or key ~ '^account:[0-9a-f-]{36}$'),
  stopped     boolean not null,
  reason      text,
  changed_by  uuid references lbe.app_users(id),
  changed_at  timestamptz not null default now()
);

create table lbe.audit_events (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default clock_timestamp(),
  actor         text not null,
  action        text not null,
  subject_type  text not null,
  subject_id    text,
  details       jsonb not null default '{}'::jsonb
);
create index audit_events_subject_idx on lbe.audit_events(subject_type, subject_id);
create index audit_events_at_idx on lbe.audit_events(at desc);

create table lbe.agent_runs (
  id              uuid primary key default gen_random_uuid(),
  purpose         text not null check (purpose in ('draft_post')),
  provider        text not null check (provider in ('mock', 'anthropic')),
  model           text not null,
  prompt_version  text not null,
  content_id      uuid references lbe.content_items(id),
  input_refs      jsonb not null default '{}'::jsonb,
  output          jsonb,
  status          text not null check (status in ('succeeded', 'failed', 'refused', 'invalid_output')),
  error           text,
  input_tokens    int,
  output_tokens   int,
  requested_by    uuid not null references lbe.app_users(id),
  started_at      timestamptz not null,
  finished_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Mock LinkedIn provider store (records attempts; deliberately does NOT dedupe,
-- so duplicate-publication tests can detect double sends).
-- ---------------------------------------------------------------------------
create table lbe_mock.linkedin_posts (
  id               bigint generated always as identity primary key,
  mock_post_urn    text not null unique,
  idempotency_key  text not null,
  author           text not null,
  commentary       text not null,
  visibility       text not null,
  payload          jsonb not null,
  received_at      timestamptz not null default clock_timestamp()
);
