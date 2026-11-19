-- P5-02 The owner's visual identity (colours, logo) is stored as Brand Brain entry identity/visual. It must NOT
-- count towards "Brand identity" completeness: that section is about who the brand is, in words. Same as 0500
-- except the v_present calculation.
create or replace function lbe.brain_load(p_session text) returns jsonb
language plpgsql security definer set search_path = lbe, pg_temp
as $$
declare v_user lbe.app_users; v_org uuid; v_present text[];
begin
  v_user := lbe.require_user(p_session, array['viewer', 'editor', 'approver', 'admin']);
  v_org := v_user.organization_id;
  select coalesce(array_agg(distinct section), '{}') into v_present from lbe.brand_entries
   where organization_id = v_org and status = 'approved' and not (section = 'identity' and key = 'visual');
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
