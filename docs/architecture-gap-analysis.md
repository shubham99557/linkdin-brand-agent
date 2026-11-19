# Architecture Gap Analysis

_2026-11-18 · Greenfield: every capability is a gap. This document records, per target capability, what LinkedIn
actually permits, what we source, and what we build._

| # | Capability (from brief) | Feasible via official API? | Source / approach | Build effort | Blocker / dependency |
|---|---|---|---|---|---|
| 1 | Company & founder content planning | n/a (internal) | Build (Supabase tables + small UI) | S | — |
| 2 | Separate brand voices | n/a | Adapt `marketingskills` context file + KWP `brand-review` (pending review) | S | Owner writes voice inputs |
| 3 | Drafting & scheduling | Yes — but **no native scheduling**; we schedule in n8n | Claude API + n8n | M | CM approval for page |
| 4 | Visuals & carousels | Yes — PDF "document" posts (≤100MB/300 pages); organic image carousels are ads-only | Satori + resvg-js + pdfkit | M | — |
| 5 | Lead magnets | n/a (own domain) | Build landing page + consent form + Umami | M | Domain, privacy policy |
| 6 | Engagement-signal ingestion | **Restricted.** Aggregates OK; member-level data only 48h and not for leads | Redesigned: aggregate analytics + 48h reply queue | M | CM approval |
| 7 | Contact & signal dedup | n/a (first-party data only) | Postgres unique keys (email, Companies House no.); Splink optional later | S | — |
| 8 | Fit scoring | First-party only | Build rule engine (no mature OSS exists) | M | ICP definition from owner |
| 9 | Intent scoring | First-party only (landing page, downloads, bookings, replies) | Build, evidence-based | M | — |
| 10 | AI response drafting | Comment replies: yes (human-approved). DMs: **no API** | Claude drafts; founder sends DMs manually | S | — |
| 11 | Human approval for outbound | n/a | Build approval queue + DB trigger | M | — |
| 12 | CRM & meetings | n/a | Adapt Atomic CRM schema in Supabase; Cal.com/Calendar integration later | M | License check Cal.com |
| 13 | Content-to-pipeline attribution | UTM on our links only | Umami + SQL views | S | — |
| 14 | Weekly learning | n/a | n8n weekly job → Claude summary of aggregates → human-approved updates | S | — |

## Gaps that cannot be closed with official APIs (documented alternatives)

| Desired action | Status | Alternative |
|---|---|---|
| Send LinkedIn DMs / InMail | Not available (partners only) | Approved draft → founder copies & sends manually; status logged |
| Identify people who engaged and add them as leads | Prohibited by API Terms | Invite engagement to the lead magnet (CTA + UTM); founder judgment in native LinkedIn |
| Native post scheduling | Not supported | Scheduled n8n job publishes approved content |
| Organic image carousel | Ads-only | PDF document post |
| Long-lived founder token | Refresh tokens partner-only (inferred) | 60-day re-auth reminder workflow |

## Environment gaps (machine)

git, Docker, Node.js, Python are not installed → required before Stage 7/8 (owner decision).
