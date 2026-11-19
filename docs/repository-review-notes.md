# Repository Review Notes

_Static, read-only review on 2026-11-18. No cloned code was installed or executed. Full notes with file/line
references:_ `C:\Users\X1 Extreme Gen3\open-source-research\linkedin-brand-engine\extracted-patterns\`

## 1. langchain-ai/social-media-agent @ `bc27973` (MIT)

- **Architecture:** TypeScript + LangGraph, 14 graphs. Slack links → scrape (FireCrawl/fetch/headless) → relevance
  check → report → post → image → human interrupt (`src/agents/shared/nodes/generate-post/human-node.ts:145-290`)
  → `schedule-post.ts` queues delayed `upload_post` to X + LinkedIn.
- **LinkedIn client** (`src/clients/linkedin.ts`): legacy `v2/ugcPosts`, `v2/assets`, `v2/shares`; no
  `LinkedIn-Version` header; static token, no refresh; person/org switch via `getAuthorString`.
- **Prompts:** good two-stage report→post structure; weak anti-fabrication (one "stick to the facts" line; one
  prompt says "get creative"); scraped pages enter prompts undelimited.
- **Approval gate is weak:** `upload_post` callable without approval; text altered after approval (prefix/strip);
  auto-reshare/retweet; empty date = post now; no approver/hash record; no kill switch.
- **Security:** no committed secrets; SSRF via unrestricted server-side fetches of scraped URLs and screenshots;
  `auth-server.ts` logs access tokens & PII and uses a static `state`; Slack bridge auth bypassable by UA spoofing.
- **Tests/CI:** scheduler unit tests (35); integration tests publish real posts.
- **Verdict:** design reference; tiny pure helpers adaptable; no module reused as-is.

## 2. marmelab/atomic-crm @ `832b07a` (MIT)

- **Architecture:** React-admin + React 19 + Tailwind 4 SPA on Supabase (~44k LOC TS). Declarative schema in
  `supabase/schemas/01–08_*.sql`, 36 migrations; edge functions: users, update_password, merge_contacts,
  delete_note_attachments, postmark, mcp.
- **Data model:** companies, contacts, contact_notes, deals, deal_notes, tasks, sales, tags, configuration.
  **No uniqueness** on email/domain (manual merge).
- **RLS:** permissive `using (true)` for all authenticated users; `grant all` to `anon`; first signup becomes admin.
- **Privacy gaps:** no consent, lawful basis, source, suppression, retention, erasure or audit log. DB triggers call
  Gravatar (email hashes) and arbitrary favicon hosts (SSRF-ish via company website).
- **Other:** committed local-dev keys (`supabase/signing_keys.json`, `.env.e2e`, `supabase/functions/.env`);
  spoofable `x-forwarded-for` IP check and non-constant-time compare in postmark webhook; CORS `*`; MCP `mutate`
  tool lets an LLM change data.
- **Tests/CI:** 58 unit + 8 Playwright; lint/typecheck/build/e2e in CI; **no RLS tests**.
- **Verdict:** redesign schema (D); adapt user-sync/invite/owner-stamping functions and `_shared/authentication.ts` (C);
  reject frontend, RLS, triggers, MCP.

## 3. coreyhaines31/marketingskills @ `73573e9` (MIT)

- `.agents/product-marketing.md` context file: 14 sections incl. voice attributes with "doesn't mean" column,
  proof points, learnings-with-evidence, changelog; supports a separate personal voice profile.
- Evidence enforcement is prompt-only ("never invent stats", `[NEED: …]` markers); social hook templates encourage
  invented results.
- **Verdict:** adapt context-file structure, `references/brand-voice.md`, copy-editing checklist, "No AI tells"
  guidance (C). Hook templates rejected.

## 4. anthropics/knowledge-work-plugins `marketing/` @ `e91a134` (Apache-2.0)

- `brand-review` checks voice, terminology, pillars, style; always flags unsubstantiated superlatives, missing
  disclaimers, comparative/regulatory claims, testimonials, copyright; severity grading. Does **not** require
  evidence links or validate numbers.
- `draft-content` has no evidence step; `content-creation` examples contain unsourced statistics → rejected.
- `.mcp.json` has no LinkedIn connector.
- **Verdict:** adapt `brand-review/SKILL.md` as the basis of our brand-check prompt (C), add claims-register gate.
