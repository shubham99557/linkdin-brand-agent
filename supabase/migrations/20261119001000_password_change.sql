-- P1-06 (finding F-2): self-service password change, and "must change temporary password".
-- Users created or reset by an admin in the app must choose their own password before doing anything else. This
-- is enforced in the database: require_user refuses every action for such a user except changing the password.
-- Operator-created users (CLI) choose their own password, so they are not flagged.

alter table lbe.app_users add column must_change_password boolean not null default false;

-- Core identity check. p_allow_pw_change lets change_password run for a user who must change their password.
create function lbe.require_user_core(p_session text, p_roles text[], p_allow_pw_change boolean) returns lbe.app_users
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.session_user_touch(p_session);
  if v_user.id is null then
    raise exception 'not authenticated' using errcode = 'LBE10';
  end if;
  if v_user.must_change_password and not p_allow_pw_change then
    raise exception 'choose a new password before continuing' using errcode = 'LBE12';
  end if;
  if not (v_user.role = any(p_roles)) then
    raise exception 'role % may not perform this action', v_user.role using errcode = 'LBE11';
  end if;
  perform set_config('lbe.actor', 'user:' || v_user.id::text, true);
  perform set_config('lbe.org', v_user.organization_id::text, true);
  return v_user;
end
$$;

create or replace function lbe.require_user(p_session text, p_roles text[]) returns lbe.app_users
language sql security definer set search_path = lbe, pg_temp
as $$ select lbe.require_user_core(p_session, p_roles, false) $$;

-- whoami reports the flag so the dashboard can show the change-password screen.
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
                            'must_change_password', v_user.must_change_password,
                            'approver_for', coalesce((select jsonb_agg(aa.account_id) from lbe.account_approvers aa where aa.user_id = v_user.id), '[]'::jsonb));
end
$$;

-- Change your own password. Wrong current password counts towards lockout; 5 failures end all of the user's
-- sessions (a stolen session cannot be used to guess the password). On success all OTHER sessions end.
create function lbe.change_password(p_session text, p_current text, p_new text) returns jsonb
language plpgsql security definer set search_path = lbe, extensions, public, pg_temp
as $$
declare v_user lbe.app_users; v_n int;
begin
  v_user := lbe.require_user_core(p_session, array['admin', 'approver', 'editor', 'viewer'], true);
  if crypt(coalesce(p_current, ''), v_user.password_hash) <> v_user.password_hash then
    update lbe.app_users
       set failed_logins = case when failed_logins + 1 >= 5 then 0 else failed_logins + 1 end,
           locked_until  = case when failed_logins + 1 >= 5 then now() + interval '15 minutes' else locked_until end
     where id = v_user.id
    returning locked_until into v_user.locked_until;
    if v_user.locked_until is not null and v_user.locked_until > now() then
      perform lbe.revoke_user_sessions(v_user.id);
    end if;
    perform lbe.audit('auth.password_change_failed', 'app_user', v_user.id::text);
    return jsonb_build_object('ok', false, 'error', 'current password is incorrect');
  end if;
  if p_new is null or length(p_new) < 12 then
    raise exception 'new password must be at least 12 characters' using errcode = 'LBE02';
  end if;
  if octet_length(p_new) > 72 then
    raise exception 'new password must be at most 72 bytes' using errcode = 'LBE02';
  end if;
  if p_new = p_current then
    raise exception 'new password must be different from the current one' using errcode = 'LBE02';
  end if;
  update lbe.app_users
     set password_hash = crypt(p_new, gen_salt('bf', 12)), must_change_password = false, failed_logins = 0, locked_until = null
   where id = v_user.id;
  update lbe.sessions set revoked_at = now()
   where user_id = v_user.id and revoked_at is null and token_hash <> lbe.hash_text(p_session);
  get diagnostics v_n = row_count;
  perform lbe.audit('auth.password_changed', 'app_user', v_user.id::text, jsonb_build_object('other_sessions_ended', v_n));
  return jsonb_build_object('ok', true, 'other_sessions_ended', v_n);
end
$$;

-- Admin-issued passwords are temporary.
create or replace function lbe.admin_add_user(p_session text, p_email text, p_display_name text, p_role text, p_password text) returns uuid
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_admin lbe.app_users; v_id uuid;
begin
  v_admin := lbe.require_user(p_session, array['admin']);
  if p_role not in ('admin', 'approver', 'editor', 'viewer') then
    raise exception 'unknown role' using errcode = 'LBE02';
  end if;
  if p_display_name is null or length(trim(p_display_name)) not between 1 and 120 then
    raise exception 'name must be 1-120 characters' using errcode = 'LBE02';
  end if;
  if p_email is null or lower(trim(p_email)) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email address' using errcode = 'LBE02';
  end if;
  v_id := lbe.admin_create_user(p_email, trim(p_display_name), p_role, p_password, v_admin.organization_id);
  update lbe.app_users set must_change_password = true where id = v_id;
  return v_id;
end
$$;

create or replace function lbe.admin_reset_password(p_session text, p_user uuid, p_password text) returns void
language plpgsql security definer set search_path = lbe, extensions, public, pg_temp
as $$
declare v_admin lbe.app_users; v_t lbe.app_users; v_n int;
begin
  v_admin := lbe.require_user(p_session, array['admin']);
  v_t := lbe.admin_target(v_admin, p_user);
  if p_password is null or length(p_password) < 12 then
    raise exception 'password must be at least 12 characters' using errcode = 'LBE02';
  end if;
  if octet_length(p_password) > 72 then
    raise exception 'password must be at most 72 bytes' using errcode = 'LBE02';
  end if;
  update lbe.app_users
     set password_hash = crypt(p_password, gen_salt('bf', 12)), failed_logins = 0, locked_until = null, must_change_password = true
   where id = v_t.id;
  v_n := lbe.revoke_user_sessions(v_t.id);
  perform lbe.audit('user.password_reset', 'app_user', v_t.id::text, jsonb_build_object('sessions_revoked', v_n));
end
$$;

revoke execute on function lbe.require_user_core(text, text[], boolean), lbe.change_password(text, text, text) from public;
grant execute on function lbe.change_password(text, text, text) to lbe_api;
