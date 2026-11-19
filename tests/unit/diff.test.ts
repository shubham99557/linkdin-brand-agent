// P5-04: word-level comparison used in the post history view.
import { describe, expect, it } from "vitest";
import { diffWords } from "../../apps/web/src/diff.ts";

const join = (parts: ReturnType<typeof diffWords>, keep: Array<"same" | "add" | "del">) =>
  parts.filter((p) => keep.includes(p.type)).map((p) => p.text).join("");

describe("diffWords", () => {
  it("reconstructs both versions exactly", () => {
    const a = "Report suspicious emails quickly.\nDon't delete them.";
    const b = "Report suspicious emails within five minutes.\nDon't delete them — forward them.";
    const d = diffWords(a, b);
    expect(join(d, ["same", "del"])).toBe(a);
    expect(join(d, ["same", "add"])).toBe(b);
  });

  it("marks only the changed words", () => {
    const d = diffWords("Spot phishing in ten seconds", "Spot phishing in five seconds");
    expect(d.filter((p) => p.type === "del").map((p) => p.text)).toEqual(["ten"]);
    expect(d.filter((p) => p.type === "add").map((p) => p.text)).toEqual(["five"]);
  });

  it("keeps a replaced phrase together (one removal, one addition) instead of alternating words", () => {
    const d = diffWords("Intro. What would you add? #cybersecurity", "Intro. Edited after approval.");
    expect(d).toEqual([
      { type: "same", text: "Intro. " },
      { type: "del", text: "What would you add? #cybersecurity" },
      { type: "add", text: "Edited after approval." },
    ]);
  });

  it("handles identical, empty and fully replaced texts", () => {
    expect(diffWords("same text", "same text")).toEqual([{ type: "same", text: "same text" }]);
    expect(diffWords("", "new")).toEqual([{ type: "add", text: "new" }]);
    expect(diffWords("old", "")).toEqual([{ type: "del", text: "old" }]);
  });

  it("stays fast on a maximum-length post (3,000 characters)", () => {
    const words = Array.from({ length: 500 }, (_, i) => `word${i}`);
    const a = words.join(" ").slice(0, 3000);
    const b = words.map((w, i) => (i % 7 === 0 ? `${w}x` : w)).join(" ").slice(0, 3000);
    const t0 = performance.now();
    const d = diffWords(a, b);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(join(d, ["same", "add"])).toBe(b);
  });
});
