-- LinkedIn Brand Engine — Phase 1 business rules
-- Invariants are enforced by triggers so they hold for EVERY role, including service_role
-- and direct SQL. Privileged operations are SECURITY DEFINER functions that resolve the
-- acting user from a raw session token inside the database.
--
-- Custom SQLSTATEs (mapped to HTTP by the API):
--   LBE01 conflict / invalid state transition   -> 409
--   LBE02 validation failed                     -> 422
--   LBE03 publishing stopped                    -> 423
--   LBE04 not found                             -> 404
--   LBE10 not authenticated                     -> 401
--   LBE11 forbidden                             -> 403

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function lbe.hash_text(p text) returns text
language sql immutable strict
as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;

create function lbe.hash_jsonb(p jsonb) returns text
language sql immutable strict
as $$ select lbe.hash_text(p::text) $$;   -- jsonb::text is canonical (sorted keys, fixed spacing)

create function lbe.actor() returns text
language sql stable
as $$ select coalesce(nullif(current_setting('lbe.actor', true), ''), 'db:' || current_user) $$;

create function lbe.audit(p_action text, p_subject_type text, p_subject_id text, p_details jsonb default '{}'::jsonb)
returns void language sql
as $$
  insert into lbe.audit_events(actor, action, subject_type, subject_id, details)
  values (lbe.actor(), p_action, p_subject_type, p_subject_id, coalesce(p_details, '{}'::jsonb))
$$;

create function lbe.is_stopped(p_account_id uuid) returns boolean
language sql stable security definer set search_path = lbe, pg_temp
as $$
  -- Fail closed: a missing flag row counts as STOPPED.
  select coalesce((select stopped from lbe.control_flags where key = 'global'), true)
      or coalesce((select stopped from lbe.control_flags where key = 'account:' || p_account_id::text), true)
      or not coalesce((select enabled from lbe.social_accounts where id = p_account_id), false)
$$;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
create function lbe.require_user(p_session text, p_roles text[]) returns lbe.app_users
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
  return v_user;
end
$$;

create function lbe.admin_create_user(p_email text, p_display_name text, p_role text, p_password text)
returns uuid language plpgsql security definer set search_path = lbe, extensions, public, pg_temp
as $$
declare v_id uuid;
begin
  if p_password is null or length(p_password) < 12 then
    raise exception 'password must be at least 12 characters' using errcode = 'LBE02';
  end if;
  insert into lbe.app_users(email, display_name, role, password_hash)
  values (lower(trim(p_email)), p_display_name, p_role, crypt(p_password, gen_salt('bf', 12)))
  returning id into v_id;
  perform lbe.audit('user.created', 'app_user', v_id::text, jsonb_build_object('role', p_role));
  return v_id;
end
$$;

create function lbe.login(p_email text, p_password text) returns jsonb
language plpgsql security definer set search_path = lbe, extensions, public, pg_temp
as $$
declare
  v_user lbe.app_users;
  v_token text;
  v_expires timestamptz := now() + interval '12 hours';
begin
  select * into v_user from lbe.app_users where email = lower(trim(coalesce(p_email, '')));
  if not found then
    perform crypt(coalesce(p_password, ''), gen_salt('bf', 12));  -- equalise timing
    perform set_config('lbe.actor', 'anonymous', true);
    perform lbe.audit('auth.login_failed', 'app_user', null, jsonb_build_object('reason', 'unknown_email'));
    return jsonb_build_object('ok', false);
  end if;
  perform set_config('lbe.actor', 'user:' || v_user.id::text, true);
  if v_user.disabled or (v_user.locked_until is not null and v_user.locked_until > now()) then
    perform lbe.audit('auth.login_failed', 'app_user', v_user.id::text, jsonb_build_object('reason', 'disabled_or_locked'));
    return jsonb_build_object('ok', false);
  end if;
  if crypt(coalesce(p_password, ''), v_user.password_hash) <> v_user.password_hash then
    update lbe.app_users
       set failed_logins = case when failed_logins + 1 >= 5 then 0 else failed_logins + 1 end,
           locked_until  = case when failed_logins + 1 >= 5 then now() + interval '15 minutes' else locked_until end
     where id = v_user.id;
    perform lbe.audit('auth.login_failed', 'app_user', v_user.id::text, jsonb_build_object('reason', 'bad_password'));
    return jsonb_build_object('ok', false);
  end if;
  update lbe.app_users set failed_logins = 0, locked_until = null where id = v_user.id;
  v_token := encode(gen_random_bytes(32), 'hex');
  insert into lbe.sessions(user_id, token_hash, expires_at) values (v_user.id, lbe.hash_text(v_token), v_expires);
  perform lbe.audit('auth.login', 'app_user', v_user.id::text);
  return jsonb_build_object('ok', true, 'token', v_token, 'expires_at', v_expires, 'user_id', v_user.id);
end
$$;

create function lbe.whoami(p_session text) returns jsonb
language sql stable security definer set search_path = lbe, pg_temp
as $$
  select jsonb_build_object('id', u.id, 'email', u.email, 'display_name', u.display_name, 'role', u.role,
                            'approver_for', coalesce((select jsonb_agg(aa.account_id) from lbe.account_approvers aa where aa.user_id = u.id), '[]'::jsonb))
    from lbe.sessions s join lbe.app_users u on u.id = s.user_id
   where p_session is not null and s.token_hash = lbe.hash_text(p_session)
     and s.revoked_at is null and s.expires_at > now() and not u.disabled
$$;

create function lbe.logout(p_session text) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
begin
  update lbe.sessions set revoked_at = now()
   where token_hash = lbe.hash_text(coalesce(p_session, '')) and revoked_at is null;
end
$$;

-- ---------------------------------------------------------------------------
-- Publication package
-- ---------------------------------------------------------------------------
create function lbe.build_package(p_content_id uuid, p_account_id uuid, p_body text, p_media text[],
                                  p_visibility text, p_scheduled timestamptz)
returns jsonb language sql stable
as $$
  select jsonb_build_object(
    'schema', 'lbe.publication.v1',
    'content_id', p_content_id,
    'destination', jsonb_build_object(
        'account_id', a.id, 'kind', a.kind, 'linkedin_urn', a.linkedin_urn,
        'publishing_mode', a.publishing_mode),
    'body', p_body,
    'media_ids', to_jsonb(coalesce(p_media, '{}'::text[])),
    'visibility', p_visibility,
    'scheduled_for', case when p_scheduled is null then null
                          else to_char(p_scheduled at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end,
    'claim_ids', coalesce((select jsonb_agg(cc.claim_id order by cc.claim_id)
                             from lbe.content_claims cc where cc.content_id = p_content_id), '[]'::jsonb))
  from lbe.social_accounts a where a.id = p_account_id
$$;

create function lbe.latest_decision(p_content_id uuid) returns lbe.content_approvals
language sql stable
as $$
  select * from lbe.content_approvals where content_id = p_content_id
   order by created_at desc, id desc limit 1
$$;

-- ---------------------------------------------------------------------------
-- content_items: package maintenance + state machine
-- ---------------------------------------------------------------------------
create function lbe.assert_content_transition(o lbe.content_items, n lbe.content_items) returns void
language plpgsql
as $$
declare v_latest lbe.content_approvals;
begin
  if not ((o.status, n.status) in (
      ('draft', 'in_review'),
      ('in_review', 'approved'), ('in_review', 'changes_requested'), ('in_review', 'rejected'), ('in_review', 'draft'),
      ('changes_requested', 'draft'), ('changes_requested', 'in_review'),
      ('approved', 'queued'), ('approved', 'draft'),
      ('queued', 'published'), ('queued', 'failed'), ('queued', 'needs_reconciliation'), ('queued', 'approved'),
      ('needs_reconciliation', 'published'), ('needs_reconciliation', 'failed'), ('needs_reconciliation', 'queued'),
      ('failed', 'draft'))) then
    raise exception 'invalid content transition % -> %', o.status, n.status using errcode = 'LBE01';
  end if;

  if n.status = 'in_review' then
    if length(trim(n.body)) = 0 then
      raise exception 'cannot submit an empty post' using errcode = 'LBE02';
    end if;
    if jsonb_array_length(n.unsupported_statements) > 0 then
      raise exception 'post contains % unsupported factual statement(s)', jsonb_array_length(n.unsupported_statements)
        using errcode = 'LBE02';
    end if;
    if exists (select 1 from lbe.content_claims cc join lbe.claims c on c.id = cc.claim_id
                where cc.content_id = n.id
                  and (c.status <> 'verified' or (c.expires_at is not null and c.expires_at <= now()))) then
      raise exception 'post references a claim that is not currently verified' using errcode = 'LBE02';
    end if;
    if exists (select 1 from lbe.content_claims cc where cc.content_id = n.id and position(cc.quoted_span in n.body) = 0) then
      raise exception 'a claim citation no longer matches the post text' using errcode = 'LBE02';
    end if;
  end if;

  if n.status = 'approved' then
    v_latest := lbe.latest_decision(n.id);
    if v_latest.id is null or v_latest.decision <> 'approved' or v_latest.package_hash <> n.package_hash then
      raise exception 'no valid approval for the current publication package' using errcode = 'LBE01';
    end if;
  end if;

  if n.status = 'queued' and not exists (
      select 1 from lbe.publication_outbox ob
       where ob.content_id = n.id and ob.package_hash = n.package_hash and ob.status in ('pending', 'dispatching')) then
    raise exception 'content can only be queued through the outbox' using errcode = 'LBE01';
  end if;

  if n.status = 'published' and (n.provider_post_ref is null or not exists (
      select 1 from lbe.publication_outbox ob
       where ob.content_id = n.id and ob.package_hash = n.package_hash and ob.status = 'succeeded')) then
    raise exception 'content can only be marked published from a succeeded outbox entry' using errcode = 'LBE01';
  end if;
end
$$;

create function lbe.tg_content_items_biu() returns trigger
language plpgsql
as $$
declare v_pkg jsonb;
begin
  if tg_op = 'UPDATE' then
    if new.id <> old.id or new.created_by <> old.created_by or new.created_at <> old.created_at then
      raise exception 'immutable content columns changed' using errcode = 'LBE01';
    end if;
  end if;

  v_pkg := lbe.build_package(new.id, new.account_id, new.body, new.media_ids, new.visibility, new.scheduled_for);
  if v_pkg is null then
    raise exception 'unknown account %', new.account_id using errcode = 'LBE04';
  end if;
  new.package := v_pkg;
  new.package_hash := lbe.hash_jsonb(v_pkg);
  new.updated_at := now();

  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.provider_post_ref is not null then
      raise exception 'new content must start as an unpublished draft' using errcode = 'LBE01';
    end if;
    return new;
  end if;

  if new.provider_post_ref is distinct from old.provider_post_ref and new.status <> 'published' then
    raise exception 'provider_post_ref can only be set when publishing' using errcode = 'LBE01';
  end if;

  if new.package_hash is distinct from old.package_hash then
    -- Any change to the publication package invalidates review/approval.
    if old.status in ('queued', 'published', 'needs_reconciliation', 'rejected') then
      raise exception 'content is locked in status %', old.status using errcode = 'LBE01';
    end if;
    new.status := 'draft';
    new.version := old.version + 1;
    return new;
  end if;

  if new.status is distinct from old.status then
    perform lbe.assert_content_transition(old, new);
  end if;
  return new;
end
$$;

create trigger content_items_biu before insert or update on lbe.content_items
  for each row execute function lbe.tg_content_items_biu();

create function lbe.tg_content_items_audit() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    perform lbe.audit('content.created', 'content_item', new.id::text,
                      jsonb_build_object('account_id', new.account_id, 'package_hash', new.package_hash));
  elsif new.status is distinct from old.status or new.package_hash is distinct from old.package_hash then
    perform lbe.audit('content.updated', 'content_item', new.id::text,
                      jsonb_build_object('from_status', old.status, 'to_status', new.status,
                                         'version', new.version, 'package_hash', new.package_hash,
                                         'package_changed', new.package_hash is distinct from old.package_hash));
  end if;
  return null;
end
$$;

create trigger content_items_audit after insert or update on lbe.content_items
  for each row execute function lbe.tg_content_items_audit();

create function lbe.tg_content_items_no_delete() returns trigger
language plpgsql
as $$ begin raise exception 'content items cannot be deleted in Phase 1' using errcode = 'LBE01'; end $$;

create trigger content_items_no_delete before delete on lbe.content_items
  for each row execute function lbe.tg_content_items_no_delete();

-- Claim citations are part of the package: touching them recomputes the hash (and invalidates approval).
create function lbe.tg_content_claims_touch() returns trigger
language plpgsql
as $$
begin
  update lbe.content_items set updated_at = now()
   where id = coalesce(case when tg_op = 'DELETE' then old.content_id else new.content_id end, old.content_id);
  return null;
end
$$;

create trigger content_claims_touch after insert or update or delete on lbe.content_claims
  for each row execute function lbe.tg_content_claims_touch();

-- ---------------------------------------------------------------------------
-- content_approvals: validated on insert, immutable afterwards
-- ---------------------------------------------------------------------------
create function lbe.tg_approvals_bi() returns trigger
language plpgsql
as $$
declare
  v_content lbe.content_items;
  v_user lbe.app_users;
begin
  select * into v_content from lbe.content_items where id = new.content_id for update;
  if not found then
    raise exception 'content not found' using errcode = 'LBE04';
  end if;
  if v_content.status <> 'in_review' then
    raise exception 'content is not awaiting review (status %)', v_content.status using errcode = 'LBE01';
  end if;
  if new.package_hash is distinct from v_content.package_hash then
    raise exception 'stale review: the publication package changed after it was previewed' using errcode = 'LBE01';
  end if;
  select * into v_user from lbe.app_users where id = new.approver_id;
  if not found or v_user.disabled or v_user.role not in ('approver', 'admin')
     or not exists (select 1 from lbe.account_approvers
                     where account_id = v_content.account_id and user_id = new.approver_id) then
    raise exception 'user is not an approver for this account' using errcode = 'LBE11';
  end if;
  new.package := v_content.package;          -- snapshot is always taken from the database
  new.created_at := clock_timestamp();
  return new;
end
$$;

create trigger approvals_bi before insert on lbe.content_approvals
  for each row execute function lbe.tg_approvals_bi();

create function lbe.tg_immutable() returns trigger
language plpgsql
as $$ begin raise exception '% rows are immutable', tg_table_name using errcode = 'LBE01'; end $$;

create trigger approvals_immutable before update or delete on lbe.content_approvals
  for each row execute function lbe.tg_immutable();
create trigger audit_events_immutable before update or delete on lbe.audit_events
  for each row execute function lbe.tg_immutable();

create function lbe.tg_approvals_audit() returns trigger
language plpgsql
as $$
begin
  perform lbe.audit('content.decision', 'content_item', new.content_id::text,
                    jsonb_build_object('approval_id', new.id, 'decision', new.decision,
                                       'package_hash', new.package_hash, 'approver_id', new.approver_id));
  return null;
end
$$;

create trigger approvals_audit after insert on lbe.content_approvals
  for each row execute function lbe.tg_approvals_audit();

-- ---------------------------------------------------------------------------
-- publication_outbox: creation requires a valid approval; strict state machine
-- ---------------------------------------------------------------------------
create function lbe.tg_outbox_bi() returns trigger
language plpgsql
as $$
declare
  v_content lbe.content_items;
  v_approval lbe.content_approvals;
  v_latest lbe.content_approvals;
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
  new.account_id := v_content.account_id;
  new.package := v_approval.package;
  new.package_hash := v_approval.package_hash;
  new.idempotency_key := v_content.id::text || ':' || v_approval.package_hash;
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

create trigger outbox_bi before insert on lbe.publication_outbox
  for each row execute function lbe.tg_outbox_bi();

create function lbe.tg_outbox_bu() returns trigger
language plpgsql
as $$
begin
  if new.content_id <> old.content_id or new.account_id <> old.account_id or new.approval_id <> old.approval_id
     or new.package <> old.package or new.package_hash <> old.package_hash
     or new.idempotency_key <> old.idempotency_key or new.provider <> old.provider
     or new.created_at <> old.created_at then
    raise exception 'immutable outbox columns changed' using errcode = 'LBE01';
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

create trigger outbox_bu before update on lbe.publication_outbox
  for each row execute function lbe.tg_outbox_bu();
create trigger outbox_no_delete before delete on lbe.publication_outbox
  for each row execute function lbe.tg_immutable();

create function lbe.tg_outbox_audit() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    perform lbe.audit('outbox.enqueued', 'publication_outbox', new.id::text,
                      jsonb_build_object('content_id', new.content_id, 'package_hash', new.package_hash,
                                         'available_at', new.available_at));
  elsif new.status is distinct from old.status then
    perform lbe.audit('outbox.' || new.status, 'publication_outbox', new.id::text,
                      jsonb_build_object('content_id', new.content_id, 'from_status', old.status,
                                         'attempts', new.attempts, 'provider_ref', new.provider_ref,
                                         'last_error', new.last_error));
  end if;
  return null;
end
$$;

create trigger outbox_audit after insert or update on lbe.publication_outbox
  for each row execute function lbe.tg_outbox_audit();

-- ---------------------------------------------------------------------------
-- Claims: verified claims are immutable; status transitions are limited
-- ---------------------------------------------------------------------------
create function lbe.tg_claims_biu() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'claims start as draft and must be verified by an approver' using errcode = 'LBE01';
    end if;
    return new;
  end if;
  if new.statement <> old.statement or new.category <> old.category
     or new.evidence_url is distinct from old.evidence_url or new.evidence_note is distinct from old.evidence_note
     or new.created_by <> old.created_by then
    if old.status <> 'draft' then
      raise exception 'only draft claims can be edited; create a new claim instead' using errcode = 'LBE01';
    end if;
  end if;
  if new.status is distinct from old.status and not ((old.status, new.status) in (
      ('draft', 'verified'), ('draft', 'rejected'), ('verified', 'expired'), ('verified', 'rejected'))) then
    raise exception 'invalid claim transition % -> %', old.status, new.status using errcode = 'LBE01';
  end if;
  return new;
end
$$;

create trigger claims_biu before insert or update on lbe.claims
  for each row execute function lbe.tg_claims_biu();
create trigger claims_no_delete before delete on lbe.claims
  for each row execute function lbe.tg_immutable();

create function lbe.tg_claims_audit() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    perform lbe.audit('claim.created', 'claim', new.id::text, jsonb_build_object('category', new.category));
  elsif new.status is distinct from old.status then
    perform lbe.audit('claim.' || new.status, 'claim', new.id::text, jsonb_build_object('from_status', old.status));
  end if;
  return null;
end
$$;

create trigger claims_audit after insert or update on lbe.claims
  for each row execute function lbe.tg_claims_audit();

-- ---------------------------------------------------------------------------
-- Accounts & control flags
-- ---------------------------------------------------------------------------
create function lbe.tg_accounts_ai() returns trigger
language plpgsql
as $$
begin
  insert into lbe.control_flags(key, stopped, reason) values ('account:' || new.id::text, false, 'account created');
  perform lbe.audit('account.created', 'social_account', new.id::text, jsonb_build_object('kind', new.kind));
  return null;
end
$$;

create trigger accounts_ai after insert on lbe.social_accounts
  for each row execute function lbe.tg_accounts_ai();

create function lbe.tg_accounts_au() returns trigger
language plpgsql
as $$
begin
  if new.kind is distinct from old.kind or new.linkedin_urn is distinct from old.linkedin_urn then
    -- Destination is part of the package: recompute (and invalidate) unpublished, unlocked content.
    update lbe.content_items set updated_at = now()
     where account_id = new.id and status in ('draft', 'in_review', 'changes_requested', 'approved', 'failed');
  end if;
  perform lbe.audit('account.updated', 'social_account', new.id::text,
                    jsonb_build_object('enabled', new.enabled, 'linkedin_urn_changed', new.linkedin_urn is distinct from old.linkedin_urn));
  return null;
end
$$;

create trigger accounts_au after update on lbe.social_accounts
  for each row execute function lbe.tg_accounts_au();

create function lbe.tg_control_flags_audit() returns trigger
language plpgsql
as $$
begin
  perform lbe.audit(case when new.stopped then 'control.stop' else 'control.resume' end, 'control_flag', new.key,
                    jsonb_build_object('reason', new.reason));
  return null;
end
$$;

create trigger control_flags_audit after insert or update on lbe.control_flags
  for each row execute function lbe.tg_control_flags_audit();
create trigger control_flags_no_delete before delete on lbe.control_flags
  for each row execute function lbe.tg_immutable();

insert into lbe.control_flags(key, stopped, reason) values ('global', false, 'initial');

-- ---------------------------------------------------------------------------
-- API operations (lbe_api). Each resolves the user from the session token.
-- ---------------------------------------------------------------------------
create function lbe.create_claim(p_session text, p_statement text, p_category text,
                                 p_evidence_url text, p_evidence_note text, p_expires_at timestamptz)
returns uuid language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_id uuid;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  insert into lbe.claims(statement, category, evidence_url, evidence_note, expires_at, created_by)
  values (p_statement, p_category, nullif(p_evidence_url, ''), nullif(p_evidence_note, ''), p_expires_at, v_user.id)
  returning id into v_id;
  return v_id;
end
$$;

create function lbe.set_claim_status(p_session text, p_claim_id uuid, p_status text) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.require_user(p_session, array['approver', 'admin']);
  if p_status not in ('verified', 'rejected', 'expired') then
    raise exception 'invalid claim status' using errcode = 'LBE02';
  end if;
  update lbe.claims
     set status = p_status,
         verified_by = case when p_status = 'verified' then v_user.id else verified_by end,
         verified_at = case when p_status = 'verified' then now() else verified_at end
   where id = p_claim_id;
  if not found then raise exception 'claim not found' using errcode = 'LBE04'; end if;
end
$$;

create function lbe.create_content(p_session text, p_account_id uuid, p_pillar text, p_brief text,
                                   p_source_material text, p_scheduled_for timestamptz)
returns uuid language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_id uuid;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  if not exists (select 1 from lbe.social_accounts where id = p_account_id and p_pillar = any(pillars)) then
    raise exception 'pillar is not an approved content pillar for this account' using errcode = 'LBE02';
  end if;
  insert into lbe.content_items(account_id, pillar, brief, source_material, scheduled_for, created_by)
  values (p_account_id, p_pillar, p_brief, nullif(p_source_material, ''), p_scheduled_for, v_user.id)
  returning id into v_id;
  return v_id;
end
$$;

-- p_patch keys: body, brief, source_material, pillar, visibility, scheduled_for, media_ids, unsupported_statements
create function lbe.update_content(p_session text, p_content_id uuid, p_patch jsonb) returns lbe.content_items
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_row lbe.content_items; v_account uuid;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  if exists (select 1 from jsonb_object_keys(p_patch) k
              where k not in ('body', 'brief', 'source_material', 'pillar', 'visibility', 'scheduled_for',
                              'media_ids', 'unsupported_statements')) then
    raise exception 'unsupported field in update' using errcode = 'LBE02';
  end if;
  select account_id into v_account from lbe.content_items where id = p_content_id;
  if not found then raise exception 'content not found' using errcode = 'LBE04'; end if;
  if p_patch ? 'pillar' and not exists (select 1 from lbe.social_accounts
                                         where id = v_account and (p_patch->>'pillar') = any(pillars)) then
    raise exception 'pillar is not an approved content pillar for this account' using errcode = 'LBE02';
  end if;
  update lbe.content_items set
    body = case when p_patch ? 'body' then coalesce(p_patch->>'body', '') else body end,
    brief = case when p_patch ? 'brief' then p_patch->>'brief' else brief end,
    source_material = case when p_patch ? 'source_material' then nullif(p_patch->>'source_material', '') else source_material end,
    pillar = case when p_patch ? 'pillar' then p_patch->>'pillar' else pillar end,
    visibility = case when p_patch ? 'visibility' then p_patch->>'visibility' else visibility end,
    scheduled_for = case when p_patch ? 'scheduled_for' then (p_patch->>'scheduled_for')::timestamptz else scheduled_for end,
    media_ids = case when p_patch ? 'media_ids'
                     then array(select jsonb_array_elements_text(p_patch->'media_ids')) else media_ids end,
    unsupported_statements = case when p_patch ? 'unsupported_statements'
                                  then p_patch->'unsupported_statements' else unsupported_statements end
  where id = p_content_id
  returning * into v_row;
  return v_row;
end
$$;

-- Store an AI (or human) draft: body, claim citations and unsupported statements, atomically.
create function lbe.set_draft_output(p_session text, p_content_id uuid, p_body text, p_citations jsonb,
                                     p_unsupported jsonb)
returns lbe.content_items language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_row lbe.content_items; v_cite jsonb;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  select * into v_row from lbe.content_items where id = p_content_id for update;
  if not found then raise exception 'content not found' using errcode = 'LBE04'; end if;
  if v_row.status in ('queued', 'published', 'needs_reconciliation', 'rejected') then
    raise exception 'content is locked in status %', v_row.status using errcode = 'LBE01';
  end if;
  if jsonb_typeof(p_citations) <> 'array' or jsonb_typeof(p_unsupported) <> 'array' then
    raise exception 'citations and unsupported statements must be arrays' using errcode = 'LBE02';
  end if;
  delete from lbe.content_claims where content_id = p_content_id;
  for v_cite in select * from jsonb_array_elements(p_citations) loop
    if not exists (select 1 from lbe.claims c where c.id = (v_cite->>'claim_id')::uuid and c.status = 'verified'
                     and (c.expires_at is null or c.expires_at > now())) then
      raise exception 'citation references a claim that is not verified' using errcode = 'LBE02';
    end if;
    insert into lbe.content_claims(content_id, claim_id, quoted_span)
    values (p_content_id, (v_cite->>'claim_id')::uuid, v_cite->>'quoted_span');
  end loop;
  update lbe.content_items set body = coalesce(p_body, ''), unsupported_statements = p_unsupported
   where id = p_content_id returning * into v_row;
  return v_row;
end
$$;

create function lbe.record_agent_run(p_session text, p_run jsonb) returns uuid
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_id uuid;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  insert into lbe.agent_runs(purpose, provider, model, prompt_version, content_id, input_refs, output, status,
                             error, input_tokens, output_tokens, requested_by, started_at)
  values (p_run->>'purpose', p_run->>'provider', p_run->>'model', p_run->>'prompt_version',
          (p_run->>'content_id')::uuid, coalesce(p_run->'input_refs', '{}'::jsonb), p_run->'output',
          p_run->>'status', p_run->>'error', (p_run->>'input_tokens')::int, (p_run->>'output_tokens')::int,
          v_user.id, (p_run->>'started_at')::timestamptz)
  returning id into v_id;
  perform lbe.audit('ai.' || (p_run->>'purpose'), 'content_item', p_run->>'content_id',
                    jsonb_build_object('agent_run_id', v_id, 'status', p_run->>'status', 'provider', p_run->>'provider'));
  return v_id;
end
$$;

create function lbe.submit_for_review(p_session text, p_content_id uuid) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
begin
  perform lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  update lbe.content_items set status = 'in_review' where id = p_content_id;
  if not found then raise exception 'content not found' using errcode = 'LBE04'; end if;
end
$$;

create function lbe.decide_content(p_session text, p_content_id uuid, p_expected_hash text,
                                   p_decision text, p_note text)
returns uuid language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_id uuid;
begin
  v_user := lbe.require_user(p_session, array['approver', 'admin']);
  if p_decision not in ('approved', 'rejected', 'changes_requested') then
    raise exception 'invalid decision' using errcode = 'LBE02';
  end if;
  if p_decision <> 'approved' and coalesce(length(trim(p_note)), 0) = 0 then
    raise exception 'a note is required when rejecting or requesting changes' using errcode = 'LBE02';
  end if;
  perform 1 from lbe.content_items where id = p_content_id for update;
  if not found then raise exception 'content not found' using errcode = 'LBE04'; end if;
  insert into lbe.content_approvals(content_id, decision, package_hash, package, approver_id, note)
  values (p_content_id, p_decision, p_expected_hash, '{}'::jsonb, v_user.id, p_note)
  returning id into v_id;
  update lbe.content_items set status = p_decision where id = p_content_id;
  return v_id;
end
$$;

create function lbe.enqueue_publication(p_session text, p_content_id uuid) returns uuid
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_content lbe.content_items; v_latest lbe.content_approvals; v_id uuid;
begin
  v_user := lbe.require_user(p_session, array['approver', 'admin']);
  select * into v_content from lbe.content_items where id = p_content_id for update;
  if not found then raise exception 'content not found' using errcode = 'LBE04'; end if;
  if not exists (select 1 from lbe.account_approvers where account_id = v_content.account_id and user_id = v_user.id) then
    raise exception 'user is not an approver for this account' using errcode = 'LBE11';
  end if;
  v_latest := lbe.latest_decision(p_content_id);
  insert into lbe.publication_outbox(content_id, account_id, approval_id, package, package_hash,
                                     idempotency_key, available_at)
  values (p_content_id, v_content.account_id, v_latest.id, '{}'::jsonb, '', 'pending',
          greatest(coalesce(v_content.scheduled_for, now()), now()))
  returning id into v_id;
  update lbe.content_items set status = 'queued' where id = p_content_id;
  return v_id;
end
$$;

create function lbe.cancel_publication(p_session text, p_outbox_id uuid) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_ob lbe.publication_outbox;
begin
  v_user := lbe.require_user(p_session, array['approver', 'admin']);
  select * into v_ob from lbe.publication_outbox where id = p_outbox_id for update;
  if not found then raise exception 'outbox entry not found' using errcode = 'LBE04'; end if;
  update lbe.publication_outbox set status = 'cancelled' where id = p_outbox_id;
  update lbe.content_items set status = 'approved' where id = v_ob.content_id;
end
$$;

-- Resolve an ambiguous publication after a human checked LinkedIn (or the mock store).
create function lbe.reconcile_publication(p_session text, p_outbox_id uuid, p_resolution text,
                                          p_provider_ref text, p_note text)
returns void language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_ob lbe.publication_outbox;
begin
  v_user := lbe.require_user(p_session, array['admin']);
  select * into v_ob from lbe.publication_outbox where id = p_outbox_id for update;
  if not found then raise exception 'outbox entry not found' using errcode = 'LBE04'; end if;
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

create function lbe.set_stop(p_session text, p_key text, p_stopped boolean, p_reason text) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  -- Anyone who can work on content may STOP; only an admin may resume.
  if p_stopped then
    v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  else
    v_user := lbe.require_user(p_session, array['admin']);
  end if;
  if coalesce(length(trim(p_reason)), 0) = 0 then
    raise exception 'a reason is required' using errcode = 'LBE02';
  end if;
  update lbe.control_flags set stopped = p_stopped, reason = p_reason, changed_by = v_user.id, changed_at = now()
   where key = p_key;
  if not found then raise exception 'unknown control flag' using errcode = 'LBE04'; end if;
end
$$;

create function lbe.write_app_audit(p_session text, p_action text, p_subject_type text, p_subject_id text,
                                    p_details jsonb)
returns void language plpgsql security definer set search_path = lbe, pg_temp
as $$
begin
  perform lbe.require_user(p_session, array['viewer', 'editor', 'approver', 'admin']);
  if p_action !~ '^app\.[a-z_.]{1,60}$' then
    raise exception 'app audit actions must start with app.' using errcode = 'LBE02';
  end if;
  perform lbe.audit(p_action, p_subject_type, p_subject_id, p_details);
end
$$;

-- ---------------------------------------------------------------------------
-- Worker operations (lbe_worker)
-- ---------------------------------------------------------------------------
create function lbe.claim_outbox(p_worker text, p_limit int, p_lease_seconds int)
returns setof lbe.publication_outbox
language plpgsql security definer set search_path = lbe, pg_temp
as $$
begin
  perform set_config('lbe.actor', 'worker:' || p_worker, true);
  return query
  with due as (
    select o.id from lbe.publication_outbox o
     where o.status = 'pending' and o.available_at <= now() and not lbe.is_stopped(o.account_id)
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

-- p_outcome: success | retryable | rejected | ambiguous | released
create function lbe.complete_outbox(p_outbox_id uuid, p_worker text, p_outcome text, p_provider_ref text,
                                    p_error text, p_retry_after_seconds int)
returns lbe.publication_outbox
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_ob lbe.publication_outbox; v_delay int;
begin
  perform set_config('lbe.actor', 'worker:' || p_worker, true);
  select * into v_ob from lbe.publication_outbox where id = p_outbox_id for update;
  if not found then raise exception 'outbox entry not found' using errcode = 'LBE04'; end if;

  -- A late success after the lease expired is still recorded (it resolves the ambiguity).
  if v_ob.status = 'needs_reconciliation' and p_outcome = 'success' then
    null;
  elsif v_ob.status <> 'dispatching' or v_ob.lease_owner is distinct from p_worker then
    raise exception 'outbox entry is not leased by this worker' using errcode = 'LBE01';
  end if;

  if p_outcome = 'success' then
    update lbe.publication_outbox set status = 'succeeded', provider_ref = p_provider_ref, last_error = null
     where id = p_outbox_id returning * into v_ob;
    update lbe.content_items set status = 'published', provider_post_ref = p_provider_ref, published_at = now()
     where id = v_ob.content_id;
  elsif p_outcome = 'released' then
    update lbe.publication_outbox set status = 'pending', attempts = greatest(attempts - 1, 0),
           lease_owner = null, lease_expires_at = null, last_error = coalesce(p_error, 'released before send')
     where id = p_outbox_id returning * into v_ob;
  elsif p_outcome = 'retryable' then
    if v_ob.attempts >= v_ob.max_attempts then
      update lbe.publication_outbox set status = 'failed', last_error = p_error where id = p_outbox_id returning * into v_ob;
      update lbe.content_items set status = 'failed' where id = v_ob.content_id;
    else
      v_delay := greatest(coalesce(p_retry_after_seconds, 0), (30 * power(2, v_ob.attempts - 1))::int);
      update lbe.publication_outbox set status = 'pending', lease_owner = null, lease_expires_at = null,
             available_at = now() + make_interval(secs => least(v_delay, 3600)), last_error = p_error
       where id = p_outbox_id returning * into v_ob;
    end if;
  elsif p_outcome = 'rejected' then
    update lbe.publication_outbox set status = 'failed', last_error = p_error where id = p_outbox_id returning * into v_ob;
    update lbe.content_items set status = 'failed' where id = v_ob.content_id;
  elsif p_outcome = 'ambiguous' then
    update lbe.publication_outbox set status = 'needs_reconciliation', last_error = p_error, lease_owner = null,
           lease_expires_at = null
     where id = p_outbox_id returning * into v_ob;
    update lbe.content_items set status = 'needs_reconciliation' where id = v_ob.content_id;
  else
    raise exception 'invalid outcome %', p_outcome using errcode = 'LBE02';
  end if;
  return v_ob;
end
$$;

-- A dispatch whose lease expired may or may not have reached the provider: never retry automatically.
create function lbe.expire_stale_dispatches(p_worker text) returns int
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_row record; v_count int := 0;
begin
  perform set_config('lbe.actor', 'worker:' || p_worker, true);
  for v_row in select id, content_id from lbe.publication_outbox
                where status = 'dispatching' and lease_expires_at < now() for update skip locked loop
    update lbe.publication_outbox set status = 'needs_reconciliation', lease_owner = null, lease_expires_at = null,
           last_error = 'lease expired while dispatching: outcome unknown'
     where id = v_row.id;
    update lbe.content_items set status = 'needs_reconciliation' where id = v_row.content_id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;
