// Prepares a SEPARATE staging configuration for the Stage 2.2 pilot:
//  - .env.staging (never overwrites), separate database folder, live publishing OFF, worker OFF
//  - a self-signed HTTPS certificate for https://localhost:8443 (Windows, via PowerShell)
// Makes no network calls. LinkedIn client id/secret are left blank for the owner to fill in.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const envPath = path.join(root, ".env.staging");
const pfxPath = path.join(root, "secrets", "localhost.pfx");
if (existsSync(envPath)) {
  console.log(".env.staging already exists — left unchanged.");
  process.exit(0);
}
mkdirSync(path.join(root, "secrets"), { recursive: true });

const passphrase = randomBytes(18).toString("base64url");
if (!existsSync(pfxPath)) {
  if (process.platform !== "win32") {
    console.error("Automatic certificate creation is implemented for Windows only. Create secrets/localhost.pfx manually (see docs/setup.md §8).");
    process.exit(1);
  }
  // Passphrase and output path are passed via environment variables, not the command line.
  const ps = [
    "$ErrorActionPreference='Stop'",
    "$c = New-SelfSignedCertificate -DnsName localhost -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddYears(1) -FriendlyName 'LinkedIn Brand Engine local staging'",
    "$pw = ConvertTo-SecureString $env:LBE_PFX_PASS -AsPlainText -Force",
    "Export-PfxCertificate -Cert $c -FilePath $env:LBE_PFX_OUT -Password $pw | Out-Null",
    // Remove it from the personal store again; the .pfx file is all the server needs.
    "Remove-Item -Path (\"Cert:\\CurrentUser\\My\\\" + $c.Thumbprint) -Confirm:$false",
  ].join("; ");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    env: { ...process.env, LBE_PFX_PASS: passphrase, LBE_PFX_OUT: pfxPath },
    stdio: "inherit",
  });
}

const env = `# Stage 2.2 pilot configuration — SEPARATE from your development .env. Git-ignored. Never share.
LBE_ENV=staging
LBE_HOST=127.0.0.1
LBE_PORT=8443
LBE_APP_ORIGINS=https://localhost:8443
LBE_COOKIE_SECURE=true
LBE_TLS_PFX=secrets/localhost.pfx
LBE_TLS_PFX_PASSPHRASE=${passphrase}

# Separate database for the pilot (never the development database)
LBE_DATABASE_URL=pglite
LBE_PGLITE_DIR=.data/staging

LBE_DRAFTER=mock
LBE_PUBLISHING_PROVIDER=mock
# Worker OFF during the pilot: an admin runs the publisher deliberately ("Run publisher now").
LBE_RUN_WORKER=false
LBE_WORKER_ID=staging-pilot

# ---- LinkedIn (founder pilot) ----
# Master switch: keep OFF until the go/no-go checklist in docs/pilot-2.2-runbook.md is complete.
LBE_LIVE_PUBLISHING=off
LBE_TOKEN_ENC_KEY=${randomBytes(32).toString("base64")}
LBE_TOKEN_KEY_ID=staging1
LBE_LINKEDIN_VERSION=202611
# ugcPosts = documented Share on LinkedIn endpoint (default). "posts" = newer Posts API (unconfirmed for this product).
LBE_LINKEDIN_MEMBER_ENDPOINT=ugcPosts
LBE_LINKEDIN_REDIRECT_URI=https://localhost:8443/api/oauth/linkedin/callback
# Fill these in yourself from the LinkedIn Developer Portal (do not paste them into chat):
LBE_LINKEDIN_FOUNDER_CLIENT_ID=
LBE_LINKEDIN_FOUNDER_CLIENT_SECRET=
# Company page is Stage 2.3 — leave blank for this pilot.
LBE_LINKEDIN_COMPANY_CLIENT_ID=
LBE_LINKEDIN_COMPANY_CLIENT_SECRET=
`;
writeFileSync(envPath, env, { encoding: "utf8", flag: "wx" });
console.log("Created .env.staging and secrets/localhost.pfx (self-signed, 1 year).");
console.log("Next: npm run staging:init   then create real users (see docs/pilot-2.2-runbook.md).");
