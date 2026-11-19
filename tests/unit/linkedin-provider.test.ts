import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PublicationPackage } from "@lbe/domain";
import {
  assertAllowedUrl, buildAuthorizeUrl, escapeLittleText, exchangeCode, fetchUserInfo, LinkedInProvider, MockLinkedInProvider,
} from "@lbe/publishing";
import { decryptToken, encryptToken, parseTokenKey } from "@lbe/security";
import { loadConfig } from "../../services/api/src/config.ts";
import { startFakeLinkedIn, type FakeLinkedIn, type PostBehaviour } from "../helpers/fake-linkedin.ts";

let fake: FakeLinkedIn;
beforeAll(async () => { fake = await startFakeLinkedIn(); });
afterAll(async () => fake.close());
beforeEach(() => { fake.requests.length = 0; fake.behaviour.post = "created"; fake.validTokens.add(fake.issuedToken); });

const pkg = (over: Partial<PublicationPackage["destination"]> = {}, body = "Hello (world) #security @team"): PublicationPackage => ({
  schema: "lbe.publication.v1",
  content_id: "c1",
  destination: { account_id: "acct-1", kind: "founder_profile", linkedin_urn: "urn:li:person:abc123XYZ", publishing_mode: "live", ...over },
  body, media_ids: [], visibility: "PUBLIC", scheduled_for: null, claim_ids: [],
});
const provider = (timeoutMs = 2000, token: string | null = null) => new LinkedInProvider({
  getAccessToken: async () => token ?? fake.issuedToken,
  apiBase: fake.base, allowedHosts: ["127.0.0.1"], timeoutMs,
});

describe("LinkedIn Posts API contract (fake server)", () => {
  it("sends the documented headers and body, and returns the URN from x-restli-id", async () => {
    const r = await provider().publish({ pkg: pkg(), idempotencyKey: "k" });
    expect(r.kind).toBe("success");
    expect(r.kind === "success" && r.providerRef).toMatch(/^urn:li:share:\d+$/);
    const req = fake.requests.at(-1)!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/rest/posts");
    expect(req.headers["linkedin-version"]).toBe("202611");
    expect(req.headers["x-restli-protocol-version"]).toBe("2.0.0");
    expect(req.headers.authorization).toBe(`Bearer ${fake.issuedToken}`);
    const body = JSON.parse(req.body);
    expect(body).toEqual({
      author: "urn:li:person:abc123XYZ",
      commentary: "Hello \\(world\\) \\#security \\@team",
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    });
  });

  const cases: Array<[PostBehaviour, string, string | undefined]> = [
    ["created_no_id", "ambiguous", undefined],
    [400, "rejected", undefined],
    [422, "rejected", undefined],
    [401, "rejected", "credential_invalid"],
    [403, "rejected", "permission_denied"],
    [426, "rejected", "version_sunset"],
    [429, "retryable", undefined],
    [409, "ambiguous", undefined],
    [500, "ambiguous", undefined],
    [503, "ambiguous", undefined],
  ];
  for (const [behaviour, kind, alert] of cases) {
    it(`maps ${behaviour} → ${kind}${alert ? ` (+${alert})` : ""}`, async () => {
      fake.behaviour.post = behaviour;
      const r = await provider().publish({ pkg: pkg(), idempotencyKey: "k" });
      expect(r.kind).toBe(kind);
      if (alert) expect(r.kind === "rejected" && r.alert?.kind).toBe(alert);
      if (behaviour === 429) expect(r.kind === "retryable" && r.retryAfterSeconds).toBe(120);
    });
  }

  it("treats a timeout as ambiguous (the post may exist)", async () => {
    fake.behaviour.post = "hang";
    const r = await provider(300).publish({ pkg: pkg(), idempotencyKey: "k" });
    expect(r.kind).toBe("ambiguous");
  });

  it("treats a dropped connection after sending as ambiguous", async () => {
    fake.behaviour.post = "destroy";
    expect((await provider().publish({ pkg: pkg(), idempotencyKey: "k" })).kind).toBe("ambiguous");
  });

  it("treats connection refused (nothing sent) as retryable", async () => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const { port } = s.address() as AddressInfo;
    await new Promise<void>((r) => s.close(() => r()));   // port is now closed → ECONNREFUSED
    const p = new LinkedInProvider({ getAccessToken: async () => "t".repeat(20), apiBase: `http://127.0.0.1:${port}`, allowedHosts: ["127.0.0.1"], timeoutMs: 2000 });
    expect((await p.publish({ pkg: pkg(), idempotencyKey: "k" })).kind).toBe("retryable");
  });

  it("refuses packages not approved for live, without a valid author, with media, or too long — without calling LinkedIn", async () => {
    const p = provider();
    expect((await p.publish({ pkg: pkg({ publishing_mode: "mock" }), idempotencyKey: "k" })).kind).toBe("rejected");
    expect((await p.publish({ pkg: pkg({ linkedin_urn: null }), idempotencyKey: "k" })).kind).toBe("rejected");
    expect((await p.publish({ pkg: { ...pkg(), media_ids: ["m"] }, idempotencyKey: "k" })).kind).toBe("rejected");
    expect((await p.publish({ pkg: pkg({}, "#".repeat(1600)), idempotencyKey: "k" })).kind).toBe("rejected");
    expect(fake.requests).toHaveLength(0);
  });

  it("no credential → rejected with credential alert and no request", async () => {
    const p = new LinkedInProvider({ getAccessToken: async () => null, apiBase: fake.base, allowedHosts: ["127.0.0.1"] });
    const r = await p.publish({ pkg: pkg(), idempotencyKey: "k" });
    expect(r.kind === "rejected" && r.alert?.kind).toBe("credential_invalid");
    expect(fake.requests).toHaveLength(0);
  });

  it("error text never contains the access token", async () => {
    fake.behaviour.post = 401;
    const r = await provider().publish({ pkg: pkg(), idempotencyKey: "k" });
    expect(JSON.stringify(r)).not.toContain(fake.issuedToken);
  });

  it("find-by-author works for organization pages and is refused for people", async () => {
    const org = new LinkedInProvider({ getAccessToken: async () => fake.issuedToken, apiBase: fake.base, allowedHosts: ["127.0.0.1"] });
    await org.publish({ pkg: pkg({ kind: "company_page", linkedin_urn: "urn:li:organization:12345" }, "Org post"), idempotencyKey: "k" });
    const found = await org.findRecentPostsByAuthor("acct-1", "urn:li:organization:12345");
    expect(found.map((f) => f.commentary)).toContain("Org post");
    expect(fake.requests.at(-1)!.headers["x-restli-method"]).toBe("FINDER");
    await expect(org.findRecentPostsByAuthor("acct-1", "urn:li:person:abc")).rejects.toThrow(/organization/);
  });

  it("the mock provider refuses live packages (and vice versa)", async () => {
    const mock = new MockLinkedInProvider({ record: async () => undefined });
    expect((await mock.publish({ pkg: pkg(), idempotencyKey: "k" })).kind).toBe("rejected");
  });
});

describe("outbound host guard", () => {
  it("allows only listed HTTPS hosts (loopback only when explicitly listed)", () => {
    expect(() => assertAllowedUrl("https://api.linkedin.com/rest/posts", ["api.linkedin.com"])).not.toThrow();
    expect(() => assertAllowedUrl("https://evil.example/rest/posts", ["api.linkedin.com"])).toThrow(/not allowed/);
    expect(() => assertAllowedUrl("http://api.linkedin.com/rest/posts", ["api.linkedin.com"])).toThrow(/HTTPS/);
    expect(() => assertAllowedUrl("http://127.0.0.1:9/x", ["api.linkedin.com"])).toThrow(/not allowed/);
    expect(() => new LinkedInProvider({ getAccessToken: async () => null, apiBase: "https://attacker.example" })).toThrow(/not allowed/);
  });
});

describe("little text format escaping", () => {
  it("escapes every reserved character", () => {
    expect(escapeLittleText("|{}@[]()<>#\\*_~")).toBe("\\|\\{\\}\\@\\[\\]\\(\\)\\<\\>\\#\\\\\\*\\_\\~");
    expect(escapeLittleText("plain text, ok.")).toBe("plain text, ok.");
  });
});

describe("OAuth client (fake server)", () => {
  const ep = () => ({ authBase: fake.base, apiBase: fake.base, allowedHosts: ["127.0.0.1"] });
  it("builds the authorize URL with minimal scopes and state", () => {
    const u = new URL(buildAuthorizeUrl({ clientId: "cid", redirectUri: "https://localhost:8443/api/oauth/linkedin/callback", app: "founder_app", state: "s".repeat(64) }));
    expect(u.origin + u.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(u.searchParams.get("scope")).toBe("openid profile w_member_social");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("state")).toBe("s".repeat(64));
    const company = new URL(buildAuthorizeUrl({ clientId: "cid", redirectUri: "https://x/cb", app: "company_app", state: "s" }));
    expect(company.searchParams.get("scope")).toBe("w_organization_social r_organization_social");
  });
  it("exchanges the code (form-encoded, with secret) and reads userinfo", async () => {
    const t = await exchangeCode({ code: "good-code", clientId: "cid", clientSecret: "sec", redirectUri: "https://x/cb", ...ep() });
    expect(t.accessToken).toBe(fake.issuedToken);
    expect(t.expiresIn).toBeGreaterThan(5_000_000);
    expect(fake.requests.at(-1)!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const u = await fetchUserInfo({ accessToken: t.accessToken, ...ep() });
    expect(u.sub).toBe(fake.sub);
  });
  it("a bad code fails without leaking the client secret", async () => {
    await expect(exchangeCode({ code: "bad", clientId: "cid", clientSecret: "SUPERSECRET", redirectUri: "https://x/cb", ...ep() }))
      .rejects.toThrow(/token exchange failed \(400\)/);
    await exchangeCode({ code: "bad", clientId: "cid", clientSecret: "SUPERSECRET", redirectUri: "https://x/cb", ...ep() })
      .catch((e: Error) => expect(e.message).not.toContain("SUPERSECRET"));
  });
});

describe("token encryption", () => {
  const key = randomBytes(32);
  it("round-trips and binds ciphertext to the account", () => {
    const ct = encryptToken(key, "acct-a", "token-value-123");
    expect(ct).not.toContain("token-value-123");
    expect(decryptToken(key, "acct-a", ct)).toBe("token-value-123");
    expect(() => decryptToken(key, "acct-b", ct)).toThrow();
    expect(() => decryptToken(randomBytes(32), "acct-a", ct)).toThrow();
  });
  it("detects tampering", () => {
    const ct = encryptToken(key, "a", "tok");
    const parts = ct.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptToken(key, "a", parts.join("."))).toThrow();
  });
  it("validates key length", () => {
    expect(() => parseTokenKey(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
    expect(parseTokenKey(key.toString("base64"))).toHaveLength(32);
  });
});

describe("Phase 2 configuration guards", () => {
  const key = randomBytes(32).toString("base64");
  const app = { LBE_LINKEDIN_FOUNDER_CLIENT_ID: "id", LBE_LINKEDIN_FOUNDER_CLIENT_SECRET: "secret" };
  it("live publishing is off by default", () => {
    expect(loadConfig({}, false).liveEnabled).toBe(false);
  });
  it("live publishing requires LBE_ENV=staging", () => {
    expect(() => loadConfig({ LBE_LIVE_PUBLISHING: "on", LBE_TOKEN_ENC_KEY: key, LBE_LINKEDIN_REDIRECT_URI: "https://localhost:8443/cb", ...app }, false))
      .toThrow(/only allowed with LBE_ENV=staging/);
    expect(loadConfig({ LBE_ENV: "staging", LBE_LIVE_PUBLISHING: "on", LBE_TOKEN_ENC_KEY: key,
      LBE_LINKEDIN_REDIRECT_URI: "https://localhost:8443/cb", ...app }, false).liveEnabled).toBe(true);
  });
  it("requires an https redirect URI and an encryption key when an app is configured", () => {
    expect(() => loadConfig({ ...app, LBE_TOKEN_ENC_KEY: key, LBE_LINKEDIN_REDIRECT_URI: "http://localhost/cb" }, false)).toThrow(/Invalid configuration/);
    expect(() => loadConfig({ ...app, LBE_LINKEDIN_REDIRECT_URI: "https://localhost/cb" }, false)).toThrow(/LBE_TOKEN_ENC_KEY/);
  });
  it("rejects a malformed encryption key and half-configured apps", () => {
    expect(() => loadConfig({ LBE_TOKEN_ENC_KEY: "short" }, false)).toThrow(/32 random bytes/);
    expect(() => loadConfig({ LBE_LINKEDIN_COMPANY_CLIENT_ID: "only-id" }, false)).toThrow(/together/);
  });
});
