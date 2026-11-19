-- LinkedIn Brand Engine — Brand Brain & agent layer.
-- Adds: organizations (tenant boundary), versioned owner-approved brand knowledge, agent proposals (the ONLY
-- way agents write memory), research findings with sources, agent workflows/strategies, and the lbe_agent role.
-- Non-destructive: existing rows are assigned to the first organization.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'lbe_agent') then
    create role lbe_agent nologin;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Organizations (tenant boundary)
-- ---------------------------------------------------------------------------
create table lbe.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(name) between 1 and 200),
  slug        text not null unique check (slug ~ '^[a-z0-9-]{2,60}$'),
  created_at  timestamptz not null default clock_timestamp()
);
insert into lbe.organizations(name, slug) values ('ActTrident', 'acttrident');

-- Single-organization convenience for existing code paths (seed, CLI). SaaS onboarding must pass orgs explicitly.
create function lbe.default_org_id() returns uuid language sql stable
as $$ select id from lbe.organizations order by created_at, id limit 1 $$;

alter table lbe.app_users       add column organization_id uuid not null default lbe.default_org_id() references lbe.organizations(id);
alter table lbe.social_accounts add column organization_id uuid not null default lbe.default_org_id() references lbe.organizations(id);
alter table lbe.claims          add column organization_id uuid not null default lbe.default_org_id() references lbe.organizations(id);
create index app_users_org_idx on lbe.app_users(organization_id);
create index social_accounts_org_idx on lbe.social_accounts(organization_id);
create index claims_org_idx on lbe.claims(organization_id);

-- An approver can only be attached to an account of their own organization.
create function lbe.tg_account_approvers_org() returns trigger language plpgsql as $$
begin
  if (select organization_id from lbe.social_accounts where id = new.account_id)
     is distinct from (select organization_id from lbe.app_users where id = new.user_id) then
    raise exception 'approver must belong to the account''s organization' using errcode = 'LBE11';
  end if;
  return new;
end $$;
create trigger account_approvers_org before insert or update on lbe.account_approvers
  for each row execute function lbe.tg_account_approvers_org();

-- ---------------------------------------------------------------------------
-- Brand Brain: versioned, owner-approved knowledge
-- ---------------------------------------------------------------------------
create function lbe.brain_sections() returns text[] language sql immutable as $$
  select array['identity', 'positioning', 'messaging', 'icp', 'audience_problems', 'audience_language',
               'voice_company', 'voice_founder', 'product', 'pillars_goals', 'prohibited',
               'communication_rules', 'lessons']
$$;
create function lbe.brain_required_sections() returns text[] language sql immutable as $$
  select array['identity', 'positioning', 'messaging', 'icp', 'audience_problems', 'voice_company',
               'voice_founder', 'product', 'pillars_goals', 'prohibited']
$$;

create table lbe.brand_entries (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references lbe.organizations(id),
  section          text not null check (section = any(lbe.brain_sections())),
  key              text not null check (key ~ '^[a-z0-9_-]{1,60}$'),
  title            text not null check (length(title) between 1 and 200),
  body             text not null check (length(body) between 1 and 20000),
  structured       jsonb not null default '{}'::jsonb check (jsonb_typeof(structured) = 'object'),
  status           text not null default 'approved' check (status in ('approved', 'retired')),
  version          int not null check (version >= 1),
  source           text not null check (source in ('owner', 'import', 'agent_proposal')),
  source_ref       text check (source_ref is null or length(source_ref) <= 500),
  approved_by      uuid not null references lbe.app_users(id),
  approved_at      timestamptz not null default clock_timestamp(),
  retired_at       timestamptz,
  unique (organization_id, section, key, version)
);
create unique index brand_entries_one_current on lbe.brand_entries(organization_id, section, key) where status = 'approved';

create function lbe.tg_brand_entries_bu() returns trigger language plpgsql as $$
begin
  if new.body <> old.body or new.title <> old.title or new.structured <> old.structured or new.section <> old.section
     or new.key <> old.key or new.version <> old.version or new.organization_id <> old.organization_id
     or new.approved_by <> old.approved_by or new.source <> old.source then
    raise exception 'approved brand knowledge is immutable — create a new version' using errcode = 'LBE01';
  end if;
  if not (old.status = 'approved' and new.status = 'retired') then
    raise exception 'brand entries can only be retired' using errcode = 'LBE01';
  end if;
  new.retired_at := now();
  return new;
end $$;
create trigger brand_entries_bu before update on lbe.brand_entries for each row execute function lbe.tg_brand_entries_bu();
create trigger brand_entries_no_delete before delete on lbe.brand_entries for each row execute function lbe.tg_immutable();

create table lbe.brand_proposals (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references lbe.organizations(id),
  section          text not null check (section = any(lbe.brain_sections())),
  key              text not null check (key ~ '^[a-z0-9_-]{1,60}$'),
  title            text not null check (length(title) between 1 and 200),
  body             text not null check (length(body) between 1 and 20000),
  structured       jsonb not null default '{}'::jsonb check (jsonb_typeof(structured) = 'object'),
  rationale        text not null check (length(rationale) between 1 and 4000),
  evidence         jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  proposer         text not null check (proposer ~ '^(agent:[a-z_]{1,40}|user:[0-9a-f-]{36})$'),
  conflicts_with   uuid references lbe.brand_entries(id),
  status           text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  decided_by       uuid references lbe.app_users(id),
  decided_at       timestamptz,
  decision_note    text,
  resulting_entry  uuid references lbe.brand_entries(id),
  created_at       timestamptz not null default clock_timestamp()
);
create index brand_proposals_org_status on lbe.brand_proposals(organization_id, status, created_at desc);

create function lbe.tg_brand_proposals_bu() returns trigger language plpgsql as $$
begin
  if old.status <> 'pending' then
    raise exception 'decided proposals are immutable' using errcode = 'LBE01';
  end if;
  if new.body <> old.body or new.title <> old.title or new.section <> old.section or new.key <> old.key
     or new.organization_id <> old.organization_id or new.proposer <> old.proposer then
    raise exception 'proposal content cannot be changed; the owner edits when accepting' using errcode = 'LBE01';
  end if;
  return new;
end $$;
create trigger brand_proposals_bu before update on lbe.brand_proposals for each row execute function lbe.tg_brand_proposals_bu();
create trigger brand_proposals_no_delete before delete on lbe.brand_proposals for each row execute function lbe.tg_immutable();

-- ---------------------------------------------------------------------------
-- Agent workflows, strategies, research findings
-- ---------------------------------------------------------------------------
create table lbe.agent_workflows (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references lbe.organizations(id),
  goal             text not null check (length(goal) between 3 and 1000),
  params           jsonb not null default '{}'::jsonb,
  status           text not null default 'running' check (status in ('running', 'completed', 'failed')),
  result           jsonb,
  error            text,
  created_by       uuid not null references lbe.app_users(id),
  created_at       timestamptz not null default clock_timestamp(),
  finished_at      timestamptz
);
create index agent_workflows_org on lbe.agent_workflows(organization_id, created_at desc);

create table lbe.content_strategies (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references lbe.organizations(id),
  workflow_id      uuid not null references lbe.agent_workflows(id),
  summary          text not null,
  items            jsonb not null check (jsonb_typeof(items) = 'array'),
  created_at       timestamptz not null default clock_timestamp()
);

create table lbe.research_findings (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references lbe.organizations(id),
  workflow_id      uuid references lbe.agent_workflows(id),
  query            text not null,
  statement        text not null check (length(statement) between 3 and 2000),
  source_url       text not null check (source_url ~ '^https://[^\s]+$' and length(source_url) <= 2000),
  source_title     text,
  publisher        text,
  published_at     date,
  retrieved_at     timestamptz not null,
  confidence       text not null check (confidence in ('high', 'medium', 'low')),
  stale            boolean not null default false,
  flags            text[] not null default '{}',
  status           text not null default 'unreviewed' check (status in ('unreviewed', 'accepted', 'rejected')),
  reviewed_by      uuid references lbe.app_users(id),
  reviewed_at      timestamptz,
  created_at       timestamptz not null default clock_timestamp()
);
create index research_findings_org on lbe.research_findings(organization_id, created_at desc);

-- Agent metadata on content (NOT part of the publication package, so it never affects approvals).
alter table lbe.content_items
  add column topic text check (topic is null or length(topic) <= 300),
  add column visual_brief jsonb check (visual_brief is null or jsonb_typeof(visual_brief) = 'object'),
  add column workflow_id uuid references lbe.agent_workflows(id),
  add column variant_group uuid,
  add column created_via text not null default 'human' check (created_via in ('human', 'agent'));

alter table lbe.agent_runs drop constraint agent_runs_purpose_check;
alter table lbe.agent_runs add constraint agent_runs_purpose_check check (purpose in (
  'draft_post', 'research', 'strategy', 'creative_brief', 'performance_review', 'brand_extraction'));

-- ---------------------------------------------------------------------------
-- Identity & tenancy helpers
-- ---------------------------------------------------------------------------
drop function lbe.admin_create_user(text, text, text, text);
create function lbe.admin_create_user(p_email text, p_display_name text, p_role text, p_password text, p_org_id uuid default null)
returns uuid language plpgsql security definer set search_path = lbe, extensions, public, pg_temp
as $$
declare v_id uuid;
begin
  if p_password is null or length(p_password) < 12 then
    raise exception 'password must be at least 12 characters' using errcode = 'LBE02';
  end if;
  insert into lbe.app_users(email, display_name, role, password_hash, organization_id)
  values (lower(trim(p_email)), p_display_name, p_role, crypt(p_password, gen_salt('bf', 12)), coalesce(p_org_id, lbe.default_org_id()))
  returning id into v_id;
  perform lbe.audit('user.created', 'app_user', v_id::text, jsonb_build_object('role', p_role));
  return v_id;
end
$$;

create or replace function lbe.whoami(p_session text) returns jsonb
language sql stable security definer set search_path = lbe, pg_temp
as $$
  select jsonb_build_object('id', u.id, 'email', u.email, 'display_name', u.display_name, 'role', u.role,
                            'organization_id', u.organization_id,
                            'organization_name', (select name from lbe.organizations o where o.id = u.organization_id),
                            'approver_for', coalesce((select jsonb_agg(aa.account_id) from lbe.account_approvers aa where aa.user_id = u.id), '[]'::jsonb))
    from lbe.sessions s join lbe.app_users u on u.id = s.user_id
   where p_session is not null and s.token_hash = lbe.hash_text(p_session)
     and s.revoked_at is null and s.expires_at > now() and not u.disabled
$$;

-- Not-found (not forbidden) for other organizations' objects, so existence is not revealed.
create function lbe.assert_org(p_user lbe.app_users, p_org uuid) returns void language plpgsql as $$
begin
  if p_org is null or p_org <> p_user.organization_id then
    raise exception 'not found' using errcode = 'LBE04';
  end if;
end $$;

create function lbe.content_org(p_content_id uuid) returns uuid language sql stable as $$
  select a.organization_id from lbe.content_items c join lbe.social_accounts a on a.id = c.account_id where c.id = p_content_id
$$;

-- ---------------------------------------------------------------------------
-- Existing operations: add organization checks (bodies otherwise unchanged)
-- ---------------------------------------------------------------------------
create or replace function lbe.create_claim(p_session text, p_statement text, p_category text,
                                            p_evidence_url text, p_evidence_note text, p_expires_at timestamptz)
returns uuid language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_id uuid;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  insert into lbe.claims(statement, category, evidence_url, evidence_note, expires_at, created_by, organization_id)
  values (p_statement, p_category, nullif(p_evidence_url, ''), nullif(p_evidence_note, ''), p_expires_at, v_user.id, v_user.organization_id)
  returning id into v_id;
  return v_id;
end
$$;

create or replace function lbe.set_claim_status(p_session text, p_claim_id uuid, p_status text) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.require_user(p_session, array['approver', 'admin']);
  perform lbe.assert_org(v_user, (select organization_id from lbe.claims where id = p_claim_id));
  if p_status not in ('verified', 'rejected', 'expired') then
    raise exception 'invalid claim status' using errcode = 'LBE02';
  end if;
  update lbe.claims
     set status = p_status,
         verified_by = case when p_status = 'verified' then v_user.id else verified_by end,
         verified_at = case when p_status = 'verified' then now() else verified_at end
   where id = p_claim_id;
end
$$;

create or replace function lbe.create_content(p_session text, p_account_id uuid, p_pillar text, p_brief text,
                                              p_source_material text, p_scheduled_for timestamptz)
returns uuid language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_id uuid;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  perform lbe.assert_org(v_user, (select organization_id from lbe.social_accounts where id = p_account_id));
  if not exists (select 1 from lbe.social_accounts where id = p_account_id and p_pillar = any(pillars)) then
    raise exception 'pillar is not an approved content pillar for this account' using errcode = 'LBE02';
  end if;
  insert into lbe.content_items(account_id, pillar, brief, source_material, scheduled_for, created_by)
  values (p_account_id, p_pillar, p_brief, nullif(p_source_material, ''), p_scheduled_for, v_user.id)
  returning id into v_id;
  return v_id;
end
$$;

create or replace function lbe.update_content(p_session text, p_content_id uuid, p_patch jsonb) returns lbe.content_items
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_row lbe.content_items; v_account uuid;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  perform lbe.assert_org(v_user, lbe.content_org(p_content_id));
  if exists (select 1 from jsonb_object_keys(p_patch) k
              where k not in ('body', 'brief', 'source_material', 'pillar', 'visibility', 'scheduled_for',
                              'media_ids', 'unsupported_statements')) then
    raise exception 'unsupported field in update' using errcode = 'LBE02';
  end if;
  select account_id into v_account from lbe.content_items where id = p_content_id;
  if p_patch ? 'pillar' and not exists (select 1 from lbe.social_accounts
                                         where id = v_account and (p_patch->>'pillar') = any(pillars)) then
    raise exception 'pillar is not an approved content pillar for this account' using errcode = 'LBE02';
  end if;
  update lbe.content_items set
    body = case when p_patch ? 'body' then coalesce(p_patch->>'body', '') else body end,
    brief = case when p_patch ? 'brief' then p_patch->>'brief' else brief end,
    source_material = case when p_patch ? 'source_material' then nullif(p_patch->>'source_material', '') else source_material end,
    pillar = case when p_patch ? 'pillar' then p_patch->>'pillar' else pillar end,
    visibility = case when p_patch ? 'visibility' then p_patch->>'visibility' else visibility end,
    scheduled_for = case when p_patch ? 'scheduled_for' then (p_patch->>'scheduled_for')::timestamptz else scheduled_for end,
    media_ids = case when p_patch ? 'media_ids'
                     then array(select jsonb_array_elements_text(p_patch->'media_ids')) else media_ids end,
    unsupported_statements = case when p_patch ? 'unsupported_statements'
                                  then p_patch->'unsupported_statements' else unsupported_statements end
  where id = p_content_id
  returning * into v_row;
  return v_row;
end
$$;

create or replace function lbe.set_draft_output(p_session text, p_content_id uuid, p_body text, p_citations jsonb,
                                                p_unsupported jsonb)
returns lbe.content_items language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_row lbe.content_items; v_cite jsonb; v_org uuid;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  v_org := lbe.content_org(p_content_id);
  perform lbe.assert_org(v_user, v_org);
  select * into v_row from lbe.content_items where id = p_content_id for update;
  if v_row.status in ('queued', 'published', 'needs_reconciliation', 'rejected') then
    raise exception 'content is locked in status %', v_row.status using errcode = 'LBE01';
  end if;
  if jsonb_typeof(p_citations) <> 'array' or jsonb_typeof(p_unsupported) <> 'array' then
    raise exception 'citations and unsupported statements must be arrays' using errcode = 'LBE02';
  end if;
  delete from lbe.content_claims where content_id = p_content_id;
  for v_cite in select * from jsonb_array_elements(p_citations) loop
    if not exists (select 1 from lbe.claims c where c.id = (v_cite->>'claim_id')::uuid and c.status = 'verified'
                     and c.organization_id = v_org and (c.expires_at is null or c.expires_at > now())) then
      raise exception 'citation references a claim that is not verified for this organization' using errcode = 'LBE02';
    end if;
    insert into lbe.content_claims(content_id, claim_id, quoted_span)
    values (p_content_id, (v_cite->>'claim_id')::uuid, v_cite->>'quoted_span');
  end loop;
  update lbe.content_items set body = coalesce(p_body, ''), unsupported_statements = p_unsupported
   where id = p_content_id returning * into v_row;
  return v_row;
end
$$;

create or replace function lbe.submit_for_review(p_session text, p_content_id uuid) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  perform lbe.assert_org(v_user, lbe.content_org(p_content_id));
  update lbe.content_items set status = 'in_review' where id = p_content_id;
end
$$;

create or replace function lbe.record_agent_run(p_session text, p_run jsonb) returns uuid
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_id uuid;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  if p_run->>'content_id' is not null then
    perform lbe.assert_org(v_user, lbe.content_org((p_run->>'content_id')::uuid));
  end if;
  insert into lbe.agent_runs(purpose, provider, model, prompt_version, content_id, input_refs, output, status,
                             error, input_tokens, output_tokens, requested_by, started_at)
  values (p_run->>'purpose', p_run->>'provider', p_run->>'model', p_run->>'prompt_version',
          (p_run->>'content_id')::uuid, coalesce(p_run->'input_refs', '{}'::jsonb), p_run->'output',
          p_run->>'status', p_run->>'error', (p_run->>'input_tokens')::int, (p_run->>'output_tokens')::int,
          v_user.id, (p_run->>'started_at')::timestamptz)
  returning id into v_id;
  perform lbe.audit('ai.' || (p_run->>'purpose'), case when p_run->>'content_id' is null then 'agent_workflow' else 'content_item' end,
                    coalesce(p_run->>'content_id', p_run#>>'{input_refs,workflow_id}'),
                    jsonb_build_object('agent_run_id', v_id, 'status', p_run->>'status', 'provider', p_run->>'provider'));
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------
-- Brand Brain operations
-- ---------------------------------------------------------------------------
create function lbe.brain_load(p_session text) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_org uuid; v_present text[];
begin
  v_user := lbe.require_user(p_session, array['viewer', 'editor', 'approver', 'admin']);
  v_org := v_user.organization_id;
  select coalesce(array_agg(distinct section), '{}') into v_present from lbe.brand_entries where organization_id = v_org and status = 'approved';
  return jsonb_build_object(
    'organization', (select jsonb_build_object('id', id, 'name', name, 'slug', slug) from lbe.organizations where id = v_org),
    'entries', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'section', e.section, 'key', e.key, 'title', e.title,
                          'body', e.body, 'structured', e.structured, 'version', e.version, 'source', e.source,
                          'source_ref', e.source_ref, 'approved_at', e.approved_at) order by e.section, e.key)
                         from lbe.brand_entries e where e.organization_id = v_org and e.status = 'approved'), '[]'::jsonb),
    'missing_sections', to_jsonb(array(select s from unnest(lbe.brain_required_sections()) s where not s = any(v_present))),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'display_name', a.display_name,
                          'pillars', a.pillars, 'publishing_mode', a.publishing_mode) order by a.kind)
                          from lbe.social_accounts a where a.organization_id = v_org), '[]'::jsonb),
    'claims', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'statement', c.statement, 'category', c.category,
                          'evidence_url', c.evidence_url, 'evidence_note', c.evidence_note) order by c.created_at)
                        from lbe.claims c where c.organization_id = v_org and c.status = 'verified'
                          and (c.expires_at is null or c.expires_at > now())), '[]'::jsonb),
    'recent_topics', coalesce((select jsonb_agg(jsonb_build_object('content_id', ci.id, 'topic', coalesce(ci.topic, left(ci.brief, 200)),
                          'pillar', ci.pillar, 'account_kind', a.kind, 'status', ci.status, 'created_at', ci.created_at) order by ci.created_at desc)
                        from lbe.content_items ci join lbe.social_accounts a on a.id = ci.account_id
                       where a.organization_id = v_org and ci.created_at > now() - interval '90 days'
                         and ci.status <> 'rejected'), '[]'::jsonb),
    'pending_proposals', (select count(*) from lbe.brand_proposals where organization_id = v_org and status = 'pending'));
end
$$;

create function lbe.brain_write_entry(p_org uuid, p_section text, p_key text, p_title text, p_body text, p_structured jsonb,
                                      p_source text, p_source_ref text, p_user uuid) returns uuid
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_id uuid; v_version int;
begin
  select coalesce(max(version), 0) + 1 into v_version from lbe.brand_entries where organization_id = p_org and section = p_section and key = p_key;
  update lbe.brand_entries set status = 'retired' where organization_id = p_org and section = p_section and key = p_key and status = 'approved';
  insert into lbe.brand_entries(organization_id, section, key, title, body, structured, version, source, source_ref, approved_by)
  values (p_org, p_section, p_key, p_title, p_body, coalesce(p_structured, '{}'::jsonb), v_version, p_source, p_source_ref, p_user)
  returning id into v_id;
  perform lbe.audit('brain.entry_approved', 'brand_entry', v_id::text,
                    jsonb_build_object('section', p_section, 'key', p_key, 'version', v_version, 'source', p_source));
  return v_id;
end
$$;

-- Owner (admin) writes approved knowledge directly (onboarding, imports, corrections).
create function lbe.brain_upsert_entry(p_session text, p_section text, p_key text, p_title text, p_body text,
                                       p_structured jsonb, p_source text, p_source_ref text) returns uuid
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.require_user(p_session, array['admin']);
  if p_source not in ('owner', 'import') then
    raise exception 'direct writes must be owner or import; agent knowledge goes through proposals' using errcode = 'LBE02';
  end if;
  return lbe.brain_write_entry(v_user.organization_id, p_section, p_key, p_title, p_body, p_structured, p_source, p_source_ref, v_user.id);
end
$$;

create function lbe.brain_retire_entry(p_session text, p_entry_id uuid) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.require_user(p_session, array['admin']);
  perform lbe.assert_org(v_user, (select organization_id from lbe.brand_entries where id = p_entry_id));
  update lbe.brand_entries set status = 'retired' where id = p_entry_id and status = 'approved';
  perform lbe.audit('brain.entry_retired', 'brand_entry', p_entry_id::text, '{}'::jsonb);
end
$$;

-- The ONLY way an agent (or a non-admin) can change Brand Brain knowledge: a pending proposal.
create function lbe.brain_propose(p_session text, p_section text, p_key text, p_title text, p_body text,
                                  p_structured jsonb, p_rationale text, p_evidence jsonb, p_agent_role text)
returns uuid language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_current lbe.brand_entries; v_id uuid;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  select * into v_current from lbe.brand_entries
   where organization_id = v_user.organization_id and section = p_section and key = p_key and status = 'approved';
  insert into lbe.brand_proposals(organization_id, section, key, title, body, structured, rationale, evidence, proposer, conflicts_with)
  values (v_user.organization_id, p_section, p_key, p_title, p_body, coalesce(p_structured, '{}'::jsonb), p_rationale,
          coalesce(p_evidence, '[]'::jsonb),
          case when p_agent_role is not null then 'agent:' || p_agent_role else 'user:' || v_user.id::text end,
          case when v_current.id is not null and v_current.body <> p_body then v_current.id end)
  returning id into v_id;
  perform lbe.audit('brain.proposed', 'brand_proposal', v_id::text,
                    jsonb_build_object('section', p_section, 'key', p_key, 'agent_role', p_agent_role, 'conflict', v_current.id is not null));
  return v_id;
end
$$;

create function lbe.brain_decide_proposal(p_session text, p_proposal_id uuid, p_decision text, p_note text,
                                          p_edited_title text, p_edited_body text) returns uuid
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_p lbe.brand_proposals; v_entry uuid;
begin
  v_user := lbe.require_user(p_session, array['admin']);
  select * into v_p from lbe.brand_proposals where id = p_proposal_id for update;
  perform lbe.assert_org(v_user, v_p.organization_id);
  if v_p.status <> 'pending' then raise exception 'proposal already decided' using errcode = 'LBE01'; end if;
  if p_decision = 'accepted' then
    v_entry := lbe.brain_write_entry(v_p.organization_id, v_p.section, v_p.key,
                                     coalesce(nullif(p_edited_title, ''), v_p.title), coalesce(nullif(p_edited_body, ''), v_p.body),
                                     v_p.structured, case when v_p.proposer like 'agent:%' then 'agent_proposal' else 'owner' end,
                                     'proposal:' || v_p.id::text, v_user.id);
  elsif p_decision <> 'rejected' then
    raise exception 'decision must be accepted or rejected' using errcode = 'LBE02';
  end if;
  update lbe.brand_proposals set status = p_decision, decided_by = v_user.id, decided_at = now(),
         decision_note = p_note, resulting_entry = v_entry where id = p_proposal_id;
  perform lbe.audit('brain.proposal_' || p_decision, 'brand_proposal', p_proposal_id::text, jsonb_build_object('entry', v_entry));
  return v_entry;
end
$$;

create function lbe.brain_list_proposals(p_session text, p_status text) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.require_user(p_session, array['viewer', 'editor', 'approver', 'admin']);
  return coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object(
            'current_body', (select body from lbe.brand_entries e where e.id = p.conflicts_with)) order by p.created_at desc)
          from lbe.brand_proposals p
         where p.organization_id = v_user.organization_id and (p_status is null or p.status = p_status)), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------------------
-- Workflows, strategy, research, agent metadata
-- ---------------------------------------------------------------------------
create function lbe.workflow_create(p_session text, p_goal text, p_params jsonb) returns uuid
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_id uuid;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  insert into lbe.agent_workflows(organization_id, goal, params, created_by)
  values (v_user.organization_id, p_goal, coalesce(p_params, '{}'::jsonb), v_user.id) returning id into v_id;
  perform lbe.audit('agent.workflow_started', 'agent_workflow', v_id::text, jsonb_build_object('goal', left(p_goal, 200)));
  return v_id;
end
$$;

create function lbe.workflow_finish(p_session text, p_workflow_id uuid, p_status text, p_result jsonb, p_error text) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  perform lbe.assert_org(v_user, (select organization_id from lbe.agent_workflows where id = p_workflow_id));
  if p_status not in ('completed', 'failed') then raise exception 'invalid workflow status' using errcode = 'LBE02'; end if;
  update lbe.agent_workflows set status = p_status, result = p_result, error = left(p_error, 2000), finished_at = now()
   where id = p_workflow_id and status = 'running';
  if not found then raise exception 'workflow is not running' using errcode = 'LBE01'; end if;
  perform lbe.audit('agent.workflow_' || p_status, 'agent_workflow', p_workflow_id::text, '{}'::jsonb);
end
$$;

create function lbe.strategy_save(p_session text, p_workflow_id uuid, p_summary text, p_items jsonb) returns uuid
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_id uuid;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  perform lbe.assert_org(v_user, (select organization_id from lbe.agent_workflows where id = p_workflow_id));
  insert into lbe.content_strategies(organization_id, workflow_id, summary, items)
  values (v_user.organization_id, p_workflow_id, p_summary, p_items) returning id into v_id;
  return v_id;
end
$$;

create function lbe.research_record(p_session text, p_workflow_id uuid, p_findings jsonb) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_f jsonb; v_ids jsonb := '[]'::jsonb; v_id uuid;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  if p_workflow_id is not null then
    perform lbe.assert_org(v_user, (select organization_id from lbe.agent_workflows where id = p_workflow_id));
  end if;
  for v_f in select * from jsonb_array_elements(p_findings) loop
    insert into lbe.research_findings(organization_id, workflow_id, query, statement, source_url, source_title, publisher,
                                      published_at, retrieved_at, confidence, stale, flags)
    values (v_user.organization_id, p_workflow_id, coalesce(v_f->>'query', ''), v_f->>'statement', v_f->>'source_url',
            v_f->>'source_title', v_f->>'publisher', (v_f->>'published_at')::date, (v_f->>'retrieved_at')::timestamptz,
            v_f->>'confidence', coalesce((v_f->>'stale')::boolean, false),
            coalesce(array(select jsonb_array_elements_text(v_f->'flags')), '{}'))
    returning id into v_id;
    v_ids := v_ids || to_jsonb(v_id);
  end loop;
  return v_ids;
end
$$;

create function lbe.research_review(p_session text, p_finding_id uuid, p_status text) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.require_user(p_session, array['approver', 'admin']);
  perform lbe.assert_org(v_user, (select organization_id from lbe.research_findings where id = p_finding_id));
  if p_status not in ('accepted', 'rejected') then raise exception 'invalid status' using errcode = 'LBE02'; end if;
  update lbe.research_findings set status = p_status, reviewed_by = v_user.id, reviewed_at = now() where id = p_finding_id;
end
$$;

-- A human turns a research finding into a DRAFT claim; an approver must still verify it.
create function lbe.research_to_claim(p_session text, p_finding_id uuid, p_category text) returns uuid
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_f lbe.research_findings;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  select * into v_f from lbe.research_findings where id = p_finding_id;
  perform lbe.assert_org(v_user, v_f.organization_id);
  return lbe.create_claim(p_session, v_f.statement, p_category, v_f.source_url,
    format('From research finding %s (retrieved %s, confidence %s%s). Verify against the source before approving.',
           v_f.id, to_char(v_f.retrieved_at, 'YYYY-MM-DD'), v_f.confidence, case when v_f.stale then ', STALE' else '' end), null);
end
$$;

create function lbe.set_agent_metadata(p_session text, p_content_id uuid, p_meta jsonb) returns void
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  perform lbe.assert_org(v_user, lbe.content_org(p_content_id));
  if p_meta ? 'workflow_id' then
    perform lbe.assert_org(v_user, (select organization_id from lbe.agent_workflows where id = (p_meta->>'workflow_id')::uuid));
  end if;
  update lbe.content_items set
    topic = case when p_meta ? 'topic' then p_meta->>'topic' else topic end,
    visual_brief = case when p_meta ? 'visual_brief' then p_meta->'visual_brief' else visual_brief end,
    workflow_id = case when p_meta ? 'workflow_id' then (p_meta->>'workflow_id')::uuid else workflow_id end,
    variant_group = case when p_meta ? 'variant_group' then (p_meta->>'variant_group')::uuid else variant_group end,
    created_via = case when p_meta ? 'created_via' then p_meta->>'created_via' else created_via end
  where id = p_content_id;
end
$$;

create function lbe.workflow_list(p_session text) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.require_user(p_session, array['viewer', 'editor', 'approver', 'admin']);
  return coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'goal', w.goal, 'status', w.status, 'created_at', w.created_at,
            'finished_at', w.finished_at, 'drafts', (select count(*) from lbe.content_items c where c.workflow_id = w.id)) order by w.created_at desc)
          from (select * from lbe.agent_workflows where organization_id = v_user.organization_id order by created_at desc limit 50) w), '[]'::jsonb);
end
$$;

create function lbe.workflow_get(p_session text, p_workflow_id uuid) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_w lbe.agent_workflows;
begin
  v_user := lbe.require_user(p_session, array['viewer', 'editor', 'approver', 'admin']);
  select * into v_w from lbe.agent_workflows where id = p_workflow_id;
  perform lbe.assert_org(v_user, v_w.organization_id);
  return to_jsonb(v_w) || jsonb_build_object(
    'strategy', (select to_jsonb(s) from lbe.content_strategies s where s.workflow_id = v_w.id order by created_at desc limit 1),
    'findings', coalesce((select jsonb_agg(to_jsonb(f) order by f.created_at) from lbe.research_findings f where f.workflow_id = v_w.id), '[]'::jsonb),
    'drafts', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'status', c.status, 'account_kind', a.kind, 'account_name', a.display_name,
                 'pillar', c.pillar, 'topic', c.topic, 'body', c.body, 'scheduled_for', c.scheduled_for, 'variant_group', c.variant_group,
                 'unsupported', c.unsupported_statements, 'visual_brief', c.visual_brief,
                 'citations', (select coalesce(jsonb_agg(jsonb_build_object('claim_id', cc.claim_id, 'quoted_span', cc.quoted_span)), '[]'::jsonb)
                                 from lbe.content_claims cc where cc.content_id = c.id)) order by c.scheduled_for nulls last, a.kind)
               from lbe.content_items c join lbe.social_accounts a on a.id = c.account_id where c.workflow_id = v_w.id), '[]'::jsonb));
end
$$;

create function lbe.research_list(p_session text) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.require_user(p_session, array['viewer', 'editor', 'approver', 'admin']);
  return coalesce((select jsonb_agg(to_jsonb(f) order by f.created_at desc)
          from (select * from lbe.research_findings where organization_id = v_user.organization_id order by created_at desc limit 200) f), '[]'::jsonb);
end
$$;

-- Approval & publishing feedback for the learning review (read-only, org-scoped).
create function lbe.learning_inputs(p_session text) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users;
begin
  v_user := lbe.require_user(p_session, array['editor', 'approver', 'admin']);
  return jsonb_build_object(
    'decisions', coalesce((select jsonb_agg(jsonb_build_object('content_id', ap.content_id, 'decision', ap.decision, 'note', ap.note,
                     'account_kind', a.kind, 'pillar', c.pillar, 'topic', coalesce(c.topic, left(c.brief, 200)), 'created_via', c.created_via,
                     'at', ap.created_at) order by ap.created_at desc)
                   from lbe.content_approvals ap join lbe.content_items c on c.id = ap.content_id
                   join lbe.social_accounts a on a.id = c.account_id
                  where a.organization_id = v_user.organization_id and ap.created_at > now() - interval '90 days'), '[]'::jsonb),
    'publications', coalesce((select jsonb_agg(jsonb_build_object('content_id', o.content_id, 'status', o.status, 'provider', o.provider,
                     'account_kind', a.kind, 'topic', coalesce(c.topic, left(c.brief, 200))) order by o.created_at desc)
                   from lbe.publication_outbox o join lbe.social_accounts a on a.id = o.account_id join lbe.content_items c on c.id = o.content_id
                  where a.organization_id = v_user.organization_id and o.created_at > now() - interval '90 days'), '[]'::jsonb),
    'metrics', 'none_available');
end
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema lbe from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on lbe.organizations, lbe.brand_entries, lbe.brand_proposals, lbe.agent_workflows, lbe.content_strategies, lbe.research_findings from %I', r);
      execute format('revoke execute on all functions in schema lbe from %I', r);
    end if;
  end loop;
end
$$;

alter table lbe.organizations enable row level security;
alter table lbe.brand_entries enable row level security;
alter table lbe.brand_proposals enable row level security;
alter table lbe.agent_workflows enable row level security;
alter table lbe.content_strategies enable row level security;
alter table lbe.research_findings enable row level security;
-- No SELECT grants on Brand Brain tables for any application role: reads go through org-scoped definer functions.

grant execute on function
  lbe.whoami(text),
  lbe.brain_load(text), lbe.brain_upsert_entry(text, text, text, text, text, jsonb, text, text),
  lbe.brain_retire_entry(text, uuid),
  lbe.brain_propose(text, text, text, text, text, jsonb, text, jsonb, text),
  lbe.brain_decide_proposal(text, uuid, text, text, text, text), lbe.brain_list_proposals(text, text),
  lbe.workflow_create(text, text, jsonb), lbe.workflow_finish(text, uuid, text, jsonb, text),
  lbe.workflow_list(text), lbe.workflow_get(text, uuid), lbe.strategy_save(text, uuid, text, jsonb),
  lbe.research_record(text, uuid, jsonb), lbe.research_review(text, uuid, text), lbe.research_to_claim(text, uuid, text),
  lbe.research_list(text), lbe.set_agent_metadata(text, uuid, jsonb), lbe.learning_inputs(text)
to lbe_api;

-- lbe_agent: the agent runtime. It can read the Brand Brain, record research/strategy/proposals and create
-- DRAFTS (submitted for review). It cannot approve, release, publish, stop/resume, verify claims, or write
-- approved brand knowledge.
grant usage on schema lbe to lbe_agent;
grant execute on function
  lbe.whoami(text), lbe.brain_load(text),
  lbe.brain_propose(text, text, text, text, text, jsonb, text, jsonb, text),
  lbe.workflow_create(text, text, jsonb), lbe.workflow_finish(text, uuid, text, jsonb, text), lbe.workflow_get(text, uuid),
  lbe.strategy_save(text, uuid, text, jsonb), lbe.research_record(text, uuid, jsonb),
  lbe.set_agent_metadata(text, uuid, jsonb), lbe.learning_inputs(text),
  lbe.create_content(text, uuid, text, text, text, timestamptz),
  lbe.set_draft_output(text, uuid, text, jsonb, jsonb),
  lbe.record_agent_run(text, jsonb),
  lbe.submit_for_review(text, uuid)
to lbe_agent;
