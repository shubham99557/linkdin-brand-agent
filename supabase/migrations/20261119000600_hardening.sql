-- LinkedIn Brand Engine — hardening (security & tenant-isolation audit, 2026-11-19).
-- Fixes confirmed by failing regression tests in tests/integration/tenant-isolation.test.ts.

-- Nobody but the owner may create objects in `public` (protects definer functions whose search_path
-- includes `public` for pgcrypto). Default since PostgreSQL 15; made explicit here.
revoke create on schema public from public;

-- ---------------------------------------------------------------------------
-- 1. Audit events carry their organization (derived from the subject).
-- ---------------------------------------------------------------------------
alter table lbe.audit_events add column organization_id uuid references lbe.organizations(id);
create index audit_events_org_idx on lbe.audit_events(organization_id, id desc);

create function lbe.subject_org(p_type text, p_id text) returns uuid
language plpgsql stable security definer set search_path = lbe, pg_temp
as $$
declare v uuid; v_uuid uuid;
begin
  if p_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_uuid := p_id::uuid; end if;
  case p_type
    when 'content_item' then v := lbe.content_org(v_uuid);
    when 'publication_outbox' then
      select a.organization_id into v from lbe.publication_outbox o join lbe.social_accounts a on a.id = o.account_id where o.id = v_uuid;
    when 'social_account' then select organization_id into v from lbe.social_accounts where id = v_uuid;
    when 'claim' then select organization_id into v from lbe.claims where id = v_uuid;
    when 'app_user' then select organization_id into v from lbe.app_users where id = v_uuid;
    when 'brand_entry' then select organization_id into v from lbe.brand_entries where id = v_uuid;
    when 'brand_proposal' then select organization_id into v from lbe.brand_proposals where id = v_uuid;
    when 'agent_workflow' then select organization_id into v from lbe.agent_workflows where id = v_uuid;
    when 'control_flag' then
      if p_id like 'account:%' then select organization_id into v from lbe.social_accounts where id = substr(p_id, 9)::uuid;
      elsif p_id like 'org:%' then v := substr(p_id, 5)::uuid;
      end if;
    else v := null;
  end case;
  -- Fall back to the organization of the session that is acting (set by require_user).
  return coalesce(v, nullif(current_setting('lbe.org', true), '')::uuid);
end
$$;

create or replace function lbe.audit(p_action text, p_subject_type text, p_subject_id text, p_details jsonb default '{}'::jsonb)
returns void language sql
as $$
  insert into lbe.audit_events(actor, action, subject_type, subject_id, details, organization_id)
  values (lbe.actor(), p_action, p_subject_type, p_subject_id, coalesce(p_details, '{}'::jsonb),
          lbe.subject_org(p_subject_type, p_subject_id))
$$;

-- One-time backfill of the new column (audit rows are otherwise immutable).
alter table lbe.audit_events disable trigger audit_events_immutable;
update lbe.audit_events set organization_id = lbe.subject_org(subject_type, subject_id) where organization_id is null;
alter table lbe.audit_events enable trigger audit_events_immutable;

create or replace function lbe.require_user(p_session text, p_roles text[]) returns lbe.app_users
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  if p_session is null or length(p_session) < 32 then
    raise exception 'not authenticated' using errcode = 'LBE10';
  end if;
  select u.* into v_user
    from lbe.sessions s join lbe.app_users u on u.id = s.user_id
   where s.token_hash = lbe.hash_text(p_session)
     and s.revoked_at is null and s.expires_at > now() and not u.disabled;
  if not found then
    raise exception 'not authenticated' using errcode = 'LBE10';
  end if;
  if not (v_user.role = any(p_roles)) then
    raise exception 'role % may not perform this action', v_user.role using errcode = 'LBE11';
  end if;
  perform set_config('lbe.actor', 'user:' || v_user.id::text, true);
  perform set_config('lbe.org', v_user.organization_id::text, true);
  return v_user;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. STOP model: platform (operators only) / organization / account.
-- ---------------------------------------------------------------------------
alter table lbe.control_flags drop constraint control_flags_key_check;
alter table lbe.control_flags add constraint control_flags_key_check
  check (key = 'global' or key ~ '^(account|org):[0-9a-f-]{36}$');
insert into lbe.control_flags(key, stopped, reason)
  select 'org:' || id::text, false, 'organization created' from lbe.organizations
  on conflict (key) do nothing;

create function lbe.tg_organizations_ai() returns trigger language plpgsql as $$
begin
  insert into lbe.control_flags(key, stopped, reason) values ('org:' || new.id::text, false, 'organization created');
  return null;
end $$;
create trigger organizations_ai after insert on lbe.organizations for each row execute function lbe.tg_organizations_ai();

-- Fail closed on every missing flag.
create or replace function lbe.is_stopped(p_account_id uuid) returns boolean
language sql stable security definer set search_path = lbe, pg_temp
as $$
  select coalesce((select stopped from lbe.control_flags where key = 'global'), true)
      or coalesce((select f.stopped from lbe.control_flags f join lbe.social_accounts a on f.key = 'org:' || a.organization_id::text
                    where a.id = p_account_id), true)
      or coalesce((select stopped from lbe.control_flags where key = 'account:' || p_account_id::text), true)
      or not coalesce((select enabled from lbe.social_accounts where id = p_account_id), false)
      or ((select publishing_mode from lbe.social_accounts where id = p_account_id) = 'live'
          and not exists (select 1 from lbe.linkedin_credentials c
                           where c.account_id = p_account_id and c.status = 'valid' and c.expires_at > now()))
$$;

-- Users act on their own organization ('global' / 'organization' are aliases for it) or their own accounts.
-- The platform flag ('global' row) is changed only by operators via lbe.platform_set_stop or automatic safety stops.
create or replace function lbe.set_stop(p_session text, p_key text, p_stopped boolean, p_reason text) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_key text;
begin
  if p_stopped then
    v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  else
    v_user := lbe.require_user(p_session, array['admin']);
  end if;
  if coalesce(length(trim(p_reason)), 0) = 0 then
    raise exception 'a reason is required' using errcode = 'LBE02';
  end if;
  if p_key in ('global', 'organization') then
    v_key := 'org:' || v_user.organization_id::text;
  elsif p_key ~ '^account:[0-9a-f-]{36}$' then
    perform lbe.assert_org(v_user, (select organization_id from lbe.social_accounts where id = substr(p_key, 9)::uuid));
    v_key := p_key;
  elsif p_key ~ '^org:[0-9a-f-]{36}$' then
    perform lbe.assert_org(v_user, substr(p_key, 5)::uuid);
    v_key := p_key;
  else
    raise exception 'unknown control flag' using errcode = 'LBE04';
  end if;
  update lbe.control_flags set stopped = p_stopped, reason = p_reason, changed_by = v_user.id, changed_at = now()
   where key = v_key;
  if not found then raise exception 'unknown control flag' using errcode = 'LBE04'; end if;
end
$$;

create function lbe.platform_set_stop(p_stopped boolean, p_reason text) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
begin
  perform set_config('lbe.actor', 'operator:' || session_user, true);
  update lbe.control_flags set stopped = p_stopped, reason = p_reason, changed_by = null, changed_at = now() where key = 'global';
end
$$;

-- Organization-scoped manual publisher runs.
drop function lbe.claim_outbox(text, int, int, text[]);
create function lbe.claim_outbox(p_worker text, p_limit int, p_lease_seconds int, p_providers text[], p_org uuid default null)
returns setof lbe.publication_outbox
language plpgsql security definer set search_path = lbe, pg_temp
as $$
begin
  perform set_config('lbe.actor', 'worker:' || p_worker, true);
  return query
  with due as (
    select o.id from lbe.publication_outbox o join lbe.social_accounts acct on acct.id = o.account_id
     where o.status = 'pending' and o.available_at <= now()
       and o.provider = any(p_providers)
       and (p_org is null or acct.organization_id = p_org)
       and (not o.requires_release or o.released_at is not null)
       and not lbe.is_stopped(o.account_id)
       and (select count(*) from lbe.publication_outbox d
             where d.account_id = o.account_id and d.status in ('dispatching', 'succeeded', 'needs_reconciliation')
               and d.updated_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc') < lbe.daily_publish_cap()
     order by o.available_at, o.created_at
     for update of o skip locked
     limit greatest(1, least(p_limit, 50)))
  update lbe.publication_outbox o
     set status = 'dispatching', attempts = o.attempts + 1, lease_owner = p_worker,
         lease_expires_at = now() + make_interval(secs => greatest(10, p_lease_seconds))
    from due where o.id = due.id
  returning o.*;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Missing organization checks.
-- ---------------------------------------------------------------------------
create or replace function lbe.cancel_publication(p_session text, p_outbox_id uuid) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_ob lbe.publication_outbox; v_org uuid;
begin
  v_user := lbe.require_user(p_session, array['approver', 'admin']);
  select * into v_ob from lbe.publication_outbox where id = p_outbox_id for update;
  select organization_id into v_org from lbe.social_accounts where id = v_ob.account_id;
  perform lbe.assert_org(v_user, v_org);
  if v_user.role <> 'admin' and not exists (
      select 1 from lbe.account_approvers where account_id = v_ob.account_id and user_id = v_user.id) then
    raise exception 'user is not an approver for this account' using errcode = 'LBE11';
  end if;
  update lbe.publication_outbox set status = 'cancelled' where id = p_outbox_id;
  update lbe.content_items set status = 'approved' where id = v_ob.content_id;
end
$$;

create or replace function lbe.reconcile_publication(p_session text, p_outbox_id uuid, p_resolution text,
                                                     p_provider_ref text, p_note text)
returns void language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_ob lbe.publication_outbox;
begin
  v_user := lbe.require_user(p_session, array['admin']);
  select * into v_ob from lbe.publication_outbox where id = p_outbox_id for update;
  perform lbe.assert_org(v_user, (select organization_id from lbe.social_accounts where id = v_ob.account_id));
  if v_ob.status <> 'needs_reconciliation' then
    raise exception 'outbox entry is not awaiting reconciliation' using errcode = 'LBE01';
  end if;
  if coalesce(length(trim(p_note)), 0) = 0 then
    raise exception 'a reconciliation note is required' using errcode = 'LBE02';
  end if;
  perform lbe.audit('outbox.reconciliation', 'publication_outbox', p_outbox_id::text,
                    jsonb_build_object('resolution', p_resolution, 'note', p_note));
  if p_resolution = 'confirmed_published' then
    if coalesce(length(trim(p_provider_ref)), 0) = 0 then
      raise exception 'provider reference required' using errcode = 'LBE02';
    end if;
    update lbe.publication_outbox set status = 'succeeded', provider_ref = p_provider_ref where id = p_outbox_id;
    update lbe.content_items set status = 'published', provider_post_ref = p_provider_ref, published_at = now()
     where id = v_ob.content_id;
  elsif p_resolution = 'confirmed_not_published' then
    update lbe.publication_outbox set status = 'pending', available_at = now(), last_error = null where id = p_outbox_id;
    update lbe.content_items set status = 'queued' where id = v_ob.content_id;
  elsif p_resolution = 'abandon' then
    update lbe.publication_outbox set status = 'failed', last_error = 'abandoned during reconciliation' where id = p_outbox_id;
    update lbe.content_items set status = 'failed' where id = v_ob.content_id;
  else
    raise exception 'invalid resolution' using errcode = 'LBE02';
  end if;
end
$$;

create or replace function lbe.begin_oauth(p_session text, p_account_id uuid) returns jsonb
language plpgsql security definer set search_path = lbe, extensions, public, pg_temp
as $$
declare v_user lbe.app_users; v_kind text; v_state text; v_app text;
begin
  v_user := lbe.require_user(p_session, array['admin']);
  perform lbe.assert_org(v_user, (select organization_id from lbe.social_accounts where id = p_account_id));
  select kind into v_kind from lbe.social_accounts where id = p_account_id;
  v_app := case when v_kind = 'founder_profile' then 'founder_app' else 'company_app' end;
  v_state := encode(gen_random_bytes(32), 'hex');
  insert into lbe.oauth_states(state_hash, user_id, account_id, app, expires_at)
  values (lbe.hash_text(v_state), v_user.id, p_account_id, v_app, now() + interval '10 minutes');
  perform lbe.audit('oauth.started', 'social_account', p_account_id::text, jsonb_build_object('app', v_app));
  return jsonb_build_object('state', v_state, 'app', v_app);
end
$$;

create or replace function lbe.revoke_linkedin_credential(p_session text, p_account_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.require_user(p_session, array['admin']);
  perform lbe.assert_org(v_user, (select organization_id from lbe.social_accounts where id = p_account_id));
  update lbe.linkedin_credentials set status = 'revoked', invalid_reason = coalesce(nullif(p_reason, ''), 'disconnected')
   where account_id = p_account_id and status <> 'revoked';
  if not found then raise exception 'no active credential' using errcode = 'LBE04'; end if;
  update lbe.social_accounts set publishing_mode = 'mock' where id = p_account_id and publishing_mode = 'live';
end
$$;

create or replace function lbe.set_live_publishing(p_session text, p_account_id uuid, p_live boolean, p_org_urn text)
returns void language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_acct lbe.social_accounts; v_cred lbe.linkedin_credentials; v_urn text;
begin
  v_user := lbe.require_user(p_session, array['admin']);
  select * into v_acct from lbe.social_accounts where id = p_account_id for update;
  perform lbe.assert_org(v_user, v_acct.organization_id);
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

create or replace function lbe.record_agent_run(p_session text, p_run jsonb) returns uuid
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_id uuid;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  if p_run->>'content_id' is not null then
    perform lbe.assert_org(v_user, lbe.content_org((p_run->>'content_id')::uuid));
  end if;
  if p_run#>>'{input_refs,workflow_id}' is not null then
    perform lbe.assert_org(v_user, (select organization_id from lbe.agent_workflows where id = (p_run#>>'{input_refs,workflow_id}')::uuid));
  end if;
  insert into lbe.agent_runs(purpose, provider, model, prompt_version, content_id, input_refs, output, status,
                             error, input_tokens, output_tokens, requested_by, started_at)
  values (p_run->>'purpose', p_run->>'provider', p_run->>'model', p_run->>'prompt_version',
          (p_run->>'content_id')::uuid, coalesce(p_run->'input_refs', '{}'::jsonb), p_run->'output',
          p_run->>'status', p_run->>'error', (p_run->>'input_tokens')::int, (p_run->>'output_tokens')::int,
          v_user.id, (p_run->>'started_at')::timestamptz)
  returning id into v_id;
  perform lbe.audit('ai.' || (p_run->>'purpose'), case when p_run->>'content_id' is null then 'agent_workflow' else 'content_item' end,
                    coalesce(p_run->>'content_id', p_run#>>'{input_refs,workflow_id}'),
                    jsonb_build_object('agent_run_id', v_id, 'status', p_run->>'status', 'provider', p_run->>'provider'));
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Authentication: bcrypt only uses the first 72 bytes — refuse longer passwords.
-- ---------------------------------------------------------------------------
create or replace function lbe.admin_create_user(p_email text, p_display_name text, p_role text, p_password text, p_org_id uuid default null)
returns uuid language plpgsql security definer set search_path = lbe, extensions, public, pg_temp
as $$
declare v_id uuid;
begin
  if p_password is null or length(p_password) < 12 then
    raise exception 'password must be at least 12 characters' using errcode = 'LBE02';
  end if;
  if octet_length(p_password) > 72 then
    raise exception 'password must be at most 72 bytes' using errcode = 'LBE02';
  end if;
  insert into lbe.app_users(email, display_name, role, password_hash, organization_id)
  values (lower(trim(p_email)), p_display_name, p_role, crypt(p_password, gen_salt('bf', 12)), coalesce(p_org_id, lbe.default_org_id()))
  returning id into v_id;
  perform lbe.audit('user.created', 'app_user', v_id::text, jsonb_build_object('role', p_role));
  return v_id;
end
$$;

-- Expired sessions are useless; let operators purge them (no app grant).
create function lbe.purge_expired_sessions() returns int
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_n int;
begin
  delete from lbe.sessions where expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days';
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema lbe from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke execute on all functions in schema lbe from %I', r);
    end if;
  end loop;
end
$$;
grant execute on function lbe.claim_outbox(text, int, int, text[], uuid) to lbe_worker;
-- subject_org, platform_set_stop, purge_expired_sessions: owner/operator only (no grants).
