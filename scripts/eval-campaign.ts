// Controlled evaluation: run ONE branding campaign in an isolated in-memory database, seeded from a Brand Brain
// snapshot, and write results + automated checks + a human scoring sheet. Never publishes; the publisher is not run.
//
// Mock (free, no network):
//   npm run eval:campaign -- --brain eval-results/brain-dev.json
// Real Claude (paid; requires ALL of: ANTHROPIC_API_KEY, --budget-usd, --i-authorize-paid-api):
//   npm run eval:campaign -- --provider anthropic --budget-usd 5 --i-authorize-paid-api --brain eval-results/brain-staging.json
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  anthropicSpecialists, evaluateCampaign, mockSpecialists, runBrandWorkflow, scoringSheet, type BrandBrain,
} from "@lbe/agents";
import { AnthropicDrafter, MockDrafter } from "@lbe/drafting";
import { migrate, openDb } from "../services/api/src/db.ts";

const GOAL = "Build a one-week LinkedIn branding strategy for ActTrident aimed at UK businesses, focusing on phishing awareness.";
const root = path.resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: {
  provider: { type: "string", default: "mock" }, "budget-usd": { type: "string" }, "i-authorize-paid-api": { type: "boolean", default: false },
  brain: { type: "string" }, out: { type: "string" }, model: { type: "string", default: "claude-opus-5-5" }, goal: { type: "string", default: GOAL },
} });

// ---- authorization gate for paid runs
const provider = values.provider;
if (provider !== "mock" && provider !== "anthropic") { console.error("--provider must be mock or anthropic"); process.exit(1); }
const budget = values["budget-usd"] ? Number(values["budget-usd"]) : undefined;
if (provider === "anthropic") {
  const missing = [
    !process.env.ANTHROPIC_API_KEY && "ANTHROPIC_API_KEY environment variable",
    !(budget && budget > 0) && "--budget-usd <positive number>",
    !values["i-authorize-paid-api"] && "--i-authorize-paid-api (explicit owner authorization)",
  ].filter(Boolean);
  if (missing.length) { console.error(`Paid evaluation refused. Missing: ${missing.join(", ")}`); process.exit(1); }
}

// ---- isolated database seeded from the snapshot
interface Snapshot { organization: { name: string }; environment?: string;
  entries: Array<{ section: string; key: string; title: string; body: string; structured: Record<string, unknown>; source: string; source_ref: string | null }>;
  claims: Array<{ statement: string; category: string; evidence_url: string | null; evidence_note: string | null }>;
  accounts: Array<{ kind: string; display_name: string; pillars: string[] }> }
const snapshot: Snapshot | null = values.brain ? JSON.parse(await readFile(path.resolve(root, values.brain), "utf8")) : null;
const db = await openDb({ url: "pglite" });
await migrate(db);
const one = async <T>(sql: string, params: unknown[] = []) => Object.values((await db.query<Record<string, unknown>>(sql, params))[0] ?? {})[0] as T;
const pw = "evaluation-only-password-1";
const admin = await one<string>("select lbe.admin_create_user('eval-admin@eval.test', 'Eval Owner', 'admin', $1)", [pw]);
await one("select lbe.admin_create_user('eval-editor@eval.test', 'Eval Editor', 'editor', $1)", [pw]);
const accounts = snapshot?.accounts.length ? snapshot.accounts : [
  { kind: "company_page", display_name: "ActTrident (company page)", pillars: ["threat-landscape", "product-education", "security-culture", "company-news"] },
  { kind: "founder_profile", display_name: "Founder", pillars: ["founder-lessons", "security-leadership", "industry-commentary"] }];
for (const a of accounts) {
  const id = await one<string>("insert into lbe.social_accounts(kind, display_name, voice_profile, pillars) values ($1, $2, $3, $4) returning id",
    [a.kind, a.display_name, a.kind === "company_page" ? "company" : "founder", a.pillars]);
  await db.query("insert into lbe.account_approvers values ($1, $2)", [id, admin]);
}
for (const e of snapshot?.entries ?? []) {
  await db.query("select lbe.brain_write_entry(lbe.default_org_id(), $1, $2, $3, $4, $5::jsonb, $6, $7, $8)",
    [e.section, e.key, e.title, e.body, JSON.stringify(e.structured ?? {}), e.source === "agent_proposal" ? "agent_proposal" : e.source, e.source_ref, admin]);
}
for (const c of snapshot?.claims ?? []) {
  const id = await one<string>("insert into lbe.claims(statement, category, evidence_url, evidence_note, created_by) values ($1, $2, $3, $4, $5) returning id",
    [c.statement, c.category, c.evidence_url, c.evidence_note, admin]);
  await db.query("update lbe.claims set status = 'verified', verified_by = $2, verified_at = now() where id = $1", [id, admin]);
}
const session = (await db.tx("lbe_api", (q) => q.query<{ r: { token: string } }>("select lbe.login('eval-editor@eval.test', $1) as r", [pw])))[0]!.r.token;

// ---- run
const key = process.env.ANTHROPIC_API_KEY;
const specialists = provider === "anthropic" ? anthropicSpecialists({ apiKey: key!, model: values.model }) : mockSpecialists();
const writer = provider === "anthropic" ? new AnthropicDrafter({ apiKey: key!, model: values.model }) : new MockDrafter();
const started = Date.now();
const { workflowId, result } = await runBrandWorkflow({ db, session, specialists, writer, budgetUsd: budget,
  readVoiceFile: async (p) => { const f = path.join(root, "brand", "voice", `${p}.md`); return existsSync(f) ? readFile(f, "utf8") : null; } },
  { goal: values.goal!, postCount: 4, days: 7 });
const brain = (await db.tx("lbe_api", (q) => q.query<{ b: BrandBrain }>("select lbe.brain_load($1) as b", [session])))[0]!.b;
const evaluation = evaluateCampaign(result, brain, { posts: 4 });
await db.close();

// ---- write results
const outDir = path.resolve(root, values.out ?? `eval-results/campaign-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await mkdir(outDir, { recursive: true });
const r = result as Record<string, any>;
const report = [
  `# Evaluation campaign — ${new Date().toISOString()}`, "",
  `- Goal: ${values.goal}`, `- Provider: **${provider}**${provider === "anthropic" ? ` (${values.model}, budget $${budget})` : " (offline mock — validates the pipeline, not content quality)"}`,
  `- Brand Brain snapshot: ${values.brain ?? "none (all sections UNKNOWN)"}${snapshot?.environment ? ` from ${snapshot.environment}` : ""}`,
  `- Workflow: ${workflowId} · duration ${((Date.now() - started) / 1000).toFixed(1)} s · estimated cost $${r.cost?.estimated_usd ?? 0}`,
  `- Publishing: none (isolated in-memory database; the publisher was not run)`, "",
  `## Verdict: **${evaluation.verdict}**`, "",
  evaluation.verdict === "NOT_READY" ? "Blocking findings:" : "No automated blocker found — human scoring (scoring-sheet.md) decides suitability.",
  ...evaluation.blocking.map((b) => `- ${b}`), "",
  "## Automated checks", "", "| Area | Check | Value | Status | Note |", "|---|---|---|---|---|",
  ...evaluation.checks.map((c) => `| ${c.area} | ${c.name} | ${c.value} | ${c.status} | ${c.note ?? ""} |`), "",
  "## Research sources", "", "| Confidence | Flags | Source | Retrieved |", "|---|---|---|---|",
  ...(r.research?.summary ?? []).map((s: any) => `| ${s.confidence} | ${s.flags.join(", ")} | ${s.source_url} | ${s.retrieved_at} |`),
  ...(r.research?.rejected ?? []).map((x: any) => `| — | REJECTED: ${x.reason} | ${x.source_url} | |`), "",
  "## Plan", "", ...(r.strategy?.items ?? []).map((i: any) => `- Day ${i.day}: **${i.topic}** — ${i.angle}`), "",
  "## Drafts", "",
  ...(r.drafts ?? []).flatMap((d: any) => [
    `### ${d.account_kind === "company_page" ? "Company" : "Founder"} — ${d.topic} (${d.status})`, "", "```", d.body ?? "", "```",
    d.unsupported?.length ? `Unsupported: ${d.unsupported.join(" | ")}` : "Unsupported: none",
    `Visual brief: ${d.visual_brief ? `${d.visual_brief.format} — “${d.visual_brief.headline}”` : "none"}`, ""]),
  "## Warnings", "", ...(r.warnings ?? []).map((w: string) => `- ${w}`),
].join("\n");
await writeFile(path.join(outDir, "report.md"), report, "utf8");
await writeFile(path.join(outDir, "scoring-sheet.md"), scoringSheet(r), "utf8");
await writeFile(path.join(outDir, "result.json"), JSON.stringify({ evaluation, result }, null, 2), "utf8");
console.log(`Verdict: ${evaluation.verdict} (${evaluation.blocking.length} blocking finding(s))`);
for (const b of evaluation.blocking) console.log(`  - ${b}`);
console.log(`Results: ${path.relative(root, outDir)}{report.md, scoring-sheet.md, result.json}`);
