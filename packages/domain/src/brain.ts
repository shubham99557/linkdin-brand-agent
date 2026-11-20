/**
 * Brand Brain sections (must match lbe.brain_sections() / lbe.brain_required_sections()).
 * Onboarding questions are asked of the OWNER; answers become approved knowledge only when the owner saves them.
 */
export const BRAIN_SECTIONS = [
  "identity", "positioning", "messaging", "icp", "ideal_follower", "audience_problems", "audience_language",
  "voice_company", "voice_founder", "founder_story", "exemplar_posts", "product", "pillars_goals", "prohibited", "communication_rules", "lessons",
] as const;
export type BrainSection = (typeof BRAIN_SECTIONS)[number];

export interface SectionMeta {
  section: BrainSection;
  label: string;
  required: boolean;
  /** Plain-language questions for guided onboarding. */
  questions: string[];
  /** Optional structured fields collected by the onboarding form. */
  listField?: { key: string; label: string };
  /** One line placed under the section heading in agent prompts, where the label alone could be misread. */
  contextNote?: string;
  /** Each entry is one authentic post with its provenance (P2-10): the editor asks for these fields. */
  postFields?: boolean;
}

/** Provenance stored in `structured` for an exemplar post (checked by lbe.exemplar_problem in the database). */
export interface ExemplarFields {
  account_kind: "company_page" | "founder_profile";
  url?: string;          // https:// link to the post, if public
  posted_on?: string;    // YYYY-MM-DD
  why?: string;          // why the owner chose it (results, tone, structure)
}

export const SECTION_META: readonly SectionMeta[] = [
  { section: "identity", label: "Brand identity", required: true,
    questions: ["In one or two sentences, what is ActTrident?", "What do you want people to feel and remember after seeing your posts?",
      "Any visual identity rules for images (colours, style, things to avoid)?"] },
  { section: "positioning", label: "Positioning", required: true,
    questions: ["Who is ActTrident for, and what alternative do they use today?", "What makes ActTrident different — in terms you can prove?"] },
  { section: "messaging", label: "Key messages", required: true,
    questions: ["What are the 3–5 messages you want repeated over and over?", "What proof supports each message (link to the claims register)?"] },
  // P2-09 (ADR-038): the buyer and the follower are different audiences. The key stays `icp` (the buyer).
  { section: "icp", label: "Buyer ICP (who buys)", required: true,
    questions: [
      "Which companies buy from ActTrident? Sector, size, and anything else that makes a company a good fit.",
      "Which roles decide or sign off the purchase, and who else is involved?",
      "Which problems make them buy? What has usually just happened when they start looking?",
      "Which countries or regions do you sell to?",
      "How do buyers choose a supplier? Only criteria you have actually seen or been told.",
      "Who should NOT be targeted (company types, sizes, sectors, roles)?",
    ],
    contextNote: "The companies and decision-makers who BUY. Use for qualification and for content aimed at buyers. Not the same people as the ideal follower." },
  { section: "ideal_follower", label: "Ideal follower (who reads)", required: true,
    questions: [
      "Who should find the posts valuable enough to follow? Roles, experience, communities.",
      "Which topics do they already follow or talk about?",
      "Which words and questions do they use? Paste real examples if you have them.",
      "How do they relate to buyers: do they advise, influence, refer or become buyers later?",
    ],
    contextNote: "The people who read, follow and share the content. They may influence or refer buyers but are not necessarily buyers. Do not treat them as the buyer ICP." },
  { section: "audience_problems", label: "Audience problems", required: true,
    questions: ["What problems keep these buyers up at night?", "What triggers them to look for help?"] },
  { section: "audience_language", label: "Audience language", required: false,
    questions: ["Words and phrases your buyers actually use (paste real quotes if you have them).", "Jargon to avoid?"] },
  { section: "voice_company", label: "Company page voice", required: true,
    questions: ["How should the company page sound?", "Paste 3–5 example posts you like."] },
  { section: "voice_founder", label: "Founder voice", required: true,
    questions: ["How should the founder sound (first person)?", "Topics the founder is happy to talk about — and ones to avoid."] },
  // P2-10 (ADR-038): written by the founder or owner; an AI may only propose it with a verbatim quote (DB rule).
  { section: "founder_story", label: "Founder story & opinions", required: false,
    questions: [
      "The founder's story in their own words: what they did before, why they started ActTrident, a few moments that shaped it.",
      "Opinions the founder genuinely holds about the industry, including ones others may disagree with.",
      "Personal topics the founder does NOT want to share.",
    ] },
  { section: "exemplar_posts", label: "Best authentic posts", required: false, postFields: true,
    questions: [
      "Paste one real post per entry that you would be happy to see more like, written by or for this account.",
      "Say which account it is from, and why you chose it (results, tone, structure). Add the link and date if you have them.",
    ] },
  { section: "product", label: "Product knowledge", required: true,
    questions: ["What does the product do today (not roadmap)?", "Which capabilities may be mentioned publicly?"] },
  // Pillars themselves live on each account (edited in the "Content pillars" panel); this section is the goals narrative.
  { section: "pillars_goals", label: "Campaign goals", required: true,
    questions: ["What should LinkedIn achieve this quarter (e.g. awareness, demo requests)?",
      "Why do the content pillars matter to your buyers? (Edit the pillar list itself in the Content pillars panel.)"] },
  { section: "prohibited", label: "Prohibited claims & topics", required: true,
    questions: ["Words or claims that must never appear (e.g. 'unhackable', 'guaranteed').", "Topics that are off-limits."],
    listField: { key: "terms", label: "Prohibited words/phrases (one per line)" } },
  { section: "communication_rules", label: "Communication rules", required: false,
    questions: ["Formatting, hashtag, emoji or length rules.", "Legal or compliance wording requirements."] },
  { section: "lessons", label: "Lessons learned", required: false,
    questions: ["What has worked or not worked before? (The agent proposes lessons here from approval feedback.)"] },
];

export const REQUIRED_SECTIONS = SECTION_META.filter((s) => s.required).map((s) => s.section);

/**
 * Guided onboarding order (P2-02): who you are → who you serve → what you sell and say → how you sound → what
 * to post about → what never to say → optional extras → proof (claims). `pillars` and `claims` are wizard-only
 * steps backed by the account pillars and the claims register. `lessons` is filled by learning proposals.
 */
export type OnboardingStep = BrainSection | "pillars" | "claims";
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  "identity", "positioning", "icp", "ideal_follower", "audience_problems", "product", "messaging",
  "voice_company", "voice_founder", "founder_story", "pillars", "pillars_goals", "prohibited",
  "audience_language", "communication_rules", "claims",
];
