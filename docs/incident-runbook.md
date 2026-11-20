# Incident runbook: what to do when something goes wrong (P9-05)

_Written 2026-11-20 for running the system on this PC (decision D-13). Day-to-day operation is in
`docs/local-operations.md`. Keep calm; most steps can be undone. Write down the **time** and **what you saw**
first; that is the most useful information afterwards._

## LinkedIn's 24-hour rule

**Source:** LinkedIn API Terms of Use, §7.1(d) "Security Breach", last revised 13 December 2022 (checked
2026-11-20 at https://www.linkedin.com/legal/l/api-terms-of-use).

**When it applies:** a security incident that could involve LinkedIn data, i.e. LinkedIn access tokens, member
data or the LinkedIn app's secret. Examples: the PC is stolen while LinkedIn is connected, `.env.staging` or
`secrets\` leaked, or someone else used the dashboard.

**What you must do:**
- report it **in writing within 24 hours** of discovering it, by email to **security@linkedin.com**;
- work with LinkedIn to correct it, and cut off the intruder immediately;
- make **no public statement** about it without LinkedIn's prior written permission.

**What the email says:**
- what happened and when you discovered it;
- which LinkedIn app is affected (founder / company);
- what you have already done (steps below);
- a contact person.

Facts only, no guesses. If unsure whether it counts, report it anyway.

## First moves (any incident)

1. **Stop publishing.** On any dashboard page, click **Stop all publishing** at the top and type a reason.
   Nothing is sent to LinkedIn until an admin clicks **Resume publishing**.
2. **Sign everyone out.** On the **Users** page, use **Sign out everywhere** on each user, or **Disable** anyone
   you don't recognise. Your own button is in the menu: **Sign out everywhere**.
3. **Check System health and Backups** (admin menu), and note the newest backup time. Don't delete anything.

## Scenarios

### The PC is lost or stolen
1. From another device, revoke the LinkedIn connections: in LinkedIn *Settings & Privacy*, find **Permitted
   services** (the apps you have allowed to use your account) and remove this app. For the company page, ask a
   page admin to do the same.
2. In the Anthropic Console, **delete the API key** used by this system and create a new one later.
3. In the LinkedIn Developer Portal, **regenerate the app's client secret** (founder app; company app if created).
4. **Report to LinkedIn within 24 hours** (see above). The tokens on the PC are encrypted, but the key that
   decrypts them is on the same PC.
5. **Recover on a new PC** from the newest USB backup: follow `READ-ME-restore.txt` in that folder, enter the new
   secrets, reconnect LinkedIn. Change every user's password (Users → **Reset password**).

### Someone else may have used the dashboard, or a password leaked
1. First moves 1 and 2.
2. Reset the affected user's password (Users → **Reset password**). They must choose a new one at next sign-in.
3. Check the **Audit log** page for actions you didn't make (approvals, releases, setting changes). Note the times.
4. If any LinkedIn action or LinkedIn data may be involved, **report to LinkedIn within 24 hours**.
5. Resume publishing only when you are sure who has access.

### A wrong or unapproved post went out
1. **Stop all publishing.**
2. Delete or edit the post **directly on LinkedIn** (the system never deletes posts for you).
3. Open the post in the dashboard: its history shows every version and who approved it; the **Audit log** shows
   who released it and when.
4. Fix the cause (wrong approval, wrong account) before you **Resume publishing**.

### An API key or secret file was exposed (pasted somewhere, emailed, uploaded)
1. **Anthropic key:** delete it in the Anthropic Console, create a new one, and put it in `.env.staging`
   yourself. Never paste it into chat.
2. **LinkedIn client secret:** regenerate it in the LinkedIn Developer Portal, update `.env.staging`, then
   reconnect the accounts. **Report to LinkedIn within 24 hours.**
3. **Token key (`LBE_TOKEN_ENC_KEY`):**
   - ask your developer to rotate it;
   - until then, **Disconnect** each LinkedIn account on *Accounts & voices*;
   - **report to LinkedIn within 24 hours**.
4. Restart the server after changing settings. The System health page flags secret files that Git tracks; that
   must always show OK.

### The database seems damaged (errors everywhere, System health says "Database: Problem")
1. Stop the server (Ctrl+C) and don't delete anything.
2. Restore the newest automatic backup into a **new** folder and switch to it. See *Restore* in
   `docs/local-operations.md`.
3. Work done after that backup's time must be redone; the Audit log of the old database shows what it was.

### Ransomware or files suddenly unreadable
1. Disconnect the PC from the network. Don't plug in the backup USB drive while the PC may be infected.
2. Follow *The PC is lost or stolen* (revoke, rotate, report), using another device.
3. Recover on a clean PC from the USB backup. This is why the drive stays unplugged.

### Disk almost full (System health: Disk space)
Free space: empty the Recycle Bin and remove large downloads. Don't delete files in the project folder. If
`backups\auto` is large, lower `LBE_AUTO_BACKUP_KEEP` in the settings file and restart.

## Afterwards

Write a short note: date and time, what happened, what you did, whether LinkedIn was told (and when). Keep it
with your company records. If the system itself was at fault, tell your developer so it can be fixed and tested.
