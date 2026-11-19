import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const EnvSchema = z.object({
  LBE_ENV: z.enum(["development", "test"]).default("development"),
  LBE_HOST: z.string().default("127.0.0.1"),
  LBE_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LBE_APP_ORIGINS: z.string().default("http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:8787,http://localhost:8787"),
  LBE_DATABASE_URL: z.string().default("pglite"),
  LBE_PGLITE_DIR: z.string().default(".data/pglite"),
  LBE_COOKIE_SECURE: bool.default(false),
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
});

export type Config = z.infer<typeof EnvSchema> & { appOrigins: string[]; pgliteDir: string };

/** Load `.env` (if present) then validate. Phase 1 deliberately has no "production" mode. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, loadDotEnv = true): Config {
  const envFile = path.join(REPO_ROOT, ".env");
  if (loadDotEnv && existsSync(envFile)) process.loadEnvFile(envFile);
  if (env.LBE_ENV === "production" || env.NODE_ENV === "production") {
    throw new Error("Phase 1 is not approved for production deployment (owner approval gate).");
  }
  const parsed = EnvSchema.safeParse(env);
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
  return {
    ...cfg,
    appOrigins: cfg.LBE_APP_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    pgliteDir: path.resolve(REPO_ROOT, cfg.LBE_PGLITE_DIR),
  };
}
