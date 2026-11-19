# Branding Agent — Evaluation Plan

**Campaign:** "Build a one-week LinkedIn branding strategy for ActTrident aimed at UK businesses, focusing on phishing awareness."

## Principles
- A successful API call is **not** evidence of quality. Automated checks can only find problems, so the automated
  verdict is `NOT_READY` or `NEEDS_HUMAN_REVIEW`. Never "ready".
- Runs are isolated in an in-memory database seeded from a Brand Brain snapshot. The publisher never runs.
- Paid runs need **all** of these: `ANTHROPIC_API_KEY`, `--budget-usd`, and `--i-authorize-paid-api`. The
  workflow stops making model calls once the estimated spend reaches the budget.

## Steps
1. Complete the real Brand Brain in staging (`docs/brand-onboarding-checklist.md`), then confirm with `npm run brain:audit:staging`.
2. `npm run brain:export:staging -- --out eval-results/brain-staging.json`
3. Free dry run: `npm run eval:campaign -- --brain eval-results/brain-staging.json`
4. Paid run, once the owner authorizes it. Type the key at a hidden prompt; never put it in the command line,
   which PowerShell saves to its history file.
   ```powershell
   $env:ANTHROPIC_API_KEY = Read-Host "Anthropic key" -AsSecureString | ForEach-Object { [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($_)) }
   npm run eval:campaign -- --provider anthropic --budget-usd 5 --i-authorize-paid-api --brain eval-results/brain-staging.json
   Remove-Item Env:ANTHROPIC_API_KEY
   ```
5. The reviewer fills in `scoring-sheet.md` and checks every source link and claim.

## What a paid run is likely to cost (rough guide, not a measurement)
These are prices verified on 2026-11-19 (ADR-026) multiplied by **assumed** token counts. The real figure is
recorded per step in the run's `cost` section and is capped by `--budget-usd`.

| Step (one weekly run, 4 posts × 2 voices) | Assumed tokens (in / out) | Est. USD at Opus 5.5 |
|---|---|---|
| Research (multi-turn web search, ~6 searches) | ~50k / ~4k | ~$0.34 |
| Strategy | ~10k / ~3k | ~$0.10 |
| 8 drafts | ~8 × 5k / 1.5k | ~$0.40 |
| 8 visual briefs | ~8 × 2k / 1k | ~$0.22 |
| **Total** | | **≈ $1–2** |

Opus 5.5 always uses adaptive thinking, and thinking tokens are billed as output. Allow up to about twice the
output above. A cyber-category refusal re-runs on Opus 4.8 at $5/$25, and the budget counts that at the higher
price. **A $5 budget therefore covers one weekly run with margin.** A 4-week campaign would need roughly $5–10.

## What is measured
| Area | Automated (blocking if failed) | Human (1–5 per post) |
|---|---|---|
| Expected outputs | ≥3 sources, 4 plan items, 8 drafts (both voices), 8 visual briefs, all in review queue | — |
| Factual accuracy | Complete source references; real (non-mock) sources; no synthetic or placeholder knowledge; required sections present; unsupported statements | Check each claim against its source |
| Evidence handling | Stale, contradicted and suspicious sources excluded; contradictions reported | Are sources reputable and current? |
| ICP relevance | Lexical proxy against ICP and problems (fails if ICP is UNKNOWN) | Relevance to the real buyer |
| Brand voice | Voice heuristics; 120–250 words; ≤3 hashtags | Does it sound like us / the founder? |
| Originality & duplication | Text overlap between posts ≤0.25; no repeated openings; distinct topics; recent topics dropped | Is it fresh and non-generic? |
| Usefulness / publishability | — | Would we publish it? (Y/N) |

## Results so far (mock only — 2026-11-19)
| Run | Snapshot | Verdict | Blocking findings |
|---|---|---|---|
| mock-staging | staging (empty Brand Brain — the real current state) | NOT_READY | mock sources; 10 required sections missing; length 0/8; repeated openings; ICP unknown; mock provider |
| mock-dev-synthetic | development (all `[SYNTHETIC]`) | NOT_READY | mock sources; 13 synthetic items; length 0/8; overlap 0.36; repeated openings; mock provider |

Structural outputs all pass: 4 items, 8 drafts in both voices, visual briefs, complete source references, and the
review queue. Content quality cannot be judged until there is real Brand Brain knowledge and an authorized
Claude run.
