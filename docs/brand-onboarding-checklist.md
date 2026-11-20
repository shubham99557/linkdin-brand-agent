# ActTrident Brand Onboarding Checklist

_2026-11-19. The staging Brand Brain is empty (correct) and the development Brand Brain is entirely `[SYNTHETIC]`
(see `npm run brain:audit`). No real ActTrident facts exist in the system yet. **Nothing below may be filled in
by the agent or by an engineer on the owner's behalf.** Missing items stay UNKNOWN._

How to enter (easiest): dashboard → **Brand Brain** → **Start guided setup** (owner/admin). It asks one topic at a
time in this order — identity, positioning, customers, problems, product, messages, both voices, content pillars,
campaign goals, never-say list, optional extras, then proof (claims) — shows progress, lets you skip anything
(it stays UNKNOWN) and resumes where you left off. Alternatively use *Fill in* per section, or paste source material into
*Add knowledge from a document* and accept the grounded proposals. Facts that need proof go into the **Claims
register** with an evidence link, and an approver verifies them there.

| # | Input | Owner provides | Source / proof expected | Section | Status |
|---|---|---|---|---|---|
| 1 | Company identity | 1–2 sentence description; what people should remember; visual identity rules (colours, imagery to avoid) | Website "about", brand guide | `identity` | UNKNOWN |
| 2 | Positioning | Who it is for, the alternative they use today, what is different (provable only) | Sales deck, competitor notes | `positioning` | UNKNOWN |
| 3 | Key messages | 3–5 repeatable messages + which claim proves each | Messaging doc | `messaging` | UNKNOWN |
| 4 | Buyer ICP (who buys) | Company characteristics, decision-maker roles, buying problems, regions, buying criteria you have actually seen, who NOT to target | CRM wins, sales notes | `icp` | UNKNOWN |
| 4b | Ideal follower (who reads) | Who should value and follow the posts, topics they follow, their words and questions, how they relate to buyers (advise, influence, refer). **Not the same as the buyer** (P2-09) | Comments, community groups, conversations | `ideal_follower` | UNKNOWN |
| 5 | Customer problems | Problems and buying triggers, in buyers' words | Call notes, support tickets (anonymised) | `audience_problems`, `audience_language` | UNKNOWN |
| 6 | Product capabilities | What the product does **today** and what may be said publicly; no roadmap | Product docs, release notes | `product` | UNKNOWN |
| 7 | Verified claims & proof | Each factual statement to be used (company facts, capability, statistics, customer outcomes **with written permission**, certifications **with certificate**) | Link or document per claim; expiry date for statistics | Claims register | UNKNOWN (0 real claims) |
| 8 | Company voice | How the page sounds; 3–5 real example posts; words to avoid | Past posts | `voice_company` | UNKNOWN (file `brand/voice/company.md` is a placeholder) |
| 9 | Founder voice | How the founder sounds; topics welcome/off-limits; 3–5 real posts. **Founder approves this section personally.** | Founder's past posts | `voice_founder` | UNKNOWN (placeholder file) |
| 10 | Content pillars & goals | Quarter goal (e.g. awareness / demo requests) and 3–5 pillars per account | Marketing plan | `pillars_goals` + account pillars | UNKNOWN (account pillars are dev defaults) |
| 11 | Prohibited claims & topics | Words that must never appear; off-limits topics (e.g. named incidents, client names, competitor pricing) | Legal/compliance guidance | `prohibited` (terms + topics) | UNKNOWN |
| 12 | Communication rules (optional) | Hashtags, emoji, length, legal wording | Brand guide | `communication_rules` | UNKNOWN |

## Before the first internal evaluation

1. Complete items 1–11 (including 4b) in **staging** (not dev): `npm run start:staging` → Brand Brain.
2. Run `npm run brain:audit:staging` → it should show **no** SYNTHETIC/PLACEHOLDER/UNKNOWN required sections.
3. Verify at least 3–5 real claims relevant to phishing awareness (statistics need a dated, reputable source).
4. Replace the development account pillars with the real ones (admin SQL today; a UI edit is a known gap).
5. Then run the evaluation campaign (`docs/evaluation-plan.md`).
