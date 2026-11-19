-- P1-03 Admin user management (organization-scoped, admin-only, audited).
-- Users of other organizations are reported as "not found". Safety rules:
--   * an admin cannot change their own role or disable themselves (ask another admin);
--   * the organization always keeps at least one enabled admin;
--   * disabling a user or resetting their password ends all their sessions;
--   * only approver/admin users can be account approvers; demoting a user removes their approver assignments.

create function lbe.admin_target(p_admin lbe.app_users, p_user uuid) returns lbe.app_users
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_t lbe.app_users;
begin
  select * into v_t from lbe.app_users where id = p_user;
  if not found then raise exception 'not found' using errcode = 'LBE04'; end if;
  perform lbe.assert_org(p_admin, v_t.organization_id);
  return v_t;
end
$$;

create function lbe.revoke_user_sessions(p_user uuid) returns int
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_n int;
begin
  update lbe.sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

create function lbe.admin_list_users(p_session text) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_admin lbe.app_users;
begin
  v_admin := lbe.require_user(p_session, array['admin']);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', u.id, 'email', u.email, 'display_name', u.display_name, 'role', u.role, 'disabled', u.disabled,
             'locked', u.locked_until is not null and u.locked_until > now(), 'created_at', u.created_at,
             'is_me', u.id = v_admin.id,
             'approver_for', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'display_name', a.display_name) order by a.display_name)
                                         from lbe.account_approvers aa join lbe.social_accounts a on a.id = aa.account_id
                                        where aa.user_id = u.id), '[]'::jsonb),
             'active_sessions', (select count(*) from lbe.sessions s where s.user_id = u.id and s.revoked_at is null
                                    and s.expires_at > now() and s.last_seen_at > now() - lbe.session_idle_timeout()),
             'last_seen_at', (select max(s.last_seen_at) from lbe.sessions s where s.user_id = u.id))
           order by u.disabled, u.display_name)
      from lbe.app_users u where u.organization_id = v_admin.organization_id), '[]'::jsonb);
end
$$;

create function lbe.admin_add_user(p_session text, p_email text, p_display_name text, p_role text, p_password text) returns uuid
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_admin lbe.app_users;
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
  return lbe.admin_create_user(p_email, trim(p_display_name), p_role, p_password, v_admin.organization_id);
end
$$;

-- NULL arguments mean "leave unchanged".
create function lbe.admin_update_user(p_session text, p_user uuid, p_role text, p_disabled boolean, p_display_name text) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_admin lbe.app_users; v_t lbe.app_users; v_role text; v_disabled boolean; v_sessions int := 0; v_removed int := 0;
begin
  v_admin := lbe.require_user(p_session, array['admin']);
  v_t := lbe.admin_target(v_admin, p_user);
  v_role := coalesce(p_role, v_t.role);
  v_disabled := coalesce(p_disabled, v_t.disabled);
  if v_role not in ('admin', 'approver', 'editor', 'viewer') then
    raise exception 'unknown role' using errcode = 'LBE02';
  end if;
  if p_display_name is not null and length(trim(p_display_name)) not between 1 and 120 then
    raise exception 'name must be 1-120 characters' using errcode = 'LBE02';
  end if;
  if v_t.id = v_admin.id and (v_role <> v_t.role or v_disabled) then
    raise exception 'you cannot change your own role or disable yourself — ask another admin' using errcode = 'LBE11';
  end if;
  if v_t.role = 'admin' and not v_t.disabled and (v_role <> 'admin' or v_disabled)
     and not exists (select 1 from lbe.app_users where organization_id = v_t.organization_id and role = 'admin'
                        and not disabled and id <> v_t.id) then
    raise exception 'the organization must keep at least one enabled admin' using errcode = 'LBE01';
  end if;

  update lbe.app_users
     set role = v_role, disabled = v_disabled,
         display_name = coalesce(nullif(trim(p_display_name), ''), display_name)
   where id = v_t.id;
  if v_disabled and not v_t.disabled then
    v_sessions := lbe.revoke_user_sessions(v_t.id);
  end if;
  if v_role in ('editor', 'viewer') then
    delete from lbe.account_approvers where user_id = v_t.id;
    get diagnostics v_removed = row_count;
  end if;
  perform lbe.audit('user.updated', 'app_user', v_t.id::text, jsonb_build_object(
    'role', jsonb_build_object('from', v_t.role, 'to', v_role),
    'disabled', jsonb_build_object('from', v_t.disabled, 'to', v_disabled),
    'display_name_changed', p_display_name is not null and trim(p_display_name) <> v_t.display_name,
    'sessions_revoked', v_sessions, 'approver_assignments_removed', v_removed));
  return jsonb_build_object('ok', true, 'sessions_revoked', v_sessions, 'approver_assignments_removed', v_removed);
end
$$;

create function lbe.admin_set_approver(p_session text, p_user uuid, p_account uuid, p_approver boolean) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_admin lbe.app_users; v_t lbe.app_users; v_org uuid;
begin
  v_admin := lbe.require_user(p_session, array['admin']);
  v_t := lbe.admin_target(v_admin, p_user);
  select organization_id into v_org from lbe.social_accounts where id = p_account;
  perform lbe.assert_org(v_admin, v_org);
  if p_approver then
    if v_t.disabled or v_t.role not in ('approver', 'admin') then
      raise exception 'only enabled approvers or admins can approve posts — change the role first' using errcode = 'LBE02';
    end if;
    insert into lbe.account_approvers(account_id, user_id) values (p_account, p_user) on conflict do nothing;
  else
    delete from lbe.account_approvers where account_id = p_account and user_id = p_user;
  end if;
  perform lbe.audit(case when p_approver then 'user.approver_added' else 'user.approver_removed' end,
                    'social_account', p_account::text, jsonb_build_object('user_id', p_user));
end
$$;

create function lbe.admin_end_sessions(p_session text, p_user uuid) returns int
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_admin lbe.app_users; v_t lbe.app_users; v_n int;
begin
  v_admin := lbe.require_user(p_session, array['admin']);
  v_t := lbe.admin_target(v_admin, p_user);
  v_n := lbe.revoke_user_sessions(v_t.id);
  perform lbe.audit('user.sessions_ended', 'app_user', v_t.id::text, jsonb_build_object('sessions_revoked', v_n));
  return v_n;
end
$$;

-- Without email, an admin-set temporary password is the recovery path. Ends the user's sessions and clears lockout.
create function lbe.admin_reset_password(p_session text, p_user uuid, p_password text) returns void
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
  update lbe.app_users set password_hash = crypt(p_password, gen_salt('bf', 12)), failed_logins = 0, locked_until = null
   where id = v_t.id;
  v_n := lbe.revoke_user_sessions(v_t.id);
  perform lbe.audit('user.password_reset', 'app_user', v_t.id::text, jsonb_build_object('sessions_revoked', v_n));
end
$$;

revoke execute on function lbe.admin_target(lbe.app_users, uuid), lbe.revoke_user_sessions(uuid),
  lbe.admin_list_users(text), lbe.admin_add_user(text, text, text, text, text),
  lbe.admin_update_user(text, uuid, text, boolean, text), lbe.admin_set_approver(text, uuid, uuid, boolean),
  lbe.admin_end_sessions(text, uuid), lbe.admin_reset_password(text, uuid, text) from public;
grant execute on function lbe.admin_list_users(text), lbe.admin_add_user(text, text, text, text, text),
  lbe.admin_update_user(text, uuid, text, boolean, text), lbe.admin_set_approver(text, uuid, uuid, boolean),
  lbe.admin_end_sessions(text, uuid), lbe.admin_reset_password(text, uuid, text) to lbe_api;
