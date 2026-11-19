import type { Drafter, DraftResult } from "./drafter.ts";
import type { DraftInput } from "./prompt.ts";

/**
 * Deterministic, offline drafter for development and tests. Makes no network calls.
 * `override` lets tests inject any raw model output (including malicious or malformed output).
 *
 * P3-02: output now meets the same automated checks a real draft must pass, so free mock evaluations test the
 * pipeline instead of failing on the template: 120–250 words; an opening that differs from the other posts in
 * the plan (`otherOpenings`); content varied per topic and account (low overlap between posts); no digits or
 * claim-like wording (the claim detector would flag it); "we" for the company page, "I" for the founder.
 * Text is generic, opinion-style and clearly not a factual statement.
 */
const COMPANY_OPENINGS = [
  "Here is a pattern we keep running into around {topic}.",
  "{Topic} is usually less about tools than about habits.",
  "When teams ask us about {topic}, the conversation rarely starts where they expect.",
  "A short note on {topic}, from the work we do with teams like yours.",
  "Ask a few people in any business about {topic} and you hear very different stories.",
  "Plenty of security advice about {topic} skips the part that matters.",
  "There is a quiet reason {topic} goes wrong, and it is rarely technical.",
  "We spend a lot of time talking with teams about {topic}.",
];
const FOUNDER_OPENINGS = [
  "I used to think {topic} was mainly a technology problem.",
  "Something I learned the hard way about {topic}.",
  "I keep coming back to one question about {topic}.",
  "A recent conversation changed how I think about {topic}.",
  "Here is what I would tell my younger self about {topic}.",
  "I get asked about {topic} more than almost anything else.",
  "Early in my career I got {topic} wrong.",
  "Every time {topic} comes up, I think of the same lesson.",
];
const ADVICE = [
  "Start with one habit and make it easy to repeat.",
  "Write the rule down in plain words, then check that everyone can find it.",
  "Ask the people closest to the work what gets in their way.",
  "Agree who to tell when something looks wrong, and make telling them painless.",
  "Practise the awkward moments before they happen, not during them.",
  "Keep the first step small enough to finish this week.",
  "Thank the person who raises a concern, even when it turns out to be nothing.",
  "Look back at near misses calmly and without looking for someone to blame.",
  "Make the secure choice the default choice wherever you can.",
  "Revisit the plan when something changes, such as a new supplier, a new tool or a new team.",
  "Treat questions as useful signals rather than interruptions.",
  "Check that leaders follow the same rules they ask others to follow.",
  "Keep instructions short enough to remember on a busy day.",
  "Pair new starters with someone who can show them how things really work.",
  "Decide in advance what good looks like, so nobody has to guess under pressure.",
  "Remove one step that people skip anyway, and protect the steps that matter.",
  "Give each shared account a named owner who checks it from time to time.",
  "Turn a long policy into a single page people will actually read.",
  "Celebrate the quiet wins, like a suspicious message reported early.",
  "Test the plan with a calm tabletop conversation before relying on it.",
  "Ask suppliers the same questions you would want answered about yourself.",
  "Retire old tools and accounts instead of leaving them switched on and forgotten.",
  "Explain the reason behind each rule; people follow what they understand.",
  "Set a regular moment to review access, and keep it short.",
  "Use real examples from your own sector rather than generic warnings.",
  "Let people practise reporting without fear of looking foolish.",
  "Write down who decides what during a disruption, before one arrives.",
  "Check that backups can actually be restored, not just that they exist.",
  "Keep a simple list of the systems the business could not live without.",
  "Give managers a short script for the conversations nobody enjoys.",
];
const COMPANY_REFLECTIONS = [
  "That is the thinking behind how we work with the teams we support.",
  "We would rather help teams build steady habits than chase quick fixes.",
  "Our view is simple: security works when it fits the way people already work.",
  "We see the biggest change when the whole team owns the habit, not one person.",
  "None of this needs a large budget, only steady attention.",
  "Small, boring improvements tend to outlast big launches.",
  "Good security often looks unremarkable from the outside, and that is the point.",
  "Teams that talk openly about mistakes usually recover faster from them.",
];
const FOUNDER_REFLECTIONS = [
  "That lesson has shaped how I lead.",
  "I would rather build steady habits than chase quick fixes.",
  "It took me longer than I would like to admit to see this.",
  "I still remind myself of this when things get busy.",
  "Most of what I know here came from getting it wrong first.",
  "The simplest version has nearly always been the one that lasted.",
  "I trust a habit people choose over a rule they put up with.",
  "Looking back, the people mattered more than the tools.",
];
const QUESTIONS = [
  "What is one habit that has worked for your team?",
  "Which of these would make the biggest difference where you work?",
  "What would you add to this list?",
  "How does your team handle this today?",
  "Where would you start if you had one afternoon to improve this?",
  "What has surprised you most when tackling this?",
  "Which step do teams you know tend to skip?",
  "What would make this easier for a busy manager?",
  "Has a small change ever made a big difference for you here?",
  "What do you wish someone had told you sooner?",
];
const COMPANY_PROBLEM_LEADS = ["The problem we hear about", "A common worry from the teams we meet", "What comes up again and again"];
const FOUNDER_PROBLEM_LEADS = ["The problem I hear about", "A worry I hear often", "What people keep telling me"];
const HASHTAGS = {
  culture: ["#cybersecurity #securityculture", "#securityawareness #culture", "#cybersecurity #leadership"],
  other: ["#cybersecurity #smallbusiness", "#infosec #smallbusiness", "#cyberresilience #ukbusiness"],
};

const MIN_WORDS = 130;   // comfortably inside the 120–250 house style
const MAX_WORDS = 240;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const opening4 = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean).slice(0, 4).join(" ");
/** Digits and claim-like phrases would be (rightly) flagged by the claim detector; keep mock text free of them. */
const safe = (s: string) => s.replace(/\d+/g, "").replace(/\s{2,}/g, " ").trim();

export class MockDrafter implements Drafter {
  readonly provider = "mock" as const;
  readonly model = "mock-drafter-v1";

  constructor(private readonly override?: (input: DraftInput) => DraftResult) {}

  async draft(input: DraftInput): Promise<DraftResult> {
    if (this.override) return this.override(input);
    const company = input.accountKind === "company_page";
    const brief = input.brief.trim();
    const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "mi").exec(brief)?.[1]?.trim();
    const topic = safe(field("Topic") ?? input.pillar.replace(/-/g, " "));
    const angle = safe(brief.split(/\n\s*\n/)[0]!.split("\n")[0]!.trim());
    const problem = field("Audience problem");
    const seed = hash(`${topic}|${input.accountKind}|${input.pillar}`);
    // A per-post shuffle (order items by a hash of seed + item): every item is reachable and two posts share few
    // items, so posts don't read as one template (the evaluation fails text overlap above 0.25).
    const pick = <T>(list: readonly T[], n: number, offset = 0): T[] =>
      [...list].sort((a, b) => hash(`${seed}:${offset}:${String(a)}`) - hash(`${seed}:${offset}:${String(b)}`)).slice(0, n);

    // Opening: first template whose first four words differ from every other post in the plan.
    const taken = new Set((input.otherOpenings ?? []).map(opening4));
    const templates = company ? COMPANY_OPENINGS : FOUNDER_OPENINGS;
    // Mid-sentence, Title-Case words from a heading-style topic read oddly ("about password Hygiene"), so lower-case
    // them; acronyms and mixed-case names (UK, ActTrident) keep their case.
    const midSentence = topic.replace(/\b[A-Z][a-z]+\b/g, (w) => w.toLowerCase());
    const fill = (t: string) => t.replace("{topic}", midSentence)
      .replace("{Topic}", midSentence.charAt(0).toUpperCase() + midSentence.slice(1));
    const candidates = templates.map((_, i) => fill(templates[(seed + i) % templates.length]!));
    const opening = candidates.find((c) => !taken.has(opening4(c))) ?? candidates[0]!;

    const claim = input.claims[0];
    const advice = pick(ADVICE, ADVICE.length, 3);
    const reflection = pick(company ? COMPANY_REFLECTIONS : FOUNDER_REFLECTIONS, 1)[0]!;
    const question = pick(QUESTIONS, 1, 5)[0]!;
    const problemLead = pick(company ? COMPANY_PROBLEM_LEADS : FOUNDER_PROBLEM_LEADS, 1, 7)[0]!;
    const hashtags = pick(input.pillar.includes("culture") ? HASHTAGS.culture : HASHTAGS.other, 1, 9)[0]!;

    const build = (adviceCount: number) => [
      opening,
      "",
      angle,
      ...(problem ? ["", safe(`${problemLead}: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`)] : []),
      ...(claim ? ["", claim.statement] : []),
      "",
      advice.slice(0, adviceCount).join(" "),
      "",
      reflection,
      "",
      `${question} ${hashtags}`,
    ].join("\n");
    let n = 3;
    let body = build(n);
    while (words(body) < MIN_WORDS && n < advice.length) body = build(++n);
    while (words(body) > MAX_WORDS && n > 1) body = build(--n);

    return {
      kind: "ok",
      raw: {
        body,
        hook_variants: candidates.filter((c) => c !== opening).slice(0, 2),
        claims_used: claim ? [{ claim_id: claim.id, quoted_span: claim.statement }] : [],
        unsupported_statements: [],
        notes_for_reviewer: "Generated by the offline mock drafter (no AI call was made).",
      },
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
