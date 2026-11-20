# Running the system on this PC (P9-01, owner decision D-13)

_Written 2026-11-20. Decision D-13: the code and all data stay on the PC that runs the system; there is no cloud
copy. This guide is the day-to-day manual. Commands are typed in PowerShell, in the project folder
`C:\Users\X1 Extreme Gen3\linkdin-brand-engine`._

## What runs where

| | Development | Staging (your real work) |
|---|---|---|
| Purpose | Testing with made-up data | Your real Brand Brain, real users, the LinkedIn pilot |
| Start | `npm start` | `npm run start:staging` |
| Address | http://127.0.0.1:8787 | https://localhost:8443 |
| Database | `.data\pglite` | `.data\staging` |
| Settings | `.env` | `.env.staging` |
| Automatic backups | `backups\auto\development` | `backups\auto\staging` |

- **This PC only.** Both servers answer only on this PC (`127.0.0.1` / `localhost`). Nobody on the network or the
  internet can reach them. Letting colleagues use it from their own computers needs a separate decision
  (HTTPS certificate for the PC's name, firewall rule, sign-in hardening P9-02). Ask Claude when that is needed.
- **Only while the server is running.** The dashboard, the Branding Agent and automatic backups work only while
  the server window is open. If the PC sleeps or is off, nothing is lost: queued agent work resumes and posts wait
  for you. Publishing to LinkedIn is always released by a person (ADR-014), so nothing posts on its own.
- **Secrets stay in two places.** `.env.staging` and `secrets\` (API key, LinkedIn app secret, token key,
  certificate) are on this PC only, are never copied by backups, and must never be pasted into chat or email.

## Start and stop

1. Open PowerShell → `cd "C:\Users\X1 Extreme Gen3\linkdin-brand-engine"` → `npm run start:staging`.
2. Open https://localhost:8443 and sign in.
3. To stop: click the PowerShell window and press **Ctrl+C**. Stopping is always safe; unfinished agent work
   resumes on the next start.

The start-up lines show the settings in use, including `automatic backups: every 24 h, keep 14` and
`LIVE LinkedIn publishing: off` (it stays off until the pilot checklist is complete).

## Backups: two layers

| Layer | What | How often | Protects against |
|---|---|---|---|
| **Automatic** (P9-04) | The running server backs up its own database, test-restores the copy in a separate process, keeps the newest 14 | Every 24 h, the first one about a minute after start | Mistakes, a damaged database, a bad update |
| **USB copy** (P0-07) | Code (full history) + every database, copied to a USB drive and proven to restore | **Weekly**, and before big changes | Losing the PC: disk failure, theft, ransomware |

C: and D: on this laptop are **one physical disk**, so only the USB copy protects against losing the PC.

**The Backups page** (admin only, in the dashboard menu) shows the newest automatic backup, whether the last one
worked, and when the last USB copy was made. It shows a warning when something needs doing (USB copy older than
7 days, no automatic backup, a failed backup).

**Weekly USB copy** (the server may keep running):
```powershell
npm run backup:external -- --to E:\LBE-backups
```
Use your USB drive's letter. It copies the code and databases into a new dated folder, then restores the copy
into a temporary folder to prove it works. While a server is running, its newest automatic backup is used (it must
be less than 26 hours old; otherwise stop the server and run the command again). Unplug the drive afterwards and
keep it somewhere safe; turn on BitLocker for it (right-click the drive → Turn on BitLocker).

**Check an old USB copy:** `npm run backup:verify -- --set E:\LBE-backups\<dated folder>`.

**Settings** (in `.env` / `.env.staging`, optional): `LBE_AUTO_BACKUP_HOURS` (default 24; 0 switches automatic
backups off) and `LBE_AUTO_BACKUP_KEEP` (default 14).

## Restore

Restoring never overwrites a database; it always goes into a new, empty folder.

1. Stop the server (Ctrl+C).
2. Pick a backup:
   - an automatic one: `backups\auto\staging\lbe-auto-staging-<date>.json`;
   - or one from the USB drive: `E:\LBE-backups\<dated folder>\databases\lbe-...json`.
3. Restore it into a new folder:
   `npm run db:restore -- --manifest <that .json file> --target .data\staging-restored`
4. Point the settings at it: in `.env.staging` change `LBE_PGLITE_DIR=.data/staging` to
   `LBE_PGLITE_DIR=.data/staging-restored`. Keep the old folder until you are happy.
5. Start the server. Everyone signs in again; LinkedIn connections may need reconnecting.

**On a new PC** (the old one is lost): install Git and Node.js, then follow `READ-ME-restore.txt` in the newest
backup folder on the USB drive. Enter the secrets again (`docs/owner-action-checklist.md`).

## Updating the software

Claude commits every change in Git on this PC, and the USB copy includes the full history. To update:
1. Check the Backups page shows an automatic backup from the last 24 hours (or make a USB copy). Database changes
   (migrations) are applied as soon as the server starts, so that backup is the way back if an update goes wrong.
2. Stop the server.
3. Run `npm ci`, then start the server again.

## Weekly routine (5 minutes)

1. Open the **Backups** page and check there is no warning.
2. Plug in the USB drive, run `npm run backup:external -- --to E:\LBE-backups`, and unplug the drive.
3. If the Backups page ever shows "failed", tell Claude the time it shows. Don't delete anything.
