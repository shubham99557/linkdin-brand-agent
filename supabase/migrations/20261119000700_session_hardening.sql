-- P1-02 Session hardening: idle timeout and "sign out everywhere".
-- Sessions now also end after lbe.session_idle_timeout() without activity (12 h absolute limit unchanged).
-- Activity is recorded at most once a minute per session to keep writes low.

alter table lbe.sessions add column last_seen_at timestamptz not null default now();

create function lbe.session_idle_timeout() returns interval language sql immutable as $$ select interval '60 minutes' $$;

-- Resolves a live session (not revoked, not expired, not idle, user enabled) and records activity.
-- Internal helper: no application role may call it directly.
create function lbe.session_user_touch(p_session text) returns lbe.app_users
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_sid uuid; v_seen timestamptz; v_uid uuid; v_user lbe.app_users;
begin
  if p_session is null or length(p_session) < 32 then return null; end if;
  select s.id, s.last_seen_at, s.user_id into v_sid, v_seen, v_uid
    from lbe.sessions s join lbe.app_users u on u.id = s.user_id
   where s.token_hash = lbe.hash_text(p_session)
     and s.revoked_at is null and s.expires_at > now()
     and s.last_seen_at > now() - lbe.session_idle_timeout()
     and not u.disabled;
  if v_sid is null then return null; end if;
  if v_seen < now() - interval '1 minute' then
    update lbe.sessions set last_seen_at = now() where id = v_sid;
  end if;
  select * into v_user from lbe.app_users where id = v_uid;
  return v_user;
end
$$;

create or replace function lbe.require_user(p_session text, p_roles text[]) returns lbe.app_users
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.session_user_touch(p_session);
  if v_user.id is null then
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

-- whoami becomes volatile (it records activity); same result shape as 0500.
create or replace function lbe.whoami(p_session text) returns jsonb
language plpgsql volatile security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.session_user_touch(p_session);
  if v_user.id is null then return null; end if;
  return jsonb_build_object('id', v_user.id, 'email', v_user.email, 'display_name', v_user.display_name, 'role', v_user.role,
                            'organization_id', v_user.organization_id,
                            'organization_name', (select name from lbe.organizations o where o.id = v_user.organization_id),
                            'approver_for', coalesce((select jsonb_agg(aa.account_id) from lbe.account_approvers aa where aa.user_id = v_user.id), '[]'::jsonb));
end
$$;

-- Sign out everywhere: revokes every live session of the calling user (including this one).
create function lbe.logout_all(p_session text) returns int
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_n int;
begin
  v_user := lbe.require_user(p_session, array['admin', 'approver', 'editor', 'viewer']);
  update lbe.sessions set revoked_at = now() where user_id = v_user.id and revoked_at is null;
  get diagnostics v_n = row_count;
  perform lbe.audit('auth.logout_all', 'app_user', v_user.id::text, jsonb_build_object('sessions_revoked', v_n));
  return v_n;
end
$$;

-- Purge also removes long-idle sessions.
create or replace function lbe.purge_expired_sessions() returns int
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_n int;
begin
  delete from lbe.sessions
   where expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days'
      or last_seen_at < now() - lbe.session_idle_timeout() - interval '7 days';
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

revoke execute on function lbe.session_idle_timeout() from public;
revoke execute on function lbe.session_user_touch(text) from public;
revoke execute on function lbe.logout_all(text) from public;
grant execute on function lbe.logout_all(text) to lbe_api;
