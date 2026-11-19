-- P4-02 Checkpointed resume of agent jobs without duplicate drafts.
-- * Database guarantee: a workflow can hold at most ONE draft per (plan item = variant_group, account). The
--   orchestrator derives variant_group deterministically from (workflow, item index), so a resumed run finds
--   and continues the existing draft instead of creating another one. Even a late write from a runner whose
--   lease was lost cannot create a duplicate: the second insert fails on this index.
-- * An expired lease now RE-QUEUES the job (same workflow) up to 3 attempts; after that it is 'interrupted'.
-- * The requester or an admin can resume an interrupted job.

create unique index content_items_one_draft_per_plan_item
  on lbe.content_items(workflow_id, variant_group, account_id)
  where workflow_id is not null and variant_group is not null;

create or replace function lbe.job_recover_expired() returns int
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_j lbe.agent_jobs; v_n int := 0; v_requeue boolean;
begin
  perform set_config('lbe.actor', 'system:agent-runner', true);
  for v_j in select * from lbe.agent_jobs where status = 'running' and lease_expires_at < now() for update skip locked loop
    v_requeue := v_j.attempts < 3;
    -- The lost runner's job session is revoked first, so it cannot keep writing.
    update lbe.sessions set revoked_at = now() where job_id = v_j.id and revoked_at is null;
    if v_requeue then
      update lbe.agent_jobs set status = 'queued', lease_owner = null, lease_expires_at = null,
             progress = progress || jsonb_build_object('stage', 'resuming', 'resumes', coalesce((progress->>'resumes')::int, 0) + 1)
       where id = v_j.id;
      perform lbe.audit('agent.job_requeued', 'agent_job', v_j.id::text, jsonb_build_object('lease_owner', v_j.lease_owner, 'attempts', v_j.attempts));
    else
      update lbe.agent_jobs set status = 'interrupted', lease_owner = null, lease_expires_at = null, finished_at = now(),
             error = 'the runner stopped unexpectedly several times; drafts already created were kept — you can resume it'
       where id = v_j.id;
      update lbe.agent_workflows set status = 'failed', error = 'interrupted', finished_at = now()
       where id = v_j.workflow_id and status = 'running';
      perform lbe.audit('agent.job_interrupted', 'agent_job', v_j.id::text, jsonb_build_object('lease_owner', v_j.lease_owner, 'attempts', v_j.attempts));
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- Same as 1200, plus the checkpoint the runner needs: the job's workflow and the estimated spend so far.
create or replace function lbe.job_claim(p_worker text, p_lease_seconds int default 120) returns jsonb
language plpgsql security definer set search_path = lbe, extensions, public, pg_temp
as $$
declare v_j lbe.agent_jobs; v_token text; v_lease timestamptz := now() + make_interval(secs => greatest(30, least(p_lease_seconds, 900)));
        v_user lbe.app_users;
begin
  if p_worker is null or length(p_worker) not between 1 and 100 then raise exception 'worker id required' using errcode = 'LBE02'; end if;
  perform set_config('lbe.actor', 'system:agent-runner', true);
  select * into v_j from lbe.agent_jobs where status = 'queued' order by created_at for update skip locked limit 1;
  if not found then return null; end if;
  select * into v_user from lbe.app_users where id = v_j.requested_by;
  if v_user.disabled then
    update lbe.agent_jobs set status = 'failed', finished_at = now(), error = 'the requesting user is disabled' where id = v_j.id;
    update lbe.agent_workflows set status = 'failed', error = 'requesting user disabled', finished_at = now()
     where id = v_j.workflow_id and status = 'running';
    return null;
  end if;
  update lbe.agent_jobs set status = 'running', lease_owner = p_worker, lease_expires_at = v_lease, attempts = attempts + 1,
         started_at = coalesce(started_at, now()),
         progress = progress || jsonb_build_object('stage', case when v_j.workflow_id is null then 'starting' else 'resuming' end)
   where id = v_j.id;
  v_token := encode(gen_random_bytes(32), 'hex');
  insert into lbe.sessions(user_id, token_hash, expires_at, kind, job_id)
  values (v_j.requested_by, lbe.hash_text(v_token), v_lease + interval '1 minute', 'agent_job', v_j.id);
  perform lbe.audit(case when v_j.workflow_id is null then 'agent.job_started' else 'agent.job_resumed' end,
                    'agent_job', v_j.id::text, jsonb_build_object('worker', p_worker, 'attempt', v_j.attempts + 1));
  return jsonb_build_object('id', v_j.id, 'kind', v_j.kind, 'params', v_j.params, 'session', v_token,
    'workflow_id', v_j.workflow_id, 'spent_usd', coalesce((v_j.progress->>'estimated_usd')::numeric, 0));
end
$$;

-- Manual resume of an interrupted job (requester or admin). Continues the same workflow.
create function lbe.job_resume(p_session text, p_job uuid) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_j lbe.agent_jobs;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  select * into v_j from lbe.agent_jobs where id = p_job for update;
  perform lbe.assert_org(v_user, v_j.organization_id);
  if v_j.requested_by <> v_user.id and v_user.role <> 'admin' then
    raise exception 'only the person who started this job, or an admin, can resume it' using errcode = 'LBE11';
  end if;
  if v_j.status <> 'interrupted' then
    raise exception 'only interrupted jobs can be resumed (this one is %)', v_j.status using errcode = 'LBE01';
  end if;
  update lbe.agent_jobs set status = 'queued', attempts = 0, finished_at = null, error = null,
         progress = progress || jsonb_build_object('stage', 'resuming')
   where id = p_job;
  update lbe.agent_workflows set status = 'running', error = null, finished_at = null
   where id = v_j.workflow_id and status = 'failed' and error = 'interrupted';
  perform lbe.audit('agent.job_resume_requested', 'agent_job', p_job::text, '{}'::jsonb);
end
$$;

revoke execute on function lbe.job_resume(text, uuid) from public;
grant execute on function lbe.job_resume(text, uuid) to lbe_api;
