# Agent Capability Inventory

_Inspected 2026-11-19, before the agent layer was built (Phase A). The "After" column is the state once this
work was complete._

| Capability | Before | After | Where |
|---|---|---|---|
| Brand identity, positioning, messaging | Missing (free text in voice files only) | **Built** — versioned, owner-approved Brand Brain sections | `lbe.brand_entries`, Brand Brain page |
| Ideal customer profiles, audience problems & language | Missing | **Built** (sections `icp`, `audience_problems`, `audience_language`) | same |
| Company and founder voices | Partial — `brand/voice/*.md` files, placeholder text | **Built** — Brand Brain `voice_company` / `voice_founder`; files importable; file fallback kept | `buildBrandContext`, `voiceFor` |
| Product knowledge | Missing | **Built** (section `product`) | — |
| Verified claims with evidence | **Existed** (`lbe.claims`, immutable when verified) | Reused; now organization-scoped; research → draft claim hand-off | `research_to_claim` |
| Content pillars & campaign goals | Done (P2-01) | Pillars: `social_accounts.pillars`, owner-edited in Brand Brain → *Content pillars* (single source); goals narrative: section `pillars_goals` ("Campaign goals") | — |
| Historical content & topic tracking | Missing | **Built** — `content_items.topic`, 90-day recent topics, duplicate detection | `validateStrategy` |
| Feedback, performance & learning memory | Missing (approval notes unused) | **Built** — learning review → owner-approved `lessons` / `communication_rules` | `runLearningReview` |
| Prohibited claims, topics & rules | Partial (detector patterns; text in voice files) | **Built** — `prohibited` section with structured terms/topics, enforced on drafts and plans | `checkBrandRules` |
| Research with sources | Missing | **Built** — URLs, retrieval time, confidence, staleness, injection flags; Claude web search (not executed) + mock | `research_findings` |
| Content strategy | Missing | **Built** | Content Strategy Specialist |
| Drafting with claim checking | **Existed** | Reused, now with Brand Brain context (prompt `draft-post.v2`) | `@lbe/drafting` |
| Visual briefs | Missing (render service deferred) | **Built** (briefs only; no image rendering) | Creative Brief Specialist |
| Human approval, outbox, STOP, audit | **Existed** | Reused unchanged; agent cannot use them (DB role) | — |
| Brand onboarding | Missing | **Built** — guided questions, file import, document → grounded proposals | Brand Brain page |
| Agent workspace | Missing | **Built** | Agent workspace page |
| Organization / tenant isolation | Missing (single-tenant, ADR-012) | **Partial** — organizations; memory and write paths isolated; some read views still global | ADR-019 |
| Claude Code specialist prototypes | Missing | **Built** — 6 project agents + `CLAUDE.md` | `.claude/agents/` |
