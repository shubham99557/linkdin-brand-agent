// Creates the two social accounts in the STAGING database (no synthetic users, claims or content).
// Users are created separately with real names via `npm run staging:user`.
import { loadConfig } from "../config.ts";
import { openConfiguredDb } from "../runtime.ts";

const cfg = loadConfig();
if (cfg.LBE_ENV !== "staging") {
  console.error("staging:init only runs with LBE_ENV=staging (.env.staging).");
  process.exit(1);
}
if (cfg.LBE_DATABASE_URL === "pglite" && /[\\/]\.data[\\/]pglite$/.test(cfg.pgliteDir)) {
  console.error("Refusing: the staging configuration points at the development database (.data/pglite).");
  process.exit(1);
}
const db = await openConfiguredDb(cfg);
const existing = await db.query<{ id: string; kind: string }>("select id, kind from lbe.social_accounts order by kind");
if (existing.length > 0) {
  console.log("Accounts already exist — nothing changed:");
  for (const a of existing) console.log(`  ${a.kind}: ${a.id}`);
} else {
  const rows = await db.query<{ id: string; kind: string }>(
    `insert into lbe.social_accounts(kind, display_name, voice_profile, pillars) values
       ('founder_profile', 'Founder (authorised profile)', 'founder', array['founder-lessons', 'security-leadership', 'industry-commentary']),
       ('company_page', 'ActTrident (company page)', 'company', array['threat-landscape', 'product-education', 'security-culture', 'company-news'])
     returning id, kind`);
  console.log("Created staging accounts (mock mode, scheduled release until live is enabled):");
  for (const a of rows) console.log(`  ${a.kind}: ${a.id}`);
}
const founder = (await db.query<{ id: string }>("select id from lbe.social_accounts where kind = 'founder_profile'"))[0]!;
console.log(`
Next — create real users (password via environment variable so it is not in shell history):
  $env:LBE_NEW_USER_PASSWORD = Read-Host "Admin password (12+ chars)"
  npm run staging:user -- --email you@acttrident.example --name "Your Name" --role admin --approver-for ${founder.id}
  Remove-Item Env:LBE_NEW_USER_PASSWORD
(Use --role approver --approver-for ${founder.id} for the founder if they are not the admin.)`);
await db.close();
