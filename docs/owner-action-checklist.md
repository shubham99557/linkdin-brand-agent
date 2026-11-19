# Owner Action Checklist

_Created 2026-11-19. Things only you (the owner) can do. Each item says what, why, where, how, what to tell
Claude afterwards, what must stay secret, and what development continues meanwhile. Task IDs refer to `plan.md`._

**Golden rule for secrets:** passwords, client secrets and API keys go **only** into the git-ignored files named
below (or are typed at a hidden prompt). Never paste them into chat, email, tickets, screenshots or the pilot log.
When you're done, just tell Claude "OA-n done" — no values needed.

Already done (no action needed): Git, Node, Docker install; Phase 1 approval (D-01); Stage 2.1/2.2 approvals;
real-PostgreSQL concurrency tests (9/9, 2026-11-19); Visual C++ runtime; internal-first strategy (D-04).

| # | Action | Unblocks | Priority |
|---|---|---|---|
| OA-1 | Private off-machine code backup | P0-07 (laptop-loss risk) | **High** |
| OA-2 | Create your real staging user | P2-06, pilot, real Brand Brain | **High** |
| OA-3 | Enter real Brand Brain knowledge | P2-08 → AI evaluation, Creative templates | **High** |
| OA-4 | Create the founder LinkedIn app | P6-01 → pilot | Medium |
| OA-5 | Create company-page app + apply for Community Management | P6-07 (review takes weeks) | Medium (start early) |
| OA-6 | Authorize a budget-capped paid AI evaluation | P3-04 | Medium (after OA-3) |
| OA-7 | Legal question on scheduled posting | P6-06 | Low |
| OA-8 | Privacy documents for leads | Phase 8 | Low (later) |
| OA-9 | Hosting choice for internal production | Phase 9 | Low (later) |
| OA-10 | Approve (or decline) the PDF reader library for document upload | P2-03b | Low (copy/paste or .txt works today) |

---

## OA-1 — Private off-machine code backup
- **What:** create an empty **private** repository and let Claude push the code there.
- **Why:** all code exists only on this laptop. A disk failure loses everything.
- **Where:** https://github.com/new (or your company's GitHub/GitLab/Azure DevOps).
- **Steps:**
  1. Sign in → *New repository* → name e.g. `linkedin-brand-engine` → select **Private** → do **not** add a README.
  2. Make sure your computer can push (GitHub: install *GitHub Desktop* or run `gh auth login`; sign in via the browser).
- **Tell Claude:** "OA-1 done, repo URL is …" (the URL is not secret). Claude adds it as `origin` and pushes **only after you confirm**.
- **Secret:** your GitHub password/token — never share; sign-in happens in the browser.
- **Meanwhile:** Claude builds database backup/restore (P1-01). `.env*`, `secrets/`, `.data/` are git-ignored and are never pushed.

## OA-2 — Create your real staging user
- **What:** an admin account for you in the staging database, marked as approver for the founder profile.
- **Why:** staging has no users; you need one to enter the real Brand Brain and to run the pilot.
- **Where:** PowerShell in the project folder `C:\Users\X1 Extreme Gen3\linkdin-brand-engine`.
- **Steps** (the password is typed at a hidden prompt, not stored):
  ```powershell
  $env:LBE_NEW_USER_PASSWORD = Read-Host "Password (12+ chars)"
  npm run staging:user -- --email <your email> --name "<your name>" --role admin --approver-for c736f20d-5186-4feb-9885-d11458df7f77
  Remove-Item Env:LBE_NEW_USER_PASSWORD
  ```
  Only this **first** admin needs the command line. Everyone else (e.g. a separate founder) you can add afterwards in
  the dashboard under **Users** → *Add a user*, then tick "Approves posts for: Founder". Give temporary passwords in
  person or by phone, not by email or chat. They'll be asked to choose their own password the first time they sign
  in. You can change yours any time via *Change password* under your name.
- **Confirm:** `npm run pilot:preflight` no longer shows the two user FAIL lines.
- **Secret:** the password.
- **Meanwhile:** independent engineering tasks (P1-xx, P4-xx).

## OA-3 — Enter real Brand Brain knowledge
- **What:** fill in the 13 Brand Brain sections and 3–5 verified claims with evidence, in **staging**.
- **Why:** AI quality can only be judged against real knowledge; agents never invent facts — missing items stay UNKNOWN.
- **Where:** `npm run start:staging` → https://localhost:8443 → sign in → **Brand Brain**. Guide: `docs/brand-onboarding-checklist.md`.
- **Steps:** click **Start guided setup** and answer one step at a time (14 steps, ending with claims). Use
  *Skip for now* for anything you're unsure about — it stays UNKNOWN. You can stop and come back; it resumes at the
  first unanswered step. Then ask an approver (or yourself, if you are one) to verify your claims in *Claims register*.
- **Account names:** staging starts with placeholder names ("ActTrident (company page)", "Founder (authorised
  profile)"). In the guided setup step **Account names & pillars** (or on **Accounts & voices** → *Rename*), enter
  the real company name and the founder's name exactly as they should appear. The writer is told whose account it
  is writing for. Renaming never changes posts that already exist or anything already approved.
- **Also:** in Brand Brain → **Visual identity**, click *Set brand colours* and pick your background, text and accent
  colours, and optionally upload a small logo (max 150 KB). Until then, image previews use neutral placeholder colours.
- **Confirm:** `npm run brain:audit:staging` shows no required section UNKNOWN and no synthetic content.
- **Secret:** none, but don't enter customer names or personal data.
- **Meanwhile:** Claude improves the onboarding UI (P2-01, P2-02).

## OA-4 — Create the founder LinkedIn app
- **What/Where/Steps:** exactly `docs/pilot-2.2-runbook.md` step **B** (https://www.linkedin.com/developers/apps;
  products *Share on LinkedIn* + *Sign In with LinkedIn using OpenID Connect* only; redirect URL
  `https://localhost:8443/api/oauth/linkedin/callback`).
- **Why:** required for any real founder post.
- **You put** the Client ID and Primary Client Secret into `.env.staging` yourself (`notepad .env.staging`).
- **Confirm:** `npm run pilot:preflight` shows PASS for "founder LinkedIn app client id/secret". Tell Claude whether
  LinkedIn **accepted** the `https://localhost` redirect URL (that's pilot check U1).
- **Secret:** the client secret. Connecting and posting remain separate go-decisions (runbook steps D–G).
- **Meanwhile:** all non-LinkedIn phases continue.

## OA-5 — Company-page app + Community Management API application
- **What:** a **separate** LinkedIn app (no other products) requesting the *Community Management API*.
- **Why:** company-page posting and page analytics need it; LinkedIn's review takes time, so start early.
- **Where:** https://www.linkedin.com/developers/apps → *Create app* → *Products* → *Community Management API* → *Request access*.
- **Needs:** a public privacy-policy URL on ActTrident's site, a page **super admin** to verify the app, and a
  description of the use (human-approved posts, manual release). Claude can draft the use-case text on request.
- **Confirm:** tell Claude the review status. Don't put its secret anywhere until it's approved.
- **Meanwhile:** the company page stays on mock publishing.

## OA-6 — Authorize a budget-capped paid AI evaluation
- **What:** an Anthropic API key with a spend limit, plus a written "yes, up to $X for this run".
- **Why:** content quality has only been tested with mock agents.
- **Where:** https://console.anthropic.com → *Settings → Limits* (set a monthly limit) → *API keys* → *Create key*.
- **Steps:** do this after OA-3. Tell Claude the budget (e.g. "authorize eval up to $5"). Then you run, in your own
  PowerShell window (key typed at a hidden prompt, never stored in a file or chat):
  ```powershell
  $env:ANTHROPIC_API_KEY = Read-Host "Anthropic key" -AsSecureString | ForEach-Object { [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($_)) }
  npm run brain:export:staging
  npm run eval:campaign -- --provider anthropic --budget-usd 5 --i-authorize-paid-api --brain eval-results/brain-staging.json
  Remove-Item Env:ANTHROPIC_API_KEY
  ```
  Command confirmed (P3-01, 2026-11-19). Prices were checked against Anthropic's official pricing page.
  One weekly run is expected to cost about **$1–2**, so a **$5** budget covers it with margin (details in
  `docs/evaluation-plan.md`). Spending stops automatically when the budget is reached. Also set a monthly
  limit in the Anthropic Console as a second safety net.
- **Then:** score the output with `eval-results/<run>/scoring-sheet.md`.
- **Secret:** the API key.
- **Meanwhile:** Claude verifies pricing (P3-01) and builds durable jobs (P4).

## OA-7 — Legal question on scheduled release
- **What:** ask counsel whether releasing a human-approved post at a scheduled time is "automated posting" under
  LinkedIn API Terms §3.1(26) (decision D-03).
- **Why:** until answered, every live post needs a manual "Publish now" click.
- **Confirm:** a written answer. **Meanwhile:** manual release works fine.

## OA-8 — Privacy documents (only before lead features)
- Privacy notice, legitimate-interest assessment, retention policy (D-11). Needed before Phase 8. Nothing to do yet.

## OA-9 — Hosting choice (only before production)
- Where the internal production system runs (D-09). Claude will prepare options and costs at Phase 9; no spending without your approval.

## OA-10 — PDF reader library for document upload (optional)
- **What:** decide whether Claude may add the open-source PDF reader `unpdf` 2.1.0 (MIT; bundles Mozilla's pdf.js)
  so PDFs can be uploaded on the Brand Brain page. `.txt` and `.md` uploads already work without it.
- **Why ask:** it is new third-party code that reads untrusted files. It was reviewed without running it (no install
  scripts, no native binaries, signed, 0 known vulnerabilities; details and safety conditions in ADR-032), but
  running it for the first time needs your go-ahead.
- **Tell Claude:** "OA-10 approved" (Claude installs and tests it, PDFs then parse in an isolated worker with size,
  page and time limits) or "OA-10 declined" (PDFs stay copy/paste only).
- **Cost / secrets:** none.

## Optional
- **WSL2** (`wsl --install`, admin PowerShell, reboot): only needed if you later want Docker. Not required now.
