-- P5-03 Visuals become part of what is approved.
-- * lbe.media_assets stores the exact rendered bytes (PNG single image or PDF document carousel). The database
--   computes the SHA-256 and checks the file signature itself; rows are immutable (no UPDATE/DELETE, even for the
--   owner), so an approved media id always means the same bytes.
-- * content_items.media_ids may only reference assets of the SAME content item (closes the free-text gap).
-- * Attaching/replacing/removing a visual changes the publication package → the existing trigger resets the
--   post to draft and any approval no longer matches (hash-bound approvals, ADR-005).

create table lbe.media_assets (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references lbe.organizations(id),
  content_id       uuid not null references lbe.content_items(id),
  kind             text not null check (kind in ('image/png', 'application/pdf')),
  data             bytea not null,
  byte_size        int not null,
  sha256           text not null,
  width            int check (width between 1 and 10000),
  height           int check (height between 1 and 10000),
  page_count       int check (page_count between 1 and 300),
  alt_text         text not null check (length(alt_text) between 1 and 1000),
  title            text check (title is null or length(title) <= 200),
  created_by       uuid not null references lbe.app_users(id),
  created_at       timestamptz not null default clock_timestamp()
);
create index media_assets_content on lbe.media_assets(content_id);
alter table lbe.media_assets enable row level security;   -- no policies: definer functions only

create function lbe.tg_media_assets_bi() returns trigger language plpgsql
set search_path = lbe, extensions, public, pg_temp
as $$
declare v_limit bigint;
begin
  new.byte_size := octet_length(new.data);
  new.sha256 := encode(digest(new.data, 'sha256'), 'hex');
  if new.kind = 'image/png' and substring(new.data from 1 for 8) <> decode('89504e470d0a1a0a', 'hex') then
    raise exception 'not a PNG file' using errcode = 'LBE02';
  end if;
  if new.kind = 'application/pdf' and substring(new.data from 1 for 5) <> decode('255044462d', 'hex') then
    raise exception 'not a PDF file' using errcode = 'LBE02';
  end if;
  -- (a CASE inside an IF condition would end the condition at its own THEN, so compute the limit first)
  v_limit := case when new.kind = 'application/pdf' then 100 * 1024 * 1024 else 10 * 1024 * 1024 end;
  if new.byte_size > v_limit then
    raise exception 'file too large for LinkedIn' using errcode = 'LBE02';
  end if;
  return new;
end $$;
create trigger media_assets_bi before insert on lbe.media_assets for each row execute function lbe.tg_media_assets_bi();

create function lbe.tg_media_assets_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'media assets are immutable (attach a new one instead)' using errcode = 'LBE01';
end $$;
create trigger media_assets_immutable before update or delete on lbe.media_assets
  for each row execute function lbe.tg_media_assets_immutable();

-- media_ids must reference this content item's own assets.
create function lbe.tg_content_items_media_check() returns trigger language plpgsql as $$
declare v_id text;
begin
  foreach v_id in array coalesce(new.media_ids, '{}') loop
    if v_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not exists (select 1 from lbe.media_assets m where m.id = v_id::uuid and m.content_id = new.id) then
      raise exception 'media % is not a visual of this post', left(v_id, 40) using errcode = 'LBE02';
    end if;
  end loop;
  if cardinality(new.media_ids) > 1 then
    raise exception 'a post can carry one visual (image or PDF document)' using errcode = 'LBE02';
  end if;
  return new;
end $$;
create trigger content_items_media_check before insert or update of media_ids on lbe.content_items
  for each row execute function lbe.tg_content_items_media_check();

-- Attach (or with p_asset = null, remove) the post's visual. Editors and the agent role may call it; it never
-- approves anything — it resets an approved/in-review post to draft through the package hash.
create function lbe.attach_media(p_session text, p_content_id uuid, p_asset jsonb) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_org uuid; v_id uuid; v_row lbe.content_items; v_status_before text;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  v_org := lbe.content_org(p_content_id);
  perform lbe.assert_org(v_user, v_org);
  select status into v_status_before from lbe.content_items where id = p_content_id;
  if p_asset is null then
    update lbe.content_items set media_ids = '{}' where id = p_content_id returning * into v_row;
  else
    if coalesce(p_asset->>'kind', '') not in ('image/png', 'application/pdf') then
      raise exception 'visual must be a PNG image or a PDF document' using errcode = 'LBE02';
    end if;
    insert into lbe.media_assets(organization_id, content_id, kind, data, byte_size, sha256, width, height, page_count, alt_text, title, created_by)
    values (v_org, p_content_id, p_asset->>'kind', decode(p_asset->>'data_base64', 'base64'), 0, '',
            (p_asset->>'width')::int, (p_asset->>'height')::int, (p_asset->>'page_count')::int,
            left(coalesce(nullif(trim(p_asset->>'alt_text'), ''), 'Visual for this post'), 1000), left(p_asset->>'title', 200), v_user.id)
    returning id into v_id;
    update lbe.content_items set media_ids = array[v_id::text] where id = p_content_id returning * into v_row;
  end if;
  perform lbe.audit(case when p_asset is null then 'content.media_removed' else 'content.media_attached' end, 'content_item', p_content_id::text,
    jsonb_build_object('media_id', v_id, 'kind', p_asset->>'kind',
                       'sha256', (select sha256 from lbe.media_assets where id = v_id),
                       'status_before', v_status_before, 'status_after', v_row.status, 'package_hash', v_row.package_hash));
  return jsonb_build_object('media_ids', to_jsonb(v_row.media_ids), 'status', v_row.status, 'package_hash', v_row.package_hash);
end
$$;

-- Metadata of a post's attached visual (no bytes).
create function lbe.media_list(p_session text, p_content_id uuid) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.require_user(p_session, array['viewer', 'editor', 'approver', 'admin']);
  perform lbe.assert_org(v_user, lbe.content_org(p_content_id));
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'sha256', m.sha256, 'byte_size', m.byte_size,
            'width', m.width, 'height', m.height, 'page_count', m.page_count, 'alt_text', m.alt_text, 'title', m.title,
            'created_at', m.created_at, 'attached', m.id::text = any(c.media_ids)) order by m.created_at desc)
          from lbe.media_assets m join lbe.content_items c on c.id = m.content_id where m.content_id = p_content_id), '[]'::jsonb);
end
$$;

-- The bytes of one asset (organization-checked).
create function lbe.media_get(p_session text, p_media_id uuid) returns table(kind text, data bytea, sha256 text, alt_text text)
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.require_user(p_session, array['viewer', 'editor', 'approver', 'admin']);
  perform lbe.assert_org(v_user, (select organization_id from lbe.media_assets where id = p_media_id));
  return query select m.kind, m.data, m.sha256, m.alt_text from lbe.media_assets m where m.id = p_media_id;
end
$$;

revoke execute on function lbe.attach_media(text, uuid, jsonb), lbe.media_list(text, uuid), lbe.media_get(text, uuid),
  lbe.tg_media_assets_bi(), lbe.tg_media_assets_immutable(), lbe.tg_content_items_media_check() from public;
grant execute on function lbe.attach_media(text, uuid, jsonb), lbe.media_list(text, uuid), lbe.media_get(text, uuid) to lbe_api;
grant execute on function lbe.attach_media(text, uuid, jsonb) to lbe_agent;
