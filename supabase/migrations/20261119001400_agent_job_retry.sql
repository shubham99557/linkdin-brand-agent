-- P4-03 Retry a failed or cancelled agent job. A retry is a NEW job (fresh workflow, same parameters) linked to
-- the original, so the original's history and drafts stay as they were. Interrupted jobs use job_resume (P4-02)
-- instead, which continues the same workflow.

alter table lbe.agent_jobs add column retry_of uuid references lbe.agent_jobs(id);
create unique index agent_jobs_one_retry on lbe.agent_jobs(retry_of) where retry_of is not null;

create or replace function lbe.job_json(j lbe.agent_jobs) returns jsonb language sql stable as $$
  select jsonb_build_object('id', j.id, 'kind', j.kind, 'goal', j.params->>'goal', 'params', j.params, 'status', j.status,
    'workflow_id', j.workflow_id, 'progress', j.progress, 'cancel_requested', j.cancel_requested, 'error', j.error,
    'requested_by', j.requested_by, 'requested_by_name', (select display_name from lbe.app_users where id = j.requested_by),
    'created_at', j.created_at, 'started_at', j.started_at, 'finished_at', j.finished_at, 'attempts', j.attempts,
    'retry_of', j.retry_of, 'retried_as', (select r.id from lbe.agent_jobs r where r.retry_of = j.id))
$$;

create function lbe.job_retry(p_session text, p_job uuid) returns uuid
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_j lbe.agent_jobs; v_id uuid;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  select * into v_j from lbe.agent_jobs where id = p_job for update;
  perform lbe.assert_org(v_user, v_j.organization_id);
  if v_j.requested_by <> v_user.id and v_user.role <> 'admin' then
    raise exception 'only the person who started this job, or an admin, can retry it' using errcode = 'LBE11';
  end if;
  if v_j.status not in ('failed', 'cancelled') then
    raise exception 'only failed or cancelled jobs can be retried (this one is %)%', v_j.status,
      case when v_j.status = 'interrupted' then ' — use Resume instead' else '' end using errcode = 'LBE01';
  end if;
  if exists (select 1 from lbe.agent_jobs where retry_of = p_job) then
    raise exception 'this job was already retried' using errcode = 'LBE01';
  end if;
  if (select count(*) from lbe.agent_jobs where organization_id = v_j.organization_id and status in ('queued', 'running')) >= 5 then
    raise exception 'too many agent jobs waiting or running for this organization — wait for one to finish' using errcode = 'LBE01';
  end if;
  -- The retry runs as the person who pressed Retry (their permissions apply from now on).
  insert into lbe.agent_jobs(organization_id, kind, params, requested_by, retry_of)
  values (v_j.organization_id, v_j.kind, v_j.params, v_user.id, p_job) returning id into v_id;
  perform lbe.audit('agent.job_retried', 'agent_job', v_id::text, jsonb_build_object('retry_of', p_job, 'status_was', v_j.status));
  return v_id;
end
$$;

revoke execute on function lbe.job_retry(text, uuid) from public;
grant execute on function lbe.job_retry(text, uuid) to lbe_api;
