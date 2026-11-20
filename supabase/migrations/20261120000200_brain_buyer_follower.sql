-- P2-09 (ADR-038): the Brand Brain separates the BUYER (who buys) from the IDEAL FOLLOWER (who reads and follows
-- the content). The existing `icp` section keeps its key and holds the buyer ICP, so existing entries, proposals
-- and history stay valid. A new required section `ideal_follower` is added. Only the allowed-section lists change:
-- the list is widened, so no existing row can become invalid. Same rules as every section: owner-approved,
-- versioned and audited; agents only propose (lbe.brain_propose).

create or replace function lbe.brain_sections() returns text[] language sql immutable as $$
  select array['identity', 'positioning', 'messaging', 'icp', 'ideal_follower', 'audience_problems', 'audience_language',
               'voice_company', 'voice_founder', 'product', 'pillars_goals', 'prohibited',
               'communication_rules', 'lessons']
$$;

create or replace function lbe.brain_required_sections() returns text[] language sql immutable as $$
  select array['identity', 'positioning', 'messaging', 'icp', 'ideal_follower', 'audience_problems', 'voice_company',
               'voice_founder', 'product', 'pillars_goals', 'prohibited']
$$;
