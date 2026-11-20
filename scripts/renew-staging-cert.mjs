// P9-03: renew the self-signed HTTPS certificate for staging (https://localhost:8443) before it expires.
// Keeps the passphrase already in .env.staging, so no settings change. The old certificate is kept as
// secrets/<name>-replaced-<date>.pfx. Restart the staging server afterwards to use the new one.
// Usage: npm run staging:renew-cert          (Windows; makes no network calls)
//        node scripts/renew-staging-cert.mjs --root <folder>   (tests: another project folder)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { parseArgs, parseEnv } from "node:util";

const { values } = parseArgs({ options: { root: { type: "string" } } });
const root = path.resolve(values.root ?? path.join(import.meta.dirname, ".."));
const fail = (msg) => { console.error(msg); process.exit(1); };

if (process.platform !== "win32") fail("Certificate renewal is implemented for Windows only (see docs/setup.md §8 for other systems).");
const envPath = path.join(root, ".env.staging");
if (!existsSync(envPath)) fail("No .env.staging found: run npm run setup:staging first (it creates the first certificate).");
const env = parseEnv(readFileSync(envPath, "utf8"));
if (!env.LBE_TLS_PFX || !env.LBE_TLS_PFX_PASSPHRASE) fail(".env.staging has no LBE_TLS_PFX / LBE_TLS_PFX_PASSPHRASE: staging does not use HTTPS here.");
const pfxPath = path.resolve(root, env.LBE_TLS_PFX);
const rel = path.relative(path.join(root, "secrets"), pfxPath);
if (rel.startsWith("..") || path.isAbsolute(rel)) fail("Refusing: the certificate file must be inside the project's secrets folder.");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const kept = pfxPath.replace(/\.pfx$/i, "") + `-replaced-${stamp}.pfx`;
if (existsSync(pfxPath)) renameSync(pfxPath, kept);
// Same recipe as setup:staging. The passphrase and output path go through environment variables, never the command
// line; the temporary entry in the personal certificate store is removed again.
const ps = [
  "$ErrorActionPreference='Stop'",
  "$c = New-SelfSignedCertificate -DnsName localhost -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddYears(1) -FriendlyName 'LinkedIn Brand Engine local staging'",
  "$pw = ConvertTo-SecureString $env:LBE_PFX_PASS -AsPlainText -Force",
  "Export-PfxCertificate -Cert $c -FilePath $env:LBE_PFX_OUT -Password $pw | Out-Null",
  "Remove-Item -Path (\"Cert:\\CurrentUser\\My\\\" + $c.Thumbprint) -Confirm:$false",
].join("; ");
try {
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    env: { ...process.env, LBE_PFX_PASS: env.LBE_TLS_PFX_PASSPHRASE, LBE_PFX_OUT: pfxPath }, stdio: ["ignore", "inherit", "inherit"],
  });
} catch {
  if (existsSync(kept) && !existsSync(pfxPath)) renameSync(kept, pfxPath);    // put the old one back
  fail("Renewal failed; the old certificate is unchanged.");
}
console.log(`New certificate written: ${path.relative(root, pfxPath)} (localhost, valid 1 year).`);
if (existsSync(kept)) console.log(`Old certificate kept as ${path.relative(root, kept)}.`);
console.log("Restart the staging server to use it. Your browser may ask you to accept the new certificate once.");
