// Export one organization's approved Brand Brain, verified claims and account pillars to JSON for evaluation.
// Usage: npm run brain:export -- --out eval-results/brain-dev.json [--org <slug>]
//        npm run brain:export:staging -- --out eval-results/brain-staging.json
// Output contains business information — it is written under eval-results/ (git-ignored). Read-only.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, REPO_ROOT } from "../config.ts";
import { openDb } from "../db.ts";

const { values } = parseArgs({ options: { out: { type: "string" }, org: { type: "string" } } });
if (!values.out) { console.error("--out <file.json> is required"); process.exit(1); }
const outPath = path.resolve(REPO_ROOT, values.out);
if (!outPath.startsWith(path.join(REPO_ROOT, "eval-results"))) { console.error("Write snapshots under eval-results/ (git-ignored)."); process.exit(1); }
const cfg = loadConfig();
const db = await openDb({ url: cfg.LBE_DATABASE_URL, dataDir: cfg.LBE_DATABASE_URL === "pglite" ? cfg.pgliteDir : undefined });
const [org] = await db.query<{ id: string; name: string; slug: string }>(
  values.org ? "select id, name, slug from lbe.organizations where slug = $1" : "select id, name, slug from lbe.organizations order by created_at limit 1",
  values.org ? [values.org] : []);
if (!org) { console.error("organization not found"); process.exit(1); }
const snapshot = {
  exported_at: new Date().toISOString(), environment: cfg.LBE_ENV, organization: { name: org.name, slug: org.slug },
  entries: await db.query("select section, key, title, body, structured, source, source_ref from lbe.brand_entries where organization_id = $1 and status = 'approved' order by section, key", [org.id]),
  claims: await db.query("select statement, category, evidence_url, evidence_note, expires_at from lbe.claims where organization_id = $1 and status = 'verified' and (expires_at is null or expires_at > now())", [org.id]),
  accounts: await db.query("select kind, display_name, pillars from lbe.social_accounts where organization_id = $1 order by kind", [org.id]),
};
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(snapshot, null, 2), "utf8");
console.log(`Exported ${snapshot.entries.length} entries, ${snapshot.claims.length} verified claims, ${snapshot.accounts.length} accounts → ${values.out}`);
await db.close();
