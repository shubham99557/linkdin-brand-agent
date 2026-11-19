// Brand Brain data-quality audit (read-only). Classifies every entry and claim per organization.
// Usage: npm run brain:audit            (development database)
//        npm run brain:audit:staging    (staging database)
// Run with the server stopped when using PGlite (one process per data folder).
import { claimIsSynthetic, entryQuality as classifyEntry } from "@lbe/agents";
import { SECTION_META } from "@lbe/domain";
import { loadConfig } from "../config.ts";
import { openDb } from "../db.ts";

const cfg = loadConfig();
const db = await openDb({ url: cfg.LBE_DATABASE_URL, dataDir: cfg.LBE_DATABASE_URL === "pglite" ? cfg.pgliteDir : undefined });
const orgs = await db.query<{ id: string; name: string }>("select id, name from lbe.organizations order by created_at").catch(() => []);
const out: string[] = [`# Brand Brain audit — ${cfg.LBE_ENV} database — ${new Date().toISOString()}`, ""];
if (orgs.length === 0) out.push("No organizations (schema not migrated?).");
let problems = 0;
for (const org of orgs) {
  const entries = await db.query<{ section: string; key: string; title: string; body: string; source: string; source_ref: string | null; version: number; approver: string }>(
    `select e.section, e.key, e.title, e.body, e.source, e.source_ref, e.version, u.email as approver
       from lbe.brand_entries e join lbe.app_users u on u.id = e.approved_by
      where e.organization_id = $1 and e.status = 'approved' order by e.section, e.key`, [org.id]);
  const claims = await db.query<{ statement: string; status: string; evidence_url: string | null; evidence_note: string | null }>(
    "select statement, status, evidence_url, evidence_note from lbe.claims where organization_id = $1 order by created_at", [org.id]);
  const syntheticUsers = await db.query<{ email: string }>("select email from lbe.app_users where organization_id = $1 and email like '%.test'", [org.id]);
  const mockFindings = await db.query<{ n: number }>("select count(*)::int as n from lbe.research_findings where organization_id = $1 and (statement like '[MOCK]%' or source_url like 'https://example.org/%')", [org.id]);

  out.push(`## ${org.name}`, "", "| Section | Required | Entries | Quality | Approved by | Source |", "|---|---|---|---|---|---|");
  for (const meta of SECTION_META) {
    // The visual identity (identity/visual: colours, logo) is reported separately and does not complete "Brand identity".
    const es = entries.filter((e) => e.section === meta.section && !(e.section === "identity" && e.key === "visual"));
    if (es.length === 0) {
      out.push(`| ${meta.label} | ${meta.required ? "yes" : "no"} | 0 | **UNKNOWN (missing)** | — | — |`);
      if (meta.required) problems++;
      continue;
    }
    for (const e of es) {
      const q = classifyEntry(e);
      if (q !== "OWNER_PROVIDED") problems++;
      out.push(`| ${meta.label} | ${meta.required ? "yes" : "no"} | ${e.key} v${e.version} | ${q === "OWNER_PROVIDED" ? "owner-provided" : `**${q}**`} | ${e.approver} | ${e.source}${e.source_ref ? ` (${e.source_ref})` : ""} |`);
    }
  }
  const visual = entries.find((e) => e.section === "identity" && e.key === "visual");
  out.push("", `Visual identity (colours/logo): ${visual ? `set (v${visual.version}, approved by ${visual.approver})` : "**not set — previews use placeholder branding**"}`);
  out.push("", "| Claim | Status | Quality | Evidence |", "|---|---|---|---|");
  for (const c of claims) {
    const synthetic = claimIsSynthetic(c);
    if (synthetic) problems++;
    out.push(`| ${c.statement.slice(0, 80)} | ${c.status} | ${synthetic ? "**SYNTHETIC**" : "owner-provided"} | ${c.evidence_url ?? (c.evidence_note ? "note only" : "none")} |`);
  }
  if (claims.length === 0) out.push("| (none) | | **UNKNOWN** — no claims | |");
  out.push("", `Synthetic users: ${syntheticUsers.map((u) => u.email).join(", ") || "none"} · Mock research findings: ${mockFindings[0]?.n ?? 0}`, "");
  problems += syntheticUsers.length > 0 ? 1 : 0;
}
out.push(`**Items needing owner action: ${problems}.** Synthetic or placeholder knowledge must be replaced by the owner — it is never promoted automatically.`);
console.log(out.join("\n"));
await db.close();
