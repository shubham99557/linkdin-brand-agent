// Stage 2.2: READ-ONLY verification of the founder's LinkedIn connection.
// Calls LinkedIn's userinfo and token-introspection endpoints. Never posts anything.
// Requires the explicit flag --yes-call-linkedin.
import { fetchUserInfo, introspectToken } from "@lbe/publishing";
import { decryptToken, parseTokenKey } from "@lbe/security";
import { loadConfig } from "../config.ts";
import { openDb } from "../db.ts";
import { DatabaseInUseError } from "../pglite-lock.ts";

if (!process.argv.includes("--yes-call-linkedin")) {
  console.error("This makes read-only calls to LinkedIn (userinfo + token introspection). Re-run with --yes-call-linkedin to proceed.");
  process.exit(1);
}
const cfg = loadConfig();
if (cfg.LBE_ENV !== "staging" || !cfg.linkedinApps.founder_app) {
  console.error("Run with the staging configuration and a configured founder app (npm run pilot:verify -- --yes-call-linkedin).");
  process.exit(1);
}
// The server must be stopped while this reads the stored token (one program per embedded database, pglite-lock.ts).
const db = await openDb({ url: cfg.LBE_DATABASE_URL, dataDir: cfg.LBE_DATABASE_URL === "pglite" ? cfg.pgliteDir : undefined })
  .catch((e: unknown) => {
    if (e instanceof DatabaseInUseError) { console.error(e.message); process.exit(1); }
    throw e;
  });
const row = (await db.query<{ account_id: string; token_ciphertext: string; subject_urn: string | null; scopes: string[]; status: string; expires_at: string }>(
  `select c.account_id, c.token_ciphertext, c.subject_urn, c.scopes, c.status, c.expires_at
     from lbe.linkedin_credentials c join lbe.social_accounts a on a.id = c.account_id where a.kind = 'founder_profile'`))[0];
await db.close();
if (!row) {
  console.error("No founder credential stored yet — connect LinkedIn in the dashboard first (runbook step D).");
  process.exit(1);
}
const token = decryptToken(parseTokenKey(cfg.LBE_TOKEN_ENC_KEY), row.account_id, row.token_ciphertext);
const app = cfg.linkedinApps.founder_app;
const report: Array<[string, string]> = [["stored status", `${row.status}, expires ${row.expires_at}`], ["stored scopes", row.scopes.join(" ") || "(none reported)"]];
try {
  const info = await fetchUserInfo({ accessToken: token });
  const urn = `urn:li:person:${info.sub}`;
  report.push(["userinfo name", info.name ?? "(none)"]);
  report.push(["userinfo sub → URN", `${urn} ${urn === row.subject_urn ? "(matches stored subject)" : `(DOES NOT MATCH stored ${row.subject_urn})`}`]);
} catch (e) {
  report.push(["userinfo", `FAILED: ${(e as Error).message}`]);
}
try {
  const t = await introspectToken({ token, clientId: app.clientId, clientSecret: app.clientSecret });
  report.push(["introspection", `active=${t.active} status=${t.status ?? "?"} expires_at=${t.expiresAt ? new Date(t.expiresAt * 1000).toISOString() : "?"}`]);
  report.push(["introspection scope", t.scope ?? "(none)"]);
} catch (e) {
  report.push(["introspection", `FAILED: ${(e as Error).message}`]);
}
for (const [k, v] of report) console.log(`${k.padEnd(22)} ${v}`);
console.log("\nNo post was created. Record these results in docs/pilot-2.2-log.md (section 'Verification of unconfirmed items').");
