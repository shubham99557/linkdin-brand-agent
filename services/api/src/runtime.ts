import path from "node:path";
import { AnthropicDrafter, MockDrafter, type Drafter } from "@lbe/drafting";
import { createProvider, MockLinkedInProvider, type PublishingProvider } from "@lbe/publishing";
import { REPO_ROOT, type Config } from "./config.ts";
import { migrate, openDb, type Db } from "./db.ts";
import { dbMockStore } from "./jobs/publisher.ts";

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

export const VOICE_DIR = path.join(REPO_ROOT, "brand", "voice");
export const WEB_DIST = path.join(REPO_ROOT, "apps", "web", "dist");
