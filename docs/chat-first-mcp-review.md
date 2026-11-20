# Chat-First Branding Agent: architecture review and recommendation (P11-00)

_2026-11-20. Status: **design A agreed in principle by the owner; read-only proof of concept built (§7), awaiting the owner's Claude Desktop chat test**. No write tools exist._

## 0. Summary for the owner

- **What your Claude subscription can do here.** You can work with Claude interactively, in Claude Desktop on
  this PC, using tools that read your approved Brand Brain and save research, a weekly plan and draft posts
  straight into this system's review queue. You stay present and approve every write. This uses no API money.
- **What it cannot do.** It cannot run on its own:
  - **No background or scheduled work against this system.** Anthropic's cloud scheduled tasks can't reach a
    PC-only server. Desktop scheduled tasks only run while the app is open, and automated use of a subscription
    is a grey area.
  - **No feeding this app.** The app may never use your subscription login to call Claude itself; Anthropic
    forbids routing subscription credentials through other products.
  - **Automation needs the API.** Automated or scheduled drafting stays with the existing API mode, which needs an
    API key.
- **API credits depend on your plan.** Max ($100/month), Ultra ($200/month) and Team ($20 per standard seat,
  pooled up to $500/month) include monthly API credits. **Pro does not.** Your plan isn't confirmed yet. On Max
  or Team, the existing automated mode would likely cost you nothing extra: a weekly campaign is about $1–2.
- **Check which terms cover your account before relying on it for the business** (corrected 2026-11-20; see §6).
  - **What the current Consumer Terms say** (effective 8 Oct 2025): this is the UK consumer version. It applies
    *"if you are a consumer who is resident in the United Kingdom"*, a consumer being someone *"acting wholly or
    mainly outside your trade, business, craft or profession"*.
  - **Where the business-use clause sits:** §11, *Non-commercial use only*: *"You agree not to use our Services for
    any commercial or business purposes"*.
  - **Whether that clause applies to a company using a Pro or Max account is not settled by this page.** It is a
    question for Anthropic or a lawyer, not something this review concludes.
  - **Clearly covered by the Commercial Terms:** Team, Enterprise and the API (when used for an organization).
  - **Automated access is a separate clause.** §3(7) is about bots and scripts driving Anthropic's apps, which this
    design does not do.
- **Recommendation.**
  - **Design A** (Claude Desktop with a small local MCP connector) for a mock-safe internal pilot. It fits
    "everything stays on this PC" (D-13), reuses the existing permissions, and adds no running cost.
  - **Keep design C** (the existing API mode) for automation.
  - **Don't build design B** (a public remote connector) now. It needs the system on the internet; it is the path
    for the future SaaS.

## 1. Research findings (official Anthropic sources, read 2026-11-20)

Quotes were taken from the live pages by a fetching tool. Spot-check the wording before quoting it formally.

| # | Question | Finding | Source |
|---|---|---|---|
| 1 | Claude chat custom connectors | Available on Free, Pro, Max, Ultra, Team and Enterprise (Free: one connector). **"Your MCP server must be reachable over the public internet from Anthropic's IP ranges"**, on HTTPS port 443. Streamable HTTP (legacy SSE being deprecated). Auth: OAuth 2.0, a request-header credential (beta), or none | support.claude.com/en/articles/11175166 · claude.com/docs/connectors/building · claude.com/docs/connectors/custom/add-unlisted |
| 1b | Private networks | MCP tunnels are a research preview, *Enterprise only, by request*, for RFC 1918 addresses. Not an option for this PC | claude.com/docs/connectors/mcp-tunnels/overview |
| 2 | Claude Desktop local MCP on Windows (rechecked per surface, §6) | **Desktop chat: supported (stated):** "A server you define in claude_desktop_config.json is available in both the Desktop chat surface and local Code tab sessions." **Cowork: not stated** (it loads the connectors enabled for the claude.ai account). **Claude Code CLI: does not read** `claude_desktop_config.json`. **claude.ai web: remote connectors only.** The documented path is `%APPDATA%\Claude\claude_desktop_config.json`, but **this PC's Microsoft Store build (6.6395) uses `%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc\`** (found locally; see §7). Full quit and restart after editing. Plan eligibility for personal plans: not stated | code.claude.com/docs/en/desktop · claude.com/docs/cowork · modelcontextprotocol.io/docs/develop/connect-local-servers · support.claude.com/en/articles/10949351 |
| 3 | Claude Code MCP | stdio and HTTP servers; scopes local / project (`.mcp.json`) / user; permission prompts for MCP tools, allow rules `mcp__<server>__<tool>`; runs stdio servers as local processes on Windows | code.claude.com/docs/en/mcp · code.claude.com/docs/en/permissions |
| 4 | Subscription vs API billing | "A paid Claude subscription enhances your chat experience, and the Claude API is billed separately." Claude Code on Pro/Max shares the same usage limits as Claude chat. An `ANTHROPIC_API_KEY` in the environment switches Claude Code to API billing | support.claude.com/en/articles/9876003 · support.claude.com/en/articles/11145838 · code.claude.com/docs/en/authentication |
| 5 | Monthly API credits | "Claude Max, Ultra, and Team plans include monthly credits for the Claude API." Max $100, Ultra $200, Team $20 per standard seat ($100 per premium seat), pooled up to $500. **"Free, Pro, and Enterprise plans aren't eligible."** They cover the Claude API, Agent SDK, Managed Agents and Playground, **not Claude Code**. Claimed by linking a Console organization; "Unused credits expire at the end of each billing cycle … and don't roll over" | platform.claude.com/docs/en/about-claude/api-credits-for-subscribers |
| 6 | Routing subscription credentials through other apps | "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users." "Developers building products or services … including those using the Agent SDK, should use API key authentication." Consumer Terms §3(7): no access "through automated or non-human means … Except when you are accessing our Services via an Anthropic API Key". The AUP forbids "Resell, proxy, or otherwise provide access to Claude through unauthorized means" | code.claude.com/docs/en/legal-and-compliance · anthropic.com/legal/consumer-terms · anthropic.com/legal/aup |
| 6b | Business use on consumer plans (rechecked, §6) | The UK consumer version (effective 8 Oct 2025, *Audience: Individual*) applies "if you are a consumer who is resident in the United Kingdom". §11 *Non-commercial use only*: "You agree not to use our Services for any commercial or business purposes", followed by a liability limitation for lost profit or business. §2 *Evaluation*: evaluation use is "for your personal, non-commercial use only". The preamble sends organization use of the API, Console and other offerings to the Commercial Terms, "For clarity, this does not include Claude.ai or Claude Pro use for individuals or entities." **Applicability to a company's Pro or Max account: not settled by the page** | anthropic.com/legal/consumer-terms |
| 7 | Connector permissions and security | Claude asks before tool calls; "only click 'Allow always' when using a server and tool that you trust to run unsupervised"; individual tools can be set to Blocked. Read-only tools can run without per-call confirmation and destructive tools always prompt (stated in the directory review criteria). "Malicious MCP servers may include hidden instructions…"; "Only connect Claude to servers built and hosted by organizations … you trust" | support.claude.com/en/articles/11175166 · claude.com/docs/connectors/building/review-criteria · modelcontextprotocol.io spec (annotations are untrusted unless from trusted servers) |
| 8 | Can chat write into our app? | Yes: tools "can read data …, create, modify, or delete data, and take actions on your behalf". Limits in Claude chat and Desktop: tool result about 150,000 characters, 240 s per call (Claude Code: 25,000 tokens) | claude.com/docs/connectors/custom/add-unlisted · claude.com/docs/connectors/building |
| 9 | Background and scheduled execution | **Claude chat scheduling: not found.** Claude Code *scheduled tasks* run on Anthropic's cloud on subscription usage, so they **cannot reach a 127.0.0.1 server**. Desktop scheduled tasks "only run while the desktop app is running and your computer is awake". Headless `claude -p` uses the subscription login unless `--bare`. "Advertised usage limits … assume ordinary, individual usage". No sentence explicitly permits unattended automation on subscription credentials (**grey area**) | code.claude.com/docs/en/routines · /desktop-scheduled-tasks · /headless · /legal-and-compliance |
| — | API prices (for cost estimates) | Opus 5.5 $4 / $20 per million input / output tokens; Sonnet 5.5 $2 / $10; Haiku 5.5 $0.10 / $0.50 (≤ 100k prompt) | platform.claude.com/docs/en/about-claude/pricing |

**Not verified (treat as open):**
- which personal plans can use local MCP in Claude Desktop (the owner checks *Settings → Extensions* / *Developer*);
- whether read-only annotations auto-approve for *unlisted* connectors;
- the maximum number of tools per connector;
- billing for Desktop local scheduled tasks.

## 2. What the existing system already provides (code inspection)

- **The privilege boundary already exists.** The `lbe_agent` database role (ADR-021) may call only: `brain_load`,
  `brain_propose`, `research_record`, `workflow_create/get/finish`, `strategy_save`, `create_content`,
  `set_draft_output`, `submit_for_review`, `attach_media`, `learning_inputs`, `record_agent_run`,
  `set_agent_metadata` and `whoami` (privilege snapshot, `tests/db/function-security.test.ts`). It **cannot**
  approve, enqueue, release, lift STOP, verify claims or write Brand Brain entries. The database refuses, and the
  tests prove it.
- **User identity for automation already exists.** Durable jobs mint short-lived **job sessions** (`kind =
  'agent_job'`) for the requesting user. Interactive dashboard routes refuse them. A *connector session* can follow
  the same pattern.
- **AI steps are replaceable components.** The orchestrator takes research, strategy, writer, creative and
  extraction components with strict zod schemas (`ResearchOutputSchema`, `StrategyOutputSchema`,
  `DraftOutputSchema`, `CreativeOutputSchema`, `ExtractionOutputSchema`) and validators (`validateResearch`,
  `validateStrategy`, `validateDraftOutput`, `checkBrandRules`, `validateCreative`, `validateExtraction`). Claude
  chat can play these parts, and its output passes the same schemas and checks. **No second Brand Brain, database
  or approval engine.**
- **One constraint matters.** The embedded database admits **one process**. An MCP server therefore must not open
  the database; it must call the running API on `127.0.0.1`. That is also the safer design: the connector holds no
  database credentials at all.
- **Not available yet:** approved performance metrics (Phase 7) and lead data (Phase 8, gated on privacy
  documents). Those tools are left out until those phases exist.

## 3. Comparison of designs

| | **A. Claude Desktop + local MCP** | **B. Claude chat + remote MCP** | **C. Existing API + durable orchestrator** |
|---|---|---|---|
| Running cost | Included in the subscription (counts against its usage limits) | Included in the subscription, plus hosting, domain and certificate | Pay-as-you-go (≈ $1–2 per weekly campaign); **covered by monthly credits on Max, Ultra or Team** |
| Set-up | Low: a small local bridge, a connector session, and a Desktop config entry | High: public HTTPS endpoint, OAuth 2.0, Anthropic IP allow-list, hosting | Done (built and tested); needs an API key and a cap |
| Security | Best for this PC: nothing reachable from outside; stdio only; `lbe_agent` role; owner approves each write | Weakest: internet-facing API, OAuth surface, conflicts with D-13 | Good: key in `.env.staging`; outbound calls only |
| Capability | Interactive research, strategy and drafting with the owner present; Claude's own web search; visuals via the existing renderer | Same as A, from any device | Full automated pipeline: research, strategy, drafts, visuals, campaigns, checkpoints, budgets |
| Reliability | Interactive only; depends on Claude Desktop being open and on subscription limits | Depends on the hosting | Highest: durable jobs, resume, retries, time limits, hard budget |
| Owner experience | Natural: conversation, and drafts appear in the dashboard | Natural, also on the phone | Click *Run the Branding Agent*, then review |
| Scheduling | None (Desktop tasks only while the app is open; grey area) | None from chat | Yes (durable jobs; scheduling can be added) |
| Terms | Owner's own interactive use of a native Anthropic app: fits, but **check business use on consumer plans** (§1 6b) | Same | Commercial Terms (API) |
| SaaS portability | Low: each customer would need Desktop and a local server | **High**: customers connect their own Claude to a hosted connector (OAuth) | **High**: tenant API billing and budgets already designed |

**Recommendation for the internal pilot on this Windows PC:**
1. **A for interactive work.** It is the only design that keeps D-13 (nothing reachable from outside) and uses the
   subscription legitimately, through Claude Desktop itself. It reuses the existing role, validators and review
   queue.
2. **Keep C** as the automated and scheduled path. If the account is Max, Ultra or Team, claim the included API
   credits and enable C with a hard cap: likely zero extra cost.
3. **B later**, only for commercial SaaS, with hosting (OA-9), OAuth and a security review.

## 4. MCP interface (proposed)

**Principles**
- **Thin bridge, no database access.** The MCP server calls the running API on `127.0.0.1`. The API runs each
  request as the **`lbe_agent`** role under a **connector session**.
- **Connector session:**
  - **Created by** a signed-in editor or admin in the dashboard (*Connect Claude*).
  - **Validity:** at most 8 hours; revocable with one click; every call audited as "<user> via Claude connector".
  - **Token handling:** written only to `secrets\` for the local server. It is never shown in chat; Claude never
    sees it.
  - **Refused elsewhere:** every interactive dashboard route refuses it.
- **Read-only by default.** Write tools are available only when the owner ticks *Allow drafts and proposals* for
  that session. Write tools carry `readOnlyHint: false`, so Claude asks before each call.
- **Same checks as the API mode:** the existing zod schemas, then the existing validators, then the existing
  database functions.
- **Never exposed:**
  - approve, reject, enqueue, release or cancel publications;
  - lift STOP;
  - verify claims;
  - write or decide Brand Brain entries;
  - LinkedIn connect or live publishing;
  - users, sessions or backups;
  - raw SQL;
  - any token.

**Read tools**

| Tool | Input (strict) | Output | Existing function |
|---|---|---|---|
| `brand_context_get` | `{ sections?: Section[] }` | approved entries (section, key, title, body, version), accounts (kind, name, pillars), voice profiles; capped at 60 KB | `lbe.brain_load` |
| `claims_list` | `{}` | verified, unexpired claims `{ id, statement, category, evidence_url, expires_at }` | `lbe.brain_load` |
| `recent_content_list` | `{ days?: 1..90 }` | recent topics `{ content_id, topic, pillar, account_kind, status, created_at }` | `lbe.brain_load` |
| `workflow_status_get` | `{ workflow_id: uuid }` | plan and draft statuses of a chat workflow | `lbe.workflow_get` |
| `metrics_get` | — | **not offered until P7-01** (no approved metrics exist) | — |

**Write tools** (opt-in per session; nothing reaches LinkedIn)

| Tool | Input (strict) | Effect | Existing functions |
|---|---|---|---|
| `research_save` | `ResearchOutputSchema` | stored as **chat-origin, unverified** findings; the owner reviews them; never auto-promoted to claims | `validateResearch`, `lbe.research_record` |
| `strategy_save` | `{ goal, start_date, StrategyOutputSchema }` | creates a chat workflow and saves the weekly plan; pillars and claim ids validated; duplicates checked against recent content | `lbe.workflow_create`, `validateStrategy`, `lbe.strategy_save` |
| `draft_create` | `{ workflow_id, plan_item_index, account, DraftOutputSchema }` | creates the draft, runs claim, voice and brand checks, **submits for human review** (never approved) | `lbe.create_content`, `validateDraftOutput`, `checkBrandRules`, `lbe.set_draft_output`, `lbe.submit_for_review` |
| `visual_request` | `{ content_id, CreativeOutputSchema }` | renders locally, attaches to the draft (approval still covers it) | `validateCreative`, `renderVisualAsset`, `lbe.attach_media` |
| `knowledge_propose` | proposals with a verbatim `source_quote` | Brand Brain **proposals** for the owner to accept or reject | `validateExtraction`, `lbe.brain_propose` |
| `lead_note_create` | — | **not offered** (Phase 8 privacy gate, OA-8) | — |

## 5. Required conclusions

- **Achievable with the subscription alone:** interactive, owner-present research, strategy, drafting and visual
  briefs in Claude Desktop, saved into this system for review, at no API cost. It counts against subscription
  usage limits.
- **Not achievable without the API (or another supported interface):**
  - unattended or scheduled runs against this PC;
  - any use of Claude from inside this app (the app may not reuse subscription credentials);
  - guaranteed throughput (subscription limits apply);
  - running Claude from a browser on other devices against this PC (that needs design B and internet exposure).
- **Monthly API credits:** only on **Max, Ultra or Team** (not Pro, Free or Enterprise). Please confirm your plan.
- **Suitable for internal use?** Yes, as a mock-safe, owner-present pilot (design A), subject to two checks:
  - local MCP is available in your Claude Desktop;
  - the terms covering your account fit business use. The UK consumer version has a non-commercial clause whose
    application to a company's Pro or Max account the page leaves open; Team, Enterprise and the API are under the
    Commercial Terms.
- **Commercial SaaS would additionally need:**
  - hosted infrastructure (OA-9);
  - a remote MCP server on public HTTPS with OAuth 2.0 per customer;
  - tenant isolation (row-level security, Phase 10);
  - per-tenant API billing and budgets under the Commercial Terms;
  - rate limiting and Anthropic IP allow-listing;
  - a security review and connector directory review criteria.

  Customers would connect their own Claude accounts; the product never handles their Claude credentials.

## 6. Recheck on owner request (2026-11-20)

**6.1 Which Claude surface can call a local MCP tool?** Each surface was checked on its own, with no inference
from one to another.

| Surface | Verdict | Evidence (official) |
|---|---|---|
| **Claude Desktop chat** (a normal conversation) | **Supported: stated** | code.claude.com/docs/en/desktop: "A server you define in claude_desktop_config.json is available in both the Desktop chat surface and local Code tab sessions." modelcontextprotocol.io/docs/develop/connect-local-servers uses Claude Desktop as the example; "All actions require your explicit approval before execution." |
| **Cowork** | **Not stated** | claude.com/docs/cowork: "Cowork loads the ones enabled for your claude.ai account, synced at session start, and doesn't read the Claude Code CLI's ~/.claude directory on your machine." No mention of local servers or desktop extensions (outside admin-managed third-party set-ups) |
| **Desktop Extensions (.mcpb)** | Packaging of a local server; in chat: supported | claude.com/docs/connectors/building/mcpb: "a zip archive containing a local MCP server and a manifest.json, which Claude Desktop installs in a single click … runs on the user's machine over stdio." Cowork and Claude Code: not stated. Directory listings for MCPB are deprecated |
| **Claude Code CLI** | **Does not read the Desktop config** | code.claude.com/docs/en/desktop: "The standalone CLI does not read claude_desktop_config.json." It uses its own config (`claude mcp add`, `.mcp.json`, `~/.claude.json`) |
| **Claude Code tab in Claude Desktop** | Supported: stated | same page: "The Desktop app loads MCP servers from claude_desktop_config.json into local Code tab sessions" |
| **claude.ai in a browser** | Remote connectors only | claude.com/docs/connectors/getting-started: "claude.ai on the web: remote connectors"; desktop extensions work in "The Claude desktop app, signed in to claude.ai" |
| **Claude Code on the web** (cloud sessions, claude.ai/code) | **Not usable for this design** (added 2026-11-20, §8) | code.claude.com/docs/en/cloud-environments: "Cloud sessions start from a fresh clone of your repository. Anything you've installed or configured only on your own machine isn't available in the session." A repository without a remote "is bundled … and uploaded" (claude-code-on-the-web). Code would leave the PC (D-13) |
| **Claude Code Remote Control** (browser at claude.ai/code, session on this PC) | **Supported: stated; verified locally except the browser view** (§8) | code.claude.com/docs/en/remote-control: "Claude keeps running locally the entire time"; "your filesystem, MCP servers, tools, and project configuration all stay available"; "makes outbound HTTPS requests only and never opens inbound ports". Team/Enterprise: an Owner must enable the Remote Control toggle |

**Conclusion:** the intended interface is **Claude Desktop chat**. Support there is stated, but stated is not the
same as tested here. The proof of concept below checks it on this PC (§7).

**6.2 Consumer Terms (current text, read 2026-11-20).** anthropic.com/legal/consumer-terms, effective 8 Oct 2025,
*Audience: Individual*.
- **Scope:**
  - "These Terms apply to you if you are a consumer who is resident in the United Kingdom";
  - a consumer is someone "acting wholly or mainly outside your trade, business, craft or profession";
  - covers "Claude.ai, Claude Pro, and other products and services that we may offer for individuals";
  - governing law: English.
- **Commercial use:**
  - §11 *Non-commercial use only*: "You agree not to use our Services for any commercial or business purposes". It
    is an obligation on the user, in the same paragraph as a limitation of liability for lost profit or business.
  - §2 *Evaluation*: "Use of our Services for evaluation purposes are for your personal, non-commercial use only."
  - Preamble: organization use of "any Anthropic API key, the Anthropic Console, or any other Anthropic offerings"
    is governed by the Commercial Terms. "For clarity, this does not include Claude.ai or Claude Pro use for
    individuals or entities."
- **Automated access (separate):** §3, "You may not access or use … our Services in the following ways:", item 7:
  "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it,
  to access the Services through automated or non-human means, whether through a bot, script, or otherwise."
- **What this review does and does not conclude:**
  - **Concludes:**
    - The automated-access clause rules out bots or scripts driving Claude.ai or Claude Desktop. Design A does not
      do that: the owner talks to Claude, and Claude calls our tool.
    - The API (design C) is the permitted route for automation.
  - **Does not conclude:** whether a UK company may use a Pro or Max account for business work. The current page
    applies the non-commercial clause to *consumers*, and it does not settle which terms govern a business user of
    Claude.ai or Pro. That stays an owner and legal question (D-16). Team, Enterprise and the API are unambiguous
    business routes.

## 7. Read-only proof of concept (P11-01a)

**What was built** (only `get_brand_brain`; no write tools):
- **Connector key:** a new session kind, created by an **admin** in the dashboard (*System health → Claude
  connector*).
  - **Lifetime:** 1–8 hours; one per person; revocable with one click.
  - **Storage:** the token is written only to `secrets\claude-connector-<env>.json` and never returned to the
    browser.
  - **Audit:** creation, revocation and every call (`connector.key_created`, `connector.keys_revoked`,
    `connector.tool_called`).
- **Database boundary:**
  - **The key works in exactly one function,** `lbe.connector_brain_get`, executable only by `lbe_agent`. It returns
    the organization's *approved* entries (not retired ones, not the logo data).
  - **Tightening found and fixed:** `lbe.session_resolve` used to accept *any* non-interactive session kind where
    job sessions are allowed. It now names `agent_job` explicitly, so a connector key is refused by every other
    function (tested on sign-in, Brand Brain read and write, drafts, key creation and STOP).
- **API:** `GET /api/connector/v1/brand-brain`, with a Bearer key only (the dashboard cookie and dashboard sessions
  are refused). It runs as `lbe_agent` and returns 404 unless `LBE_CONNECTOR=on`, which is **off by default**.
  Admin routes create, revoke and show status.
- **Bridge** (`services/api/src/connector-bridge.ts`): the process Claude Desktop starts.
  - **Footprint:** plain Node, **no dependencies, no database access**; MCP over stdio (JSON-RPC 2.0; versions
    2024-11-05 to 2025-11-25).
  - **Tool:** exactly one, `readOnlyHint: true`, no arguments accepted.
  - **Key handling:** sent only to 127.0.0.1 or localhost. Over HTTPS it is sent only after the server's
    certificate matches the fingerprint stored with the key. It never appears in output or logs.
  - **Why no SDK yet:** the MCP SDK dependency gate (P11-02) is deferred until the read-only path is proven.

**Evidence:**
- **Tests:**
  - `tests/db/connector.test.ts`: 7 tests;
  - `tests/integration/connector.test.ts`: 9 tests, including the real bridge process spoken to over stdio, and a
    silent server answered with a plain message and no crash;
  - the privilege snapshot is updated.
- **Mutation checks**, each caught: key accepted by other functions, read function accepting any session kind,
  route ignoring the off switch, key returned to the browser, tool not marked read-only.
- **Full regression:** Vitest 496, Playwright 21, PostgreSQL 11/11, audit 0.
- **Real runs on this PC:**
  - **Development** (connector on, test data): a key was created through the admin route (the key is not in the
    browser response). The bridge, started exactly as Claude Desktop starts it, completed initialize and tools/list
    (one tool, read-only) and returned **10 approved entries**. The key was absent from the output and logs, and the
    audit recorded the call.
  - **Staging, HTTPS pinning with a dummy key** (connector still off there):
    - with a matching certificate, the request reached the server;
    - with a wrong certificate, nothing was sent.

    This run found and fixed two bugs: the pinned connection was being bypassed, and a timeout crashed the bridge.
- **Claude Desktop on this PC:** the Microsoft Store build 6.6395 keeps its config at
  `%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc\claude_desktop_config.json`, not the documented `%APPDATA%` path.
  - A first attempt at the documented path was not read. It was found by local inspection and corrected.
  - The entry was added next to the existing preferences, with a backup kept.
  - The app was restarted.
  - **The chat call itself needs the owner at the screen** (P11-01a acceptance).
  - **Rerun 2026-11-20 11:29:** Claude Desktop had not started the connector because it was **signed out**
    (main.log: "User is logged out"). Superseded by §8.

## 8. Owner switch: Claude Code in the browser (2026-11-20)

**Owner:** "instead of claude desktop can we use claude code in browser".

**What "Claude Code in the browser" can mean** (official docs, quotes in §6.1):
- **Cloud sessions** run in an Anthropic VM from a clone or upload of the code. A tool on this PC is unreachable,
  and the code would leave the PC. **Rejected** (D-13, no internet exposure).
- **Remote Control:** Claude Code runs **on this PC** and claude.ai/code only shows the session.
  - **Network:** outbound HTTPS only, routed through Anthropic; no inbound ports.
  - **Local tools:** the local connector and settings apply.
  - **Chosen.**

**Plan and terms:** `claude auth status` on this PC reports `subscriptionType: team` (claude.ai sign-in). A Team plan
is a business plan under the Commercial Terms, which largely settles D-16. Remote Control on Team is **off until an
organization Owner switches it on**. Observed: "Remote Control is disabled by your organization's policy."

**Set-up** (`scripts/start-brand-chat.ps1`):
- **Chat folder:** a dedicated folder outside the project, `%USERPROFILE%\acttrident-brand-chat`, with instructions
  in `tools/claude-brand-chat/CLAUDE.md`. They cover: approved facts only, sources with dates, untrusted web pages,
  and no posting.
- **Connector:** registered for that folder only (`claude mcp add --scope local`, same bridge and key as P11-01a).
- **Permission file:** kept outside the folder and passed with `--settings`, so sessions can't change it.
  - **Allowed without asking:** `get_brand_brain`, WebSearch, WebFetch.
  - **Denied:** Bash, PowerShell, Read, Glob, Grep, Edit, Write, NotebookEdit; scheduled and cloud agents, workflows,
    plugin publishing, worktrees; and the owner's personal claude.ai connectors (Gmail, Calendar, Drive, Docs and
    others).
  - **Why:** the chat reads untrusted web pages, so it must not reach mail, files or a shell.
- **Retry:** the window retries Remote Control every 30 s until the organization toggle is on.

**Evidence (2026-11-20 11:51, Claude Code 2.1.329, real session in the chat folder with that permission file):**
- **Connector registered:** `claude mcp list` shows `acttrident-brand-brain … √ Connected`.
- **Tools offered to the model:** `get_brand_brain`, WebSearch and harness tools. **No Read, Bash, Edit or Write.**
  Deny rules remove the tools rather than prompting.
- **Model answer:**
  - "The get_brand_brain tool returned 10 approved entries. The first is titled 'Audience problems'";
  - reading `.env.example`: "DENIED. No file-reading tool is available";
  - shell: "DENIED. No shell tool is available".
- **Audit (development):** `connector.tool_called {"tool":"get_brand_brain","entries":10}` at 11:51:05, same key.
- **Not yet seen:** the same session viewed from the owner's browser. It waits on the organization toggle; the
  browser is only a view of the same local session.

**Comparison with Claude Desktop chat:** Desktop chat has no shell or file tools at all. Claude Code has them, and
they are removed by a permission file rather than absent by design. With the deny list above, the reachable surface
is the same: one read-only tool plus web research.
