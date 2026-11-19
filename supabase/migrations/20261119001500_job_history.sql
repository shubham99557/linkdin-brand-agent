-- P4-04 Job history and progress polish.
-- * Users page: "open sessions" and "last active" count only real sign-ins, not background agent-job sessions.
-- * Job JSON gains timing, draft count and cost so the dashboard can show a run history.

create or replace function lbe.admin_list_users(p_session text) returns jsonb
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
             'active_sessions', (select count(*) from lbe.sessions s where s.user_id = u.id and s.kind = 'interactive'
                                    and s.revoked_at is null and s.expires_at > now() and s.last_seen_at > now() - lbe.session_idle_timeout()),
             'last_seen_at', (select max(s.last_seen_at) from lbe.sessions s where s.user_id = u.id and s.kind = 'interactive'),
             'running_jobs', (select count(*) from lbe.agent_jobs j where j.requested_by = u.id and j.status in ('queued', 'running')))
           order by u.disabled, u.display_name)
      from lbe.app_users u where u.organization_id = v_admin.organization_id), '[]'::jsonb);
end
$$;

create or replace function lbe.job_json(j lbe.agent_jobs) returns jsonb language sql stable as $$
  select jsonb_build_object('id', j.id, 'kind', j.kind, 'goal', j.params->>'goal', 'params', j.params, 'status', j.status,
    'workflow_id', j.workflow_id, 'progress', j.progress, 'cancel_requested', j.cancel_requested, 'error', j.error,
    'requested_by', j.requested_by, 'requested_by_name', (select display_name from lbe.app_users where id = j.requested_by),
    'created_at', j.created_at, 'started_at', j.started_at, 'finished_at', j.finished_at, 'attempts', j.attempts,
    'retry_of', j.retry_of, 'retried_as', (select r.id from lbe.agent_jobs r where r.retry_of = j.id),
    'duration_seconds', case when j.started_at is null then null
                             else round(extract(epoch from (coalesce(j.finished_at, now()) - j.started_at)))::int end,
    'drafts', case when j.workflow_id is null then 0
                   else (select count(*) from lbe.content_items c where c.workflow_id = j.workflow_id) end,
    'in_review', case when j.workflow_id is null then 0
                      else (select count(*) from lbe.content_items c where c.workflow_id = j.workflow_id and c.status = 'in_review') end,
    'estimated_usd', coalesce((j.progress->>'estimated_usd')::numeric, 0))
$$;
