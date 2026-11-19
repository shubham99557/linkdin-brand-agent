import { describe, expect, it } from "vitest";
import { createProvider, MockLinkedInProvider } from "@lbe/publishing";
import { isTrustedOrigin, safeTokenEqual } from "@lbe/security";
import { loadConfig } from "../../services/api/src/config.ts";

describe("configuration guards", () => {
  it("refuses production mode in Phase 1", () => {
    expect(() => loadConfig({ LBE_ENV: "production" }, false)).toThrow(/not approved for production/);
    expect(() => loadConfig({ NODE_ENV: "production" }, false)).toThrow(/not approved for production/);
  });
  it("refuses any publishing provider other than mock", () => {
    expect(() => loadConfig({ LBE_PUBLISHING_PROVIDER: "linkedin" }, false)).toThrow(/Invalid configuration/);
  });
  it("requires an API key for the Anthropic drafter", () => {
    expect(() => loadConfig({ LBE_DRAFTER: "anthropic" }, false)).toThrow(/ANTHROPIC_API_KEY/);
  });
  it("defaults to safe values (mock drafter, mock provider, embedded DB, localhost)", () => {
    const c = loadConfig({}, false);
    expect([c.LBE_DRAFTER, c.LBE_PUBLISHING_PROVIDER, c.LBE_DATABASE_URL, c.LBE_HOST]).toEqual(["mock", "mock", "pglite", "127.0.0.1"]);
  });
});

describe("provider factory", () => {
  it("only creates the mock provider", () => {
    const mock = () => new MockLinkedInProvider({ record: async () => undefined });
    expect(createProvider("mock", { mock }).name).toBe("mock");
    expect(() => createProvider("linkedin", { mock })).toThrow(/only when LBE_LIVE_PUBLISHING=on/);
  });
});

describe("transport security helpers", () => {
  it("origin allow-list", () => {
    const allowed = ["http://localhost:5173"];
    expect(isTrustedOrigin({ origin: "http://localhost:5173" }, allowed)).toBe(true);
    expect(isTrustedOrigin({ origin: "https://evil.example" }, allowed)).toBe(false);
    expect(isTrustedOrigin({ secFetchSite: "same-origin" }, allowed)).toBe(true);
    expect(isTrustedOrigin({ secFetchSite: "cross-site" }, allowed)).toBe(false);
    expect(isTrustedOrigin({}, allowed)).toBe(false);
  });
  it("constant-time token compare", () => {
    expect(safeTokenEqual("a".repeat(40), "a".repeat(40))).toBe(true);
    expect(safeTokenEqual("b".repeat(40), "a".repeat(40))).toBe(false);
    expect(safeTokenEqual("", "a".repeat(40))).toBe(false);
  });
});
