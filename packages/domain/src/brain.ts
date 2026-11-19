/**
 * Brand Brain sections (must match lbe.brain_sections() / lbe.brain_required_sections()).
 * Onboarding questions are asked of the OWNER; answers become approved knowledge only when the owner saves them.
 */
export const BRAIN_SECTIONS = [
  "identity", "positioning", "messaging", "icp", "audience_problems", "audience_language",
  "voice_company", "voice_founder", "product", "pillars_goals", "prohibited", "communication_rules", "lessons",
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
}

export const SECTION_META: readonly SectionMeta[] = [
  { section: "identity", label: "Brand identity", required: true,
    questions: ["In one or two sentences, what is ActTrident?", "What do you want people to feel and remember after seeing your posts?",
      "Any visual identity rules for images (colours, style, things to avoid)?"] },
  { section: "positioning", label: "Positioning", required: true,
    questions: ["Who is ActTrident for, and what alternative do they use today?", "What makes ActTrident different — in terms you can prove?"] },
  { section: "messaging", label: "Key messages", required: true,
    questions: ["What are the 3–5 messages you want repeated over and over?", "What proof supports each message (link to the claims register)?"] },
  { section: "icp", label: "Ideal customer profiles", required: true,
    questions: ["Describe your best customers: sector, size, role of the buyer, region.", "Who should NOT be targeted?"] },
  { section: "audience_problems", label: "Audience problems", required: true,
    questions: ["What problems keep these buyers up at night?", "What triggers them to look for help?"] },
  { section: "audience_language", label: "Audience language", required: false,
    questions: ["Words and phrases your buyers actually use (paste real quotes if you have them).", "Jargon to avoid?"] },
  { section: "voice_company", label: "Company page voice", required: true,
    questions: ["How should the company page sound?", "Paste 3–5 example posts you like."] },
  { section: "voice_founder", label: "Founder voice", required: true,
    questions: ["How should the founder sound (first person)?", "Topics the founder is happy to talk about — and ones to avoid."] },
  { section: "product", label: "Product knowledge", required: true,
    questions: ["What does the product do today (not roadmap)?", "Which capabilities may be mentioned publicly?"] },
  { section: "pillars_goals", label: "Content pillars & campaign goals", required: true,
    questions: ["What should LinkedIn achieve this quarter (e.g. awareness, demo requests)?", "Which themes (pillars) should posts rotate through?"] },
  { section: "prohibited", label: "Prohibited claims & topics", required: true,
    questions: ["Words or claims that must never appear (e.g. 'unhackable', 'guaranteed').", "Topics that are off-limits."],
    listField: { key: "terms", label: "Prohibited words/phrases (one per line)" } },
  { section: "communication_rules", label: "Communication rules", required: false,
    questions: ["Formatting, hashtag, emoji or length rules.", "Legal or compliance wording requirements."] },
  { section: "lessons", label: "Lessons learned", required: false,
    questions: ["What has worked or not worked before? (The agent proposes lessons here from approval feedback.)"] },
];

export const REQUIRED_SECTIONS = SECTION_META.filter((s) => s.required).map((s) => s.section);
