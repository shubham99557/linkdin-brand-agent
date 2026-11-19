# Setup Guide (beginner-friendly)

This runs the LinkedIn Brand Engine **on your own computer**. Nothing is posted to LinkedIn — Phase 1 only
uses a **mock** LinkedIn that stores posts in a local database.

## 1. Install the tools (once)

Open **PowerShell** and run (each asks for administrator approval):

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
```

Close and reopen PowerShell, then check:

```powershell
git --version     # e.g. git version 2.56…
node --version    # v26.x or newer
```

Docker is **optional** (only needed for the PostgreSQL concurrency tests — see section 6).

## 2. Get the project and install packages

```powershell
cd "$env:USERPROFILE\linkdin-brand-engine"
npm install
```

## 3. Create your local settings and demo users

```powershell
npm run setup:local   # creates .env with random passwords (never committed to git)
npm run db:seed       # creates the database in .data\pglite and synthetic users
```

The seed creates four **synthetic** users. Their passwords are in your `.env` file
(open it with Notepad: `notepad .env`):

| Email | Role | Password variable in .env |
|---|---|---|
| admin@lbe.test | admin (can resume after STOP, reconcile, run publisher) | `LBE_DEV_ADMIN_PASSWORD` |
| marketing@lbe.test | approver for the company page | `LBE_DEV_APPROVER_PASSWORD` |
| founder@lbe.test | approver for the founder profile only | `LBE_DEV_FOUNDER_PASSWORD` |
| editor@lbe.test | editor (drafts, submits) | `LBE_DEV_EDITOR_PASSWORD` |

## 4. Start the app

```powershell
npm run build:web     # builds the dashboard (once, or after UI changes)
npm start             # starts the API + dashboard + background publisher
```

Open **http://127.0.0.1:8787** and sign in.

To see the whole flow without clicking, keep `npm start` running and in a second PowerShell window run:

```powershell
npm run demo
```

### The flow in the dashboard
1. **Editor** → *New post* → choose account and pillar → write a brief → *Create* → *Generate AI draft*.
2. Fix anything listed under *Unsupported factual statements* → *Submit for review*.
3. **Approver** (company: marketing@…, founder posts: founder@…) → open the post → check the
   *Final publication preview* and *Supporting evidence* → *Approve*.
4. Approver → *Queue for publishing*.
5. The background publisher sends it to the mock (every 15 s), or **admin** → *Publishing outbox* → *Run publisher now*.
6. See it under *Mock LinkedIn*; every step is in the *Audit log*.

**STOP:** the red *Stop all publishing* button is on every page. Each account also has its own stop button
under *Accounts & voices*. Only an admin can resume.

## 5. Run the checks

```powershell
npm run typecheck          # TypeScript
npm test                   # unit + database + API integration tests (PGlite)
npx playwright install chromium   # once
npm run test:e2e           # browser tests
npm run security:secrets   # secret scan
npm run security:audit     # dependency vulnerabilities
```

## 6. Optional: real PostgreSQL (Docker) for concurrency tests

Docker Desktop needs **WSL2**. In an **administrator** PowerShell:

```powershell
wsl --install --no-distribution
```

Restart Windows, start **Docker Desktop**, accept its licence, then:

```powershell
cd "$env:USERPROFILE\linkdin-brand-engine"
docker compose up -d                    # starts PostgreSQL 18.6 on 127.0.0.1:54329
$pw = (Select-String -Path .env -Pattern '^LBE_PG_PASSWORD=(.*)$').Matches[0].Groups[1].Value
$env:LBE_TEST_PG_URL = "postgres://postgres:$pw@127.0.0.1:54329/lbe"
npm run test:pg
```

To run the app on PostgreSQL instead of the embedded database, set
`LBE_DATABASE_URL=postgres://postgres:<password>@127.0.0.1:54329/lbe` in `.env`, then
`npm run db:seed` and `npm start`.

## 7. Optional: real AI drafting (costs money)

Get an Anthropic API key **with a spend limit**, then in `.env` set:

```
LBE_DRAFTER=anthropic
ANTHROPIC_API_KEY=<your key>
```

Restart `npm start`. Drafts are still validated against the claims register and still need human approval.

## 8. Phase 2 — connecting LinkedIn (only for an owner-approved pilot stage)

> Live publishing is **off** by default and refused unless `LBE_ENV=staging`. Do these steps only when the
> owner has approved Stage 2.2 (founder pilot) or 2.3 (company page). See `docs/phase-2-plan.md`.

**a. Create a local HTTPS certificate** (LinkedIn only redirects to HTTPS). In PowerShell, from the project folder:

```powershell
New-Item -ItemType Directory -Force secrets | Out-Null     # git-ignored
$cert = New-SelfSignedCertificate -DnsName localhost -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(1)
$pw = Read-Host -AsSecureString "Choose a certificate passphrase"
Export-PfxCertificate -Cert $cert -FilePath secrets\localhost.pfx -Password $pw
```

Your browser will warn that the certificate is self-signed. That is expected for local use.

**b. Create the LinkedIn app(s)** at https://www.linkedin.com/developers/apps:
- **Founder app:** add the products *Share on LinkedIn* and *Sign In with LinkedIn using OpenID Connect*.
- **Company app:** a *separate, new* app with *Community Management API* only (LinkedIn review required).
- Under *Auth → Authorized redirect URLs*, add `https://localhost:8443/api/oauth/linkedin/callback`.

**c. Edit `.env`:**

```
LBE_ENV=staging
LBE_PORT=8443
LBE_TLS_PFX=secrets/localhost.pfx
LBE_TLS_PFX_PASSPHRASE=<your certificate passphrase>
LBE_APP_ORIGINS=https://localhost:8443
LBE_LINKEDIN_REDIRECT_URI=https://localhost:8443/api/oauth/linkedin/callback
LBE_LINKEDIN_FOUNDER_CLIENT_ID=<from the LinkedIn app>
LBE_LINKEDIN_FOUNDER_CLIENT_SECRET=<from the LinkedIn app>
LBE_LIVE_PUBLISHING=on        # only during an approved pilot; set back to off afterwards
```

**d.** Run `npm start` and open **https://localhost:8443**. Then, as admin, go to *Accounts & voices* →
*Connect LinkedIn* and check the connected name. Click *Enable LIVE publishing* only for the approved pilot.

**To stop everything at once:** press STOP, or set `LBE_LIVE_PUBLISHING=off` and restart, or remove the app's
access in LinkedIn settings. Any one of these is enough.

## Troubleshooting

| Problem | Fix |
|---|---|
| `npm` not found | Reopen PowerShell after installing Node.js |
| "Users already exist — seed skipped" | Normal: the seed never overwrites. To start fresh, stop the app and delete the `.data` folder |
| Port 8787 in use | Set `LBE_PORT=8790` in `.env` (and use that port in the browser) |
| "cross-origin request refused" | Open the app at exactly `http://127.0.0.1:8787` (or add your URL to `LBE_APP_ORIGINS`) |
| Login locked | 5 wrong passwords lock the account for 15 minutes |
| PGlite "one process" | Don't run `npm run worker` with PGlite — the API runs the worker itself |
| "LBE_LIVE_PUBLISHING=on is only allowed with LBE_ENV=staging" | Intended safety rule — set `LBE_ENV=staging` only for an approved pilot |
| A live post is stuck as "awaiting release" | Intended — an approver must click *Publish now* and confirm |
| Account shows "AUTO: LinkedIn credential invalid" | LinkedIn rejected the token: reconnect, then an admin resumes the account |
