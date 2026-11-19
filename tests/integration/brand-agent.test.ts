// Brand Brain + agent workflow, end to end through the API and database (mock specialists, mock publisher).
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockSpecialists, type Specialists } from "@lbe/agents";
import { MockDrafter, type Drafter, type DraftInput, type DraftResult } from "@lbe/drafting";
import { MockLinkedInProvider } from "@lbe/publishing";
import { createApp } from "../../services/api/src/app.ts";
import { dbMockStore, runPublisherTick } from "../../services/api/src/jobs/publisher.ts";
import { runAgentJobTick } from "../../services/api/src/jobs/agent-runner.ts";
import { expectCode, freshDb, TEST_PASSWORDS, type TestDb } from "../helpers/db.ts";

const ORIGIN = "http://localhost:5173";
const GOAL = "Create a one-week LinkedIn strategy for ActTrident about phishing awareness for UK businesses.";
let t: TestDb;
let app: ReturnType<typeof createApp>;
let specialists: Specialists;
let writerOverride: ((i: DraftInput) => DraftResult) | undefined;
const writerInputs: DraftInput[] = [];
let orgB: { org: string; account: string; password: string };
let testWriter: Drafter;
const app_writer = () => testWriter;

const EMAIL = { admin: "admin@lbe.test", approver: "marketing@lbe.test", founder: "founder@lbe.test", editor: "editor@lbe.test",
  adminB: "admin@other.test" } as const;
const PW: Record<keyof typeof EMAIL, string> = { ...TEST_PASSWORDS, adminB: "other-org-password-1" };

beforeAll(async () => {
  t = await freshDb();
  const real = new MockDrafter();
  const writer: Drafter = { provider: "mock", model: "mock-drafter-v1", draft: async (i) => { writerInputs.push(i); return writerOverride ? writerOverride(i) : real.draft(i); } };
  testWriter = writer;
  specialists = mockSpecialists();
  app = createApp({
    db: t.db, drafter: writer, provider: new MockLinkedInProvider(dbMockStore(t.db)), specialists,
    appOrigins: [ORIGIN], cookieSecure: false, voiceDir: path.resolve(import.meta.dirname, "../../brand/voice"), workerId: "it", log: () => undefined,
  });
  // A second organization with its own admin and account (tenant B).
  const [o] = await t.db.query<{ id: string }>("insert into lbe.organizations(name, slug) values ('Other Co', 'other-co') returning id");
  await t.db.query("select lbe.admin_create_user($1, 'Other Admin', 'admin', $2, $3)", [EMAIL.adminB, PW.adminB, o!.id]);
  const [a] = await t.db.query<{ id: string }>(
    "insert into lbe.social_accounts(kind, display_name, voice_profile, pillars, organization_id) values ('company_page', 'Other Co page', 'company', array['news'], $1) returning id", [o!.id]);
  orgB = { org: o!.id, account: a!.id, password: PW.adminB };
});
afterAll(async () => t.db.close());

async function login(who: keyof typeof EMAIL): Promise<string> {
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email: EMAIL[who], password: PW[who] }) });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
const sessionToken = (cookie: string) => cookie.split("=")[1]!;
async function call(cookie: string, method: string, url: string, body?: unknown) {
  const res = await app.request(url, { method, headers: { cookie, origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
/** Queue a workflow through the API (202 + job id), run the durable job runner once, return the finished workflow. */
async function runWorkflow(cookie: string, body: Record<string, unknown>) {
  const queued = await call(cookie, "POST", "/api/agent/workflows", body);
  expect(queued.status).toBe(202);
  const tick = await runAgentJobTick({ db: t.db, specialists, writer: app_writer(), voiceDir: path.resolve(import.meta.dirname, "../../brand/voice"), workerId: "it-runner" });
  expect(tick.job?.id).toBe(queued.body.job_id);
  const job = (await call(cookie, "GET", `/api/agent/jobs/${queued.body.job_id}`)).body;
  const wf = job.workflow_id ? (await call(cookie, "GET", `/api/agent/workflows/${job.workflow_id}`)).body : null;
  return { status: job.status === "succeeded" ? 201 : 500, job, body: { workflow_id: job.workflow_id, result: wf?.result } };
}
const asAgent = (sql: string, params: unknown[] = []) => t.db.tx("lbe_agent", (q) => q.query(sql, params));
const count = async (sql: string, params: unknown[] = []) => (await t.db.query<{ n: number }>(sql, params))[0]!.n;

async function seedBrain(admin: string) {
  const entries: Array<[string, string, string, string, Record<string, unknown>?]> = [
    ["identity", "main", "Who we are", "[SYNTHETIC] ActTrident helps UK organisations run practical, jargon-free security programmes. Visual identity: navy and white, calm, real people at work."],
    ["positioning", "main", "Positioning", "[SYNTHETIC] For UK SMEs that need security help without an in-house team."],
    ["messaging", "main", "Key messages", "[SYNTHETIC] Security is a habit, not a product. Report early, without blame."],
    ["icp", "main", "Ideal customers", "[SYNTHETIC] UK businesses with 20–250 staff; buyer is the operations or IT lead."],
    ["audience_problems", "main", "Problems", "[SYNTHETIC] Staff click on phishing links; nobody knows what to do next."],
    ["voice_company", "main", "Company voice", "COMPANY-VOICE-MARKER: calm, expert, 'we'."],
    ["voice_founder", "main", "Founder voice", "FOUNDER-VOICE-MARKER: personal, reflective, 'I'."],
    ["product", "main", "Product", "[SYNTHETIC] Awareness training and incident response retainers (no roadmap claims)."],
    ["pillars_goals", "main", "Goals", "[SYNTHETIC] Q4 goal: awareness among UK SME operations leads."],
    ["prohibited", "main", "Never say", "Never claim to be unhackable or to guarantee protection.", { terms: ["unhackable", "guaranteed protection"], topics: ["competitor pricing"] }],
  ];
  for (const [section, key, title, body, structured] of entries) {
    const r = await call(admin, "POST", "/api/brain/entries", { section, key, title, body, structured });
    expect(r.status).toBe(201);
  }
}

describe("Brand Brain — owner-controlled knowledge", () => {
  it("starts empty with every required section reported as missing", async () => {
    const editor = await login("editor");
    const r = await call(editor, "GET", "/api/brain");
    expect(r.body.organization.name).toBe("ActTrident");
    expect(r.body.missing_sections).toContain("positioning");
    expect(r.body.sections.length).toBeGreaterThan(10);
  });

  it("only an admin (owner) can write approved knowledge", async () => {
    const editor = await login("editor");
    expect((await call(editor, "POST", "/api/brain/entries", { section: "identity", key: "main", title: "x", body: "x" })).status).toBe(403);
    await seedBrain(await login("admin"));
    const r = await call(editor, "GET", "/api/brain");
    expect(r.body.missing_sections).toEqual([]);
  });

  it("knowledge is versioned and approved entries are immutable even for the database owner", async () => {
    const admin = await login("admin");
    await call(admin, "POST", "/api/brain/entries", { section: "messaging", key: "main", title: "Key messages", body: "[SYNTHETIC] v2 messages." });
    const rows = await t.db.query<{ id: string; version: number; status: string }>(
      "select id, version, status from lbe.brand_entries where section = 'messaging' and key = 'main' order by version");
    expect(rows.map((r) => [r.version, r.status])).toEqual([[1, "retired"], [2, "approved"]]);
    await expectCode(t.db.query("update lbe.brand_entries set body = 'tampered' where id = $1", [rows[1]!.id]), "LBE01");
    await expectCode(t.db.query("delete from lbe.brand_entries where id = $1", [rows[1]!.id]), "LBE01");
  });

  it("agents and the API role cannot write brand knowledge directly (memory write-back authorization)", async () => {
    const s = sessionToken(await login("admin"));
    await expectCode(asAgent("select lbe.brain_upsert_entry($1, 'identity', 'main', 't', 'b', '{}'::jsonb, 'owner', null)", [s]), "42501");
    await expectCode(asAgent("select lbe.brain_decide_proposal($1, gen_random_uuid(), 'accepted', null, null, null)", [s]), "42501");
    await expectCode(asAgent("insert into lbe.brand_entries(organization_id, section, key, title, body, version, source, approved_by) select organization_id, 'identity', 'x', 't', 'b', 9, 'owner', id from lbe.app_users limit 1"), "42501");
    await expectCode(t.db.tx("lbe_api", (q) => q.query("select * from lbe.brand_entries")), "42501");
    await expectCode(t.db.tx("lbe_api", (q) => q.query("update lbe.brand_entries set status = 'retired'")), "42501");
  });

  it("a proposal that conflicts with an approved fact is flagged and changes nothing until the owner decides", async () => {
    const editor = await login("editor");
    const s = sessionToken(editor);
    const [p] = await asAgent("select lbe.brain_propose($1, 'positioning', 'main', 'Positioning', 'We are the #1 provider in Europe.', '{}'::jsonb, 'agent idea', '[]'::jsonb, 'content_strategy') as id", [s]) as Array<{ id: string }>;
    const list = await call(editor, "GET", "/api/brain/proposals?status=pending");
    const prop = list.body.find((x: { id: string }) => x.id === p!.id);
    expect(prop.conflicts_with).toBeTruthy();
    expect(prop.current_body).toContain("For UK SMEs");
    expect(prop.proposer).toBe("agent:content_strategy");
    expect((await call(editor, "GET", "/api/brain")).body.entries.find((e: { section: string }) => e.section === "positioning").body).toContain("For UK SMEs");
    expect((await call(editor, "POST", `/api/brain/proposals/${p!.id}/decision`, { decision: "accepted" })).status).toBe(403);
    const admin = await login("admin");
    expect((await call(admin, "POST", `/api/brain/proposals/${p!.id}/decision`, { decision: "rejected", note: "not true" })).status).toBe(200);
    await expectCode(t.db.query("update lbe.brand_proposals set status = 'pending' where id = $1", [p!.id]), "LBE01");
  });

  it("the owner can correct a proposal before accepting it", async () => {
    const editor = await login("editor");
    const [p] = await asAgent("select lbe.brain_propose($1, 'communication_rules', 'hashtags', 'Hashtags', 'Use 10 hashtags.', '{}'::jsonb, 'reach', '[]'::jsonb, 'content_strategy') as id", [sessionToken(editor)]) as Array<{ id: string }>;
    const admin = await login("admin");
    await call(admin, "POST", `/api/brain/proposals/${p!.id}/decision`, { decision: "accepted", body: "Use at most 3 relevant hashtags." });
    const brain = (await call(admin, "GET", "/api/brain")).body;
    const rule = brain.entries.find((e: { key: string }) => e.key === "hashtags");
    expect(rule).toMatchObject({ body: "Use at most 3 relevant hashtags.", source: "agent_proposal" });
  });
});

describe("tenant isolation of memory", () => {
  it("each organization sees only its own Brand Brain, proposals and research", async () => {
    const b = await login("adminB");
    const brainB = (await call(b, "GET", "/api/brain")).body;
    expect(brainB.organization.name).toBe("Other Co");
    expect(brainB.entries).toEqual([]);
    expect(brainB.accounts.map((a: { id: string }) => a.id)).toEqual([orgB.account]);
    expect((await call(b, "GET", "/api/brain/proposals")).body).toEqual([]);
    expect((await call(b, "GET", "/api/research")).body).toEqual([]);
    expect((await call(b, "GET", "/api/claims")).body).toEqual([]);
    expect((await call(b, "GET", "/api/content")).body).toEqual([]);
  });

  it("cannot act on another organization's objects", async () => {
    const editorA = await login("editor");
    const [p] = await asAgent("select lbe.brain_propose($1, 'lessons', 'x', 'X', 'y', '{}'::jsonb, 'r', '[]'::jsonb, null) as id", [sessionToken(editorA)]) as Array<{ id: string }>;
    const b = await login("adminB");
    const sB = sessionToken(b);
    expect((await call(b, "POST", `/api/brain/proposals/${p!.id}/decision`, { decision: "accepted" })).status).toBe(404);
    await expectCode(t.api("select lbe.create_content($1, $2, 'threat-landscape', 'b', null, null)", [sB, t.ids.accounts.company]), "LBE04");
    // Org B content may not cite org A's verified claim.
    const idB = await t.api<string>("select lbe.create_content($1, $2, 'news', 'b', null, null)", [sB, orgB.account]);
    await expectCode(t.api("select lbe.set_draft_output($1, $2, 'x', $3::jsonb, '[]'::jsonb)",
      [sB, idB, JSON.stringify([{ claim_id: t.ids.claims[0], quoted_span: "x" }])]), "LBE02");
    await expectCode(t.api("select lbe.set_claim_status($1, $2, 'expired')", [sB, t.ids.claims[0]]), "LBE04");
    expect((await call(b, "GET", `/api/content/${t.ids.claims[0]}`)).status).toBe(404);
  });

  it("an approver cannot be attached to another organization's account", async () => {
    const [u] = await t.db.query<{ id: string }>("select id from lbe.app_users where email = $1", [EMAIL.adminB]);
    await expectCode(t.db.query("insert into lbe.account_approvers(account_id, user_id) values ($1, $2)", [t.ids.accounts.company, u!.id]), "LBE11");
  });
});

describe("complete example: one-week phishing awareness strategy (mock specialists, mock publisher)", () => {
  let result: Record<string, any>;
  let workflowId: string;

  it("runs the full workflow and produces approval-ready drafts without publishing anything", async () => {
    const mockPostsBefore = await count("select count(*)::int as n from lbe_mock.linkedin_posts");
    const approvalsBefore = await count("select count(*)::int as n from lbe.content_approvals");
    const outboxBefore = await count("select count(*)::int as n from lbe.publication_outbox");
    writerInputs.length = 0;
    const editor = await login("editor");
    const r = await runWorkflow(editor, { goal: GOAL, start_date: "2026-11-23", days: 7 });
    expect(r.status).toBe(201);
    workflowId = r.body.workflow_id;
    result = r.body.result;

    // Research summary with sources, timestamps, confidence; bad sources rejected/flagged
    expect(result.research.summary.length).toBeGreaterThanOrEqual(3);
    for (const f of result.research.summary) {
      expect(f.source_url).toMatch(/^https:\/\//);
      expect(f.retrieved_at).toBeTruthy();
      expect(["high", "medium", "low"]).toContain(f.confidence);
    }
    expect(result.research.rejected.map((x: { reason: string }) => x.reason)).toContain("source must use HTTPS");
    expect(result.research.stale).toBe(1);
    expect(result.research.flagged).toBe(1);

    // Content plan with 3–5 posts, each in company AND founder voice
    expect(result.strategy.items.length).toBeGreaterThanOrEqual(3);
    expect(result.strategy.items.length).toBeLessThanOrEqual(5);
    expect(result.drafts.length).toBe(result.strategy.items.length * 2);
    const groups = new Map<string, string[]>();
    for (const d of result.drafts) groups.set(d.variant_group, [...(groups.get(d.variant_group) ?? []), d.account_kind]);
    for (const kinds of groups.values()) expect(kinds.sort()).toEqual(["company_page", "founder_profile"]);

    // Visual briefs and claims report
    for (const d of result.drafts) expect(d.visual_brief?.format).toMatch(/single_image|document_carousel|text_only/);
    expect(result.claims_report.drafts_with_unsupported_statements).toBe(0);
    expect(result.claims_report.submitted_for_review).toBe(result.drafts.length);

    // Approval-ready records, nothing approved or published
    const statuses = await t.db.query<{ status: string; created_via: string }>(
      "select status, created_via from lbe.content_items where workflow_id = $1", [workflowId]);
    expect(statuses.every((s) => s.status === "in_review" && s.created_via === "agent")).toBe(true);
    expect(await count("select count(*)::int as n from lbe.content_approvals")).toBe(approvalsBefore);
    expect(await count("select count(*)::int as n from lbe.publication_outbox")).toBe(outboxBefore);
    expect(await count("select count(*)::int as n from lbe_mock.linkedin_posts")).toBe(mockPostsBefore);
    expect(result.publishing).toMatch(/Nothing was published/);
  });

  it("keeps company and founder voices separate", () => {
    const company = writerInputs.filter((i) => i.accountKind === "company_page");
    const founder = writerInputs.filter((i) => i.accountKind === "founder_profile");
    expect(company.every((i) => i.voiceProfile.includes("COMPANY-VOICE-MARKER") && !i.voiceProfile.includes("FOUNDER-VOICE-MARKER"))).toBe(true);
    expect(founder.every((i) => i.voiceProfile.includes("FOUNDER-VOICE-MARKER") && !i.voiceProfile.includes("COMPANY-VOICE-MARKER"))).toBe(true);
    expect(writerInputs.every((i) => i.brandContext?.includes("For UK SMEs"))).toBe(true);
    expect(result.brain.voice_sources).toEqual({ company_page: "brain", founder_profile: "brain" });
  });

  it("never feeds flagged (injected) or stale research into drafts", () => {
    const material = writerInputs.map((i) => i.sourceMaterial ?? "").join("\n");
    expect(material).not.toMatch(/Ignore previous instructions/i);
    expect(material).not.toContain("old-survey");
  });

  it("the workflow is retrievable with strategy, findings and drafts", async () => {
    const editor = await login("editor");
    const w = (await call(editor, "GET", `/api/agent/workflows/${workflowId}`)).body;
    expect(w.status).toBe("completed");
    expect(w.strategy.items.length).toBe(result.strategy.items.length);
    expect(w.findings.every((f: { retrieved_at: string }) => !!f.retrieved_at)).toBe(true);
    expect(w.drafts.length).toBe(result.drafts.length);
  });

  it("does not recommend duplicates of recent content on the next run", async () => {
    const editor = await login("editor");
    const r = await runWorkflow(editor, { goal: GOAL, start_date: "2026-11-30", days: 7 });
    expect(r.status).toBe(201);
    const dropped = r.body.result.strategy.dropped as Array<{ reason: string }>;
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.every((d) => d.reason.startsWith("duplicates recent content"))).toBe(true);
    const firstTopics = result.strategy.items.map((i: { topic: string }) => i.topic);
    for (const item of r.body.result.strategy.items) expect(firstTopics).not.toContain(item.topic);
  });

  it("an approved agent draft goes through the normal mock publishing path", async () => {
    const approver = await login("approver");
    const companyDraft = result.drafts.find((d: { account_kind: string }) => d.account_kind === "company_page");
    const detail = (await call(approver, "GET", `/api/content/${companyDraft.content_id}`)).body;
    expect((await call(approver, "POST", `/api/content/${companyDraft.content_id}/decision`,
      { decision: "approved", expected_package_hash: detail.item.package_hash })).status).toBe(200);
    expect((await call(approver, "POST", `/api/content/${companyDraft.content_id}/enqueue`)).status).toBe(200);
    // The agent scheduled it for its plan day; simulate that time arriving.
    await t.db.query("update lbe.publication_outbox set available_at = now() where content_id = $1", [companyDraft.content_id]);
    const s = await runPublisherTick(t.db, new MockLinkedInProvider(dbMockStore(t.db)), { workerId: "it" });
    expect(s.succeeded).toBe(1);
    const [post] = await t.db.query<{ commentary: string }>("select commentary from lbe_mock.linkedin_posts order by id desc limit 1");
    expect(post!.commentary).toBe(companyDraft.body);
  });
});

describe("safety: unsupported claims, injection and approval bypass", () => {
  it("drafts with unsupported security claims or prohibited terms are held as drafts, not submitted", async () => {
    writerOverride = (i) => ({ kind: "ok", raw: {
      body: i.accountKind === "company_page" ? "ActTrident blocks 99% of phishing attacks." : "Our approach makes you unhackable.",
      hook_variants: [], claims_used: [], unsupported_statements: [], notes_for_reviewer: "" } });
    const editor = await login("editor");
    const r = await runWorkflow(editor, { goal: "Week of posts on ransomware readiness for UK firms", start_date: "2026-12-07" });
    writerOverride = undefined;
    expect(r.status).toBe(201);
    const drafts = r.body.result.drafts as Array<{ status: string; unsupported: string[]; account_kind: string }>;
    expect(drafts.every((d) => d.status === "draft" && d.unsupported.length > 0)).toBe(true);
    expect(drafts.find((d) => d.account_kind === "founder_profile")!.unsupported).toContain('Prohibited by brand rules: "unhackable"');
  });

  it("model output that tries to set extra fields (e.g. approval) is rejected", async () => {
    writerOverride = () => ({ kind: "ok", raw: { body: "x", hook_variants: [], claims_used: [], unsupported_statements: [], notes_for_reviewer: "", status: "approved" } });
    const editor = await login("editor");
    const r = await runWorkflow(editor, { goal: "Supply-chain security week", start_date: "2026-12-14" });
    writerOverride = undefined;
    expect(r.body.result.drafts.every((d: { status: string; error?: string }) => d.status === "draft" && /schema validation/.test(d.error ?? ""))).toBe(true);
  });

  it("a strategy that smuggles extra instructions fails the workflow safely", async () => {
    const original = specialists.strategy;
    (specialists as { strategy: Specialists["strategy"] }).strategy = mockSpecialists({ strategy: () => ({ kind: "ok", raw: {
      summary: "s", items: [{ day: 1, topic: "t", angle: "a", objective: "o", audience_problem: "p",
        pillars: { company_page: "security-culture", founder_profile: "founder-lessons" }, finding_ids: [], claim_ids: [], publish_immediately: true }] } }) }).strategy;
    const editor = await login("editor");
    const r = await runWorkflow(editor, { goal: "Injected strategy test" });
    (specialists as { strategy: Specialists["strategy"] }).strategy = original;
    expect(r.status).toBe(500);
    const list = (await call(editor, "GET", "/api/agent/workflows")).body as Array<{ goal: string; status: string }>;
    expect(list.find((w) => w.goal === "Injected strategy test")!.status).toBe("failed");
  });

  it("the agent role cannot approve, release, publish, stop/resume or verify claims", async () => {
    const s = sessionToken(await login("admin"));
    for (const sql of [
      "select lbe.decide_content($1, gen_random_uuid(), 'x', 'approved', null)",
      "select lbe.enqueue_publication($1, gen_random_uuid())",
      "select lbe.release_publication($1, gen_random_uuid())",
      "select lbe.set_stop($1, 'global', false, 'r')",
      "select lbe.set_claim_status($1, gen_random_uuid(), 'verified')",
      "select lbe.set_live_publishing($1, gen_random_uuid(), true, null)",
      "select lbe.research_review($1, gen_random_uuid(), 'accepted')",
    ]) {
      await expectCode(asAgent(sql, [s]), "42501");
    }
    await expectCode(asAgent("select * from lbe.content_items"), "42501");
    await expectCode(asAgent("select * from lbe.linkedin_credentials"), "42501");
  });
});

describe("learning, onboarding and research hand-off", () => {
  it("review feedback becomes a learning PROPOSAL that only the owner can accept", async () => {
    const approver = await login("approver");
    const editor = await login("editor");
    const wf = (await call(editor, "GET", "/api/agent/workflows")).body as Array<{ id: string; status: string }>;
    let target: { id: string } | undefined;
    for (const x of wf.filter((w) => w.status === "completed")) {
      const w = (await call(editor, "GET", `/api/agent/workflows/${x.id}`)).body;
      target = w.drafts.find((d: { status: string; account_kind: string }) => d.status === "in_review" && d.account_kind === "company_page");
      if (target) break;
    }
    if (!target) throw new Error("no in-review agent draft found");
    const detail = (await call(approver, "GET", `/api/content/${target.id}`)).body;
    await call(approver, "POST", `/api/content/${target.id}/decision`, { decision: "changes_requested", note: "Shorter opening line, no rhetorical questions.", expected_package_hash: detail.item.package_hash });

    const r = await call(editor, "POST", "/api/agent/learning-review");
    expect(r.status).toBe(200);
    expect(r.body.proposalIds.length).toBe(1);
    const proposals = (await call(editor, "GET", "/api/brain/proposals?status=pending")).body;
    const lesson = proposals.find((p: { id: string }) => p.id === r.body.proposalIds[0]);
    expect(lesson).toMatchObject({ section: "lessons", proposer: "agent:performance_analysis" });
    expect(lesson.body).toContain("Shorter opening line");
    expect((await call(editor, "POST", `/api/brain/proposals/${lesson.id}/decision`, { decision: "accepted" })).status).toBe(403);
    const admin = await login("admin");
    await call(admin, "POST", `/api/brain/proposals/${lesson.id}/decision`, { decision: "accepted" });
    expect((await call(editor, "GET", "/api/brain")).body.entries.some((e: { section: string }) => e.section === "lessons")).toBe(true);
  });

  it("onboarding ingestion creates grounded proposals, never direct knowledge", async () => {
    const editor = await login("editor");
    const before = (await call(editor, "GET", "/api/brain")).body.entries.length;
    const text = "## Audience language\nOur buyers say 'keep the lights on' and 'we don't have a security person'.\n\n## Communication rules\nNo emojis in company posts. Always UK spelling.";
    const r = await call(editor, "POST", "/api/brain/ingest", { name: "brand-notes.md", text });
    expect(r.status).toBe(200);
    expect(r.body.proposalIds.length).toBe(2);
    expect((await call(editor, "GET", "/api/brain")).body.entries.length).toBe(before);
  });

  it("an editor can turn a research finding into a DRAFT claim that still needs verification", async () => {
    const editor = await login("editor");
    const findings = (await call(editor, "GET", "/api/research")).body as Array<{ id: string; flags: string[]; stale: boolean; source_url: string }>;
    const good = findings.find((f) => !f.stale && f.flags.length === 0)!;
    const r = await call(editor, "POST", `/api/research/${good.id}/to-claim`, { category: "breach_statistic" });
    expect(r.status).toBe(201);
    const [claim] = await t.db.query<{ status: string; evidence_url: string }>("select status, evidence_url from lbe.claims where id = $1", [r.body.claim_id]);
    expect(claim).toEqual({ status: "draft", evidence_url: good.source_url });
  });
});

describe("content pillars (P2-01: single source, owner-edited)", () => {
  it("only the owner can change pillars; agents then plan and draft within the new pillars", async () => {
    const editor = await login("editor");
    const admin = await login("admin");
    const company = t.ids.accounts.company;
    expect((await call(editor, "PUT", `/api/accounts/${company}/pillars`, { pillars: ["x-y"] })).status).toBe(403);
    const r = await call(admin, "PUT", `/api/accounts/${company}/pillars`, { pillars: ["awareness-habits", "incident-readiness"] });
    expect(r.status).toBe(200);
    expect(r.body.pillars).toEqual(["awareness-habits", "incident-readiness"]);
    expect((await call(editor, "GET", "/api/brain")).body.accounts.find((a: { id: string }) => a.id === company).pillars)
      .toEqual(["awareness-habits", "incident-readiness"]);

    const wf = await runWorkflow(editor, { goal: "Password manager adoption week", start_date: "2027-01-04" });
    expect(wf.status).toBe(201);
    const items = wf.body.result.strategy.items as Array<{ pillars: { company_page: string } }>;
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(["awareness-habits", "incident-readiness"]).toContain(i.pillars.company_page);
    const companyDrafts = (wf.body.result.drafts as Array<{ content_id?: string; account_kind: string }>).filter((d) => d.account_kind === "company_page" && d.content_id);
    expect(companyDrafts.length).toBeGreaterThan(0);
    for (const d of companyDrafts) {
      const [row] = await t.db.query<{ pillar: string }>("select pillar from lbe.content_items where id = $1", [d.content_id]);
      expect(["awareness-habits", "incident-readiness"]).toContain(row!.pillar);
    }
  });

  it("existing content keeps its old pillar; new content must use an approved one", async () => {
    const editor = await login("editor");
    const [old] = await t.db.query<{ n: number }>(
      "select count(*)::int as n from lbe.content_items where account_id = $1 and pillar = 'security-culture'", [t.ids.accounts.company]);
    expect(old!.n).toBeGreaterThan(0);                                   // created before the change, untouched
    const bad = await call(editor, "POST", "/api/content", { account_id: t.ids.accounts.company, pillar: "security-culture", brief: "old pillar" });
    expect(bad.status).toBe(422);
    const good = await call(editor, "POST", "/api/content", { account_id: t.ids.accounts.company, pillar: "incident-readiness", brief: "new pillar" });
    expect(good.status).toBe(201);
  });
});

describe("missing knowledge", () => {
  it("a workflow for an organization with an empty Brand Brain reports gaps and marks them UNKNOWN", async () => {
    const b = await login("adminB");
    writerInputs.length = 0;
    const r = await runWorkflow(b, { goal: "Introduce Other Co on LinkedIn" });
    expect(r.status).toBe(201);
    expect(r.body.result.brain.missing_sections).toContain("product");
    expect(r.body.result.warnings.join(" ")).toMatch(/Brand Brain is missing/);
    expect(writerInputs.every((i) => (i.brandContext ?? "").includes("UNKNOWN"))).toBe(true);
    // Other Co has only a company page; drafts are created only for its own account.
    expect(r.body.result.drafts.every((d: { account_kind: string }) => d.account_kind === "company_page")).toBe(true);
  });
});
