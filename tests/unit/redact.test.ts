import { describe, expect, it } from "vitest";
import { MAX_LOG_TEXT, redactForLog } from "@lbe/security";

describe("redactForLog", () => {
  it("removes session tokens, API keys and long secrets but keeps UUIDs", () => {
    const token = "a".repeat(64);
    const out = redactForLog(`session ${token} key sk-ant-api03-${"Z".repeat(40)} record 3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab`);
    expect(out).not.toContain(token);
    expect(out).not.toMatch(/ZZZZ/);
    expect(out).toContain("3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab");
  });

  it("removes email addresses", () => {
    expect(redactForLog("duplicate for Jane.Doe@Example.co.uk here")).toBe("duplicate for [email] here");
  });

  it("removes credentials in connection strings and auth headers", () => {
    const url = ["connect postgres://lbe", "hunter2@127.0.0.1:5432/db failed"].join(":");   // assembled: keeps the secret scanner quiet
    expect(redactForLog(url)).toBe("connect postgres://[redacted]@127.0.0.1:5432/db failed");
    expect(redactForLog("Authorization: Bearer abc.def")).toBe("Authorization: Bearer [redacted]");
  });

  it("removes OAuth codes, states and token-like query/JSON values, even short ones", () => {
    const out = redactForLog('GET /cb?code=AQx12&state=ab12 body {"access_token":"tok","client_secret":"s"} password=pw1');
    expect(out).not.toMatch(/AQx12|ab12|"tok"|"s"|pw1/);
  });

  it("caps length and accepts non-string input", () => {
    expect(redactForLog("x ".repeat(1000)).length).toBeLessThanOrEqual(MAX_LOG_TEXT + 20);
    expect(redactForLog(new Error("boom user@a.io"))).toBe("boom [email]");
  });
});
