-- P5-04 Draft revisions & history. Every version of a post's publication package (text, visual, visibility,
-- schedule, cited claims) is kept, immutably, with who made it and through which role (human dashboard vs agent).
-- Written by the database itself, so no code path can change a post without leaving a revision behind.

create table lbe.content_revisions (
  id               bigint generated always as identity primary key,
  content_id       uuid not null references lbe.content_items(id),
  organization_id  uuid not null references lbe.organizations(id),
  version          int not null,
  package          jsonb not null,
  package_hash     text not null,
  brief            text not null,
  actor            text not null,          -- user:<uuid> | system:… | migration:…
  via              text,                   -- database role of the caller: lbe_api (dashboard) | lbe_agent (agent) | …
  created_at       timestamptz not null default clock_timestamp(),
  unique (content_id, version)
);
alter table lbe.content_revisions enable row level security;   -- no policies: definer functions only

create function lbe.tg_content_revisions_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'revisions are immutable' using errcode = 'LBE01';
end $$;
create trigger content_revisions_immutable before update or delete on lbe.content_revisions
  for each row execute function lbe.tg_content_revisions_immutable();

create function lbe.tg_content_items_revision() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.package_hash is distinct from old.package_hash then
    insert into lbe.content_revisions(content_id, organization_id, version, package, package_hash, brief, actor, via)
    values (new.id, (select organization_id from lbe.social_accounts where id = new.account_id), new.version,
            new.package, new.package_hash, new.brief, lbe.actor(), nullif(current_setting('role', true), 'none'));
  end if;
  return null;
end $$;
create trigger content_items_revision after insert or update on lbe.content_items
  for each row execute function lbe.tg_content_items_revision();

-- Starting point for posts that existed before history was recorded.
insert into lbe.content_revisions(content_id, organization_id, version, package, package_hash, brief, actor, via, created_at)
select c.id, a.organization_id, c.version, c.package, c.package_hash, c.brief, 'migration:history-start', null, c.updated_at
  from lbe.content_items c join lbe.social_accounts a on a.id = c.account_id;

create function lbe.content_history(p_session text, p_content_id uuid) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_current text;
begin
  v_user := lbe.require_user(p_session, array['viewer', 'editor', 'approver', 'admin']);
  perform lbe.assert_org(v_user, lbe.content_org(p_content_id));
  select package_hash into v_current from lbe.content_items where id = p_content_id;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'version', r.version, 'created_at', r.created_at, 'package_hash', r.package_hash, 'is_current', r.package_hash = v_current,
      'actor', r.actor, 'via', r.via,
      'actor_name', case when r.actor like 'user:%'
                         then (select display_name from lbe.app_users where id::text = substr(r.actor, 6))
                         else r.actor end,
      'brief', r.brief,
      'body', r.package->>'body', 'visibility', r.package->>'visibility', 'scheduled_for', r.package->>'scheduled_for',
      'media_ids', r.package->'media_ids', 'claim_ids', r.package->'claim_ids',
      'decisions', coalesce((select jsonb_agg(jsonb_build_object('decision', ca.decision, 'note', ca.note, 'created_at', ca.created_at,
                     'approver_name', (select display_name from lbe.app_users where id = ca.approver_id)) order by ca.created_at)
                   from lbe.content_approvals ca where ca.content_id = r.content_id and ca.package_hash = r.package_hash), '[]'::jsonb))
    order by r.version desc)
    from lbe.content_revisions r where r.content_id = p_content_id), '[]'::jsonb);
end
$$;

revoke execute on function lbe.tg_content_revisions_immutable(), lbe.tg_content_items_revision(), lbe.content_history(text, uuid) from public;
grant execute on function lbe.content_history(text, uuid) to lbe_api;
