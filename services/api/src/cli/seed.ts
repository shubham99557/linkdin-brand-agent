// Seeds SYNTHETIC development data. Refuses to run if any users already exist.
import { loadConfig } from "../config.ts";
import { openConfiguredDb } from "../runtime.ts";
import { seed } from "../seed.ts";

const cfg = loadConfig();
const need = (name: string) => {
  const v = process.env[name];
  if (!v || v.length < 12) {
    console.error(`${name} must be set (12+ chars). Run "npm run setup:local" to generate a .env with random dev passwords.`);
    process.exit(1);
  }
  return v;
};
const passwords = {
  admin: need("LBE_DEV_ADMIN_PASSWORD"),
  approver: need("LBE_DEV_APPROVER_PASSWORD"),
  founder: need("LBE_DEV_FOUNDER_PASSWORD"),
  editor: need("LBE_DEV_EDITOR_PASSWORD"),
};
const db = await openConfiguredDb(cfg);
const existing = await db.query<{ n: number }>("select count(*)::int as n from lbe.app_users");
if ((existing[0]?.n ?? 0) > 0) {
  console.log("Users already exist — seed skipped (it never overwrites data).");
} else {
  const r = await seed(db, passwords);
  console.log("Seeded synthetic development data:");
  console.log("  admin@lbe.test, marketing@lbe.test (company approver), founder@lbe.test (founder approver), editor@lbe.test");
  console.log(`  accounts: company=${r.accounts.company} founder=${r.accounts.founder}`);
  console.log("  passwords: see LBE_DEV_*_PASSWORD in your local .env");
}
await db.close();
