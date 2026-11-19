# Prompt Review for Real Models (P3-03)

_2026-11-19. Target model: Claude Opus 5.5 (`claude-opus-5-5`); thinking is always on, effort `medium`. Method:
the Claude API reference's prompt-audit guide, plus the product's own acceptance checks: audience-aware
planning, originality, length, and alignment with the Brand Brain sections. **No real model was called.**
Every change below is a hypothesis until the paid evaluation (P3-04) and human scoring (P3-05) measure it._

## Surfaces reviewed

| Surface | File | Version |
|---|---|---|
| Writer (LinkedIn Writing Specialist) | `services/drafting/src/prompt.ts` | draft-post.v2 → **v3** |
| Strategy | `services/agents/src/anthropic-specialists.ts` | strategy.v1 → **v2** |
| Creative brief | same | creative.v1 → **v2** |
| Research (web search) | same | research.v1 (unchanged) |
| Performance / learning | same | performance.v1 (unchanged) |
| Brand extraction | same | extraction.v1 (unchanged) |
| Request config | both adapters | reviewed |

Prompt versions are recorded on every agent run (`agent_runs.prompt_version`), so evaluation results can be
compared per version.

## Findings and changes

| # | Surface | Finding | Change |
|---|---|---|---|
| 1 | Writer | **The audience was implicit.** The ideal-customer, audience-problem and audience-language sections reached the model, but nothing said how to use them. | A short paragraph says who the post is for and that it must speak to one real problem in the readers' own words. Where those sections are UNKNOWN, the post stays general rather than guessing (the Brand Brain rule). |
| 2 | Writer | **Originality could not be achieved.** Each post was written blind to the others, yet the evaluation fails a run on repeated openings and >25% text overlap. The writer had no information to avoid them. | The orchestrator now passes the opening lines of posts already written in the same plan (`otherOpenings`, as an escaped data block). The prompt asks for a different opening and a varied shape, and explains why: LinkedIn shows only the first two lines before "see more". |
| 3 | Writer | Constraints had no reasons ("Plain text only", "No engagement bait", "120–250 words"). | Each now carries its reason: LinkedIn doesn't render markdown; LinkedIn demotes engagement bait; the word range is the owner's house style (A-06), which the evaluation checks. The numeric range is kept because it is a business rule, not a verbosity clamp. |
| 4 | Strategy | **Planning didn't target the customer.** `audience_problem` was in the schema, but the prompt didn't tie it to the Brand Brain. Campaign objectives and weekly focus (P5-05) arrive inside the goal, yet the prompt didn't say to follow them. | Each item must address one concrete problem of the ideal customer, using the audience-problems section, and serve the goal's objective and weekly focus. With UNKNOWN sections it picks problems any UK business recognises and keeps claims general. |
| 5 | Strategy | "Do not repeat recent topics" was a bare prohibition. | Replaced with a positive description: items distinct in problem and angle, preferring angles a generic vendor couldn't post, with the reason that near-repeats are dropped by the system and wasted. |
| 6 | Creative | **Alt text wasn't specified**, but since P5-06 the database blocks review if the alt text is under 15 characters or generic. Short model alt text would have held drafts back. | The prompt explains that alt text is read to screen-reader users and published, and asks for one or two full sentences that include the on-image text. |
| 7 | Creative | **Format choice was unguided, and the slide limit didn't match the renderer.** The schema allows 10 slides; the renderer shows a cover plus 9, so a 10th slide would be silently lost. | The prompt says when to use carousel, single image or text-only, and that the headline becomes the cover plus up to 9 slides. It also explains that briefs are rendered automatically, so the text appears verbatim on the image. |
| 8 | Creative | "Never add statistics…" had no reason. | Reason added: the post's facts were checked; facts added to the visual would not be. |

## Kept deliberately (audit keep-list)

These were not cut:
- **Fact-safety rules:** approved claims only; no invented statistics, CVEs, customers or certifications;
  `[NEEDS EVIDENCE]`. These are business and compliance constraints for a cybersecurity company, and they are
  enforced in code (claim checker, restatement check). They have a stated reason, so they stay.
- **Prompt-injection notes and delimited data blocks:** research, documents and other openings are wrapped in
  data blocks with escaping. This is contract detail.
- **One-line role statements** at the top of each prompt.
- **"Never publish / never approve" statements:** they describe the product's real boundaries, which the
  database also enforces.

## Dated patterns — none found

- No "think step by step", scratchpads or reasoning fields.
- No pressure language: no CAPS MUST/NEVER clusters, no "be thorough".
- No assistant prefill, no `temperature`, `budget_tokens` or `tool_choice`.
- Structured outputs are used for every specialist except research, which needs the web-search tool; its
  sources are checked against the URLs the tool actually returned.

## Request configuration notes

- **`max_tokens: 16000`.**
  - **Risk:** thinking is always on for Opus 5.5 and counts towards `max_tokens`. A long thinking pass could
    hit the limit. This is not seen yet, because it needs real calls.
  - **Mitigation:** `stop_reason: "max_tokens"` is already handled as a step error, so the draft is held or
    the step fails, and there is a per-step time limit.
  - **Action in P3-04:** if any run records "output truncated (max_tokens)", raise the limit. Above about
    21k, switch that call to streaming, because the SDK refuses long non-streaming requests.
- `fallbacks: "default"` with `server-side-fallback-2026-07-01` is valid. Cost handling is covered in P3-01 and
  ADR-026.
- Effort `medium` is Opus 5.5's default. Change it only if the evaluation shows a quality or cost problem; tune
  depth through effort, not prose.

## What only the paid evaluation can tell (P3-04/P3-05)

- Whether the posts now actually address the customer's problem in their language (human score: relevance).
- Whether openings differ and overlap drops (automated checks: repeated openings, max overlap ≤ 0.25).
- Whether drafts land in 120–250 words (automated check).
- Whether alt text passes the database rule without manual fixes.
- Thinking or token use against `max_tokens`, and cost against the guide in `docs/evaluation-plan.md`.
