import path from "node:path";
import { AnthropicDrafter, MockDrafter, type Drafter } from "@lbe/drafting";
import { createProvider, LinkedInProvider, MockLinkedInProvider, type ProviderRegistry, type PublishingProvider } from "@lbe/publishing";
import { parseTokenKey } from "@lbe/security";
import type { LinkedInDeps } from "./app.ts";
import { REPO_ROOT, type Config } from "./config.ts";
import { migrate, openDb, type Db } from "./db.ts";
import { dbMockStore, dbTokenSource } from "./jobs/publisher.ts";

export async function openConfiguredDb(cfg: Config): Promise<Db> {
  const db = await openDb({ url: cfg.LBE_DATABASE_URL, dataDir: cfg.LBE_DATABASE_URL === "pglite" ? cfg.pgliteDir : undefined });
  await migrate(db);
  return db;
}

export function buildDrafter(cfg: Config): Drafter {
  if (cfg.LBE_DRAFTER === "anthropic") {
    return new AnthropicDrafter({ apiKey: cfg.ANTHROPIC_API_KEY!, model: cfg.LBE_ANTHROPIC_MODEL, effort: cfg.LBE_ANTHROPIC_EFFORT });
  }
  return new MockDrafter();
}

export function buildProvider(cfg: Config, db: Db): PublishingProvider {
  return createProvider(cfg.LBE_PUBLISHING_PROVIDER, {
    mock: () => new MockLinkedInProvider(dbMockStore(db), () => cfg.LBE_MOCK_BEHAVIOUR),
  });
}

/** LinkedIn wiring. Returns undefined when no LinkedIn app is configured. The live provider exists only when LBE_LIVE_PUBLISHING=on. */
export function buildLinkedIn(cfg: Config, db: Db): LinkedInDeps | undefined {
  if (!cfg.linkedinApps.founder_app && !cfg.linkedinApps.company_app) return undefined;
  const tokenKey = parseTokenKey(cfg.LBE_TOKEN_ENC_KEY);
  return {
    liveEnabled: cfg.liveEnabled,
    apps: cfg.linkedinApps,
    redirectUri: cfg.LBE_LINKEDIN_REDIRECT_URI!,
    tokenKey,
    tokenKeyId: cfg.LBE_TOKEN_KEY_ID,
    liveProvider: cfg.liveEnabled
      ? new LinkedInProvider({ getAccessToken: dbTokenSource(db, cfg.LBE_WORKER_ID, tokenKey), version: cfg.LBE_LINKEDIN_VERSION })
      : undefined,
  };
}

export function buildRegistry(mock: PublishingProvider, linkedin?: LinkedInDeps): ProviderRegistry {
  return { mock, ...(linkedin?.liveEnabled && linkedin.liveProvider ? { linkedin: linkedin.liveProvider } : {}) };
}

export const VOICE_DIR = path.join(REPO_ROOT, "brand", "voice");
export const WEB_DIST = path.join(REPO_ROOT, "apps", "web", "dist");
