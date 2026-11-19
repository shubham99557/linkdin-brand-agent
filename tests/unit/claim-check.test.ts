import { describe, expect, it } from "vitest";
import { findUnsupportedStatements, splitSentences } from "@lbe/domain";

describe("findUnsupportedStatements", () => {
  const flagged = (body: string, spans: string[] = []) => findUnsupportedStatements(body, spans).map((f) => f.sentence);

  it.each([
    "We stop 99% of phishing attacks.",
    "Our platform is ISO 27001 certified.",
    "We are fully GDPR compliant.",
    "Our customers saw incidents drop sharply.",
    "We are the leading MDR provider in the UK.",
    "ActTrident is the only platform that does this.",
    "We were the first to ship this control.",
    "Exploitation of CVE-2026-12345 is trivial.",
    "It saves teams 10 hours less per week.",
    "Acme Ltd was breached last month.",
    "We guarantee your data is safe.",
    "Attacks cost UK firms £3,000 each.",
    "Most organisations still reuse passwords.",
  ])("flags uncited factual claim: %s", (sentence) => {
    expect(flagged(sentence)).toEqual([sentence]);
  });

  it.each([
    "What is the first thing you check after an alert?",
    "Security culture starts with leadership.",
    "I learned this the hard way.",
  ])("does not flag opinion or question: %s", (sentence) => {
    expect(flagged(sentence)).toEqual([]);
  });

  it("a sentence fully covered by a citation is not flagged", () => {
    const s = "Phishing accounted for 84% of reported attacks in the survey.";
    expect(flagged(s, [s])).toEqual([]);
  });

  it("extra claims appended to a cited sentence are still flagged", () => {
    const span = "ActTrident is a UK-registered cybersecurity company";
    const body = `${span} and blocks 99% of ransomware.`;
    expect(flagged(body, [span])).toEqual([body]);
  });

  it("splits on sentence punctuation and newlines", () => {
    expect(splitSentences("One. Two!\nThree?")).toEqual(["One.", "Two!", "Three?"]);
  });
});
