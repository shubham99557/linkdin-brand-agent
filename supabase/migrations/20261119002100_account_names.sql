-- P2-04 Account display names (e.g. the real company name and the founder's name) are edited by the owner (admin).
--
-- The display name is NOT part of the publication package (lbe.build_package uses the account id, kind, LinkedIn
-- URN and publishing mode), so renaming never changes or invalidates approved content. It is used for new drafts
-- (the writer is told whose account it writes for) and in the dashboard.
--
-- Rules, enforced in the database for every write path (dashboard, seed, CLI):
--   * 1–120 characters after trimming; no control characters (incl. line breaks) and no angle brackets, because the
--     name is placed inside the writer's prompt and must not be able to open or close a delimited block.
--   * Checked by a trigger on insert and on change of display_name only, so an unrelated update of an older row
--     (e.g. revoking a credential, which forces publishing_mode back to mock) can never be blocked by its name.

create function lbe.tg_accounts_name_check() returns trigger
language plpgsql
as $$
begin
  new.display_name := btrim(new.display_name);
  if length(new.display_name) not between 1 and 120 then
    raise exception 'account name must be 1-120 characters' using errcode = 'LBE02';
  end if;
  if new.display_name ~ '[[:cntrl:]<>]' then
    raise exception 'account name must not contain line breaks, control characters or angle brackets' using errcode = 'LBE02';
  end if;
  return new;
end
$$;

create trigger accounts_name_check before insert or update of display_name on lbe.social_accounts
  for each row execute function lbe.tg_accounts_name_check();

revoke execute on function lbe.tg_accounts_name_check() from public;

create function lbe.set_account_display_name(p_session text, p_account uuid, p_name text) returns text
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_admin lbe.app_users; v_acc lbe.social_accounts; v_new text;
begin
  v_admin := lbe.require_user(p_session, array['admin']);
  select * into v_acc from lbe.social_accounts where id = p_account for update;
  perform lbe.assert_org(v_admin, v_acc.organization_id);
  if p_name is null then
    raise exception 'account name is required' using errcode = 'LBE02';
  end if;
  update lbe.social_accounts set display_name = p_name where id = p_account returning display_name into v_new;
  if v_new is distinct from v_acc.display_name then
    perform lbe.audit('account.renamed', 'social_account', p_account::text,
                      jsonb_build_object('from', v_acc.display_name, 'to', v_new));
  end if;
  return v_new;
end
$$;

revoke execute on function lbe.set_account_display_name(text, uuid, text) from public;
grant execute on function lbe.set_account_display_name(text, uuid, text) to lbe_api;
