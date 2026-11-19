-- LinkedIn Brand Engine — Phase 1 privileges
-- Principle: application roles can READ what they need and can WRITE only through
-- SECURITY DEFINER functions. No application role has INSERT/UPDATE/DELETE on any table.

revoke all on schema lbe from public;
revoke all on schema lbe_mock from public;
revoke all on all tables in schema lbe from public;
revoke all on all tables in schema lbe_mock from public;
revoke execute on all functions in schema lbe from public;
alter default privileges in schema lbe revoke execute on functions from public;

-- Supabase's API roles must never reach these schemas (no-op where the roles do not exist).
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema lbe, lbe_mock from %I', r);
      execute format('revoke all on all tables in schema lbe from %I', r);
      execute format('revoke all on all tables in schema lbe_mock from %I', r);
      execute format('revoke execute on all functions in schema lbe from %I', r);
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- lbe_api: dashboard reads + session-authenticated operations
-- ---------------------------------------------------------------------------
grant usage on schema lbe to lbe_api;
grant usage on schema lbe_mock to lbe_api;
grant select on lbe.social_accounts, lbe.account_approvers, lbe.claims, lbe.content_items, lbe.content_claims,
                lbe.content_approvals, lbe.publication_outbox, lbe.control_flags, lbe.audit_events, lbe.agent_runs
  to lbe_api;
grant select (id, email, display_name, role, disabled, created_at) on lbe.app_users to lbe_api;
grant select on lbe_mock.linkedin_posts to lbe_api;
-- NOTE: no access to lbe.sessions or app_users.password_hash.

grant execute on function
  lbe.login(text, text),
  lbe.logout(text),
  lbe.whoami(text),
  lbe.is_stopped(uuid),
  lbe.create_claim(text, text, text, text, text, timestamptz),
  lbe.set_claim_status(text, uuid, text),
  lbe.create_content(text, uuid, text, text, text, timestamptz),
  lbe.update_content(text, uuid, jsonb),
  lbe.set_draft_output(text, uuid, text, jsonb, jsonb),
  lbe.record_agent_run(text, jsonb),
  lbe.submit_for_review(text, uuid),
  lbe.decide_content(text, uuid, text, text, text),
  lbe.enqueue_publication(text, uuid),
  lbe.cancel_publication(text, uuid),
  lbe.reconcile_publication(text, uuid, text, text, text),
  lbe.set_stop(text, text, boolean, text),
  lbe.write_app_audit(text, text, text, text, jsonb)
to lbe_api;

-- ---------------------------------------------------------------------------
-- lbe_worker: outbox processing + mock provider store
-- ---------------------------------------------------------------------------
grant usage on schema lbe to lbe_worker;
grant usage on schema lbe_mock to lbe_worker;
grant select on lbe.publication_outbox, lbe.control_flags, lbe.social_accounts to lbe_worker;
grant insert, select on lbe_mock.linkedin_posts to lbe_worker;
grant execute on function
  lbe.is_stopped(uuid),
  lbe.claim_outbox(text, int, int),
  lbe.complete_outbox(uuid, text, text, text, text, int),
  lbe.expire_stale_dispatches(text)
to lbe_worker;

-- ---------------------------------------------------------------------------
-- Row-level security: enabled on every table (defence in depth for Supabase).
-- Only the explicit read policies below exist; everything else is denied.
-- SECURITY DEFINER functions run as the table owner and are not affected.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['app_users', 'sessions', 'social_accounts', 'account_approvers', 'claims',
                           'content_items', 'content_claims', 'content_approvals', 'publication_outbox',
                           'control_flags', 'audit_events', 'agent_runs'] loop
    execute format('alter table lbe.%I enable row level security', t);
  end loop;
  alter table lbe_mock.linkedin_posts enable row level security;

  foreach t in array array['app_users', 'social_accounts', 'account_approvers', 'claims', 'content_items',
                           'content_claims', 'content_approvals', 'publication_outbox', 'control_flags',
                           'audit_events', 'agent_runs'] loop
    execute format('create policy api_read on lbe.%I for select to lbe_api using (true)', t);
  end loop;
  foreach t in array array['publication_outbox', 'control_flags', 'social_accounts'] loop
    execute format('create policy worker_read on lbe.%I for select to lbe_worker using (true)', t);
  end loop;
end
$$;

create policy api_read on lbe_mock.linkedin_posts for select to lbe_api using (true);
create policy worker_rw on lbe_mock.linkedin_posts for all to lbe_worker using (true) with check (true);
