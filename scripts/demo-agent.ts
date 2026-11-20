// Branding Agent demonstration against a RUNNING local server (npm start), development database only.
// Runs the brief's example goal and prints research, plan, drafts in both voices, visual briefs and the
// claims report. No external network calls in mock mode; nothing is published.
//   npm run demo:agent                          (uses whatever Brand Brain exists)
//   npm run demo:agent -- --with-synthetic-brain  (dev only: the synthetic admin fills empty sections with [SYNTHETIC] text)
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
if (existsSync(path.join(root, ".env"))) process.loadEnvFile(path.join(root, ".env"));
if (process.env.LBE_ENV === "staging") { console.error("Refusing: demo:agent is for the development environment only."); process.exit(1); }
const BASE = process.env.LBE_DEMO_URL ?? `http://127.0.0.1:${process.env.LBE_PORT ?? 8787}`;
const GOAL = "Create a one-week LinkedIn strategy for ActTrident about phishing awareness for UK businesses.";

class Session {
  cookie = "";
  async call<T = any>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE}/api${url}`, { method, headers: { origin: BASE, cookie: this.cookie,
      ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!;
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.error ?? ""}`);
    return data as T;
  }
  static async login(email: string, pwVar: string) {
    const s = new Session();
    await s.call("POST", "/auth/login", { email, password: process.env[pwVar] });
    return s;
  }
}

const SYNTHETIC: Record<string, [string, string, Record<string, unknown>?]> = {
  identity: ["Who we are", "[SYNTHETIC] ActTrident helps UK organisations run practical, jargon-free security programmes. Visual identity: navy and white, calm, real people at work."],
  positioning: ["Positioning", "[SYNTHETIC] For UK SMEs that need security help without an in-house security team."],
  messaging: ["Key messages", "[SYNTHETIC] Security is a habit, not a product. Report early, without blame. Small steps beat big promises."],
  icp: ["Buyer ICP", "[SYNTHETIC] UK businesses with 20–250 staff; the buyer is the operations or IT lead."],
  ideal_follower: ["Ideal follower", "[SYNTHETIC] UK IT managers, office managers and security-curious founders who share practical advice with their teams."],
  audience_problems: ["Audience problems", "[SYNTHETIC] Staff click on phishing links; nobody knows what to do in the first hour."],
  voice_company: ["Company voice", "[SYNTHETIC] Calm, expert, practical. 'We'. No fear-mongering, no hype."],
  voice_founder: ["Founder voice", "[SYNTHETIC] Personal and reflective, first person. Shares lessons, credits others."],
  product: ["Product knowledge", "[SYNTHETIC] Awareness training and incident response support. Do not mention roadmap features."],
  pillars_goals: ["Campaign goals", "[SYNTHETIC] Q4: build awareness among UK SME operations leads; encourage reporting culture."],
  prohibited: ["Never say", "[SYNTHETIC] Never claim to be unhackable or to guarantee protection.", { terms: ["unhackable", "guaranteed protection"], topics: ["competitor pricing"] }],
};

const editor = await Session.login("editor@lbe.test", "LBE_DEV_EDITOR_PASSWORD");
if (process.argv.includes("--with-synthetic-brain")) {
  const admin = await Session.login("admin@lbe.test", "LBE_DEV_ADMIN_PASSWORD");
  const brain = await admin.call("GET", "/brain");
  for (const s of brain.missing_sections as string[]) {
    const [title, body, structured] = SYNTHETIC[s]!;
    await admin.call("POST", "/brain/entries", { section: s, key: "main", title, body, structured });
  }
  console.log(`Filled ${brain.missing_sections.length} empty Brand Brain section(s) with [SYNTHETIC] development text (as the dev admin).`);
}
const outboxBefore = (await editor.call<unknown[]>("GET", "/outbox")).length;

console.log(`\nGoal: ${GOAL}\n`);
// The workflow runs as a durable background job (P4-01): queue it, then follow its progress.
const { job_id } = await editor.call<{ job_id: string }>("POST", "/agent/workflows", { goal: GOAL, days: 7 });
let job: { status: string; workflow_id: string | null; error: string | null; progress: { stage?: string; done?: number; total?: number } };
let lastStage = "";
const waitUntil = Date.now() + 10 * 60_000;
for (;;) {
  if (Date.now() > waitUntil) { console.error("Still waiting after 10 minutes — is the server running with LBE_RUN_AGENT_JOBS=true?"); process.exit(1); }
  job = await editor.call("GET", `/agent/jobs/${job_id}`);
  const stage = `${job.status}/${job.progress.stage ?? ""}${job.progress.total ? ` ${job.progress.done}/${job.progress.total}` : ""}`;
  if (stage !== lastStage) { console.log(`  job ${job.status}: ${job.progress.stage ?? "waiting"}${job.progress.total ? ` (${job.progress.done ?? 0}/${job.progress.total})` : ""}`); lastStage = stage; }
  if (!["queued", "running"].includes(job.status)) break;
  await new Promise((r) => setTimeout(r, 1000));
}
if (job.status !== "succeeded") { console.error(`Agent job ${job.status}: ${job.error ?? ""}`); process.exit(1); }
const workflow_id = job.workflow_id!;
const r = (await editor.call<{ result: any }>("GET", `/agent/workflows/${workflow_id}`)).result;

console.log(`Brand Brain: ${r.brain.organization} · missing sections: ${r.brain.missing_sections.join(", ") || "none"} · voices: company=${r.brain.voice_sources.company_page}, founder=${r.brain.voice_sources.founder_profile}`);
console.log(`\nRESEARCH (${r.research.provider}): ${r.research.accepted} kept, ${r.research.usable_as_evidence} usable as evidence, ${r.research.stale} stale, ${r.research.flagged} flagged, ${r.research.rejected.length} rejected`);
for (const f of r.research.summary) console.log(`  [${[f.confidence, ...f.flags].join(", ")}] ${f.statement.slice(0, 90)}\n      ${f.source_url} (retrieved ${f.retrieved_at})`);
for (const x of r.research.rejected) console.log(`  REJECTED ${x.source_url} — ${x.reason}`);

console.log(`\nPLAN: ${r.strategy.summary}`);
for (const i of r.strategy.items) console.log(`  Day ${i.day}: ${i.topic} — company: ${i.pillars.company_page}, founder: ${i.pillars.founder_profile}`);
for (const d of r.strategy.dropped) console.log(`  (not planned) ${d.topic}: ${d.reason}`);

console.log(`\nDRAFTS (${r.drafts.length})`);
for (const d of r.drafts) {
  console.log(`  [${d.account_kind === "company_page" ? "COMPANY" : "FOUNDER"}] ${d.status.toUpperCase()} · ${d.topic} · visual: ${d.visual_brief?.format ?? "none"} · citations: ${d.citations.length}`);
  console.log(`      ${String(d.body).replace(/\s+/g, " ").slice(0, 150)}…`);
  if (d.unsupported.length) console.log(`      UNSUPPORTED: ${d.unsupported.join(" | ")}`);
}
console.log(`\nCLAIMS REPORT: submitted for review ${r.claims_report.submitted_for_review}, held ${r.claims_report.held_as_draft}, verified claims used ${r.claims_report.verified_claims_used.length}`);
for (const w of r.warnings) console.log(`  note: ${w}`);
const outboxAfter = (await editor.call<unknown[]>("GET", "/outbox")).length;
console.log(`\nPublishing: outbox entries before ${outboxBefore}, after ${outboxAfter} — ${r.publishing}`);
console.log(`Open ${BASE}/#/agent/${workflow_id} to review.`);
