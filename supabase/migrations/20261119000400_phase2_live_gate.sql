-- LinkedIn Brand Engine — Phase 2.1: live-publishing gate, manual release, credentials, OAuth state.
-- Non-destructive: adds columns/tables, replaces functions. Existing rows keep Phase 1 behaviour.
-- Nothing here can send anything: the live provider also requires LBE_LIVE_PUBLISHING=on (application config).

-- ---------------------------------------------------------------------------
-- Accounts: live mode, release mode, two-key enablement
-- ---------------------------------------------------------------------------
alter table lbe.social_accounts drop constraint social_accounts_publishing_mode_check;
alter table lbe.social_accounts
  add constraint social_accounts_publishing_mode_check check (publishing_mode in ('mock', 'live')),
  add column release_mode text not null default 'scheduled' check (release_mode in ('manual', 'scheduled')),
  add column live_enabled_by uuid references lbe.app_users(id),
  add column live_enabled_at timestamptz,
  -- API Terms §3.1(26): until legal clearance, live accounts may only release on an explicit human click.
  add constraint social_accounts_live_is_manual check (publishing_mode = 'mock' or release_mode = 'manual'),
  add constraint social_accounts_live_enabled_by check (
    publishing_mode = 'mock' or (live_enabled_by is not null and live_enabled_at is not null and linkedin_urn is not null));

-- ---------------------------------------------------------------------------
-- Credentials (ciphertext only; the encryption key never enters the database)
-- ---------------------------------------------------------------------------
create table lbe.linkedin_credentials (
  account_id         uuid primary key references lbe.social_accounts(id),
  app                text not null check (app in ('founder_app', 'company_app')),
  subject_urn        text,
  subject_name       text,
  scopes             text[] not null,
  token_ciphertext   text not null check (length(token_ciphertext) between 40 and 8000),
  key_id             text not null check (key_id ~ '^[a-z0-9_-]{1,32}$'),
  expires_at         timestamptz not null,
  status             text not null default 'valid' check (status in ('valid', 'invalid', 'revoked', 'expired')),
  invalid_reason     text,
  connected_by       uuid not null references lbe.app_users(id),
  connected_at       timestamptz not null default now(),
  last_checked_at    timestamptz
);

create table lbe.oauth_states (
  id           uuid primary key default gen_random_uuid(),
  state_hash   text not null unique,
  user_id      uuid not null references lbe.app_users(id),
  account_id   uuid not null references lbe.social_accounts(id),
  app          text not null check (app in ('founder_app', 'company_app')),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  stored_at    timestamptz
);

-- ---------------------------------------------------------------------------
-- Outbox: provider follows the approved destination; manual release
-- ---------------------------------------------------------------------------
alter table lbe.publication_outbox drop constraint publication_outbox_provider_check;
alter table lbe.publication_outbox
  add constraint publication_outbox_provider_check check (provider in ('mock', 'linkedin')),
  add column requires_release boolean not null default false,
  add column released_by uuid references lbe.app_users(id),
  add column released_at timestamptz;

create function lbe.daily_publish_cap() returns int language sql immutable as $$ select 25 $$;

-- Fail closed: global STOP, account STOP, disabled account, or a live account without a valid credential.
create or replace function lbe.is_stopped(p_account_id uuid) returns boolean
language sql stable security definer set search_path = lbe, pg_temp
as $$
  select coalesce((select stopped from lbe.control_flags where key = 'global'), true)
      or coalesce((select stopped from lbe.control_flags where key = 'account:' || p_account_id::text), true)
      or not coalesce((select enabled from lbe.social_accounts where id = p_account_id), false)
      or ((select publishing_mode from lbe.social_accounts where id = p_account_id) = 'live'
          and not exists (select 1 from lbe.linkedin_credentials c
                           where c.account_id = p_account_id and c.status = 'valid' and c.expires_at > now()))
$$;

create or replace function lbe.tg_outbox_bi() returns trigger
language plpgsql
as $$
declare
  v_content lbe.content_items;
  v_approval lbe.content_approvals;
  v_latest lbe.content_approvals;
  v_account lbe.social_accounts;
begin
  select * into v_content from lbe.content_items where id = new.content_id for update;
  select * into v_approval from lbe.content_approvals where id = new.approval_id;
  v_latest := lbe.latest_decision(new.content_id);
  if v_content.id is null or v_approval.id is null then
    raise exception 'content or approval not found' using errcode = 'LBE04';
  end if;
  if v_content.status <> 'approved'
     or v_approval.content_id <> v_content.id
     or v_approval.decision <> 'approved'
     or v_latest.id is distinct from v_approval.id
     or v_approval.package_hash <> v_content.package_hash then
    raise exception 'outbox entry requires the latest, matching approval' using errcode = 'LBE01';
  end if;
  select * into v_account from lbe.social_accounts where id = v_content.account_id;
  new.account_id := v_content.account_id;
  new.package := v_approval.package;
  new.package_hash := v_approval.package_hash;
  new.idempotency_key := v_content.id::text || ':' || v_approval.package_hash;
  -- The provider follows the destination the approver saw, not the account's current mode.
  new.provider := case when v_approval.package #>> '{destination,publishing_mode}' = 'live' then 'linkedin' else 'mock' end;
  new.requires_release := (v_account.release_mode = 'manual' or new.provider = 'linkedin');
  new.released_by := null;
  new.released_at := null;
  new.status := 'pending';
  new.attempts := 0;
  new.lease_owner := null;
  new.lease_expires_at := null;
  new.provider_ref := null;
  new.created_at := now();
  new.updated_at := now();
  return new;
end
$$;

create or replace function lbe.tg_outbox_bu() returns trigger
language plpgsql
as $$
begin
  if new.content_id <> old.content_id or new.account_id <> old.account_id or new.approval_id <> old.approval_id
     or new.package <> old.package or new.package_hash <> old.package_hash
     or new.idempotency_key <> old.idempotency_key or new.provider <> old.provider
     or new.requires_release <> old.requires_release or new.created_at <> old.created_at then
    raise exception 'immutable outbox columns changed' using errcode = 'LBE01';
  end if;
  if (new.released_at is distinct from old.released_at or new.released_by is distinct from old.released_by) then
    if old.released_at is not null or old.status <> 'pending' or new.released_at is null or new.released_by is null then
      raise exception 'an outbox entry can be released once, while pending' using errcode = 'LBE01';
    end if;
  end if;

  if new.status is distinct from old.status then
    if not ((old.status, new.status) in (
        ('pending', 'dispatching'), ('pending', 'cancelled'),
        ('dispatching', 'succeeded'), ('dispatching', 'pending'), ('dispatching', 'failed'),
        ('dispatching', 'needs_reconciliation'),
        ('needs_reconciliation', 'succeeded'), ('needs_reconciliation', 'pending'),
        ('needs_reconciliation', 'failed'))) then
      raise exception 'invalid outbox transition % -> %', old.status, new.status using errcode = 'LBE01';
    end if;
    if new.status = 'dispatching' then
      if lbe.is_stopped(new.account_id) then
        raise exception 'publishing is stopped for this account' using errcode = 'LBE03';
      end if;
      if new.requires_release and new.released_at is null then
        raise exception 'this publication must be released by an approver' using errcode = 'LBE01';
      end if;
      if new.provider = 'linkedin' and not exists (
          select 1 from lbe.social_accounts a where a.id = new.account_id and a.publishing_mode = 'live') then
        raise exception 'account is not enabled for live publishing' using errcode = 'LBE03';
      end if;
      if not exists (select 1 from lbe.content_items c
                      where c.id = new.content_id and c.status = 'queued' and c.package_hash = new.package_hash) then
        raise exception 'content no longer matches the approved package' using errcode = 'LBE01';
      end if;
    end if;
    if new.status = 'succeeded' and new.provider_ref is null then
      raise exception 'succeeded requires provider_ref' using errcode = 'LBE01';
    end if;
    if new.status in ('succeeded', 'failed', 'cancelled') then
      new.completed_at := now();
      new.lease_owner := null;
      new.lease_expires_at := null;
    end if;
  elsif new.provider_ref is distinct from old.provider_ref then
    raise exception 'provider_ref can only change with a status transition' using errcode = 'LBE01';
  end if;
  new.updated_at := now();
  return new;
end
$$;

-- Switching an account between mock and live changes the destination in every unpublished package,
-- so existing approvals (given for the other mode) no longer match.
create or replace function lbe.tg_accounts_au() returns trigger
language plpgsql
as $$
begin
  if new.kind is distinct from old.kind or new.linkedin_urn is distinct from old.linkedin_urn
     or new.publishing_mode is distinct from old.publishing_mode then
    update lbe.content_items set updated_at = now()
     where account_id = new.id and status in ('draft', 'in_review', 'changes_requested', 'approved', 'failed');
  end if;
  perform lbe.audit('account.updated', 'social_account', new.id::text,
                    jsonb_build_object('enabled', new.enabled, 'publishing_mode', new.publishing_mode,
                                       'release_mode', new.release_mode,
                                       'linkedin_urn_changed', new.linkedin_urn is distinct from old.linkedin_urn));
  return null;
end
$$;

-- Live mode needs a valid credential at the moment it is switched on.
create function lbe.tg_accounts_live_bu() returns trigger
language plpgsql
as $$
begin
  if new.publishing_mode = 'live' and old.publishing_mode <> 'live' and not exists (
      select 1 from lbe.linkedin_credentials c
       where c.account_id = new.id and c.status = 'valid' and c.expires_at > now()) then
    raise exception 'connect a valid LinkedIn credential before enabling live publishing' using errcode = 'LBE01';
  end if;
  return new;
end
$$;

create trigger accounts_live_bu before update on lbe.social_accounts
  for each row execute function lbe.tg_accounts_live_bu();

create function lbe.tg_credentials_audit() returns trigger
language plpgsql
as $$
begin
  -- Never include token material in audit details.
  perform lbe.audit(case when tg_op = 'INSERT' then 'credential.connected' else 'credential.' || new.status end,
                    'social_account', new.account_id::text,
                    jsonb_build_object('app', new.app, 'subject_urn', new.subject_urn, 'scopes', new.scopes,
                                       'expires_at', new.expires_at, 'status', new.status,
                                       'reason', new.invalid_reason));
  return null;
end
$$;

create trigger credentials_audit after insert or update on lbe.linkedin_credentials
  for each row execute function lbe.tg_credentials_audit();
create trigger credentials_no_delete before delete on lbe.linkedin_credentials
  for each row execute function lbe.tg_immutable();

-- ---------------------------------------------------------------------------
-- API operations
-- ---------------------------------------------------------------------------
create function lbe.release_publication(p_session text, p_outbox_id uuid) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_ob lbe.publication_outbox;
begin
  v_user := lbe.require_user(p_session, array['approver', 'admin']);
  select * into v_ob from lbe.publication_outbox where id = p_outbox_id for update;
  if not found then raise exception 'outbox entry not found' using errcode = 'LBE04'; end if;
  if not exists (select 1 from lbe.account_approvers where account_id = v_ob.account_id and user_id = v_user.id) then
    raise exception 'user is not an approver for this account' using errcode = 'LBE11';
  end if;
  if v_ob.status <> 'pending' or v_ob.released_at is not null then
    raise exception 'only a pending, unreleased publication can be released' using errcode = 'LBE01';
  end if;
  update lbe.publication_outbox set released_by = v_user.id, released_at = now(), available_at = now()
   where id = p_outbox_id;
  perform lbe.audit('outbox.released', 'publication_outbox', p_outbox_id::text,
                    jsonb_build_object('content_id', v_ob.content_id, 'provider', v_ob.provider));
end
$$;

create function lbe.begin_oauth(p_session text, p_account_id uuid) returns jsonb
language plpgsql security definer set search_path = lbe, extensions, public, pg_temp
as $$
declare v_user lbe.app_users; v_kind text; v_state text; v_app text;
begin
  v_user := lbe.require_user(p_session, array['admin']);
  select kind into v_kind from lbe.social_accounts where id = p_account_id;
  if not found then raise exception 'account not found' using errcode = 'LBE04'; end if;
  v_app := case when v_kind = 'founder_profile' then 'founder_app' else 'company_app' end;
  v_state := encode(gen_random_bytes(32), 'hex');
  insert into lbe.oauth_states(state_hash, user_id, account_id, app, expires_at)
  values (lbe.hash_text(v_state), v_user.id, p_account_id, v_app, now() + interval '10 minutes');
  perform lbe.audit('oauth.started', 'social_account', p_account_id::text, jsonb_build_object('app', v_app));
  return jsonb_build_object('state', v_state, 'app', v_app);
end
$$;

-- Single use, 10 minutes, and only by the admin who started it.
create function lbe.consume_oauth_state(p_session text, p_state text) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_row lbe.oauth_states;
begin
  v_user := lbe.require_user(p_session, array['admin']);
  select * into v_row from lbe.oauth_states where state_hash = lbe.hash_text(coalesce(p_state, '')) for update;
  if not found or v_row.user_id <> v_user.id or v_row.consumed_at is not null or v_row.expires_at <= now() then
    perform lbe.audit('oauth.state_rejected', 'social_account', v_row.account_id::text, '{}'::jsonb);
    return null;
  end if;
  update lbe.oauth_states set consumed_at = now() where id = v_row.id;
  return jsonb_build_object('account_id', v_row.account_id, 'app', v_row.app);
end
$$;

create function lbe.store_linkedin_credential(p_session text, p_state text, p_subject_urn text, p_subject_name text,
                                              p_scopes text[], p_ciphertext text, p_key_id text, p_expires_at timestamptz)
returns void language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_row lbe.oauth_states;
begin
  v_user := lbe.require_user(p_session, array['admin']);
  select * into v_row from lbe.oauth_states where state_hash = lbe.hash_text(coalesce(p_state, '')) for update;
  if not found or v_row.user_id <> v_user.id or v_row.consumed_at is null or v_row.stored_at is not null
     or v_row.consumed_at < now() - interval '10 minutes' then
    raise exception 'OAuth session is not valid for storing a credential' using errcode = 'LBE01';
  end if;
  update lbe.oauth_states set stored_at = now() where id = v_row.id;
  -- Replace any previous credential for the account (history is kept in the audit log).
  if exists (select 1 from lbe.linkedin_credentials where account_id = v_row.account_id) then
    update lbe.linkedin_credentials
       set app = v_row.app, subject_urn = p_subject_urn, subject_name = p_subject_name, scopes = p_scopes,
           token_ciphertext = p_ciphertext, key_id = p_key_id, expires_at = p_expires_at, status = 'valid',
           invalid_reason = null, connected_by = v_user.id, connected_at = now(), last_checked_at = now()
     where account_id = v_row.account_id;
  else
    insert into lbe.linkedin_credentials(account_id, app, subject_urn, subject_name, scopes, token_ciphertext,
                                         key_id, expires_at, connected_by, last_checked_at)
    values (v_row.account_id, v_row.app, p_subject_urn, p_subject_name, p_scopes, p_ciphertext, p_key_id,
            p_expires_at, v_user.id, now());
  end if;
end
$$;

create function lbe.revoke_linkedin_credential(p_session text, p_account_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
begin
  perform lbe.require_user(p_session, array['admin']);
  update lbe.linkedin_credentials set status = 'revoked', invalid_reason = coalesce(nullif(p_reason, ''), 'disconnected')
   where account_id = p_account_id and status <> 'revoked';
  if not found then raise exception 'no active credential' using errcode = 'LBE04'; end if;
  update lbe.social_accounts set publishing_mode = 'mock' where id = p_account_id and publishing_mode = 'live';
end
$$;

-- Two-key enablement: admin action + valid credential (+ LBE_LIVE_PUBLISHING=on in the application).
create function lbe.set_live_publishing(p_session text, p_account_id uuid, p_live boolean, p_org_urn text)
returns void language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_acct lbe.social_accounts; v_cred lbe.linkedin_credentials; v_urn text;
begin
  v_user := lbe.require_user(p_session, array['admin']);
  select * into v_acct from lbe.social_accounts where id = p_account_id for update;
  if not found then raise exception 'account not found' using errcode = 'LBE04'; end if;
  if not p_live then
    update lbe.social_accounts set publishing_mode = 'mock' where id = p_account_id;
    return;
  end if;
  select * into v_cred from lbe.linkedin_credentials where account_id = p_account_id;
  if v_cred.account_id is null or v_cred.status <> 'valid' or v_cred.expires_at <= now() then
    raise exception 'connect a valid LinkedIn credential first' using errcode = 'LBE01';
  end if;
  if v_acct.kind = 'founder_profile' then
    v_urn := v_cred.subject_urn;
  else
    if p_org_urn is null or p_org_urn !~ '^urn:li:organization:[0-9]{1,20}$' then
      raise exception 'company pages need an organization URN like urn:li:organization:12345' using errcode = 'LBE02';
    end if;
    v_urn := p_org_urn;
  end if;
  if v_urn is null then raise exception 'credential has no subject URN' using errcode = 'LBE02'; end if;
  update lbe.social_accounts
     set linkedin_urn = v_urn, release_mode = 'manual', live_enabled_by = v_user.id, live_enabled_at = now(),
         publishing_mode = 'live'
   where id = p_account_id;
end
$$;

-- ---------------------------------------------------------------------------
-- Worker operations
-- ---------------------------------------------------------------------------
drop function lbe.claim_outbox(text, int, int);

create function lbe.claim_outbox(p_worker text, p_limit int, p_lease_seconds int, p_providers text[])
returns setof lbe.publication_outbox
language plpgsql security definer set search_path = lbe, pg_temp
as $$
begin
  perform set_config('lbe.actor', 'worker:' || p_worker, true);
  return query
  with due as (
    select o.id from lbe.publication_outbox o
     where o.status = 'pending' and o.available_at <= now()
       and o.provider = any(p_providers)
       and (not o.requires_release or o.released_at is not null)
       and not lbe.is_stopped(o.account_id)
       and (select count(*) from lbe.publication_outbox d
             where d.account_id = o.account_id and d.status in ('dispatching', 'succeeded', 'needs_reconciliation')
               and d.updated_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc') < lbe.daily_publish_cap()
     order by o.available_at, o.created_at
     for update skip locked
     limit greatest(1, least(p_limit, 50)))
  update lbe.publication_outbox o
     set status = 'dispatching', attempts = o.attempts + 1, lease_owner = p_worker,
         lease_expires_at = now() + make_interval(secs => greatest(10, p_lease_seconds))
    from due where o.id = due.id
  returning o.*;
end
$$;

-- Returns ciphertext only for a live account with a valid credential. Decryption happens in the worker.
create function lbe.worker_get_credential(p_worker text, p_account_id uuid) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_cred lbe.linkedin_credentials;
begin
  perform set_config('lbe.actor', 'worker:' || p_worker, true);
  select c.* into v_cred from lbe.linkedin_credentials c join lbe.social_accounts a on a.id = c.account_id
   where c.account_id = p_account_id and c.status = 'valid' and c.expires_at > now() and a.publishing_mode = 'live';
  if not found then return null; end if;
  return jsonb_build_object('ciphertext', v_cred.token_ciphertext, 'key_id', v_cred.key_id,
                            'subject_urn', v_cred.subject_urn, 'app', v_cred.app);
end
$$;

-- Workers may STOP (never resume).
create function lbe.worker_auto_stop(p_worker text, p_key text, p_reason text) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
begin
  perform set_config('lbe.actor', 'worker:' || p_worker, true);
  update lbe.control_flags set stopped = true, reason = 'AUTO: ' || left(coalesce(p_reason, 'worker'), 300), changed_by = null, changed_at = now()
   where key = p_key and not stopped;
end
$$;

create function lbe.worker_mark_credential(p_worker text, p_account_id uuid, p_status text, p_reason text) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
begin
  perform set_config('lbe.actor', 'worker:' || p_worker, true);
  if p_status not in ('invalid', 'expired') then
    raise exception 'workers may only mark credentials invalid or expired' using errcode = 'LBE02';
  end if;
  update lbe.linkedin_credentials set status = p_status, invalid_reason = left(p_reason, 300), last_checked_at = now()
   where account_id = p_account_id and status = 'valid';
  perform lbe.worker_auto_stop(p_worker, 'account:' || p_account_id::text, 'LinkedIn credential ' || p_status || ': ' || coalesce(p_reason, ''));
end
$$;

create function lbe.expire_credentials(p_worker text) returns int
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_row record; v_n int := 0;
begin
  for v_row in select account_id from lbe.linkedin_credentials where status = 'valid' and expires_at <= now() loop
    perform lbe.worker_mark_credential(p_worker, v_row.account_id, 'expired', 'access token expired — reconnect');
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- ---------------------------------------------------------------------------
-- Privileges & RLS for new objects
-- ---------------------------------------------------------------------------
revoke all on lbe.linkedin_credentials, lbe.oauth_states from public;
revoke execute on all functions in schema lbe from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on lbe.linkedin_credentials, lbe.oauth_states from %I', r);
      execute format('revoke execute on all functions in schema lbe from %I', r);
    end if;
  end loop;
end
$$;

alter table lbe.linkedin_credentials enable row level security;
alter table lbe.oauth_states enable row level security;
-- lbe_api may see credential metadata but NOT the ciphertext column.
grant select (account_id, app, subject_urn, subject_name, scopes, expires_at, status, invalid_reason,
              connected_by, connected_at, last_checked_at) on lbe.linkedin_credentials to lbe_api;
create policy api_read on lbe.linkedin_credentials for select to lbe_api using (true);

grant execute on function
  lbe.release_publication(text, uuid),
  lbe.begin_oauth(text, uuid),
  lbe.consume_oauth_state(text, text),
  lbe.store_linkedin_credential(text, text, text, text, text[], text, text, timestamptz),
  lbe.revoke_linkedin_credential(text, uuid, text),
  lbe.set_live_publishing(text, uuid, boolean, text)
to lbe_api;

grant execute on function
  lbe.claim_outbox(text, int, int, text[]),
  lbe.worker_get_credential(text, uuid),
  lbe.worker_auto_stop(text, text, text),
  lbe.worker_mark_credential(text, uuid, text, text),
  lbe.expire_credentials(text)
to lbe_worker;
grant select on lbe.social_accounts to lbe_worker;
