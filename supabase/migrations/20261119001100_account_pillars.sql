-- P2-01 Single source for content pillars: lbe.social_accounts.pillars, edited by the owner (admin) in the
-- Brand Brain page. The Brand Brain section `pillars_goals` now holds the campaign-goals narrative only.
-- Existing content keeps its pillar (it was valid when written); only new content and new edits are checked.

create function lbe.set_account_pillars(p_session text, p_account uuid, p_pillars text[]) returns text[]
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_admin lbe.app_users; v_acc lbe.social_accounts; v_clean text[]; v_p text;
begin
  v_admin := lbe.require_user(p_session, array['admin']);
  select * into v_acc from lbe.social_accounts where id = p_account;
  perform lbe.assert_org(v_admin, v_acc.organization_id);
  -- keep the owner's order, drop duplicates
  v_clean := array(select x from (select x, min(n) as n from unnest(coalesce(p_pillars, '{}')) with ordinality as u(x, n) group by x) s order by n);
  if cardinality(v_clean) not between 1 and 8 then
    raise exception 'an account needs between 1 and 8 content pillars' using errcode = 'LBE02';
  end if;
  foreach v_p in array v_clean loop
    if v_p !~ '^[a-z0-9][a-z0-9-]{1,39}$' then
      raise exception 'pillar "%" must be 2-40 lowercase letters, digits or hyphens (e.g. threat-landscape)', left(v_p, 60)
        using errcode = 'LBE02';
    end if;
  end loop;
  update lbe.social_accounts set pillars = v_clean where id = p_account;
  perform lbe.audit('account.pillars_changed', 'social_account', p_account::text,
                    jsonb_build_object('from', to_jsonb(v_acc.pillars), 'to', to_jsonb(v_clean)));
  return v_clean;
end
$$;

revoke execute on function lbe.set_account_pillars(text, uuid, text[]) from public;
grant execute on function lbe.set_account_pillars(text, uuid, text[]) to lbe_api;
