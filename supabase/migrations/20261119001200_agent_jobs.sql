-- P4-01 Durable agent jobs. Workflows no longer run inside the HTTP request: the API enqueues a job, a runner
-- claims it (FOR UPDATE SKIP LOCKED + lease, like the publication outbox), and runs it as the requesting user.
--
-- Identity: a runner never sees a user's browser session. When it claims a job the database mints a short-lived
-- JOB SESSION for the requester (only its hash is stored; it expires with the lease and is revoked when the job
-- ends). Job sessions are accepted by require_user (so every existing rule, organization check and role check
-- applies unchanged) but REFUSED by whoami, so they can never be used to sign in to the dashboard/API.
-- The orchestrator still runs as the lbe_agent role: it cannot approve, release, publish, resume STOP or verify claims.
--
-- Interruption: if a runner dies, its lease expires and the job becomes 'interrupted' (not re-run: a blind re-run
-- could duplicate drafts; checkpointed resume is P4-02). The linked workflow is marked failed.

alter table lbe.sessions add column kind text not null default 'interactive' check (kind in ('interactive', 'agent_job'));
alter table lbe.sessions add column job_id uuid;

alter table lbe.agent_workflows drop constraint agent_workflows_status_check;
alter table lbe.agent_workflows add constraint agent_workflows_status_check check (status in ('running', 'completed', 'failed', 'cancelled'));

create table lbe.agent_jobs (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references lbe.organizations(id),
  kind              text not null check (kind in ('brand_workflow')),
  params            jsonb not null,
  status            text not null default 'queued'
                    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  requested_by      uuid not null references lbe.app_users(id),
  workflow_id       uuid references lbe.agent_workflows(id),
  progress          jsonb not null default '{}'::jsonb,
  cancel_requested  boolean not null default false,
  attempts          int not null default 0,
  lease_owner       text,
  lease_expires_at  timestamptz,
  error             text,
  created_at        timestamptz not null default clock_timestamp(),
  started_at        timestamptz,
  finished_at       timestamptz,
  check ((status = 'running') = (lease_owner is not null and lease_expires_at is not null))
);
create index agent_jobs_queue on lbe.agent_jobs(created_at) where status = 'queued';
create index agent_jobs_running on lbe.agent_jobs(lease_expires_at) where status = 'running';
create index agent_jobs_org on lbe.agent_jobs(organization_id, created_at desc);
alter table lbe.agent_jobs enable row level security;   -- no policies: definer functions only
alter table lbe.sessions add constraint sessions_job_fk foreign key (job_id) references lbe.agent_jobs(id);

-- ---------------------------------------------------------------------------
-- Session resolution: interactive sessions only for the dashboard (whoami), both kinds for require_user.
-- ---------------------------------------------------------------------------
create function lbe.session_resolve(p_session text, p_allow_job boolean) returns lbe.app_users
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_sid uuid; v_seen timestamptz; v_uid uuid; v_user lbe.app_users;
begin
  if p_session is null or length(p_session) < 32 then return null; end if;
  select s.id, s.last_seen_at, s.user_id into v_sid, v_seen, v_uid
    from lbe.sessions s join lbe.app_users u on u.id = s.user_id
   where s.token_hash = lbe.hash_text(p_session)
     and s.revoked_at is null and s.expires_at > now()
     and s.last_seen_at > now() - lbe.session_idle_timeout()
     and (s.kind = 'interactive' or p_allow_job)
     and not u.disabled;
  if v_sid is null then return null; end if;
  if v_seen < now() - interval '1 minute' then
    update lbe.sessions set last_seen_at = now() where id = v_sid;
  end if;
  select * into v_user from lbe.app_users where id = v_uid;
  return v_user;
end
$$;

-- whoami (dashboard/API sign-in check) keeps using this: interactive sessions only.
create or replace function lbe.session_user_touch(p_session text) returns lbe.app_users
language sql security definer set search_path = lbe, pg_temp
as $$ select lbe.session_resolve(p_session, false) $$;

create or replace function lbe.require_user_core(p_session text, p_roles text[], p_allow_pw_change boolean) returns lbe.app_users
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.session_resolve(p_session, true);
  if v_user.id is null then
    raise exception 'not authenticated' using errcode = 'LBE10';
  end if;
  if v_user.must_change_password and not p_allow_pw_change then
    raise exception 'choose a new password before continuing' using errcode = 'LBE12';
  end if;
  if not (v_user.role = any(p_roles)) then
    raise exception 'role % may not perform this action', v_user.role using errcode = 'LBE11';
  end if;
  perform set_config('lbe.actor', 'user:' || v_user.id::text, true);
  perform set_config('lbe.org', v_user.organization_id::text, true);
  return v_user;
end
$$;

-- ---------------------------------------------------------------------------
-- API side (session-authenticated)
-- ---------------------------------------------------------------------------
create function lbe.job_enqueue(p_session text, p_kind text, p_params jsonb) returns uuid
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_id uuid;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  if p_kind <> 'brand_workflow' then raise exception 'unknown job kind' using errcode = 'LBE02'; end if;
  if coalesce(length(p_params->>'goal'), 0) not between 3 and 1000 then
    raise exception 'goal must be 3-1000 characters' using errcode = 'LBE02';
  end if;
  if (select count(*) from lbe.agent_jobs where organization_id = v_user.organization_id and status in ('queued', 'running')) >= 5 then
    raise exception 'too many agent jobs waiting or running for this organization — wait for one to finish' using errcode = 'LBE01';
  end if;
  insert into lbe.agent_jobs(organization_id, kind, params, requested_by)
  values (v_user.organization_id, p_kind, p_params, v_user.id) returning id into v_id;
  perform lbe.audit('agent.job_queued', 'agent_job', v_id::text, jsonb_build_object('kind', p_kind, 'goal', left(p_params->>'goal', 200)));
  return v_id;
end
$$;

create function lbe.job_json(j lbe.agent_jobs) returns jsonb language sql stable as $$
  select jsonb_build_object('id', j.id, 'kind', j.kind, 'goal', j.params->>'goal', 'params', j.params, 'status', j.status,
    'workflow_id', j.workflow_id, 'progress', j.progress, 'cancel_requested', j.cancel_requested, 'error', j.error,
    'requested_by', j.requested_by, 'requested_by_name', (select display_name from lbe.app_users where id = j.requested_by),
    'created_at', j.created_at, 'started_at', j.started_at, 'finished_at', j.finished_at)
$$;

create function lbe.job_get(p_session text, p_job uuid) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_j lbe.agent_jobs;
begin
  v_user := lbe.require_user(p_session, array['viewer', 'editor', 'approver', 'admin']);
  select * into v_j from lbe.agent_jobs where id = p_job;
  perform lbe.assert_org(v_user, v_j.organization_id);
  return lbe.job_json(v_j);
end
$$;

create function lbe.job_list(p_session text) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.require_user(p_session, array['viewer', 'editor', 'approver', 'admin']);
  return coalesce((select jsonb_agg(lbe.job_json(j) order by j.created_at desc)
                     from (select * from lbe.agent_jobs where organization_id = v_user.organization_id
                            order by created_at desc limit 50) j), '[]'::jsonb);
end
$$;

-- The requester or an admin may cancel. Queued → cancelled at once; running → flagged, the runner stops at the
-- next step boundary.
create function lbe.job_cancel(p_session text, p_job uuid) returns text
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_j lbe.agent_jobs;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  select * into v_j from lbe.agent_jobs where id = p_job for update;
  perform lbe.assert_org(v_user, v_j.organization_id);
  if v_j.requested_by <> v_user.id and v_user.role <> 'admin' then
    raise exception 'only the person who started this job, or an admin, can cancel it' using errcode = 'LBE11';
  end if;
  if v_j.status = 'queued' then
    update lbe.agent_jobs set status = 'cancelled', finished_at = now(), error = 'cancelled before it started' where id = p_job;
  elsif v_j.status = 'running' then
    update lbe.agent_jobs set cancel_requested = true where id = p_job;
  else
    raise exception 'job already finished (%)', v_j.status using errcode = 'LBE01';
  end if;
  perform lbe.audit('agent.job_cancel_requested', 'agent_job', p_job::text, jsonb_build_object('status_was', v_j.status));
  return case when v_j.status = 'queued' then 'cancelled' else 'cancel_requested' end;
end
$$;

-- ---------------------------------------------------------------------------
-- Runner side (lbe_worker)
-- ---------------------------------------------------------------------------
-- Expired leases → interrupted (job session revoked, workflow marked failed). Returns how many.
create function lbe.job_recover_expired() returns int
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_j lbe.agent_jobs; v_n int := 0;
begin
  perform set_config('lbe.actor', 'system:agent-runner', true);
  for v_j in select * from lbe.agent_jobs where status = 'running' and lease_expires_at < now() for update skip locked loop
    update lbe.agent_jobs set status = 'interrupted', lease_owner = null, lease_expires_at = null, finished_at = now(),
           error = 'the runner stopped unexpectedly; drafts already created were kept — start the job again if needed'
     where id = v_j.id;
    update lbe.sessions set revoked_at = now() where job_id = v_j.id and revoked_at is null;
    update lbe.agent_workflows set status = 'failed', error = 'interrupted', finished_at = now()
     where id = v_j.workflow_id and status = 'running';
    perform lbe.audit('agent.job_interrupted', 'agent_job', v_j.id::text, jsonb_build_object('lease_owner', v_j.lease_owner));
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- Claim the oldest queued job; mint its job session. Returns null when there is nothing to do.
create function lbe.job_claim(p_worker text, p_lease_seconds int default 120) returns jsonb
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
    return null;
  end if;
  update lbe.agent_jobs set status = 'running', lease_owner = p_worker, lease_expires_at = v_lease, attempts = attempts + 1,
         started_at = coalesce(started_at, now()), progress = jsonb_build_object('stage', 'starting')
   where id = v_j.id;
  v_token := encode(gen_random_bytes(32), 'hex');
  insert into lbe.sessions(user_id, token_hash, expires_at, kind, job_id)
  values (v_j.requested_by, lbe.hash_text(v_token), v_lease + interval '1 minute', 'agent_job', v_j.id);
  perform lbe.audit('agent.job_started', 'agent_job', v_j.id::text, jsonb_build_object('worker', p_worker));
  return jsonb_build_object('id', v_j.id, 'kind', v_j.kind, 'params', v_j.params, 'session', v_token);
end
$$;

-- Extend the lease, store progress, report whether cancellation was requested. Only the lease owner.
create function lbe.job_heartbeat(p_worker text, p_job uuid, p_progress jsonb, p_workflow uuid, p_lease_seconds int default 120) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_j lbe.agent_jobs; v_lease timestamptz := now() + make_interval(secs => greatest(30, least(p_lease_seconds, 900)));
begin
  select * into v_j from lbe.agent_jobs where id = p_job for update;
  if not found or v_j.status <> 'running' or v_j.lease_owner is distinct from p_worker then
    return jsonb_build_object('ok', false, 'cancel', true, 'reason', 'lease lost');
  end if;
  if p_workflow is not null and v_j.workflow_id is not null and v_j.workflow_id <> p_workflow then
    raise exception 'workflow mismatch' using errcode = 'LBE02';
  end if;
  if p_workflow is not null and (select organization_id from lbe.agent_workflows where id = p_workflow) is distinct from v_j.organization_id then
    raise exception 'workflow belongs to another organization' using errcode = 'LBE04';
  end if;
  update lbe.agent_jobs set lease_expires_at = v_lease, progress = coalesce(p_progress, progress),
         workflow_id = coalesce(p_workflow, workflow_id)
   where id = p_job;
  update lbe.sessions set expires_at = v_lease + interval '1 minute' where job_id = p_job and revoked_at is null;
  return jsonb_build_object('ok', true, 'cancel', v_j.cancel_requested);
end
$$;

create function lbe.job_finish(p_worker text, p_job uuid, p_status text, p_error text) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_j lbe.agent_jobs;
begin
  if p_status not in ('succeeded', 'failed', 'cancelled') then raise exception 'invalid job status' using errcode = 'LBE02'; end if;
  perform set_config('lbe.actor', 'system:agent-runner', true);
  select * into v_j from lbe.agent_jobs where id = p_job for update;
  if not found or v_j.status <> 'running' or v_j.lease_owner is distinct from p_worker then
    raise exception 'job is not leased by this worker' using errcode = 'LBE01';
  end if;
  update lbe.agent_jobs set status = p_status, error = left(p_error, 2000), finished_at = now(), lease_owner = null, lease_expires_at = null
   where id = p_job;
  update lbe.sessions set revoked_at = now() where job_id = p_job and revoked_at is null;
  perform lbe.audit('agent.job_' || p_status, 'agent_job', p_job::text, '{}'::jsonb);
end
$$;

-- Workflows may now end as cancelled.
create or replace function lbe.workflow_finish(p_session text, p_workflow_id uuid, p_status text, p_result jsonb, p_error text) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  perform lbe.assert_org(v_user, (select organization_id from lbe.agent_workflows where id = p_workflow_id));
  if p_status not in ('completed', 'failed', 'cancelled') then raise exception 'invalid workflow status' using errcode = 'LBE02'; end if;
  update lbe.agent_workflows set status = p_status, result = p_result, error = left(p_error, 2000), finished_at = now()
   where id = p_workflow_id and status = 'running';
  if not found then raise exception 'workflow is not running' using errcode = 'LBE01'; end if;
  perform lbe.audit('agent.workflow_' || p_status, 'agent_workflow', p_workflow_id::text, '{}'::jsonb);
end
$$;

-- Audit subject resolution: same as 0600 plus the new 'agent_job' subject type.
create or replace function lbe.subject_org(p_type text, p_id text) returns uuid
language plpgsql stable security definer set search_path = lbe, pg_temp
as $$
declare v uuid; v_uuid uuid;
begin
  if p_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_uuid := p_id::uuid; end if;
  case p_type
    when 'content_item' then v := lbe.content_org(v_uuid);
    when 'publication_outbox' then
      select a.organization_id into v from lbe.publication_outbox o join lbe.social_accounts a on a.id = o.account_id where o.id = v_uuid;
    when 'social_account' then select organization_id into v from lbe.social_accounts where id = v_uuid;
    when 'claim' then select organization_id into v from lbe.claims where id = v_uuid;
    when 'app_user' then select organization_id into v from lbe.app_users where id = v_uuid;
    when 'brand_entry' then select organization_id into v from lbe.brand_entries where id = v_uuid;
    when 'brand_proposal' then select organization_id into v from lbe.brand_proposals where id = v_uuid;
    when 'agent_workflow' then select organization_id into v from lbe.agent_workflows where id = v_uuid;
    when 'agent_job' then select organization_id into v from lbe.agent_jobs where id = v_uuid;
    when 'control_flag' then
      if p_id like 'account:%' then select organization_id into v from lbe.social_accounts where id = substr(p_id, 9)::uuid;
      elsif p_id like 'org:%' then v := substr(p_id, 5)::uuid;
      end if;
    else v := null;
  end case;
  return coalesce(v, nullif(current_setting('lbe.org', true), '')::uuid);
end
$$;

revoke execute on function lbe.session_resolve(text, boolean), lbe.job_json(lbe.agent_jobs),
  lbe.job_enqueue(text, text, jsonb), lbe.job_get(text, uuid), lbe.job_list(text), lbe.job_cancel(text, uuid),
  lbe.job_recover_expired(), lbe.job_claim(text, int), lbe.job_heartbeat(text, uuid, jsonb, uuid, int),
  lbe.job_finish(text, uuid, text, text) from public;
grant execute on function lbe.job_enqueue(text, text, jsonb), lbe.job_get(text, uuid), lbe.job_list(text),
  lbe.job_cancel(text, uuid) to lbe_api;
grant execute on function lbe.job_recover_expired(), lbe.job_claim(text, int), lbe.job_heartbeat(text, uuid, jsonb, uuid, int),
  lbe.job_finish(text, uuid, text, text) to lbe_worker;
