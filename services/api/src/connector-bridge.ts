// P11-01a (ADR-036): local MCP bridge for Claude Desktop, read-only proof of concept.
// Claude Desktop starts this file (node connector-bridge.ts --environment staging) and talks MCP over stdio.
// It offers exactly ONE tool, get_brand_brain, which asks the running API on this PC for the organization's
// approved Brand Brain entries.
//   * No database access, no dependencies: plain Node, stdio, newline-delimited JSON-RPC 2.0.
//   * The connector key is read from secrets\claude-connector-<env>.json at each call (create or revoke it in the
//     dashboard). It is sent only to 127.0.0.1 or localhost and never appears in tool output or logs.
//   * HTTPS (staging): the server certificate's SHA-256 fingerprint must match the one recorded with the key,
//     before the key is sent.
// Plain Node TypeScript (erasable syntax only): Node runs this file directly.
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import path from "node:path";
import readline from "node:readline";
import tls from "node:tls";

export const SERVER_INFO = { name: "acttrident-brand-brain", title: "ActTrident Brand Brain (read-only)", version: "0.1.0" };
export const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_TEXT = 100_000;

export const TOOL = {
  name: "get_brand_brain",
  title: "Get the approved Brand Brain",
  description: "Returns ActTrident's owner-approved Brand Brain entries (positioning, audience, voice, offers, proof points and other "
    + "approved knowledge). Use it before planning or writing anything about ActTrident, and treat it as the only source of company "
    + "facts. Read-only: it cannot change, approve or publish anything.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { title: "Get the approved Brand Brain", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export interface BrandBrain {
  organization: string | null;
  count: number;
  read_at: string;
  entries: Array<{ section: string; key: string; title: string; body: string; version: number; approved_at: string | null }>;
}
export interface KeyFile { format: string; environment: string; base_url: string; token: string; expires_at: string; cert_sha256: string | null }

/** A problem the owner can fix; its message is shown to Claude (never contains the key). */
export class BridgeError extends Error {}

type Json = Record<string, unknown>;
type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json };

export async function readKeyFile(file: string): Promise<KeyFile> {
  let k: KeyFile;
  try {
    k = JSON.parse(await readFile(file, "utf8")) as KeyFile;
  } catch {
    throw new BridgeError("No connector key on this PC. In the dashboard, open System health → Claude connector and click \"Create key (8 hours)\", then try again.");
  }
  if (k.format !== "lbe-claude-connector/1" || !/^[0-9a-f]{64}$/.test(k.token ?? "")) throw new BridgeError("The connector key file is damaged. Create a new key in the dashboard.");
  if (Date.parse(k.expires_at) <= Date.now()) throw new BridgeError("The connector key has expired. Create a new key in the dashboard (System health → Claude connector).");
  return k;
}

/** GET a JSON path from the local API with the key; HTTPS only to a pinned certificate. */
export async function fetchBrandBrain(key: KeyFile, timeoutMs = 15_000): Promise<BrandBrain> {
  const url = new URL("/api/connector/v1/brand-brain", key.base_url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new BridgeError("The connector only talks to this computer (127.0.0.1).");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const host = url.hostname === "[::1]" ? "::1" : url.hostname;
  const https = url.protocol === "https:";
  if (!https && url.protocol !== "http:") throw new BridgeError("Unsupported connector address.");
  if (https && !key.cert_sha256) throw new BridgeError("The connector key has no certificate fingerprint. Create a new key in the dashboard.");
  // One path for HTTP and HTTPS: open the connection ourselves, check the certificate (HTTPS), and only then send
  // the request carrying the key over that same connection.
  const socket: net.Socket = https ? tls.connect({ host, port, servername: "localhost", rejectUnauthorized: false }) : net.connect({ host, port });
  socket.on("error", () => undefined);                   // failures surface below as plain messages; never crash the bridge
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error("timeout")));
  try {
    try {
      await once(socket, https ? "secureConnect" : "connect");
    } catch {
      throw new BridgeError("The ActTrident system is not running on this PC. Start it and try again.");
    }
    if (https && (socket as tls.TLSSocket).getPeerCertificate().fingerprint256 !== key.cert_sha256) {
      throw new BridgeError("The server on this PC is not the one this key was made for (certificate mismatch). Nothing was sent.");
    }
    const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        host, port, path: url.pathname, method: "GET", createConnection: (() => socket) as never,
        headers: { authorization: `Bearer ${key.token}`, accept: "application/json", connection: "close" },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    }).catch(() => { throw new BridgeError("The ActTrident system did not answer. Check it is running and try again."); });
    if (status === 401) throw new BridgeError("The connector key was revoked or has expired. Create a new key in the dashboard.");
    if (status === 404) throw new BridgeError("The Claude connector is switched off on this system (LBE_CONNECTOR=off).");
    if (status !== 200) throw new BridgeError(`The ActTrident system answered with an error (HTTP ${status}).`);
    return JSON.parse(body) as BrandBrain;
  } finally {
    socket.destroy();
  }
}

/** Plain text for Claude: one heading per entry, approved facts only. */
export function renderBrandBrain(b: BrandBrain): string {
  if (b.count === 0) {
    return "The Brand Brain has no approved entries yet. The owner adds them in the dashboard (Brand Brain → guided setup). "
      + "Do not make up company facts in the meantime.";
  }
  const parts = [`${b.organization ?? "ActTrident"} Brand Brain: ${b.count} owner-approved entries (read ${b.read_at}).`,
    "These are the only approved company facts. Do not invent others; say when something is not covered.", ""];
  for (const e of b.entries) {
    parts.push(`## ${e.section} / ${e.key}: ${e.title} (v${e.version}${e.approved_at ? `, approved ${e.approved_at.slice(0, 10)}` : ""})`, e.body, "");
  }
  const text = parts.join("\n");
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[Shortened: the Brand Brain is longer than this connector returns.]` : text;
}

export interface BridgeDeps { getBrandBrain: () => Promise<BrandBrain>; log?: (line: string) => void }

/** Handles one JSON-RPC message; returns the response object, or null for notifications. */
export async function handleMessage(msg: Rpc, deps: BridgeDeps): Promise<Json | null> {
  const id = msg.id ?? null;
  const reply = (result: Json) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return msg.id === undefined ? null : fail(-32600, "Invalid request");
  if (msg.id === undefined) return null;                                   // notifications (e.g. notifications/initialized)
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return reply({
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[1]!,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "Read-only access to ActTrident's owner-approved Brand Brain. Call get_brand_brain before writing about "
          + "ActTrident. This connector cannot create, change, approve or publish anything.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: [TOOL] });
    case "tools/call": {
      const name = msg.params?.name;
      const args = msg.params?.arguments;
      if (name !== TOOL.name) return fail(-32602, `Unknown tool: ${String(name)}`);
      if (args !== undefined && (typeof args !== "object" || args === null || Object.keys(args).length > 0)) {
        return fail(-32602, "get_brand_brain takes no arguments");
      }
      try {
        const brain = await deps.getBrandBrain();
        deps.log?.(`get_brand_brain: ${brain.count} entries`);
        return reply({ content: [{ type: "text", text: renderBrandBrain(brain) }], isError: false });
      } catch (e) {
        const text = e instanceof BridgeError ? e.message : "The Brand Brain could not be read (unexpected error).";
        deps.log?.(`get_brand_brain failed: ${text}`);
        return reply({ content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

/** stdio loop: one JSON message per line in, one per line out. Logs go to stderr only. */
export function runStdio(deps: BridgeDeps, input = process.stdin, output = process.stdout): void {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const write = (o: unknown) => output.write(`${JSON.stringify(o)}\n`);
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
    const batch = Array.isArray(msg) ? msg : [msg];
    const out = (await Promise.all(batch.map((m) => handleMessage(m as Rpc, deps)))).filter((r) => r !== null);
    if (out.length) write(Array.isArray(msg) ? out : out[0]);
  });
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Started directly by Claude Desktop (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const environment = argValue("--environment") ?? "staging";
  if (!/^[a-z0-9-]{1,30}$/.test(environment)) { process.stderr.write("invalid --environment\n"); process.exit(2); }
  const keyFile = argValue("--key-file") ?? path.join(import.meta.dirname, "..", "..", "..", "secrets", `claude-connector-${environment}.json`);
  const log = (line: string) => process.stderr.write(`[acttrident-brand-brain] ${new Date().toISOString()} ${line}\n`);
  log(`started (environment ${environment}); read-only; one tool`);
  runStdio({ getBrandBrain: async () => fetchBrandBrain(await readKeyFile(keyFile)), log });
}
