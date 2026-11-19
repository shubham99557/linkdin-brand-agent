// Stage 2.2 go/no-go checks. Makes NO calls to LinkedIn and changes nothing.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createSecureContext } from "node:tls";
import { loadConfig, REPO_ROOT } from "../config.ts";
import { MIGRATIONS_DIR, openDb } from "../db.ts";

type Level = "PASS" | "WARN" | "FAIL";
const results: Array<[Level, string]> = [];
const check = (level: Level, msg: string) => results.push([level, msg]);

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  console.error(`FAIL  configuration: ${(e as Error).message}`);
  process.exit(1);
}

// --- configuration -----------------------------------------------------------
check(cfg.LBE_ENV === "staging" ? "PASS" : "FAIL", `LBE_ENV=${cfg.LBE_ENV} (pilot requires staging; run via npm run pilot:preflight)`);
const devDb = /[\\/]\.data[\\/]pglite$/.test(cfg.pgliteDir);
check(cfg.LBE_DATABASE_URL !== "pglite" || !devDb ? "PASS" : "FAIL", `database is separate from development (${cfg.LBE_DATABASE_URL === "pglite" ? cfg.pgliteDir : "PostgreSQL URL"})`);

if (!cfg.LBE_TLS_PFX) {
  check("FAIL", "LBE_TLS_PFX not set — LinkedIn only redirects to HTTPS");
} else {
  try {
    const pfx = readFileSync(path.resolve(REPO_ROOT, cfg.LBE_TLS_PFX));
    createSecureContext({ pfx, passphrase: cfg.LBE_TLS_PFX_PASSPHRASE });
    check("PASS", `TLS certificate loads (${cfg.LBE_TLS_PFX})`);
  } catch (e) {
    check("FAIL", `TLS certificate cannot be loaded: ${(e as Error).message}`);
  }
}
const expectedOrigin = `https://localhost:${cfg.LBE_PORT}`;
check(cfg.appOrigins.includes(expectedOrigin) ? "PASS" : "FAIL", `LBE_APP_ORIGINS includes ${expectedOrigin}`);
const expectedRedirect = `${expectedOrigin}/api/oauth/linkedin/callback`;
check(cfg.LBE_LINKEDIN_REDIRECT_URI === expectedRedirect ? "PASS" : "WARN",
  `redirect URI = ${cfg.LBE_LINKEDIN_REDIRECT_URI ?? "(not set)"} (expected ${expectedRedirect}; must be listed in the LinkedIn app)`);
check(cfg.linkedinApps.founder_app ? "PASS" : "FAIL", "founder LinkedIn app client id/secret set in .env.staging");
check(cfg.linkedinApps.company_app ? "WARN" : "PASS", cfg.linkedinApps.company_app
  ? "company app is configured — Stage 2.2 is founder-only; leave company live publishing off"
  : "company app not configured (correct for Stage 2.2)");
check(cfg.LBE_TOKEN_ENC_KEY ? "PASS" : "FAIL", "token encryption key set");
check(cfg.LBE_COOKIE_SECURE || !!cfg.LBE_TLS_PFX ? "PASS" : "WARN", "session cookie marked Secure");
check(!cfg.LBE_RUN_WORKER ? "PASS" : "WARN", `background worker ${cfg.LBE_RUN_WORKER ? "ON (posts go out ~15 s after release)" : "OFF (admin runs the publisher deliberately)"}`);
check(cfg.LBE_DRAFTER === "mock" ? "PASS" : "WARN", `drafter: ${cfg.LBE_DRAFTER}`);
check("PASS", `member endpoint: ${cfg.LBE_LINKEDIN_MEMBER_ENDPOINT} (${cfg.LBE_LINKEDIN_MEMBER_ENDPOINT === "ugcPosts" ? "documented for Share on LinkedIn" : "UNCONFIRMED for this product"})`);
check(cfg.liveEnabled ? "WARN" : "PASS", `LIVE master switch is ${cfg.liveEnabled ? "ON — posts can go to LinkedIn once released" : "off (switch on only at runbook step F)"}`);

// --- database ----------------------------------------------------------------
const db = await openDb({ url: cfg.LBE_DATABASE_URL, dataDir: cfg.LBE_DATABASE_URL === "pglite" ? cfg.pgliteDir : undefined });
try {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  const applied = await db.query<{ version: string }>("select version from public.lbe_schema_migrations").catch(() => []);
  check(applied.length === files.length ? "PASS" : "FAIL", `migrations applied: ${applied.length}/${files.length}${applied.length < files.length ? " (start the staging server once, or run npm run staging:init)" : ""}`);
  if (applied.length === files.length) {
    const founder = (await db.query<{ id: string; publishing_mode: string; release_mode: string; linkedin_urn: string | null }>(
      "select id, publishing_mode, release_mode, linkedin_urn from lbe.social_accounts where kind = 'founder_profile'"))[0];
    check(founder ? "PASS" : "FAIL", founder ? `founder account exists (${founder.id}) mode=${founder.publishing_mode} release=${founder.release_mode}` : "no founder account — run npm run staging:init");
    const users = await db.query<{ email: string; role: string; approver: boolean }>(
      `select u.email, u.role, exists (select 1 from lbe.account_approvers aa join lbe.social_accounts a on a.id = aa.account_id
                                        where aa.user_id = u.id and a.kind = 'founder_profile') as approver
         from lbe.app_users u where not u.disabled`);
    const synthetic = users.filter((u) => u.email.endsWith(".test"));
    check(synthetic.length === 0 ? "PASS" : "FAIL", synthetic.length ? `synthetic users present in staging: ${synthetic.map((u) => u.email).join(", ")}` : "no synthetic users in staging");
    check(users.some((u) => u.role === "admin") ? "PASS" : "FAIL", "at least one admin user (connects LinkedIn, runs the publisher)");
    check(users.some((u) => u.approver && (u.role === "approver" || u.role === "admin")) ? "PASS" : "FAIL", "founder account has an approver (the founder)");
    const flags = await db.query<{ key: string; stopped: boolean }>("select key, stopped from lbe.control_flags");
    const global = flags.find((f) => f.key === "global");
    check(global && !global.stopped ? "PASS" : "WARN", `global STOP is ${global?.stopped ? "ON (resume when ready)" : "off"}`);
    if (founder) {
      const cred = (await db.query<{ status: string; expires_at: string; subject_urn: string | null }>(
        "select status, expires_at, subject_urn from lbe.linkedin_credentials where account_id = $1", [founder.id]))[0];
      check(cred?.status === "valid" ? "PASS" : "WARN", cred
        ? `founder LinkedIn credential: ${cred.status}, expires ${cred.expires_at}, subject ${cred.subject_urn}`
        : "founder LinkedIn not connected yet (runbook step D)");
    }
  }
} finally {
  await db.close();
}

// --- owner preconditions (cannot be checked automatically) ---------------------
check("WARN", "P2-D8: real-PostgreSQL concurrency tests have not run (WSL2/Docker). Owner must run them or explicitly waive for the pilot.");
check("WARN", "Owner must be present and approve each live post (runbook step G).");

const order: Level[] = ["FAIL", "WARN", "PASS"];
for (const level of order) for (const [l, m] of results) if (l === level) console.log(`${l.padEnd(5)} ${m}`);
const fails = results.filter(([l]) => l === "FAIL").length;
console.log(`\n${fails === 0 ? "NO BLOCKING FAILURES" : `${fails} BLOCKING FAILURE(S)`} — this check made no calls to LinkedIn.`);
process.exit(fails === 0 ? 0 : 1);
