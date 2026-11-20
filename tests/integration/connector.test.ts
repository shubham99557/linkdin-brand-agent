// P11-01a: read-only Claude connector. API routes (off by default, admin-only key management, Bearer key only)
// and the real MCP bridge process that Claude Desktop starts, spoken to over stdio exactly as Claude does.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { MockDrafter } from "@lbe/drafting";
import { MockLinkedInProvider } from "@lbe/publishing";
import { createApp } from "../../services/api/src/app.ts";
import { BRIDGE_SCRIPT, type ConnectorConfig } from "../../services/api/src/connector.ts";
import { BridgeError, fetchBrandBrain, handleMessage, readKeyFile, renderBrandBrain, SUPPORTED_VERSIONS, TOOL } from "../../services/api/src/connector-bridge.ts";
import { dbMockStore } from "../../services/api/src/jobs/publisher.ts";
import { freshDb, TEST_PASSWORDS, type TestDb } from "../helpers/db.ts";

const ORIGIN = "http://localhost:5173";
let t: TestDb;
let work: string;
let connector: ConnectorConfig;
let app: ReturnType<typeof createApp>;
let server: ReturnType<typeof serve>;

const makeApp = (cfg?: ConnectorConfig) => createApp({
  db: t.db, drafter: new MockDrafter(), provider: new MockLinkedInProvider(dbMockStore(t.db)), appOrigins: [ORIGIN], cookieSecure: false,
  voiceDir: path.resolve(import.meta.dirname, "../../brand/voice"), workerId: "it", log: () => undefined, ...(cfg ? { connector: cfg } : {}),
});
async function login(a: ReturnType<typeof createApp>, email: string, password: string) {
  const res = await a.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ email, password }) });
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (a: ReturnType<typeof createApp>, method: string, url: string, cookie?: string, origin = ORIGIN) =>
  a.request(url, { method, headers: { ...(cookie ? { cookie } : {}), origin } });
const brain = (a: ReturnType<typeof createApp>, token?: string) =>
  a.request("/api/connector/v1/brand-brain", { headers: token ? { authorization: `Bearer ${token}` } : {} });

beforeAll(async () => {
  t = await freshDb();
  work = await mkdtemp(path.join(tmpdir(), "lbe-connector-"));
  const admin = await t.login("admin");
  await t.api("select lbe.brain_upsert_entry($1, 'identity', 'main', 'Who we are', 'ActTrident helps UK firms build security habits.', '{}'::jsonb, 'owner', null)", [admin]);
  await t.api("select lbe.brain_upsert_entry($1, 'voice_company', 'main', 'Company voice', 'Calm, practical, no fear-mongering.', '{}'::jsonb, 'owner', null)", [admin]);
  connector = { enabled: true, environment: "test", keyFile: path.join(work, "claude-connector-test.json"), baseUrl: "http://127.0.0.1:0" };
  app = makeApp(connector);
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => { connector.baseUrl = `http://127.0.0.1:${info.port}`; resolve(); });
  });
}, 120_000);
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await t.db.close();
  await rm(work, { recursive: true, force: true });
});

describe("connector API (P11-01a)", () => {
  it("is off unless switched on: the read route answers 404 and keys cannot be created", async () => {
    const off = makeApp();
    expect((await brain(off, "a".repeat(64))).status).toBe(404);
    const cookie = await login(off, "admin@lbe.test", TEST_PASSWORDS.admin);
    expect((await call(off, "POST", "/api/connector/key", cookie)).status).toBe(409);
  });

  it("only an admin manages keys; the key goes to the file, never to the browser", async () => {
    expect((await call(app, "POST", "/api/connector/key")).status).toBe(401);
    expect((await call(app, "POST", "/api/connector/key", await login(app, "editor@lbe.test", TEST_PASSWORDS.editor))).status).toBe(403);
    const admin = await login(app, "admin@lbe.test", TEST_PASSWORDS.admin);
    expect((await call(app, "POST", "/api/connector/key", admin, "https://evil.example")).status).toBe(403);
    const res = await call(app, "POST", "/api/connector/key", admin);
    expect(res.status).toBe(201);
    const body = await res.text();
    const file = JSON.parse(await readFile(connector.keyFile, "utf8")) as { token: string; base_url: string; scope: string };
    expect(file.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body).not.toContain(file.token);
    expect(file).toMatchObject({ base_url: connector.baseUrl, scope: "read:brand_brain" });
    const status = await (await call(app, "GET", "/api/connector/status", admin)).text();
    expect(status).not.toContain(file.token);
    expect(JSON.parse(status)).toMatchObject({ enabled: true, key_file_present: true, tools: ["get_brand_brain"] });
  });

  it("the read route needs the connector key: no key, a wrong key or a dashboard session are refused", async () => {
    const { token } = JSON.parse(await readFile(connector.keyFile, "utf8")) as { token: string };
    expect((await brain(app)).status).toBe(401);
    expect((await brain(app, "f".repeat(64))).status).toBe(401);
    const sessionToken = (await login(app, "admin@lbe.test", TEST_PASSWORDS.admin)).split("=")[1]!;
    expect((await brain(app, sessionToken)).status).toBe(401);
    const ok = await brain(app, token);
    expect(ok.status).toBe(200);
    const r = await ok.json() as { count: number; entries: Array<{ title: string }> };
    expect(r.entries.map((e) => e.title)).toEqual(["Who we are", "Company voice"]);
  });
});

describe("MCP bridge: the process Claude Desktop starts (P11-01a)", () => {
  let child: ChildProcessWithoutNullStreams;
  let stdout = "";
  let stderr = "";
  const responses = new Map<number, Record<string, unknown>>();
  const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
  const rpc = async (id: number, method: string, params?: unknown) => {
    send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    for (let i = 0; i < 200 && !responses.has(id); i++) await new Promise((r) => setTimeout(r, 50));
    return responses.get(id)! as { result?: Record<string, unknown>; error?: { code: number } };
  };

  beforeAll(() => {
    child = spawn(process.execPath, [BRIDGE_SCRIPT, "--environment", "test", "--key-file", connector.keyFile], { stdio: "pipe" });
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
      let nl: number;
      while ((nl = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, nl); stdout = stdout.slice(nl + 1);
        const m = JSON.parse(line) as { id: number };
        responses.set(m.id, m as never);
      }
    });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
  });
  afterAll(() => { child.kill(); });

  it("initialize → one read-only tool → get_brand_brain returns the approved entries; the key never appears", async () => {
    const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "acttrident-brand-brain" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const list = await rpc(2, "tools/list");
    expect((list.result as { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> }).tools.map((x) => [x.name, x.annotations.readOnlyHint]))
      .toEqual([["get_brand_brain", true]]);
    const res = await rpc(3, "tools/call", { name: "get_brand_brain", arguments: {} });
    const text = ((res.result as { content: Array<{ text: string }> }).content[0]!.text);
    expect((res.result as { isError: boolean }).isError).toBe(false);
    expect(text).toContain("2 owner-approved entries");
    expect(text).toContain("## identity / main: Who we are");
    expect(text).toContain("Calm, practical, no fear-mongering.");
    const { token } = JSON.parse(await readFile(connector.keyFile, "utf8")) as { token: string };
    expect(text + stderr).not.toContain(token);
    const [audit] = await t.db.query<{ n: number }>("select count(*)::int as n from lbe.audit_events where action = 'connector.tool_called'");
    expect(audit!.n).toBeGreaterThan(0);
  }, 30_000);

  it("after the owner revokes the key, the tool reports it plainly (no data, no key)", async () => {
    const admin = await login(app, "admin@lbe.test", TEST_PASSWORDS.admin);
    const { token } = JSON.parse(await readFile(connector.keyFile, "utf8")) as { token: string };
    // Keep a copy of the old key file so the bridge still presents the revoked key.
    const oldFile = path.join(work, "old-key.json");
    await writeFile(oldFile, await readFile(connector.keyFile));
    expect((await (await call(app, "DELETE", "/api/connector/key", admin)).json() as { revoked: number }).revoked).toBe(1);
    expect(existsSync(connector.keyFile)).toBe(false);
    expect((await brain(app, token)).status).toBe(401);
    const res = await handleMessage({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "get_brand_brain", arguments: {} } },
      { getBrandBrain: async () => fetchBrandBrain(await readKeyFile(oldFile)) });
    expect(res).toMatchObject({ result: { isError: true } });
    const text = JSON.stringify(res);
    expect(text).toMatch(/revoked or has expired/);
    expect(text).not.toContain(token);
    // And with no key file at all:
    const missing = await rpc(4, "tools/call", { name: "get_brand_brain" });
    expect(JSON.stringify(missing)).toMatch(/No connector key on this PC/);
  }, 30_000);
});

describe("MCP bridge protocol details (P11-01a)", () => {
  const deps = { getBrandBrain: async () => ({ organization: "ActTrident", count: 0, read_at: "2026-11-20T00:00:00Z", entries: [] }) };
  it("negotiates the protocol version, answers ping, ignores notifications, refuses unknown methods, tools and arguments", async () => {
    expect(await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }, deps))
      .toMatchObject({ result: { protocolVersion: SUPPORTED_VERSIONS[1] } });
    for (const v of SUPPORTED_VERSIONS) {
      expect(await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v } }, deps)).toMatchObject({ result: { protocolVersion: v } });
    }
    expect(await handleMessage({ jsonrpc: "2.0", id: 2, method: "ping" }, deps)).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, deps)).toBeNull();
    expect(await handleMessage({ jsonrpc: "2.0", id: 3, method: "resources/list" }, deps)).toMatchObject({ error: { code: -32601 } });
    expect(await handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "approve_post" } }, deps)).toMatchObject({ error: { code: -32602 } });
    expect(await handleMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_brand_brain", arguments: { sql: "drop" } } }, deps)).toMatchObject({ error: { code: -32602 } });
    expect(TOOL.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
  });

  it("an empty Brand Brain says so, and tells Claude not to invent facts", () => {
    expect(renderBrandBrain({ organization: "ActTrident", count: 0, read_at: "x", entries: [] })).toMatch(/no approved entries yet.*Do not make up/s);
  });

  it("a server that accepts but never answers gives a plain message after the time limit, without crashing the bridge", async () => {
    const silent = net.createServer(() => undefined);
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    const port = (silent.address() as net.AddressInfo).port;
    try {
      const key = { format: "lbe-claude-connector/1", environment: "x", token: "a".repeat(64), expires_at: "2999-01-01T00:00:00Z", cert_sha256: null };
      await expect(fetchBrandBrain({ ...key, base_url: `http://127.0.0.1:${port}` }, 300)).rejects.toThrow(/did not answer/);
      await expect(fetchBrandBrain({ ...key, base_url: "http://127.0.0.1:1" }, 300)).rejects.toThrow(/not running/);
      await new Promise((r) => setTimeout(r, 500));                 // a late socket error must not surface as a crash
    } finally {
      silent.close();
    }
  });

  it("refuses to send the key anywhere but this computer, and refuses HTTPS without a pinned certificate", async () => {
    const key = { format: "lbe-claude-connector/1", environment: "x", token: "a".repeat(64), expires_at: "2999-01-01T00:00:00Z", cert_sha256: null };
    await expect(fetchBrandBrain({ ...key, base_url: "https://example.com" })).rejects.toThrow(/only talks to this computer/);
    await expect(fetchBrandBrain({ ...key, base_url: "https://127.0.0.1:8443" })).rejects.toThrow(/no certificate fingerprint/);
    await expect(fetchBrandBrain({ ...key, base_url: "https://127.0.0.1:8443" })).rejects.toBeInstanceOf(BridgeError);
    const expired = path.join(work, "expired.json");
    await writeFile(expired, JSON.stringify({ ...key, base_url: "http://127.0.0.1:1", expires_at: "2000-01-01T00:00:00Z" }));
    await expect(readKeyFile(expired)).rejects.toThrow(/has expired/);
  });
});
