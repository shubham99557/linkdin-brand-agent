import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const EnvSchema = z.object({
  LBE_ENV: z.enum(["development", "test", "staging"]).default("development"),
  LBE_HOST: z.string().default("127.0.0.1"),
  LBE_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LBE_APP_ORIGINS: z.string().default("http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:8787,http://localhost:8787"),
  LBE_DATABASE_URL: z.string().default("pglite"),
  LBE_PGLITE_DIR: z.string().default(".data/pglite"),
  LBE_COOKIE_SECURE: bool.default(false),
  LBE_TLS_PFX: z.string().optional(),
  LBE_TLS_PFX_PASSPHRASE: z.string().optional(),
  LBE_DRAFTER: z.enum(["mock", "anthropic"]).default("mock"),
  ANTHROPIC_API_KEY: z.string().optional(),
  LBE_ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  LBE_ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  LBE_PUBLISHING_PROVIDER: z.literal("mock").default("mock"),
  LBE_MOCK_BEHAVIOUR: z.enum(["success", "rate_limited", "server_error", "timeout_after_write", "validation_error"]).default("success"),
  LBE_RUN_WORKER: bool.default(true),
  LBE_WORKER_INTERVAL_MS: z.coerce.number().int().min(1000).default(15000),
  LBE_WORKER_ID: z.string().regex(/^[a-z0-9_-]{1,40}$/).default("local-worker"),
  LBE_INTERNAL_JOB_TOKEN: z.string().optional(),
  // ---- Phase 2: live LinkedIn (all optional; live publishing is OFF unless explicitly enabled) ----
  LBE_LIVE_PUBLISHING: z.enum(["on", "off"]).default("off"),
  LBE_TOKEN_ENC_KEY: z.string().optional(),
  LBE_TOKEN_KEY_ID: z.string().regex(/^[a-z0-9_-]{1,32}$/).default("k1"),
  LBE_LINKEDIN_VERSION: z.string().regex(/^\d{6}$/).default("202611"),
  LBE_LINKEDIN_REDIRECT_URI: z.string().url().startsWith("https://").optional(),
  LBE_LINKEDIN_FOUNDER_CLIENT_ID: z.string().optional(),
  LBE_LINKEDIN_FOUNDER_CLIENT_SECRET: z.string().optional(),
  LBE_LINKEDIN_COMPANY_CLIENT_ID: z.string().optional(),
  LBE_LINKEDIN_COMPANY_CLIENT_SECRET: z.string().optional(),
});

export type Config = z.infer<typeof EnvSchema> & {
  appOrigins: string[];
  pgliteDir: string;
  liveEnabled: boolean;
  linkedinApps: { founder_app?: { clientId: string; clientSecret: string }; company_app?: { clientId: string; clientSecret: string } };
};

/** Load `.env` (if present) then validate. Phase 1/2.1 deliberately has no "production" mode. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, loadDotEnv = true): Config {
  const envFile = path.join(REPO_ROOT, ".env");
  if (loadDotEnv && existsSync(envFile)) process.loadEnvFile(envFile);
  if (env.LBE_ENV === "production" || env.NODE_ENV === "production") {
    throw new Error("This build is not approved for production deployment (owner approval gate).");
  }
  // Blank lines like `ANTHROPIC_API_KEY=` in .env mean "not set".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const cfg = parsed.data;
  if (cfg.LBE_DRAFTER === "anthropic" && !cfg.ANTHROPIC_API_KEY) {
    throw new Error("LBE_DRAFTER=anthropic requires ANTHROPIC_API_KEY (or set LBE_DRAFTER=mock).");
  }
  if (cfg.LBE_INTERNAL_JOB_TOKEN !== undefined && cfg.LBE_INTERNAL_JOB_TOKEN.length < 32) {
    throw new Error("LBE_INTERNAL_JOB_TOKEN must be at least 32 characters when set.");
  }
  if (cfg.LBE_TOKEN_ENC_KEY !== undefined && Buffer.from(cfg.LBE_TOKEN_ENC_KEY, "base64").length !== 32) {
    throw new Error("LBE_TOKEN_ENC_KEY must be 32 random bytes, base64-encoded (npm run setup:local generates one).");
  }
  const pair = (id?: string, secret?: string) => {
    if (!id && !secret) return undefined;
    if (!id || !secret) throw new Error("LinkedIn client id and secret must be set together.");
    return { clientId: id, clientSecret: secret };
  };
  const linkedinApps = {
    founder_app: pair(cfg.LBE_LINKEDIN_FOUNDER_CLIENT_ID, cfg.LBE_LINKEDIN_FOUNDER_CLIENT_SECRET),
    company_app: pair(cfg.LBE_LINKEDIN_COMPANY_CLIENT_ID, cfg.LBE_LINKEDIN_COMPANY_CLIENT_SECRET),
  };
  if ((linkedinApps.founder_app || linkedinApps.company_app) && (!cfg.LBE_LINKEDIN_REDIRECT_URI || !cfg.LBE_TOKEN_ENC_KEY)) {
    throw new Error("A LinkedIn app is configured: LBE_LINKEDIN_REDIRECT_URI (https) and LBE_TOKEN_ENC_KEY are required.");
  }
  const liveEnabled = cfg.LBE_LIVE_PUBLISHING === "on";
  if (liveEnabled) {
    if (cfg.LBE_ENV !== "staging") {
      throw new Error("LBE_LIVE_PUBLISHING=on is only allowed with LBE_ENV=staging (owner-approved pilot stages).");
    }
    if (!cfg.LBE_TOKEN_ENC_KEY || !(linkedinApps.founder_app || linkedinApps.company_app)) {
      throw new Error("LBE_LIVE_PUBLISHING=on requires LBE_TOKEN_ENC_KEY and at least one LinkedIn app.");
    }
  }
  if (cfg.LBE_TLS_PFX && !existsSync(path.resolve(REPO_ROOT, cfg.LBE_TLS_PFX))) {
    throw new Error(`LBE_TLS_PFX file not found: ${cfg.LBE_TLS_PFX}`);
  }
  return {
    ...cfg,
    appOrigins: cfg.LBE_APP_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    pgliteDir: path.resolve(REPO_ROOT, cfg.LBE_PGLITE_DIR),
    liveEnabled,
    linkedinApps,
  };
}
