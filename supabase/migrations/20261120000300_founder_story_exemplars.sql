-- P2-10 (ADR-038): two optional Brand Brain sections.
--   founder_story  — the founder's story and genuine opinions. Written by the owner. An AI may only PROPOSE it,
--                    and only with a verbatim quote from an owner-supplied source (no invented personal history).
--   exemplar_posts — authentic posts the owner chooses as style references, one entry per post, each tied to the
--                    account it was written for. The writer imitates their style, never their sentences.
-- The allowed-section lists are widened only (existing rows stay valid); both sections are optional.

create or replace function lbe.brain_sections() returns text[] language sql immutable as $$
  select array['identity', 'positioning', 'messaging', 'icp', 'ideal_follower', 'audience_problems', 'audience_language',
               'voice_company', 'voice_founder', 'founder_story', 'exemplar_posts', 'product', 'pillars_goals', 'prohibited',
               'communication_rules', 'lessons']
$$;

-- Exemplar posts carry their provenance in `structured`: which account (required), and optionally where and when
-- it was posted and why the owner chose it. Checked for approved entries AND proposals.
create function lbe.exemplar_problem(p_section text, p_body text, p_structured jsonb) returns text
language sql immutable set search_path = lbe, pg_temp as $$
  select case
    when p_section <> 'exemplar_posts' then null
    when coalesce(p_structured->>'account_kind', '') not in ('company_page', 'founder_profile')
      then 'an exemplar post must say which account it was written for (company_page or founder_profile)'
    when length(btrim(p_body)) < 40 then 'an exemplar post must contain the post text (at least 40 characters)'
    when length(p_body) > 3000 then 'an exemplar post is longer than a LinkedIn post (3,000 characters)'
    when p_structured ? 'url' and coalesce(p_structured->>'url', '') !~ '^https://[^\s]+$' then 'the link to an exemplar post must start with https://'
    when p_structured ? 'posted_on' and coalesce(p_structured->>'posted_on', '') !~ '^\d{4}-\d{2}-\d{2}$' then 'the posting date must be YYYY-MM-DD'
    else null end
$$;

create function lbe.tg_brain_exemplar_check() returns trigger
language plpgsql set search_path = lbe, pg_temp as $$
declare v_problem text := lbe.exemplar_problem(new.section, new.body, new.structured);
begin
  if v_problem is not null then raise exception '%', v_problem using errcode = 'LBE02'; end if;
  return new;
end
$$;
create trigger brand_entries_exemplar before insert or update on lbe.brand_entries
  for each row execute function lbe.tg_brain_exemplar_check();
create trigger brand_proposals_exemplar before insert on lbe.brand_proposals
  for each row execute function lbe.tg_brain_exemplar_check();

-- An AI proposal for the founder story must quote its source word for word (the extraction step already checks
-- that the quote appears in the owner's document). People write it directly; agents never invent it.
create function lbe.tg_founder_story_proposal_check() returns trigger
language plpgsql set search_path = lbe, pg_temp as $$
begin
  if new.section = 'founder_story' and new.proposer like 'agent:%' and not exists (
       select 1 from jsonb_array_elements(case when jsonb_typeof(new.evidence) = 'array' then new.evidence else '[]'::jsonb end) e
        where jsonb_typeof(e) = 'object' and length(btrim(coalesce(e->>'quote', ''))) >= 10) then
    raise exception 'an AI proposal for the founder story needs a verbatim quote from an owner-supplied source' using errcode = 'LBE02';
  end if;
  return new;
end
$$;
create trigger brand_proposals_founder_story before insert on lbe.brand_proposals
  for each row execute function lbe.tg_founder_story_proposal_check();

-- Trigger functions are never called directly (see the privilege snapshot).
revoke all on function lbe.tg_brain_exemplar_check() from public;
revoke all on function lbe.tg_founder_story_proposal_check() from public;
revoke all on function lbe.exemplar_problem(text, text, jsonb) from public;
