# Current Architecture — Greenfield Baseline

_Evaluated: 2026-11-18_

## Decision

The LinkedIn Brand Engine is a **new, standalone product**. The owner instructed (2026-11-18) that it must not
depend on or extend the former "ai-social-media-team" / ActTrident GTM System. No orchestrator, agent team,
playbooks or Brand OS from that system are assumed to exist.

## Inventory of what exists

| Item | Status | Evidence |
|---|---|---|
| Product source code | **None** | `linkdin-brand-engine/` created empty on 2026-11-18 |
| `CLAUDE.md` / project instructions | **None** | Searched user profile, OneDrive, Documents, Desktop, Downloads, C:\ and D:\ (depth 4–5) |
| Agents, playbooks, Brand OS | **None on this machine** | Same search; excluded by owner decision |
| Supabase schema / migrations | **None** | — |
| n8n workflows | **None** | — |
| Approval queue, audit log, STOP control | **None** | Must be built (see target architecture) |

## Development machine tooling (as found)

| Tool | Status | Impact |
|---|---|---|
| git | Not installed | Repos retrieved as pinned-commit archives instead of `git clone` |
| Docker | Not installed | Blocks local n8n + Supabase stack (Stage 8) |
| Node.js / npm | Not installed | Blocks TypeScript build and tests |
| Python | Windows Store alias only (likely stub) | Treat as not installed |
| WSL | Not installed | — |
| GitHub CLI, n8n CLI, Supabase CLI | Not installed | — |

## Capability classification

- **Existing capabilities:** none.
- **Partially implemented:** none.
- **Missing:** all 14 target capabilities (see `target-architecture.md`).
- **Reusable internal components:** none — every capability is either built or sourced from vetted open source.

## Folder layout

```text
C:\Users\X1 Extreme Gen3\
  linkdin-brand-engine\                 # product (this repo)
    docs\                               # deliverables 1–12
  open-source-research\
    linkedin-brand-engine\
      research\                         # raw research notes per category
      clones\                           # pinned third-party snapshots (never executed)
      extracted-patterns\               # notes on designs to reimplement
```

Third-party code never lives inside `linkdin-brand-engine\`.
