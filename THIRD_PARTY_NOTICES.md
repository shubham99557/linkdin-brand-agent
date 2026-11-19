# Third-Party Notices

## Copied or adapted source code

**None.** Phase 1 contains no source code copied from the research snapshots in
`open-source-research/linkedin-brand-engine/clones/`. The following were used as **design references only**
(ideas reimplemented in our own words and code):

| Project | Licence | Commit reviewed | What informed our design |
|---|---|---|---|
| langchain-ai/social-media-agent | MIT | bc27973c9c11f5c4929d78f26cb9ed200ab017f2 | Two-stage brief→post drafting; human review step (and its weaknesses, which our hash-bound approvals fix) |
| marmelab/atomic-crm | MIT | 832b07a89be2d9265a66bbf879fed0299c14ebfb | Supabase schema layout (not used in Phase 1) |
| coreyhaines31/marketingskills | MIT | 73573e94a06a39965978b3fa1f9c1eace8cebc7c | Voice-profile structure with "means / does not mean" columns |
| anthropics/knowledge-work-plugins (marketing/brand-review) | Apache-2.0 | e91a134584eb798bac7fb0379358006a2b63b965 | Brand-review checks for unsubstantiated superlatives and regulatory claims |
| Libr-AI/OpenFactVerification | MIT | (design only) | Claim-checking pipeline idea |

## Runtime dependencies

Installed from npm and listed with exact versions in `package-lock.json`. Licences: MIT and Apache-2.0
(see ADR-009). PGlite bundles PostgreSQL (PostgreSQL Licence).
