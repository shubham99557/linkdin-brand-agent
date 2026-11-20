# Chat-First Branding Agent: architecture review and recommendation (P11-00)

_2026-11-20. Status: **recommendation, awaiting owner decision D-14**. Nothing has been built for this yet._

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
- **Check before relying on it for the business.** The Consumer Terms that cover Claude.ai and Claude Pro for
  individuals say: *"You agree not to use our Services for any commercial or business purposes."* Business use
  normally sits under a Team or Enterprise plan or the API, which use Anthropic's Commercial Terms. Please check
  which plan and terms your account is on; this is a legal point, not a technical one.
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
| 2 | Claude Desktop local MCP on Windows | Supported: config at `%APPDATA%\Claude\claude_desktop_config.json`, or desktop extensions (`.mcpb`) under Settings → Extensions. "A desktop extension … runs on your device inside Claude Desktop", "with your user permissions", available "when you're signed in to claude.ai". **Plan eligibility for personal plans isn't stated** (Team/Enterprise admins can restrict it) | modelcontextprotocol.io/docs/develop/connect-local-servers · claude.com/docs/connectors/custom/add-unlisted · support.claude.com/en/articles/10949351 |
| 3 | Claude Code MCP | stdio and HTTP servers; scopes local / project (`.mcp.json`) / user; permission prompts for MCP tools, allow rules `mcp__<server>__<tool>`; runs stdio servers as local processes on Windows | code.claude.com/docs/en/mcp · code.claude.com/docs/en/permissions |
| 4 | Subscription vs API billing | "A paid Claude subscription enhances your chat experience, and the Claude API is billed separately." Claude Code on Pro/Max shares the same usage limits as Claude chat. An `ANTHROPIC_API_KEY` in the environment switches Claude Code to API billing | support.claude.com/en/articles/9876003 · support.claude.com/en/articles/11145838 · code.claude.com/docs/en/authentication |
| 5 | Monthly API credits | "Claude Max, Ultra, and Team plans include monthly credits for the Claude API." Max $100, Ultra $200, Team $20 per standard seat ($100 per premium seat), pooled up to $500. **"Free, Pro, and Enterprise plans aren't eligible."** They cover the Claude API, Agent SDK, Managed Agents and Playground, **not Claude Code**. Claimed by linking a Console organization; "Unused credits expire at the end of each billing cycle … and don't roll over" | platform.claude.com/docs/en/about-claude/api-credits-for-subscribers |
| 6 | Routing subscription credentials through other apps | "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users." "Developers building products or services … including those using the Agent SDK, should use API key authentication." Consumer Terms §3(7): no access "through automated or non-human means … Except when you are accessing our Services via an Anthropic API Key". The AUP forbids "Resell, proxy, or otherwise provide access to Claude through unauthorized means" | code.claude.com/docs/en/legal-and-compliance · anthropic.com/legal/consumer-terms · anthropic.com/legal/aup |
| 6b | Business use on consumer plans | Consumer Terms §11, *Non-commercial use only*: "You agree not to use our Services for any commercial or business purposes". These terms cover "Claude.ai, Claude Pro, and other products and services … for individuals" (effective 8 Oct 2025). Organization use of the API and Console is under the Commercial Terms | anthropic.com/legal/consumer-terms |
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
  - your plan's terms allow business use. Consumer terms exclude it; Team and Enterprise are commercial.
- **Commercial SaaS would additionally need:**
  - hosted infrastructure (OA-9);
  - a remote MCP server on public HTTPS with OAuth 2.0 per customer;
  - tenant isolation (row-level security, Phase 10);
  - per-tenant API billing and budgets under the Commercial Terms;
  - rate limiting and Anthropic IP allow-listing;
  - a security review and connector directory review criteria.

  Customers would connect their own Claude accounts; the product never handles their Claude credentials.
