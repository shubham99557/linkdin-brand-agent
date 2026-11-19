-- P1-05 review finding F-1: an admin could make themselves approver of the founder profile from the Users page,
-- then approve and release posts in the founder's name (contradicts A-02: founder posts approved only by the founder).
-- Rule: nobody can change their OWN approver assignment for a founder profile through the app. Another admin must
-- do it, or an operator via the CLI (`npm run staging:user -- --approver-for`), which runs as the owner role.

create or replace function lbe.admin_set_approver(p_session text, p_user uuid, p_account uuid, p_approver boolean) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_admin lbe.app_users; v_t lbe.app_users; v_org uuid; v_kind text;
begin
  v_admin := lbe.require_user(p_session, array['admin']);
  v_t := lbe.admin_target(v_admin, p_user);
  select organization_id, kind into v_org, v_kind from lbe.social_accounts where id = p_account;
  perform lbe.assert_org(v_admin, v_org);
  if v_kind = 'founder_profile' and v_t.id = v_admin.id and p_approver then
    raise exception 'you cannot make yourself an approver of a founder profile — another admin must do it'
      using errcode = 'LBE11';
  end if;
  if p_approver then
    if v_t.disabled or v_t.role not in ('approver', 'admin') then
      raise exception 'only enabled approvers or admins can approve posts — change the role first' using errcode = 'LBE02';
    end if;
    insert into lbe.account_approvers(account_id, user_id) values (p_account, p_user) on conflict do nothing;
  else
    delete from lbe.account_approvers where account_id = p_account and user_id = p_user;
  end if;
  perform lbe.audit(case when p_approver then 'user.approver_added' else 'user.approver_removed' end,
                    'social_account', p_account::text, jsonb_build_object('user_id', p_user, 'account_kind', v_kind));
end
$$;
