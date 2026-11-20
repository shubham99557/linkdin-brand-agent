// P2-05: fresh DEVELOPMENT database without the synthetic example knowledge (dev logins and accounts only).
// Usage (stop the development server first):
//   npm run brain:reset-dev                              empty Brand Brain, no example claims
//   npm run brain:reset-dev -- --with-synthetic-claims   also add the [SYNTHETIC] example claims
// Never touches staging. The old database folder is kept (renamed), never deleted.
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../config.ts";
import { DevResetRefused, resetDevDatabase } from "../dev-reset.ts";

const { values } = parseArgs({ options: { "with-synthetic-claims": { type: "boolean" } } });
if (process.env.LBE_ENV_FILE && process.env.LBE_ENV_FILE !== ".env") {
  console.error(`Refusing: LBE_ENV_FILE=${process.env.LBE_ENV_FILE}. brain:reset-dev only resets the development environment (.env).`);
  process.exit(1);
}
try {
  const r = await resetDevDatabase({ repoRoot: REPO_ROOT, withSyntheticClaims: values["with-synthetic-claims"] });
  console.log(`Development database reset: ${path.relative(REPO_ROOT, r.dataDir)}`);
  console.log(`  ${r.users} dev logins (passwords in .env), ${r.accounts} DEV accounts, ${r.claims} example claims, empty Brand Brain.`);
  if (r.movedTo) {
    console.log(`  Previous database kept as ${path.relative(REPO_ROOT, r.movedTo)} (to go back: stop the server and set LBE_PGLITE_DIR to it in .env).`);
  }
  console.log("Staging (your real data) was not touched.");
} catch (e) {
  console.error(e instanceof DevResetRefused ? e.message : `Reset failed: ${(e as Error).message}`);
  process.exit(1);
}
