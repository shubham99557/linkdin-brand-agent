-- P5-05 Monthly planning & campaign objectives.
-- A campaign is a month (1–5 weeks) of weekly Branding Agent runs sharing an objective. Each week is a normal
-- durable job (resume, cancel, budget, duplicate checks all apply). Weeks run strictly in order — the database
-- will not hand out week k while an earlier week is still queued or running — so every week's strategy sees the
-- drafts of the weeks before it and the duplicate-topic rule applies across the whole month.

create table lbe.campaigns (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references lbe.organizations(id),
  name             text not null check (length(name) between 3 and 120),
  objective        text not null check (objective in ('awareness', 'engagement', 'thought_leadership', 'lead_generation', 'event_promotion')),
  goal             text not null check (length(goal) between 3 and 1000),
  start_date       date not null,
  weeks            int not null check (weeks between 1 and 5),
  posts_per_week   int not null check (posts_per_week between 3 and 5),
  created_by       uuid not null references lbe.app_users(id),
  created_at       timestamptz not null default clock_timestamp()
);
create index campaigns_org on lbe.campaigns(organization_id, created_at desc);
alter table lbe.campaigns enable row level security;   -- no policies: definer functions only

alter table lbe.agent_jobs add column campaign_id uuid references lbe.campaigns(id);
alter table lbe.agent_jobs add column campaign_week int check (campaign_week between 1 and 5);
alter table lbe.agent_jobs add constraint agent_jobs_campaign_week check ((campaign_id is null) = (campaign_week is null));
create unique index agent_jobs_one_per_week on lbe.agent_jobs(campaign_id, campaign_week) where campaign_id is not null and retry_of is null;

create function lbe.objective_label(p text) returns text language sql immutable as $$
  select case p when 'awareness' then 'build awareness' when 'engagement' then 'drive engagement and conversation'
    when 'thought_leadership' then 'establish thought leadership' when 'lead_generation' then 'generate inbound interest (no cold outreach)'
    when 'event_promotion' then 'promote an event' else p end
$$;

create function lbe.campaign_create(p_session text, p_name text, p_objective text, p_goal text, p_start date,
                                    p_weeks int, p_posts_per_week int) returns uuid
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_id uuid; v_pillars text[]; v_focus text; k int;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  if exists (select 1 from lbe.agent_jobs j where j.organization_id = v_user.organization_id and j.campaign_id is not null
               and j.status in ('queued', 'running')) then
    raise exception 'a campaign is already in progress for this organization — wait for it to finish or cancel it' using errcode = 'LBE01';
  end if;
  if p_start is null or p_start < current_date then raise exception 'the campaign must start today or later' using errcode = 'LBE02'; end if;
  insert into lbe.campaigns(organization_id, name, objective, goal, start_date, weeks, posts_per_week, created_by)
  values (v_user.organization_id, trim(p_name), p_objective, trim(p_goal), p_start, p_weeks, p_posts_per_week, v_user.id)
  returning id into v_id;
  -- Rotate the weekly focus through the company page's approved pillars (falls back to the goal alone).
  select pillars into v_pillars from lbe.social_accounts
   where organization_id = v_user.organization_id and kind = 'company_page' order by created_at limit 1;
  for k in 1..p_weeks loop
    v_focus := case when cardinality(coalesce(v_pillars, '{}')) > 0
                    then replace(v_pillars[1 + ((k - 1) % cardinality(v_pillars))], '-', ' ') end;
    insert into lbe.agent_jobs(organization_id, kind, params, requested_by, campaign_id, campaign_week)
    values (v_user.organization_id, 'brand_workflow', jsonb_build_object(
              'goal', left(format('%s — week %s of %s, objective: %s%s', trim(p_goal), k, p_weeks, lbe.objective_label(p_objective),
                                  coalesce('; focus: ' || v_focus, '')), 1000),
              'start_date', to_char(p_start + (k - 1) * 7, 'YYYY-MM-DD'), 'days', 7, 'post_count', p_posts_per_week,
              'campaign', jsonb_build_object('id', v_id, 'week', k, 'weeks', p_weeks, 'objective', p_objective, 'focus', v_focus)),
            v_user.id, v_id, k);
  end loop;
  perform lbe.audit('agent.campaign_created', 'campaign', v_id::text,
    jsonb_build_object('objective', p_objective, 'weeks', p_weeks, 'posts_per_week', p_posts_per_week));
  return v_id;
end
$$;

create function lbe.campaign_json(c lbe.campaigns) returns jsonb language sql stable as $$
  with w as (select j.* from lbe.agent_jobs j where j.campaign_id = c.id
               and not exists (select 1 from lbe.agent_jobs r where r.retry_of = j.id))   -- latest attempt per week
  select jsonb_build_object('id', c.id, 'name', c.name, 'objective', c.objective, 'goal', c.goal, 'start_date', c.start_date,
    'weeks', c.weeks, 'posts_per_week', c.posts_per_week, 'created_at', c.created_at,
    'created_by_name', (select display_name from lbe.app_users where id = c.created_by),
    'status', case
       when exists (select 1 from w where status in ('queued', 'running')) then
         case when exists (select 1 from w where status <> 'queued') then 'running' else 'planned' end
       when not exists (select 1 from w where status <> 'succeeded') then 'completed'
       when not exists (select 1 from w where status = 'succeeded') and exists (select 1 from w where status = 'cancelled') then 'cancelled'
       else 'partially_completed' end,
    'week_jobs', coalesce((select jsonb_agg(jsonb_build_object('week', w.campaign_week, 'job_id', w.id, 'status', w.status,
        'workflow_id', w.workflow_id, 'start_date', w.params->>'start_date', 'focus', w.params#>>'{campaign,focus}', 'error', w.error,
        'drafts', case when w.workflow_id is null then 0 else (select count(*) from lbe.content_items ci where ci.workflow_id = w.workflow_id) end)
        order by w.campaign_week) from w), '[]'::jsonb))
$$;

create function lbe.campaign_list(p_session text) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.require_user(p_session, array['viewer', 'editor', 'approver', 'admin']);
  return coalesce((select jsonb_agg(lbe.campaign_json(c) order by c.created_at desc)
                     from (select * from lbe.campaigns where organization_id = v_user.organization_id order by created_at desc limit 20) c), '[]'::jsonb);
end
$$;

-- One campaign with every planned post (topic, date, account, status) for the month view.
create function lbe.campaign_get(p_session text, p_campaign uuid) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_c lbe.campaigns;
begin
  v_user := lbe.require_user(p_session, array['viewer', 'editor', 'approver', 'admin']);
  select * into v_c from lbe.campaigns where id = p_campaign;
  perform lbe.assert_org(v_user, v_c.organization_id);
  return lbe.campaign_json(v_c) || jsonb_build_object('posts', coalesce((
    select jsonb_agg(jsonb_build_object('content_id', ci.id, 'week', j.campaign_week, 'topic', ci.topic, 'pillar', ci.pillar,
             'account_kind', a.kind, 'status', ci.status, 'scheduled_for', ci.scheduled_for, 'variant_group', ci.variant_group)
             order by ci.scheduled_for, a.kind)
      from lbe.agent_jobs j join lbe.content_items ci on ci.workflow_id = j.workflow_id join lbe.social_accounts a on a.id = ci.account_id
     where j.campaign_id = v_c.id), '[]'::jsonb));
end
$$;

create function lbe.campaign_cancel(p_session text, p_campaign uuid) returns int
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_c lbe.campaigns; v_j uuid; v_n int := 0;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  select * into v_c from lbe.campaigns where id = p_campaign;
  perform lbe.assert_org(v_user, v_c.organization_id);
  for v_j in select id from lbe.agent_jobs where campaign_id = p_campaign and status in ('queued', 'running') loop
    perform lbe.job_cancel(p_session, v_j);       -- same permission rule: requester or admin
    v_n := v_n + 1;
  end loop;
  perform lbe.audit('agent.campaign_cancelled', 'campaign', p_campaign::text, jsonb_build_object('jobs', v_n));
  return v_n;
end
$$;

-- Ad-hoc runs: campaign weeks do not count towards the 5-job limit (a campaign has its own limit of one).
create or replace function lbe.job_enqueue(p_session text, p_kind text, p_params jsonb) returns uuid
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_id uuid;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  if p_kind <> 'brand_workflow' then raise exception 'unknown job kind' using errcode = 'LBE02'; end if;
  if coalesce(length(p_params->>'goal'), 0) not between 3 and 1000 then
    raise exception 'goal must be 3-1000 characters' using errcode = 'LBE02';
  end if;
  if p_params ? 'campaign' then raise exception 'campaign weeks are created with campaign_create' using errcode = 'LBE02'; end if;
  if (select count(*) from lbe.agent_jobs where organization_id = v_user.organization_id and status in ('queued', 'running')
        and campaign_id is null) >= 5 then
    raise exception 'too many agent jobs waiting or running for this organization — wait for one to finish' using errcode = 'LBE01';
  end if;
  insert into lbe.agent_jobs(organization_id, kind, params, requested_by)
  values (v_user.organization_id, p_kind, p_params, v_user.id) returning id into v_id;
  perform lbe.audit('agent.job_queued', 'agent_job', v_id::text, jsonb_build_object('kind', p_kind, 'goal', left(p_params->>'goal', 200)));
  return v_id;
end
$$;

-- Claim: same as 1300, plus "a campaign week waits until every earlier week of its campaign has finished".
create or replace function lbe.job_claim(p_worker text, p_lease_seconds int default 120) returns jsonb
language plpgsql security definer set search_path = lbe, extensions, public, pg_temp
as $$
declare v_j lbe.agent_jobs; v_token text; v_lease timestamptz := now() + make_interval(secs => greatest(30, least(p_lease_seconds, 900)));
        v_user lbe.app_users;
begin
  if p_worker is null or length(p_worker) not between 1 and 100 then raise exception 'worker id required' using errcode = 'LBE02'; end if;
  perform set_config('lbe.actor', 'system:agent-runner', true);
  select * into v_j from lbe.agent_jobs j
   where j.status = 'queued'
     and (j.campaign_id is null or not exists (
           select 1 from lbe.agent_jobs p where p.campaign_id = j.campaign_id and p.campaign_week < j.campaign_week
              and p.status in ('queued', 'running')))
   order by j.created_at for update skip locked limit 1;
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

-- Retries of a campaign week stay attached to their campaign and week.
create or replace function lbe.job_retry(p_session text, p_job uuid) returns uuid
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
  insert into lbe.agent_jobs(organization_id, kind, params, requested_by, retry_of, campaign_id, campaign_week)
  values (v_j.organization_id, v_j.kind, v_j.params, v_user.id, p_job, v_j.campaign_id, v_j.campaign_week) returning id into v_id;
  perform lbe.audit('agent.job_retried', 'agent_job', v_id::text, jsonb_build_object('retry_of', p_job, 'status_was', v_j.status));
  return v_id;
end
$$;

-- Audit subject resolution for 'campaign'.
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
    when 'campaign' then select organization_id into v from lbe.campaigns where id = v_uuid;
    when 'control_flag' then
      if p_id like 'account:%' then select organization_id into v from lbe.social_accounts where id = substr(p_id, 9)::uuid;
      elsif p_id like 'org:%' then v := substr(p_id, 5)::uuid;
      end if;
    else v := null;
  end case;
  return coalesce(v, nullif(current_setting('lbe.org', true), '')::uuid);
end
$$;

revoke execute on function lbe.objective_label(text), lbe.campaign_json(lbe.campaigns), lbe.campaign_create(text, text, text, text, date, int, int),
  lbe.campaign_list(text), lbe.campaign_get(text, uuid), lbe.campaign_cancel(text, uuid) from public;
grant execute on function lbe.campaign_create(text, text, text, text, date, int, int), lbe.campaign_list(text),
  lbe.campaign_get(text, uuid), lbe.campaign_cancel(text, uuid) to lbe_api;
