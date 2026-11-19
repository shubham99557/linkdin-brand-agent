# Security & Compliance Review

_2026-11-18. Covers (a) findings in reviewed third-party code, (b) platform & legal constraints, (c) the controls
our design must implement. Legal points are engineering triage, not legal advice._

## A. Third-party code findings (none of this code is being imported as-is)

| Repo | Finding | Severity | Our control |
|---|---|---|---|
| social-media-agent | `upload_post` callable without approval; text mutated after approval | High | Publisher only sends rows whose approval hash = sent hash |
| social-media-agent | SSRF: unrestricted server-side fetch/screenshot of scraped URLs | High | No URL fetching in v1; render service has no network egress |
| social-media-agent | OAuth helper logs access tokens & PII; static OAuth `state` | High | Tokens only in n8n credential store; random per-request `state` |
| social-media-agent | No kill switch; auto-reshare | Medium | `control_flags` STOP checked before every call; no reshare feature |
| social-media-agent | Untrusted page text in prompts undelimited | Medium | Delimited data blocks; drafting model has no tools |
| Atomic CRM | Permissive RLS, `grant all` to anon, first signup = admin | High | Write own RLS deny-by-default + pgTAP tests; signups disabled |
| Atomic CRM | Gravatar/favicon triggers leak email hashes, fetch arbitrary hosts | Medium | Not adopted |
| Atomic CRM | Committed dev keys | Low (dev only) | Never copied; gitleaks in CI |
| Atomic CRM | Spoofable IP check, non-constant-time compare, CORS `*` | Medium | Not adopted; our webhooks use HMAC + constant-time compare, strict CORS |
| Atomic CRM | MCP `mutate` tool lets LLM write data | High | LLMs get no write tools to the DB |
| Gotenberg (fallback) | Private-IP blocking off by default | High if used | Not in v1; if used: deny private IPs, disable JS, internal network |
| Satori/resvg | Can fetch remote images | Medium | Data URIs from allow-listed bucket only |
| n8n | Wait-node webhooks need public reachability | Medium | Approvals happen in our own UI (authenticated), not public resume URLs |

## B. LinkedIn platform constraints (from official docs; see `research/raw-linkedin-api-compliance.md`)

| Constraint | Design response |
|---|---|
| API member data may not be used to identify prospects, create leads, enrich CRM, build audiences, mass-message | Lead tables accept only first-party sources (DB CHECK); API data never joined to `people` |
| Cache limits: profile data 24h; comments/reactions/posts 48h; page aggregates 1 year | `comment_queue` pg_cron purge at 48h; metrics table aggregates only, 1-year retention |
| No automated posting (API Terms §3.1(26)); no bots/automated engagement (User Agreement §8.2) | Every post and reply requires recorded human approval. **Open question for legal:** whether a human-approved post released by a scheduler counts as "automated posting". Fallback: publish on explicit "Publish now" click |
| No DM/InMail API | Founder sends manually from approved drafts |
| Delete data on user request immediately; on client request ≤10 days | Erasure function + runbook |
| Report security incidents to LinkedIn within 24h | Incident runbook |
| Must have own privacy policy at least as protective | Owner to publish before CM application |
| CM API: separate app, legal entity, super-admin verification, screencast | Prerequisite P3 |

## C. UK GDPR / PECR

| Requirement | Control |
|---|---|
| Lawful basis | Consent on lead-magnet form (versioned consent text); LIA documented for B2B follow-up |
| Art 14 notice ≤1 month for data not obtained from the person | Avoided by design: we only hold data people submit; manual founder entries trigger notice task |
| PECR: corporate subscribers (ltd/plc/LLP) may be emailed with identification + opt-out; sole traders/partnerships need consent/soft opt-in | `companies.entity_type`; send trigger checks PECR rule |
| Absolute right to object to direct marketing | `suppression` table (hashed), enforced in DB trigger |
| Retention | Retention policy table + scheduled purge; LinkedIn limits override |
| DUAA 2025: complaints procedure mandatory (19 Jun 2026); PECR fines up to £17.5m / 4% | Complaints contact in privacy notice; owner action |

## D. AI-specific controls

1. External text (comments, articles) is data in delimited blocks; injection test fixtures in CI.
2. Drafting/reply models have **no tools**; they return JSON validated against schema.
3. Claude never assigns scores, approves, or sends.
4. Factual claims must map to a verified `claims` row; otherwise item cannot be approved.
5. Every model call logged in `agent_runs` (prompt version, inputs by reference, no secrets).
6. STOP switch blocks all outbound actions within one scheduler tick.

## E. Secrets

LinkedIn tokens and Anthropic key in n8n's encrypted credential store; Supabase service-role key only in n8n
server env; `.env` git-ignored; gitleaks pre-commit. Cloned research repos never receive product secrets.
