// P11-01a (ADR-036): read-only Claude connector, server side. The API creates a connector key for a signed-in
// admin and writes it ONLY to a git-ignored file in secrets\, which the local MCP bridge (connector-bridge.ts)
// reads. The key is never returned to the browser, shown in chat, logged or backed up.
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ConnectorConfig {
  /** LBE_CONNECTOR=on; everything connector-related answers 404 / 409 otherwise. */
  enabled: boolean;
  environment: string;
  /** secrets/claude-connector-<environment>.json */
  keyFile: string;
  /** How the bridge reaches this server on this PC, e.g. https://127.0.0.1:8443 */
  baseUrl: string;
  /** SHA-256 fingerprint of this server's HTTPS certificate; the bridge pins it. Absent for plain HTTP (dev). */
  certSha256?: string;
}

export interface ConnectorKeyFile {
  format: "lbe-claude-connector/1";
  environment: string;
  base_url: string;
  token: string;
  expires_at: string;
  cert_sha256: string | null;
  scope: "read:brand_brain";
}

export const connectorKeyFile = (root: string, environment: string) => path.join(root, "secrets", `claude-connector-${environment}.json`);
/** The bridge Claude Desktop starts (plain Node TypeScript, no dependencies). */
export const BRIDGE_SCRIPT = path.join(import.meta.dirname, "connector-bridge.ts");

export async function writeConnectorKey(cfg: ConnectorConfig, key: { token: string; expires_at: string }): Promise<void> {
  const body: ConnectorKeyFile = {
    format: "lbe-claude-connector/1", environment: cfg.environment, base_url: cfg.baseUrl, token: key.token,
    expires_at: key.expires_at, cert_sha256: cfg.certSha256 ?? null, scope: "read:brand_brain",
  };
  await mkdir(path.dirname(cfg.keyFile), { recursive: true });
  await writeFile(cfg.keyFile, JSON.stringify(body, null, 2), { encoding: "utf8", mode: 0o600 });
}

export async function removeConnectorKey(cfg: ConnectorConfig): Promise<void> {
  await rm(cfg.keyFile, { force: true });
}

export const connectorKeyPresent = (cfg: ConnectorConfig) => existsSync(cfg.keyFile);

/** The entry Claude Desktop needs in claude_desktop_config.json (no secrets in it). */
export function claudeDesktopEntry(environment: string) {
  return { command: process.execPath, args: [BRIDGE_SCRIPT, "--environment", environment] };
}
