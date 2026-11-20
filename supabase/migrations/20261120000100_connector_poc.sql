-- P11-01a (ADR-036): read-only Claude connector, proof of concept.
-- A "connector" key lets the local MCP bridge used by Claude Desktop call exactly ONE database function,
-- lbe.connector_brain_get, as the lbe_agent role. An admin creates it in the dashboard. It lasts at most 8
-- hours, can be revoked at any time, and every call is audited. No other function accepts it.

alter table lbe.sessions drop constraint sessions_kind_check;
alter table lbe.sessions add constraint sessions_kind_check check (kind in ('interactive', 'agent_job', 'connector'));

-- Existing functions accept interactive sessions, and job sessions where allowed. Previously "allow job" meant
-- "any non-interactive kind"; it now names the kind, so a connector key is refused everywhere else.
create or replace function lbe.session_resolve(p_session text, p_allow_job boolean) returns lbe.app_users
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
     and (s.kind = 'interactive' or (p_allow_job and s.kind = 'agent_job'))
     and not u.disabled;
  if v_sid is null then return null; end if;
  if v_seen < now() - interval '1 minute' then
    update lbe.sessions set last_seen_at = now() where id = v_sid;
  end if;
  select * into v_user from lbe.app_users where id = v_uid;
  return v_user;
end
$$;

-- Admin: create a connector key (1-8 hours). One active key per person; a new one ends the previous one.
create function lbe.connector_create(p_session text, p_hours int default 8) returns jsonb
language plpgsql security definer set search_path = lbe, extensions, public, pg_temp
as $$
declare v_user lbe.app_users; v_token text; v_id uuid; v_exp timestamptz;
begin
  v_user := lbe.require_user(p_session, array['admin']);
  if p_hours is null or p_hours not between 1 and 8 then
    raise exception 'a connector key lasts 1 to 8 hours' using errcode = 'LBE02';
  end if;
  update lbe.sessions set revoked_at = now() where user_id = v_user.id and kind = 'connector' and revoked_at is null;
  v_token := encode(gen_random_bytes(32), 'hex');
  v_exp := now() + make_interval(hours => p_hours);
  insert into lbe.sessions(user_id, token_hash, expires_at, kind)
  values (v_user.id, lbe.hash_text(v_token), v_exp, 'connector') returning id into v_id;
  perform lbe.audit('connector.key_created', 'app_user', v_user.id::text,
                    jsonb_build_object('key_id', v_id, 'hours', p_hours, 'scope', 'read:brand_brain'));
  return jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', v_exp);
end
$$;

-- Admin: end every connector key in the organization.
create function lbe.connector_revoke_all(p_session text) returns int
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_n int;
begin
  v_user := lbe.require_user(p_session, array['admin']);
  with r as (
    update lbe.sessions s set revoked_at = now()
      from lbe.app_users u
     where u.id = s.user_id and u.organization_id = v_user.organization_id
       and s.kind = 'connector' and s.revoked_at is null
    returning s.id)
  select count(*)::int into v_n from r;
  perform lbe.audit('connector.keys_revoked', 'app_user', v_user.id::text, jsonb_build_object('count', v_n));
  return v_n;
end
$$;

-- Admin: active connector keys (never the token) and the latest calls, for the dashboard.
create function lbe.connector_status(p_session text) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.require_user(p_session, array['admin']);
  return jsonb_build_object(
    'keys', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'user', u.display_name, 'created_at', s.created_at,
                        'expires_at', s.expires_at, 'last_used_at', s.last_seen_at) order by s.created_at desc)
                      from lbe.sessions s join lbe.app_users u on u.id = s.user_id
                     where u.organization_id = v_user.organization_id and s.kind = 'connector'
                       and s.revoked_at is null and s.expires_at > now()), '[]'::jsonb),
    'recent_calls', coalesce((select jsonb_agg(c order by c->>'at' desc) from (
                        select jsonb_build_object('at', a.at, 'action', a.action, 'details', a.details) as c
                          from lbe.audit_events a
                         where a.organization_id = v_user.organization_id and a.action like 'connector.%'
                         order by a.at desc limit 10) x), '[]'::jsonb));
end
$$;

-- The bridge's only function (lbe_agent role): approved Brand Brain entries of the key owner's organization.
-- Read-only; the visual identity entry (logo data) is left out; every call is audited.
create function lbe.connector_brain_get(p_token text) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_sid uuid; v_user lbe.app_users; v_entries jsonb; v_n int;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'not authenticated' using errcode = 'LBE10';
  end if;
  select s.id into v_sid from lbe.sessions s join lbe.app_users u on u.id = s.user_id
   where s.token_hash = lbe.hash_text(p_token) and s.kind = 'connector'
     and s.revoked_at is null and s.expires_at > now() and not u.disabled;
  if v_sid is null then raise exception 'not authenticated' using errcode = 'LBE10'; end if;
  select u.* into v_user from lbe.sessions s join lbe.app_users u on u.id = s.user_id where s.id = v_sid;
  perform set_config('lbe.actor', 'connector:' || v_user.id::text, true);
  perform set_config('lbe.org', v_user.organization_id::text, true);
  update lbe.sessions set last_seen_at = now() where id = v_sid;
  select coalesce(jsonb_agg(jsonb_build_object('section', e.section, 'key', e.key, 'title', e.title, 'body', e.body,
                    'version', e.version, 'approved_at', e.approved_at) order by e.section, e.key), '[]'::jsonb),
         count(*)::int
    into v_entries, v_n
    from lbe.brand_entries e
   where e.organization_id = v_user.organization_id and e.status = 'approved'
     and not (e.section = 'identity' and e.key = 'visual');
  perform lbe.audit('connector.tool_called', 'app_user', v_user.id::text,
                    jsonb_build_object('key_id', v_sid, 'tool', 'get_brand_brain', 'entries', v_n));
  return jsonb_build_object('organization', (select name from lbe.organizations where id = v_user.organization_id),
                            'entries', v_entries, 'count', v_n, 'read_at', now());
end
$$;

revoke all on function lbe.connector_create(text, int), lbe.connector_revoke_all(text), lbe.connector_status(text),
                       lbe.connector_brain_get(text) from public;
grant execute on function lbe.connector_create(text, int), lbe.connector_revoke_all(text), lbe.connector_status(text) to lbe_api;
grant execute on function lbe.connector_brain_get(text) to lbe_agent;
