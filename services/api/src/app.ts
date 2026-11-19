import { readFile } from "node:fs/promises";
import path from "node:path";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import {
  buildBrandContext, ingestSourceMaterial, mockSpecialists, runLearningReview, voiceFor,
  type AgentDeps, type BrandBrain, type Specialists,
} from "@lbe/agents";
import { BRAIN_SECTIONS, CAPABILITIES, CLAIM_CATEGORIES, findUnsupportedStatements, ONBOARDING_STEPS, SECTION_META, type Role, type VerifiedClaim } from "@lbe/domain";
import { validateDraftOutput, PROMPT_VERSION, type Drafter } from "@lbe/drafting";
import {
  buildAuthorizeUrl, exchangeCode, fetchUserInfo, escapeLittleText,
  type LinkedInApp, type LinkedInProvider, type OAuthEndpoints, type ProviderRegistry, type PublishingProvider,
} from "@lbe/publishing";
import { randomUUID } from "node:crypto";
import { encryptToken, isTrustedOrigin, looksLikeSessionToken, redactForLog, ROLE_HINTS, safeTokenEqual, SESSION_COOKIE } from "@lbe/security";
import { dbErrorStatus, type Db } from "./db.ts";
import { runPublisherTick } from "./jobs/publisher.ts";

export interface LinkedInDeps {
  /** Master switch (LBE_LIVE_PUBLISHING). When false, nothing can be enabled or sent live. */
  liveEnabled: boolean;
  apps: Partial<Record<LinkedInApp, { clientId: string; clientSecret: string }>>;
  redirectUri: string;
  tokenKey: Buffer;
  tokenKeyId: string;
  oauth?: OAuthEndpoints;
  /** Registered only when liveEnabled. */
  liveProvider?: LinkedInProvider;
}

export interface AppDeps {
  db: Db;
  drafter: Drafter;
  provider: PublishingProvider;
  linkedin?: LinkedInDeps;
  /** Agent specialists (default: offline mocks). */
  specialists?: Specialists;
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
  organization_id: string;
  organization_name: string;
  must_change_password: boolean;
  approver_for: string[];
}

type Env = { Variables: { user: SessionUser; session: string; requestId: string } };

const uuid = z.string().uuid();
const isoOrNull = z.string().datetime({ offset: true }).nullable().optional();

export function createApp(deps: AppDeps) {
  const { db } = deps;
  const log = deps.log ?? ((msg, extra) => console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...extra })));
  const app = new Hono<Env>();
  const li = deps.linkedin;
  const liveOn = !!(li?.liveEnabled && li.liveProvider);
  const registry: ProviderRegistry = { mock: deps.provider, ...(liveOn ? { linkedin: li!.liveProvider! } : {}) };
  const specialists = deps.specialists ?? mockSpecialists();
  const agentDeps = (session: string): AgentDeps => ({
    db, session, specialists, writer: deps.drafter,
    readVoiceFile: async (profile) => readFile(path.join(deps.voiceDir, `${profile}.md`), "utf8").catch(() => null),
  });

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
  // Request ID + access log. The ID is always generated here (client-supplied IDs are ignored) and returned in
  // X-Request-Id and in 5xx bodies so a user can quote it. Logged: method, route pattern (never the raw URL or
  // query string — OAuth codes travel there), status, duration, user id. Never bodies, cookies or emails.
  app.use("*", async (c, next) => {
    const requestId = randomUUID();
    c.set("requestId", requestId);
    const started = performance.now();
    await next();
    c.header("X-Request-Id", requestId);
    if (c.req.path.startsWith("/api/") && c.req.path !== "/api/health") {
      log("request", {
        request_id: requestId, method: c.req.method, route: c.req.routePath, status: c.res.status,
        ms: Math.round(performance.now() - started), user_id: c.get("user")?.id ?? null,
      });
    }
  });
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
    const requestId = c.get("requestId");
    log("unhandled_error", {
      request_id: requestId, method: c.req.method, route: c.req.routePath,
      error_type: (err as Error)?.name ?? typeof err, code: (err as { code?: string })?.code ?? null, error: redactForLog(err),
    });
    return c.json({ error: "internal error", request_id: requestId }, 500);
  });

  // ---------------------------------------------------------------- public
  app.get("/api/health", async (c) => {
    await q("select 1");
    return c.json({ ok: true, publishing_provider: deps.provider.name, drafter: deps.drafter.provider, live_publishing: liveOn });
  });

  // LinkedIn redirects the browser here (cross-site, so the SameSite=Strict session cookie is NOT sent).
  // Hand code/state to the dashboard in the URL fragment; the dashboard completes the flow with the admin's
  // session via a same-origin POST, which binds the callback to the admin who started it.
  app.get("/api/oauth/linkedin/callback", (c) => {
    const p = new URLSearchParams();
    for (const k of ["code", "state", "error", "error_description"] as const) {
      const v = c.req.query(k);
      if (v) p.set(k, v.slice(0, 2000));
    }
    return c.redirect(`/#/oauth/complete?${p.toString()}`, 302);
  });

  const loginLimiter = new Map<string, { count: number; resetAt: number }>();
  app.post("/api/auth/login", async (c) => {
    const body = await json(c, z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }));
    // Key on the TCP peer address, never on client-supplied headers such as X-Forwarded-For (spoofable).
    let peer = "local";
    try { peer = getConnInfo(c).remote.address ?? "local"; } catch { /* not running under the Node server (tests) */ }
    const key = `${peer}|${body.email.toLowerCase()}`;
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
    return c.json(await runPublisherTick(db, registry, { workerId: `${deps.workerId}-ext` }));
  });

  // ---------------------------------------------------------------- authenticated
  const api = new Hono<Env>();
  api.use("*", requireAuth);

  api.post("/auth/logout", async (c) => {
    await q("select lbe.logout($1)", [c.get("session")]);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // Sign out everywhere: revokes every session of the current user (all browsers/devices).
  api.post("/auth/logout-all", async (c) => {
    const revoked = await one<number>("select lbe.logout_all($1)", [c.get("session")]);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true, sessions_revoked: revoked });
  });

  // Change your own password (also the forced first-sign-in change for admin-issued temporary passwords).
  api.post("/auth/change-password", async (c) => {
    const b = await json(c, z.object({ current_password: z.string().min(1).max(200), new_password: z.string().min(12).max(200) }));
    const r = await one<{ ok: boolean; error?: string; other_sessions_ended?: number }>(
      "select lbe.change_password($1, $2, $3)", [c.get("session"), b.current_password, b.new_password]);
    if (!r.ok) return c.json({ error: r.error ?? "password not changed" }, 400);
    return c.json(r);
  });

  api.get("/me", (c) => {
    const user = c.get("user");
    return c.json({ ...user, hints: ROLE_HINTS[user.role] });
  });

  api.get("/capabilities", (c) => c.json(CAPABILITIES));

  // Accounts & voices
  api.get("/accounts", async (c) => c.json((await q<{ organization_id: string }>(
    `select a.id, a.kind, a.display_name, a.linkedin_urn, a.voice_profile, a.pillars, a.enabled, a.publishing_mode,
            a.release_mode, a.live_enabled_at, cf.stopped, cf.reason as stop_reason,
            (select jsonb_build_object('app', lc.app, 'status', lc.status, 'expires_at', lc.expires_at,
                                       'subject_urn', lc.subject_urn, 'subject_name', lc.subject_name,
                                       'scopes', lc.scopes, 'invalid_reason', lc.invalid_reason, 'connected_at', lc.connected_at)
               from lbe.linkedin_credentials lc where lc.account_id = a.id) as credential,
            coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'display_name', u.display_name))
                        from lbe.account_approvers aa join lbe.app_users u on u.id = aa.user_id
                       where aa.account_id = a.id), '[]') as approvers, a.organization_id
       from lbe.social_accounts a left join lbe.control_flags cf on cf.key = 'account:' || a.id::text
      where a.organization_id = $1
      order by a.kind`, [c.get("user").organization_id]))));

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
    const rows = await q<{ voice_profile: string }>("select voice_profile from lbe.social_accounts where id = $1 and organization_id = $2",
      [id, c.get("user").organization_id]);
    if (!rows[0]) throw new HTTPException(404, { message: "not found" });
    return c.json({ profile: rows[0].voice_profile, markdown: await readVoice(rows[0].voice_profile) });
  });

  // Claims register
  api.get("/claims", async (c) => c.json(await q(
    `select c.*, (c.status = 'verified' and (c.expires_at is null or c.expires_at > now())) as usable,
            cu.display_name as created_by_name, vu.display_name as verified_by_name
       from lbe.claims c join lbe.app_users cu on cu.id = c.created_by left join lbe.app_users vu on vu.id = c.verified_by
      where c.organization_id = $1
      order by c.created_at desc`, [c.get("user").organization_id])));

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
            jsonb_array_length(ci.unsupported_statements) as unsupported_count, ci.created_via, ci.topic, ci.workflow_id
       from lbe.content_items ci join lbe.social_accounts a on a.id = ci.account_id
      where a.organization_id = $1
      order by coalesce(ci.scheduled_for, ci.created_at) desc
      limit 500`, [c.get("user").organization_id])));

  api.get("/content/:id", async (c) => {
    const id = param(c, "id");
    const items = await q<Record<string, unknown>>(
      `select ci.*, a.display_name as account_name, a.kind as account_kind, a.pillars as account_pillars
         from lbe.content_items ci join lbe.social_accounts a on a.id = ci.account_id
        where ci.id = $1 and a.organization_id = $2`, [id, c.get("user").organization_id]);
    if (!items[0]) throw new HTTPException(404, { message: "not found" });
    const [citations, approvals, outbox, audit, runs] = await Promise.all([
      q(`select cc.claim_id, cc.quoted_span, cl.statement, cl.category, cl.evidence_url, cl.evidence_note, cl.status,
                cl.expires_at, vu.display_name as verified_by_name, cl.verified_at
           from lbe.content_claims cc join lbe.claims cl on cl.id = cc.claim_id
           left join lbe.app_users vu on vu.id = cl.verified_by where cc.content_id = $1`, [id]),
      q(`select ap.id, ap.decision, ap.package_hash, ap.note, ap.created_at, u.display_name as approver_name
           from lbe.content_approvals ap join lbe.app_users u on u.id = ap.approver_id
          where ap.content_id = $1 order by ap.created_at desc`, [id]),
      q(`select id, status, attempts, max_attempts, available_at, last_error, provider, provider_ref, package_hash,
                requires_release, released_at, created_at, completed_at
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
      const spans = (await q<{ quoted_span: string }>(
        `select cc.quoted_span from lbe.content_claims cc join lbe.content_items ci on ci.id = cc.content_id
           join lbe.social_accounts a on a.id = ci.account_id where cc.content_id = $1 and a.organization_id = $2`,
        [id, c.get("user").organization_id]))
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
         from lbe.content_items ci join lbe.social_accounts a on a.id = ci.account_id
        where ci.id = $1 and a.organization_id = $2`, [id, c.get("user").organization_id]);
    const item = items[0];
    // Checked BEFORE any AI call so another organization's brief never reaches a model.
    if (!item) throw new HTTPException(404, { message: "not found" });
    if (!["draft", "changes_requested", "failed"].includes(item.status)) {
      throw new HTTPException(409, { message: `cannot redraft content in status ${item.status}` });
    }
    const claims = await q<VerifiedClaim>(
      `select id, statement, category, evidence_url, evidence_note from lbe.claims
        where status = 'verified' and organization_id = $1 and (expires_at is null or expires_at > now()) order by created_at`,
      [c.get("user").organization_id]);
    // Brand Brain voice + approved context when available; Phase 1 voice file as fallback.
    const brain = await one<BrandBrain>("select lbe.brain_load($1)", [session]);
    const startedAt = new Date().toISOString();
    const result = await deps.drafter.draft({
      accountKind: item.kind,
      accountName: item.display_name,
      voiceProfile: voiceFor(brain, item.kind) ?? await readVoice(item.voice_profile),
      brandContext: buildBrandContext(brain),
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
    `select o.id, o.content_id, o.account_id, o.status, o.attempts, o.max_attempts, o.available_at, o.last_error, o.provider,
            o.provider_ref, o.requires_release, o.released_at, o.created_at, o.completed_at, a.kind as account_kind,
            a.display_name as account_name, left(o.package->>'body', 120) as excerpt
       from lbe.publication_outbox o join lbe.social_accounts a on a.id = o.account_id
      where a.organization_id = $1
      order by o.created_at desc limit 200`, [c.get("user").organization_id])));

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

  // Manual publisher run (admin) — processes ONLY the admin's organization.
  api.post("/jobs/publisher-tick", async (c) => {
    if (c.get("user").role !== "admin") throw new HTTPException(403, { message: "admin only" });
    await one("select lbe.write_app_audit($1, 'app.publisher_tick_requested', 'job', 'publisher', '{}'::jsonb)", [c.get("session")]);
    return c.json(await runPublisherTick(db, registry, { workerId: `${deps.workerId}-manual`, organizationId: c.get("user").organization_id }));
  });

  // "Publish now": manual release (required for live accounts — API Terms §3.1(26), owner decision P2-D1).
  api.post("/outbox/:id/release", async (c) => {
    const id = param(c, "id");
    const b = await json(c, z.object({ confirm_public_post: z.boolean().optional() }));
    const rows = await q<{ provider: string }>("select provider from lbe.publication_outbox where id = $1", [id]);
    if (!rows[0]) throw new HTTPException(404, { message: "not found" });
    if (rows[0].provider === "linkedin") {
      if (!liveOn) throw new HTTPException(409, { message: "live publishing is switched off (LBE_LIVE_PUBLISHING)" });
      if (b.confirm_public_post !== true) {
        throw new HTTPException(422, { message: "confirm that this will be posted publicly on LinkedIn" });
      }
    }
    await q("select lbe.release_publication($1, $2)", [c.get("session"), id]);
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- Brand Brain
  const section = z.enum(BRAIN_SECTIONS);
  const slug = z.string().regex(/^[a-z0-9_-]{1,60}$/);

  api.get("/brain", async (c) => {
    const brain = await one<BrandBrain>("select lbe.brain_load($1)", [c.get("session")]);
    return c.json({ ...brain, sections: SECTION_META, onboarding_steps: ONBOARDING_STEPS, claim_categories: CLAIM_CATEGORIES });
  });

  api.post("/brain/entries", async (c) => {
    const b = await json(c, z.object({
      section, key: slug, title: z.string().min(1).max(200), body: z.string().min(1).max(20000),
      structured: z.record(z.string(), z.unknown()).optional(),
    }));
    const id = await one<string>("select lbe.brain_upsert_entry($1, $2, $3, $4, $5, $6::jsonb, 'owner', null)",
      [c.get("session"), b.section, b.key, b.title, b.body, JSON.stringify(b.structured ?? {})]);
    return c.json({ id }, 201);
  });

  api.post("/brain/entries/:id/retire", async (c) => {
    await q("select lbe.brain_retire_entry($1, $2)", [c.get("session"), param(c, "id")]);
    return c.json({ ok: true });
  });

  // Owner action: import the Phase 1 voice files into the Brand Brain (one source of truth afterwards).
  api.post("/brain/import-voice-files", async (c) => {
    const imported: string[] = [];
    for (const [profile, sec] of [["company", "voice_company"], ["founder", "voice_founder"]] as const) {
      const text = await readFile(path.join(deps.voiceDir, `${profile}.md`), "utf8").catch(() => null);
      if (!text) continue;
      await one("select lbe.brain_upsert_entry($1, $2, 'main', $3, $4, '{}'::jsonb, 'import', $5)",
        [c.get("session"), sec, `${profile === "company" ? "Company page" : "Founder"} voice (imported)`, text, `brand/voice/${profile}.md`]);
      imported.push(sec);
    }
    return c.json({ imported });
  });

  // Onboarding: owner pastes source material → grounded proposals (agent), owner then accepts/edits/rejects.
  api.post("/brain/ingest", async (c) => {
    const b = await json(c, z.object({ name: z.string().min(1).max(200), text: z.string().min(20).max(50000) }));
    return c.json(await ingestSourceMaterial(agentDeps(c.get("session")), { name: b.name, text: b.text }));
  });

  api.get("/brain/proposals", async (c) => {
    const status = c.req.query("status");
    if (status && !["pending", "accepted", "rejected"].includes(status)) throw new HTTPException(422, { message: "invalid status" });
    return c.json(await one("select lbe.brain_list_proposals($1, $2)", [c.get("session"), status ?? null]));
  });

  api.post("/brain/proposals/:id/decision", async (c) => {
    const b = await json(c, z.object({
      decision: z.enum(["accepted", "rejected"]), note: z.string().max(2000).optional(),
      title: z.string().max(200).optional(), body: z.string().max(20000).optional(),
    }));
    const entry = await one<string | null>("select lbe.brain_decide_proposal($1, $2, $3, $4, $5, $6)",
      [c.get("session"), param(c, "id"), b.decision, b.note ?? null, b.title ?? null, b.body ?? null]);
    return c.json({ entry_id: entry });
  });

  // ---------------------------------------------------------------- Agent workspace
  api.get("/agent/workflows", async (c) => c.json(await one("select lbe.workflow_list($1)", [c.get("session")])));

  api.post("/agent/workflows", async (c) => {
    const b = await json(c, z.object({
      goal: z.string().min(3).max(1000),
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      days: z.number().int().min(1).max(31).optional(),
      post_count: z.number().int().min(3).max(5).optional(),
    }));
    // Durable job (P4-01): queued here, executed by the agent runner; poll GET /agent/jobs/:id for progress.
    const jobId = await one<string>("select lbe.job_enqueue($1, 'brand_workflow', $2::jsonb)", [c.get("session"),
      JSON.stringify({ goal: b.goal, start_date: b.start_date, days: b.days, post_count: b.post_count })]);
    return c.json({ job_id: jobId, status: "queued" }, 202);
  });

  api.get("/agent/jobs", async (c) => c.json(await one("select lbe.job_list($1)", [c.get("session")])));
  api.get("/agent/jobs/:id", async (c) => c.json(await one("select lbe.job_get($1, $2)", [c.get("session"), param(c, "id")])));
  api.post("/agent/jobs/:id/cancel", async (c) =>
    c.json({ result: await one<string>("select lbe.job_cancel($1, $2)", [c.get("session"), param(c, "id")]) }));

  api.get("/agent/workflows/:id", async (c) =>
    c.json(await one("select lbe.workflow_get($1, $2)", [c.get("session"), param(c, "id")])));

  api.post("/agent/learning-review", async (c) => c.json(await runLearningReview(agentDeps(c.get("session")))));

  api.get("/research", async (c) => c.json(await one("select lbe.research_list($1)", [c.get("session")])));

  api.post("/research/:id/review", async (c) => {
    const b = await json(c, z.object({ status: z.enum(["accepted", "rejected"]) }));
    await q("select lbe.research_review($1, $2, $3)", [c.get("session"), param(c, "id"), b.status]);
    return c.json({ ok: true });
  });

  api.post("/research/:id/to-claim", async (c) => {
    const b = await json(c, z.object({ category: z.enum(CLAIM_CATEGORIES) }));
    const id = await one<string>("select lbe.research_to_claim($1, $2, $3)", [c.get("session"), param(c, "id"), b.category]);
    return c.json({ claim_id: id }, 201);
  });

  // ---------------------------------------------------------------- LinkedIn connection (admin)
  const requireLinkedIn = () => {
    if (!li) throw new HTTPException(409, { message: "LinkedIn is not configured (see docs/setup.md, Phase 2)" });
    return li;
  };

  api.post("/accounts/:id/linkedin/connect", async (c) => {
    const id = param(c, "id");
    const cfg = requireLinkedIn();
    const r = await one<{ state: string; app: LinkedInApp }>("select lbe.begin_oauth($1, $2)", [c.get("session"), id]);
    const app = cfg.apps[r.app];
    if (!app) throw new HTTPException(409, { message: `the ${r.app.replace("_", " ")} is not configured` });
    return c.json({ url: buildAuthorizeUrl({ clientId: app.clientId, redirectUri: cfg.redirectUri, app: r.app, state: r.state, ...cfg.oauth }) });
  });

  api.post("/oauth/linkedin/complete", async (c) => {
    const cfg = requireLinkedIn();
    const b = await json(c, z.object({ code: z.string().min(1).max(2000), state: z.string().regex(/^[0-9a-f]{64}$/) }));
    const session = c.get("session");
    const st = await one<{ account_id: string; app: LinkedInApp } | null>("select lbe.consume_oauth_state($1, $2)", [session, b.state]);
    if (!st) throw new HTTPException(400, { message: "this LinkedIn sign-in link is invalid or has expired — start again" });
    const app = cfg.apps[st.app];
    if (!app) throw new HTTPException(409, { message: `the ${st.app} is not configured` });
    let token;
    let subject: { sub: string; name: string | null } | null = null;
    try {
      token = await exchangeCode({ code: b.code, clientId: app.clientId, clientSecret: app.clientSecret, redirectUri: cfg.redirectUri, ...cfg.oauth });
      if (st.app === "founder_app") subject = await fetchUserInfo({ accessToken: token.accessToken, ...cfg.oauth });
    } catch (err) {
      log("oauth_failed", { request_id: c.get("requestId"), account_id: st.account_id, error: redactForLog(err) });
      await one("select lbe.write_app_audit($1, 'app.oauth_failed', 'social_account', $2, '{}'::jsonb)", [session, st.account_id]);
      throw new HTTPException(502, { message: "LinkedIn did not complete the connection — try again" });
    }
    const ciphertext = encryptToken(cfg.tokenKey, st.account_id, token.accessToken);
    const expiresAt = new Date(Date.now() + token.expiresIn * 1000).toISOString();
    // UNCONFIRMED (Stage 2.2): that the person URN is urn:li:person:{sub}.
    const subjectUrn = subject ? `urn:li:person:${subject.sub}` : null;
    await q("select lbe.store_linkedin_credential($1, $2, $3, $4, $5, $6, $7, $8)",
      [session, b.state, subjectUrn, subject?.name ?? null, token.scopes, ciphertext, cfg.tokenKeyId, expiresAt]);
    return c.json({ account_id: st.account_id, subject_urn: subjectUrn, subject_name: subject?.name ?? null, expires_at: expiresAt, scopes: token.scopes });
  });

  api.post("/accounts/:id/linkedin/disconnect", async (c) => {
    const id = param(c, "id");
    const b = await json(c, z.object({ reason: z.string().max(300).optional() }));
    await q("select lbe.revoke_linkedin_credential($1, $2, $3)", [c.get("session"), id, b.reason ?? "disconnected by admin"]);
    return c.json({ ok: true, note: "Also remove the app's access in LinkedIn settings to revoke the token at LinkedIn." });
  });

  // Content pillars (admin; validated and audited in the database).
  api.put("/accounts/:id/pillars", async (c) => {
    const b = await json(c, z.object({ pillars: z.array(z.string().max(60)).min(1).max(8) }));
    const pillars = await one<string[]>("select lbe.set_account_pillars($1, $2, $3)", [c.get("session"), param(c, "id"), b.pillars]);
    return c.json({ pillars });
  });

  api.post("/accounts/:id/live", async (c) => {
    const id = param(c, "id");
    const b = await json(c, z.object({ live: z.boolean(), org_urn: z.string().max(80).nullable().optional() }));
    if (b.live && !liveOn) {
      throw new HTTPException(409, { message: "live publishing is switched off on this server (LBE_LIVE_PUBLISHING=off)" });
    }
    await q("select lbe.set_live_publishing($1, $2, $3, $4)", [c.get("session"), id, b.live, b.org_urn ?? null]);
    return c.json({ ok: true });
  });

  // Reconciliation assist: company pages only (founder posts cannot be read back via the API).
  api.get("/outbox/:id/linkedin-candidates", async (c) => {
    const id = param(c, "id");
    if (c.get("user").role !== "admin") throw new HTTPException(403, { message: "admin only" });
    const rows = await q<{ provider: string; status: string; account_id: string; kind: string; body: string; author: string | null }>(
      `select o.provider, o.status, o.account_id, a.kind, o.package->>'body' as body, o.package#>>'{destination,linkedin_urn}' as author
         from lbe.publication_outbox o join lbe.social_accounts a on a.id = o.account_id
        where o.id = $1 and a.organization_id = $2`, [id, c.get("user").organization_id]);
    const r = rows[0];
    if (!r) throw new HTTPException(404, { message: "not found" });
    if (!liveOn) throw new HTTPException(409, { message: "live publishing is switched off" });
    if (r.provider !== "linkedin" || r.status !== "needs_reconciliation") {
      throw new HTTPException(409, { message: "only live publications awaiting reconciliation can be checked" });
    }
    if (r.kind !== "company_page" || !r.author) {
      return c.json({ supported: false, message: "Founder posts cannot be read back through the API. Check the founder's LinkedIn activity manually." });
    }
    const posts = await li!.liveProvider!.findRecentPostsByAuthor(r.account_id, r.author);
    const expected = escapeLittleText(r.body);
    return c.json({ supported: true, candidates: posts.map((p) => ({ ...p, matches: p.commentary === expected || p.commentary === r.body })) });
  });

  // User management (admin only; every rule is enforced in the database functions).
  const password = z.string().min(12).max(200);
  api.get("/users", async (c) => c.json(await one("select lbe.admin_list_users($1)", [c.get("session")])));
  api.post("/users", async (c) => {
    const b = await json(c, z.object({
      email: z.string().email().max(200), display_name: z.string().min(1).max(120),
      role: z.enum(["admin", "approver", "editor", "viewer"]), password,
    }));
    const id = await one<string>("select lbe.admin_add_user($1, $2, $3, $4, $5)", [c.get("session"), b.email, b.display_name, b.role, b.password]);
    return c.json({ id }, 201);
  });
  api.patch("/users/:id", async (c) => {
    const b = await json(c, z.object({
      role: z.enum(["admin", "approver", "editor", "viewer"]).optional(), disabled: z.boolean().optional(),
      display_name: z.string().min(1).max(120).optional(),
    }));
    return c.json(await one("select lbe.admin_update_user($1, $2, $3, $4, $5)",
      [c.get("session"), param(c, "id"), b.role ?? null, b.disabled ?? null, b.display_name ?? null]));
  });
  api.put("/users/:id/approver/:account", async (c) => {
    const b = await json(c, z.object({ approver: z.boolean() }));
    await q("select lbe.admin_set_approver($1, $2, $3, $4)", [c.get("session"), param(c, "id"), param(c, "account"), b.approver]);
    return c.json({ ok: true });
  });
  api.post("/users/:id/end-sessions", async (c) =>
    c.json({ sessions_revoked: await one<number>("select lbe.admin_end_sessions($1, $2)", [c.get("session"), param(c, "id")]) }));
  api.post("/users/:id/reset-password", async (c) => {
    const b = await json(c, z.object({ password }));
    await q("select lbe.admin_reset_password($1, $2, $3)", [c.get("session"), param(c, "id"), b.password]);
    return c.json({ ok: true });
  });

  // STOP controls
  // STOP controls. Scopes: platform (read-only here; operators only), organization (the caller's), accounts (the caller's).
  api.get("/controls", async (c) => {
    const org = c.get("user").organization_id;
    return c.json(await q(
      `select case when cf.key = 'global' then 'platform' when cf.key like 'org:%' then 'organization' else cf.key end as key,
              case when cf.key = 'global' then 'platform' when cf.key like 'org:%' then 'organization' else 'account' end as scope,
              cf.stopped, cf.reason, cf.changed_at, u.display_name as changed_by_name, a.display_name as account_name
         from lbe.control_flags cf left join lbe.app_users u on u.id = cf.changed_by
         left join lbe.social_accounts a on cf.key = 'account:' || a.id::text
        where cf.key = 'global' or cf.key = 'org:' || $1::uuid::text or a.organization_id = $1::uuid
        order by cf.key = 'global' desc, cf.key like 'org:%' desc, cf.key`, [org]));
  });

  api.post("/controls", async (c) => {
    const b = await json(c, z.object({
      key: z.string().regex(/^(global|organization|account:[0-9a-f-]{36})$/),
      stopped: z.boolean(),
      reason: z.string().min(1).max(500),
    }));
    await q("select lbe.set_stop($1, $2, $3, $4)", [c.get("session"), b.key, b.stopped, b.reason]);
    return c.json({ ok: true });
  });

  // Mock LinkedIn store & audit
  api.get("/mock/posts", async (c) => c.json(await q(
    `select m.id, m.mock_post_urn, m.idempotency_key, m.author, m.commentary, m.visibility, m.received_at
       from lbe_mock.linkedin_posts m
       join lbe.content_items ci on ci.id::text = split_part(m.idempotency_key, ':', 1)
       join lbe.social_accounts a on a.id = ci.account_id
      where a.organization_id = $1
      order by m.id desc limit 200`, [c.get("user").organization_id])));

  api.get("/audit", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 1000);
    return c.json(await q(
      `select id, at, actor, action, subject_type, subject_id, details from lbe.audit_events
        where organization_id = $1 order by id desc limit $2`, [c.get("user").organization_id, limit]));
  });

  app.route("/api", api);
  return app;
}
