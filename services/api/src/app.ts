import { readFile } from "node:fs/promises";
import path from "node:path";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { CAPABILITIES, CLAIM_CATEGORIES, findUnsupportedStatements, type Role, type VerifiedClaim } from "@lbe/domain";
import { validateDraftOutput, PROMPT_VERSION, type Drafter } from "@lbe/drafting";
import type { PublishingProvider } from "@lbe/publishing";
import { isTrustedOrigin, looksLikeSessionToken, ROLE_HINTS, safeTokenEqual, SESSION_COOKIE } from "@lbe/security";
import { dbErrorStatus, type Db } from "./db.ts";
import { runPublisherTick } from "./jobs/publisher.ts";

export interface AppDeps {
  db: Db;
  drafter: Drafter;
  provider: PublishingProvider;
  appOrigins: string[];
  cookieSecure: boolean;
  voiceDir: string;
  workerId: string;
  internalJobToken?: string;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

interface SessionUser {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  approver_for: string[];
}

type Env = { Variables: { user: SessionUser; session: string } };

const uuid = z.string().uuid();
const isoOrNull = z.string().datetime({ offset: true }).nullable().optional();

export function createApp(deps: AppDeps) {
  const { db } = deps;
  const log = deps.log ?? ((msg, extra) => console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...extra })));
  const app = new Hono<Env>();

  /** Run SQL as lbe_api. */
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    db.tx("lbe_api", (t) => t.query<T>(sql, params));
  const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => {
    const rows = await q<Record<string, unknown>>(sql, params);
    const first = rows[0];
    return (first ? Object.values(first)[0] : undefined) as T;
  };
  const json = async <T>(c: Context, schema: z.ZodType<T>): Promise<T> => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new HTTPException(400, { message: "request body must be JSON" });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new HTTPException(422, { message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
    return parsed.data;
  };
  const param = (c: Context, name: string) => {
    const v = c.req.param(name);
    if (!uuid.safeParse(v).success) throw new HTTPException(404, { message: "not found" });
    return v!;
  };

  // ---------------------------------------------------------------- middleware
  app.use("*", secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"], connectSrc: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"],
      baseUri: ["'none'"], objectSrc: ["'none'"],
    },
    referrerPolicy: "no-referrer",
    xFrameOptions: "DENY",
  }));
  app.use("/api/*", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "request too large" }, 413) }));
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  // CSRF: state-changing cookie requests must come from an allowed origin.
  app.use("/api/*", async (c, next) => {
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD" && !c.req.path.startsWith("/api/internal/")) {
      const ok = isTrustedOrigin(
        { origin: c.req.header("origin"), secFetchSite: c.req.header("sec-fetch-site") }, deps.appOrigins);
      if (!ok) return c.json({ error: "cross-origin request refused" }, 403);
    }
    await next();
  });

  const requireAuth = async (c: Context<Env>, next: () => Promise<void>) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!looksLikeSessionToken(token)) return c.json({ error: "not authenticated" }, 401);
    const user = await one<SessionUser | null>("select lbe.whoami($1)", [token]);
    if (!user) return c.json({ error: "not authenticated" }, 401);
    c.set("user", user);
    c.set("session", token);
    await next();
  };

  app.notFound((c) => c.json({ error: "not found" }, 404));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    const mapped = dbErrorStatus(err);
    if (mapped) return c.json({ error: mapped.message }, mapped.status as 400);
    log("unhandled_error", { path: c.req.path, error: (err as Error).message });
    return c.json({ error: "internal error" }, 500);
  });

  // ---------------------------------------------------------------- public
  app.get("/api/health", async (c) => {
    await q("select 1");
    return c.json({ ok: true, publishing_provider: deps.provider.name, drafter: deps.drafter.provider });
  });

  const loginLimiter = new Map<string, { count: number; resetAt: number }>();
  app.post("/api/auth/login", async (c) => {
    const body = await json(c, z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }));
    const key = `${c.req.header("x-forwarded-for") ?? "local"}|${body.email.toLowerCase()}`;
    const now = Date.now();
    const entry = loginLimiter.get(key);
    if (entry && entry.resetAt > now && entry.count >= 10) return c.json({ error: "too many attempts — wait a minute" }, 429);
    const r = await one<{ ok: boolean; token?: string; expires_at?: string }>("select lbe.login($1, $2)", [body.email, body.password]);
    if (!r?.ok || !r.token) {
      loginLimiter.set(key, { count: (entry && entry.resetAt > now ? entry.count : 0) + 1, resetAt: entry && entry.resetAt > now ? entry.resetAt : now + 60_000 });
      return c.json({ error: "invalid email or password" }, 401);
    }
    loginLimiter.delete(key);
    setCookie(c, SESSION_COOKIE, r.token, {
      httpOnly: true, sameSite: "Strict", secure: deps.cookieSecure, path: "/", maxAge: 12 * 60 * 60,
    });
    return c.json({ ok: true });
  });

  // Internal job endpoint for an external orchestrator (n8n/cron). Disabled unless a token is configured.
  app.post("/api/internal/publisher-tick", async (c) => {
    if (!deps.internalJobToken) return c.json({ error: "internal jobs disabled" }, 404);
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!safeTokenEqual(token, deps.internalJobToken)) return c.json({ error: "unauthorized" }, 401);
    return c.json(await runPublisherTick(db, deps.provider, { workerId: `${deps.workerId}-ext` }));
  });

  // ---------------------------------------------------------------- authenticated
  const api = new Hono<Env>();
  api.use("*", requireAuth);

  api.post("/auth/logout", async (c) => {
    await q("select lbe.logout($1)", [c.get("session")]);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  api.get("/me", (c) => {
    const user = c.get("user");
    return c.json({ ...user, hints: ROLE_HINTS[user.role] });
  });

  api.get("/capabilities", (c) => c.json(CAPABILITIES));

  // Accounts & voices
  api.get("/accounts", async (c) => c.json(await q(
    `select a.id, a.kind, a.display_name, a.linkedin_urn, a.voice_profile, a.pillars, a.enabled, a.publishing_mode,
            cf.stopped, cf.reason as stop_reason,
            coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'display_name', u.display_name))
                        from lbe.account_approvers aa join lbe.app_users u on u.id = aa.user_id
                       where aa.account_id = a.id), '[]') as approvers
       from lbe.social_accounts a left join lbe.control_flags cf on cf.key = 'account:' || a.id::text
      order by a.kind`)));

  const readVoice = async (profile: string) => {
    if (!/^[a-z0-9_-]{1,40}$/.test(profile)) throw new HTTPException(404, { message: "voice not found" });
    try {
      return await readFile(path.join(deps.voiceDir, `${profile}.md`), "utf8");
    } catch {
      throw new HTTPException(404, { message: `voice profile brand/voice/${profile}.md is missing` });
    }
  };
  api.get("/accounts/:id/voice", async (c) => {
    const id = param(c, "id");
    const rows = await q<{ voice_profile: string }>("select voice_profile from lbe.social_accounts where id = $1", [id]);
    if (!rows[0]) throw new HTTPException(404, { message: "not found" });
    return c.json({ profile: rows[0].voice_profile, markdown: await readVoice(rows[0].voice_profile) });
  });

  // Claims register
  api.get("/claims", async (c) => c.json(await q(
    `select c.*, (c.status = 'verified' and (c.expires_at is null or c.expires_at > now())) as usable,
            cu.display_name as created_by_name, vu.display_name as verified_by_name
       from lbe.claims c join lbe.app_users cu on cu.id = c.created_by left join lbe.app_users vu on vu.id = c.verified_by
      order by c.created_at desc`)));

  api.post("/claims", async (c) => {
    const b = await json(c, z.object({
      statement: z.string().min(3).max(1000),
      category: z.enum(CLAIM_CATEGORIES),
      evidence_url: z.string().url().startsWith("https://").max(2000).nullable().optional(),
      evidence_note: z.string().max(2000).nullable().optional(),
      expires_at: isoOrNull,
    }));
    const id = await one<string>("select lbe.create_claim($1, $2, $3, $4, $5, $6)",
      [c.get("session"), b.statement, b.category, b.evidence_url ?? null, b.evidence_note ?? null, b.expires_at ?? null]);
    return c.json({ id }, 201);
  });

  api.post("/claims/:id/status", async (c) => {
    const id = param(c, "id");
    const b = await json(c, z.object({ status: z.enum(["verified", "rejected", "expired"]) }));
    await q("select lbe.set_claim_status($1, $2, $3)", [c.get("session"), id, b.status]);
    return c.json({ ok: true });
  });

  // Content calendar
  api.get("/content", async (c) => c.json(await q(
    `select ci.id, ci.account_id, a.display_name as account_name, a.kind as account_kind, ci.pillar, ci.status,
            ci.scheduled_for, ci.updated_at, ci.version, left(coalesce(nullif(ci.body, ''), ci.brief), 160) as excerpt,
            jsonb_array_length(ci.unsupported_statements) as unsupported_count
       from lbe.content_items ci join lbe.social_accounts a on a.id = ci.account_id
      order by coalesce(ci.scheduled_for, ci.created_at) desc
      limit 500`)));

  api.get("/content/:id", async (c) => {
    const id = param(c, "id");
    const items = await q<Record<string, unknown>>(
      `select ci.*, a.display_name as account_name, a.kind as account_kind, a.pillars as account_pillars
         from lbe.content_items ci join lbe.social_accounts a on a.id = ci.account_id where ci.id = $1`, [id]);
    if (!items[0]) throw new HTTPException(404, { message: "not found" });
    const [citations, approvals, outbox, audit, runs] = await Promise.all([
      q(`select cc.claim_id, cc.quoted_span, cl.statement, cl.category, cl.evidence_url, cl.evidence_note, cl.status,
                cl.expires_at, vu.display_name as verified_by_name, cl.verified_at
           from lbe.content_claims cc join lbe.claims cl on cl.id = cc.claim_id
           left join lbe.app_users vu on vu.id = cl.verified_by where cc.content_id = $1`, [id]),
      q(`select ap.id, ap.decision, ap.package_hash, ap.note, ap.created_at, u.display_name as approver_name
           from lbe.content_approvals ap join lbe.app_users u on u.id = ap.approver_id
          where ap.content_id = $1 order by ap.created_at desc`, [id]),
      q(`select id, status, attempts, max_attempts, available_at, last_error, provider_ref, package_hash, created_at, completed_at
           from lbe.publication_outbox where content_id = $1 order by created_at desc`, [id]),
      q(`select id, at, actor, action, details from lbe.audit_events
          where (subject_type = 'content_item' and subject_id = $1)
             or (subject_type = 'publication_outbox' and subject_id in
                   (select id::text from lbe.publication_outbox where content_id = $1::uuid))
          order by id desc limit 100`, [id]),
      q(`select id, provider, model, prompt_version, status, error, output->'validation_notes' as validation_notes,
                output->>'notes_for_reviewer' as notes_for_reviewer, output->'hook_variants' as hook_variants, finished_at
           from lbe.agent_runs where content_id = $1 order by finished_at desc limit 5`, [id]),
    ]);
    const user = c.get("user");
    const item = items[0];
    return c.json({
      item, citations, approvals, outbox, audit, agent_runs: runs,
      viewer: {
        is_account_approver: user.approver_for.includes(item.account_id as string),
        hints: ROLE_HINTS[user.role],
      },
    });
  });

  api.post("/content", async (c) => {
    const b = await json(c, z.object({
      account_id: uuid,
      pillar: z.string().min(1).max(80),
      brief: z.string().min(1).max(4000),
      source_material: z.string().max(20000).nullable().optional(),
      scheduled_for: isoOrNull,
    }));
    const id = await one<string>("select lbe.create_content($1, $2, $3, $4, $5, $6)",
      [c.get("session"), b.account_id, b.pillar, b.brief, b.source_material ?? null, b.scheduled_for ?? null]);
    return c.json({ id }, 201);
  });

  api.patch("/content/:id", async (c) => {
    const id = param(c, "id");
    const b = await json(c, z.object({
      body: z.string().max(3000).optional(),
      brief: z.string().min(1).max(4000).optional(),
      source_material: z.string().max(20000).nullable().optional(),
      pillar: z.string().min(1).max(80).optional(),
      visibility: z.enum(["PUBLIC", "CONNECTIONS"]).optional(),
      scheduled_for: isoOrNull,
    }).strict());
    const patch: Record<string, unknown> = { ...b };
    if (b.body !== undefined) {
      // A human edit re-runs the deterministic claim detector against the remaining citations.
      const spans = (await q<{ quoted_span: string }>("select quoted_span from lbe.content_claims where content_id = $1", [id]))
        .map((r) => r.quoted_span).filter((s) => b.body!.includes(s));
      patch.unsupported_statements = findUnsupportedStatements(b.body, spans).map((f) => f.sentence);
    }
    const row = await one<Record<string, unknown>>("select to_jsonb(lbe.update_content($1, $2, $3::jsonb))",
      [c.get("session"), id, JSON.stringify(patch)]);
    return c.json(row);
  });

  api.post("/content/:id/draft", async (c) => {
    const id = param(c, "id");
    const session = c.get("session");
    const items = await q<{ account_id: string; pillar: string; brief: string; source_material: string | null; status: string;
                            kind: "company_page" | "founder_profile"; display_name: string; voice_profile: string; pillars: string[] }>(
      `select ci.account_id, ci.pillar, ci.brief, ci.source_material, ci.status, a.kind, a.display_name, a.voice_profile, a.pillars
         from lbe.content_items ci join lbe.social_accounts a on a.id = ci.account_id where ci.id = $1`, [id]);
    const item = items[0];
    if (!item) throw new HTTPException(404, { message: "not found" });
    if (!["draft", "changes_requested", "failed"].includes(item.status)) {
      throw new HTTPException(409, { message: `cannot redraft content in status ${item.status}` });
    }
    const claims = await q<VerifiedClaim>(
      `select id, statement, category, evidence_url, evidence_note from lbe.claims
        where status = 'verified' and (expires_at is null or expires_at > now()) order by created_at`);
    const startedAt = new Date().toISOString();
    const result = await deps.drafter.draft({
      accountKind: item.kind,
      accountName: item.display_name,
      voiceProfile: await readVoice(item.voice_profile),
      pillar: item.pillar,
      allowedPillars: item.pillars,
      brief: item.brief,
      sourceMaterial: item.source_material,
      claims,
    });
    const run = {
      purpose: "draft_post", provider: deps.drafter.provider, model: deps.drafter.model, prompt_version: PROMPT_VERSION,
      content_id: id, input_refs: { claim_ids: claims.map((cl) => cl.id), had_source_material: !!item.source_material },
      started_at: startedAt,
    };
    if (result.kind !== "ok") {
      await one("select lbe.record_agent_run($1, $2::jsonb)", [session, JSON.stringify({
        ...run, status: result.kind === "refused" ? "refused" : "failed",
        error: result.kind === "refused" ? result.reason : result.message })]);
      throw new HTTPException(502, { message: result.kind === "refused" ? `AI declined to draft: ${result.reason}` : result.message });
    }
    const validated = validateDraftOutput(result.raw, claims);
    if (!validated.ok) {
      await one("select lbe.record_agent_run($1, $2::jsonb)", [session, JSON.stringify({
        ...run, status: "invalid_output", error: validated.error })]);
      throw new HTTPException(502, { message: validated.error });
    }
    const d = validated.draft;
    await one("select lbe.set_draft_output($1, $2, $3, $4::jsonb, $5::jsonb)",
      [session, id, d.body, JSON.stringify(d.citations), JSON.stringify(d.unsupported)]);
    await one("select lbe.record_agent_run($1, $2::jsonb)", [session, JSON.stringify({
      ...run, status: "succeeded",
      output: { body: d.body, citations: d.citations, unsupported: d.unsupported, hook_variants: d.hookVariants,
                notes_for_reviewer: d.notesForReviewer, validation_notes: d.validationNotes },
      input_tokens: result.usage?.inputTokens ?? null, output_tokens: result.usage?.outputTokens ?? null })]);
    return c.json({ ok: true, unsupported: d.unsupported, validation_notes: d.validationNotes });
  });

  api.post("/content/:id/submit", async (c) => {
    await q("select lbe.submit_for_review($1, $2)", [c.get("session"), param(c, "id")]);
    return c.json({ ok: true });
  });

  api.post("/content/:id/decision", async (c) => {
    const id = param(c, "id");
    const b = await json(c, z.object({
      decision: z.enum(["approved", "rejected", "changes_requested"]),
      expected_package_hash: z.string().regex(/^[0-9a-f]{64}$/),
      note: z.string().max(2000).nullable().optional(),
    }));
    const approvalId = await one<string>("select lbe.decide_content($1, $2, $3, $4, $5)",
      [c.get("session"), id, b.expected_package_hash, b.decision, b.note ?? null]);
    return c.json({ approval_id: approvalId });
  });

  api.post("/content/:id/enqueue", async (c) => {
    const outboxId = await one<string>("select lbe.enqueue_publication($1, $2)", [c.get("session"), param(c, "id")]);
    return c.json({ outbox_id: outboxId });
  });

  // Outbox
  api.get("/outbox", async (c) => c.json(await q(
    `select o.id, o.content_id, o.status, o.attempts, o.max_attempts, o.available_at, o.last_error, o.provider,
            o.provider_ref, o.created_at, o.completed_at, a.display_name as account_name, left(o.package->>'body', 120) as excerpt
       from lbe.publication_outbox o join lbe.social_accounts a on a.id = o.account_id
      order by o.created_at desc limit 200`)));

  api.post("/outbox/:id/cancel", async (c) => {
    await q("select lbe.cancel_publication($1, $2)", [c.get("session"), param(c, "id")]);
    return c.json({ ok: true });
  });

  api.post("/outbox/:id/reconcile", async (c) => {
    const id = param(c, "id");
    const b = await json(c, z.object({
      resolution: z.enum(["confirmed_published", "confirmed_not_published", "abandon"]),
      provider_ref: z.string().max(200).nullable().optional(),
      note: z.string().min(1).max(2000),
    }));
    await q("select lbe.reconcile_publication($1, $2, $3, $4, $5)",
      [c.get("session"), id, b.resolution, b.provider_ref ?? null, b.note]);
    return c.json({ ok: true });
  });

  // Manual publisher run (admin) — convenient for the local demo.
  api.post("/jobs/publisher-tick", async (c) => {
    if (c.get("user").role !== "admin") throw new HTTPException(403, { message: "admin only" });
    await one("select lbe.write_app_audit($1, 'app.publisher_tick_requested', 'job', 'publisher', '{}'::jsonb)", [c.get("session")]);
    return c.json(await runPublisherTick(db, deps.provider, { workerId: `${deps.workerId}-manual` }));
  });

  // STOP controls
  api.get("/controls", async (c) => c.json(await q(
    `select cf.key, cf.stopped, cf.reason, cf.changed_at, u.display_name as changed_by_name, a.display_name as account_name
       from lbe.control_flags cf left join lbe.app_users u on u.id = cf.changed_by
       left join lbe.social_accounts a on cf.key = 'account:' || a.id::text
      order by cf.key = 'global' desc, cf.key`)));

  api.post("/controls", async (c) => {
    const b = await json(c, z.object({
      key: z.string().regex(/^(global|account:[0-9a-f-]{36})$/),
      stopped: z.boolean(),
      reason: z.string().min(1).max(500),
    }));
    await q("select lbe.set_stop($1, $2, $3, $4)", [c.get("session"), b.key, b.stopped, b.reason]);
    return c.json({ ok: true });
  });

  // Mock LinkedIn store & audit
  api.get("/mock/posts", async (c) => c.json(await q(
    "select id, mock_post_urn, idempotency_key, author, commentary, visibility, received_at from lbe_mock.linkedin_posts order by id desc limit 200")));

  api.get("/audit", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 1000);
    return c.json(await q("select id, at, actor, action, subject_type, subject_id, details from lbe.audit_events order by id desc limit $1", [limit]));
  });

  app.route("/api", api);
  return app;
}
