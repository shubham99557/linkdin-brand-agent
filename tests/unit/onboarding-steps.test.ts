import { describe, expect, it } from "vitest";
import { BRAIN_SECTIONS, ONBOARDING_STEPS, REQUIRED_SECTIONS } from "@lbe/domain";

describe("guided onboarding order (P2-02)", () => {
  it("covers every required section exactly once, plus pillars and a final claims step", () => {
    expect(new Set(ONBOARDING_STEPS).size).toBe(ONBOARDING_STEPS.length);
    for (const s of REQUIRED_SECTIONS) expect(ONBOARDING_STEPS).toContain(s);
    expect(ONBOARDING_STEPS).toContain("pillars");
    expect(ONBOARDING_STEPS.at(-1)).toBe("claims");
  });

  it("asks for pillars before campaign goals, and leaves 'lessons' to learning proposals", () => {
    expect(ONBOARDING_STEPS.indexOf("pillars")).toBeLessThan(ONBOARDING_STEPS.indexOf("pillars_goals"));
    expect(ONBOARDING_STEPS).not.toContain("lessons");
    for (const s of ONBOARDING_STEPS) if (s !== "pillars" && s !== "claims") expect(BRAIN_SECTIONS).toContain(s);
  });
});
