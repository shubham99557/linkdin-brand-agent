-- P5-06 Accessibility: every attached visual needs a real description (alt text) before review.
-- * Alt text is published with the image, so it is part of what is approved: editing it attaches a new immutable
--   copy of the visual with the new text → the package changes → the post returns to draft (ADR-030).
-- * A post cannot enter review while its visual has no meaningful alt text (missing/generic/too short).

create function lbe.alt_text_problem(p_alt text) returns text language sql immutable as $$
  select case
    when p_alt is null or length(trim(p_alt)) = 0 then 'the visual has no description (alt text)'
    when trim(p_alt) = 'Visual for this post' then 'the visual only has the generic placeholder description'
    when length(trim(p_alt)) < 15 then 'the visual''s description (alt text) is too short — describe what it shows'
    else null end
$$;

create function lbe.tg_content_items_alt_check() returns trigger language plpgsql as $$
declare v_problem text;
begin
  if new.status = 'in_review' and old.status is distinct from 'in_review' and cardinality(new.media_ids) > 0 then
    select lbe.alt_text_problem(m.alt_text) into v_problem
      from lbe.media_assets m where m.id::text = any(new.media_ids) and lbe.alt_text_problem(m.alt_text) is not null limit 1;
    if v_problem is not null then
      raise exception 'add a description of the visual before review: %', v_problem using errcode = 'LBE02';
    end if;
  end if;
  return new;
end $$;
-- "zz" so it runs after content_items_biu (which may have reset the status to draft).
create trigger content_items_zz_alt_check before update of status on lbe.content_items
  for each row execute function lbe.tg_content_items_alt_check();

create function lbe.set_media_alt_text(p_session text, p_content_id uuid, p_alt_text text) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_org uuid; v_old lbe.media_assets; v_new uuid; v_row lbe.content_items; v_problem text;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  v_org := lbe.content_org(p_content_id);
  perform lbe.assert_org(v_user, v_org);
  v_problem := lbe.alt_text_problem(p_alt_text);
  if v_problem is not null then raise exception '%', v_problem using errcode = 'LBE02'; end if;
  if length(p_alt_text) > 1000 then raise exception 'description must be at most 1000 characters' using errcode = 'LBE02'; end if;
  select m.* into v_old from lbe.media_assets m join lbe.content_items c on c.id = m.content_id
   where m.content_id = p_content_id and m.id::text = any(c.media_ids);
  if v_old.id is null then raise exception 'this post has no attached visual' using errcode = 'LBE01'; end if;
  if trim(p_alt_text) = v_old.alt_text then
    return jsonb_build_object('media_ids', to_jsonb(array[v_old.id::text]), 'unchanged', true);
  end if;
  insert into lbe.media_assets(organization_id, content_id, kind, data, byte_size, sha256, width, height, page_count, alt_text, title, created_by)
  values (v_old.organization_id, v_old.content_id, v_old.kind, v_old.data, 0, '', v_old.width, v_old.height, v_old.page_count,
          trim(p_alt_text), v_old.title, v_user.id)
  returning id into v_new;
  update lbe.content_items set media_ids = array[v_new::text] where id = p_content_id returning * into v_row;
  perform lbe.audit('content.media_alt_text_changed', 'content_item', p_content_id::text,
    jsonb_build_object('media_id', v_new, 'replaces', v_old.id, 'status_after', v_row.status, 'package_hash', v_row.package_hash));
  return jsonb_build_object('media_ids', to_jsonb(v_row.media_ids), 'status', v_row.status, 'package_hash', v_row.package_hash);
end
$$;

revoke execute on function lbe.alt_text_problem(text), lbe.tg_content_items_alt_check(), lbe.set_media_alt_text(text, uuid, text) from public;
grant execute on function lbe.set_media_alt_text(text, uuid, text) to lbe_api;
