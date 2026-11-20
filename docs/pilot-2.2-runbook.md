# Stage 2.2 Runbook — Founder Pilot (live LinkedIn)

_Approved by owner 2026-11-19 ("continue with stage 2.2"). Each live post still needs the owner present and
an explicit go at step G. Record everything in [`pilot-2.2-log.md`](pilot-2.2-log.md)._

## Scope

| In scope | Out of scope |
|---|---|
| Founder app (Share on LinkedIn + OIDC), **text posts only**, manual release | Company page (Stage 2.3), images/carousels (2.4), scheduled release (2.5), comments, analytics, DMs |
| First a LinkedIn **test profile**, then — after a separate go — the founder's real profile | Any other member or page |

**Success:**
1. A human-approved post appears on LinkedIn with the stored URN.
2. The audit trail is complete.
3. STOP and switch-off are demonstrated.
4. The unconfirmed items are resolved and recorded.

**Abort immediately (press STOP, then step H) if any of these happen:**
- any response other than 201;
- the post appears on the wrong profile;
- the visibility is wrong;
- an unexpected duplicate appears;
- anything surprises you.

## Steps

### A. Precondition decision (owner)
P2-D8 asks for the real-PostgreSQL concurrency tests to be run first. Either run them (setup.md §6) or write
"waived for founder pilot" in the log. The pilot has one approver and a single publish, so the risk is low,
but it is your call.

### B. Create the founder LinkedIn app (owner, ~10 min)
1. Go to https://www.linkedin.com/developers/apps → **Create app**. LinkedIn asks you to associate the app with
   a LinkedIn Page (ActTrident's page is fine). This does **not** give the app access to the page.
2. **Products** tab → add **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect**.
   Do **not** add anything else. The company page needs a separate app later.
3. **Auth** tab → *Authorized redirect URLs* → add exactly:
   `https://localhost:8443/api/oauth/linkedin/callback`
4. Enter **Client ID** and **Primary Client Secret** in the guided window
   (`powershell -ExecutionPolicy Bypass -File scripts\set-linkedin-app.ps1`; Claude opens it for you). The secret
   is hidden while you type and is written only to `.env.staging`. Or edit the file yourself
   (`notepad .env.staging` → `LBE_LINKEDIN_FOUNDER_CLIENT_ID=` / `LBE_LINKEDIN_FOUNDER_CLIENT_SECRET=`).
   **Do not paste the secret into chat, email or tickets.**

### C. Create real staging users (owner)
In PowerShell, in the project folder (the password is typed, not stored in history):
```powershell
$env:LBE_NEW_USER_PASSWORD = Read-Host "Password (12+ chars)"
npm run staging:user -- --email <your email> --name "<your name>" --role admin --approver-for c736f20d-5186-4feb-9885-d11458df7f77
Remove-Item Env:LBE_NEW_USER_PASSWORD
```
If the founder is a different person, create them with `--role approver --approver-for c736f20d-5186-4feb-9885-d11458df7f77`.
(That ID is the staging founder account. `npm run staging:init` prints it again.)

### D. Pre-flight, start, connect (owner + me)
_Owner decision 2026-11-20: "i want to use normal linkdin account". Connect the founder's normal LinkedIn account
directly, without a test profile. Connecting and the read-only check post nothing; every live post still needs
steps E–G with the owner present._
1. With the staging server **stopped**, run `npm run pilot:preflight` → must show **NO BLOCKING FAILURES**.
   The embedded database admits one program at a time; with the server running, the check refuses.
2. `npm run start:staging`, then open **https://localhost:8443**. Accept the browser warning for the self-signed
   certificate (local only), and sign in as admin.
3. *Accounts & voices* → founder account → **Connect LinkedIn**. On LinkedIn, sign in to the founder's account and
   allow.
4. Back in the dashboard, confirm the connected name is the founder.
5. Stop the server, run `npm run pilot:verify -- --yes-call-linkedin` (read-only), then start it again. Claude does
   this step. Record the userinfo URN and introspection scopes in the log.
   **If the URN does not match, stop here.**

### E. Go/no-go #1 — switch live on (owner)
1. In `.env.staging` set `LBE_LIVE_PUBLISHING=on`, stop the server (Ctrl+C) and run `npm run start:staging` again.
   The red LIVE banner must now show.
2. *Accounts & voices* → founder → **Enable LIVE publishing**. The panel must show `LIVE · release: manual`.

### F. Create and approve the pilot post (owner)
1. *New post* → founder account → pillar `founder-lessons`. Brief: a short, non-factual test note
   (for example "Testing an approval-based publishing workflow"). Write the body yourself (no AI needed) and
   include **no factual claims**.
2. Set visibility to **Connections only** for the test profile.
3. Submit, then approve as the founder approver. Check that the preview's package shows `"publishing_mode": "live"`
   and the expected `linkedin_urn`. Then click **Queue for publishing**.

### G. Go/no-go #2 — release (owner present)
1. On the post: tick *"I confirm this will be posted publicly on LinkedIn now"*, then click **Publish now**.
2. As admin: *Publishing outbox* → **Run publisher now**. Expect "succeeded 1".
3. Open the profile on LinkedIn and confirm the post is there with the correct text and visibility.
   Record the stored `urn:li:share:…` in the log.
4. Demonstrate STOP: press **Stop all publishing** and check the banner. An admin then resumes.

### H. Switch off (always — success or abort)
1. Set `LBE_LIVE_PUBLISHING=off` in `.env.staging` and restart (or simply stop the server).
2. Optional: delete the test post on LinkedIn by hand.
3. If anything went wrong, follow *Publishing outbox* → **Reconcile…** and record what you found.

### I. Real founder profile (separate go decision)
Repeat D (reconnect, signed in as the founder), E, F and G with a real, founder-written post. Reconnecting changes
the author, which automatically invalidates earlier approvals, so approve again. Then do H.

## Rollback (any one is enough)
- Press STOP.
- Set `LBE_LIVE_PUBLISHING=off` and restart.
- Disconnect in the dashboard.
- On LinkedIn: *Settings → Data privacy → Permitted services* → remove the app.
