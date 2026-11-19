# License Review

_2026-11-18. Engineering triage, **not legal advice**. Items marked LEGAL need owner/solicitor sign-off._

| Component | License | Use | Obligations | Status |
|---|---|---|---|---|
| n8n CE | Sustainable Use License; `.ee.` files Enterprise | Self-hosted, internal business use | No resale/hosting n8n for third parties; don't use `.ee` features without licence | **LEGAL** — confirm the engine is only used by ActTrident internally. If it becomes a product sold to others, a commercial n8n licence (or replacing n8n) is required |
| social-media-agent | MIT | Adapt small pieces | Keep copyright + MIT notice in adapted files / `THIRD_PARTY_NOTICES.md` | PASS |
| Atomic CRM | MIT | Adapt schema/UI | MIT notice | PASS |
| marketingskills | MIT | Adapt context-file/skill text | MIT notice | PASS |
| knowledge-work-plugins/marketing | Apache-2.0 | Adapt brand-review skill | Include LICENSE, NOTICE (if present), mark modified files with change statement | PASS |
| Satori, resvg-js | MPL-2.0 | npm dependency, unmodified | If we modify their files, publish those files' source | PASS (unmodified) |
| pdfkit, Umami, Gotenberg, Pydantic AI, LangGraph, Splink, Evidence | MIT / Apache-2.0 | Dependency / service | Notices | PASS |
| Takumi | Apache-2.0 | Trial only | Notices | PASS |
| Postiz | AGPL-3.0 | Design reference only | **No code copied**; patterns reimplemented from LinkedIn's own docs | PASS (as reference) |
| Metabase OSS, Twenty, EspoCRM | AGPL-3.0 | Not selected | — | Not used |
| Cal.com | Reported MIT ("Cal.diy"), previously AGPL | API integration only (later) | Verify LICENSE file before any self-hosting | **Verify** |
| n8n.io community templates | No license shown | Reference only | Rebuild workflows ourselves; don't import JSON verbatim | **LEGAL** if imported |
| LinkedIn official API clients | Proprietary LinkedIn licence | Not used | — | Not used |
| LinkedIn API Terms | Contract | Mandatory | Purpose limits, 24h/48h caching, deletion, 24h incident reporting, own privacy policy | **LEGAL** — see security-review.md |
| browserless | SSPL / commercial | — | — | FAIL |
| chatgpt-your-files | None | — | — | FAIL |

## Attribution plan

`THIRD_PARTY_NOTICES.md` at repo root listing every adapted file: source repo, commit SHA, license, and change
summary. Adapted files carry a header comment with the same.
