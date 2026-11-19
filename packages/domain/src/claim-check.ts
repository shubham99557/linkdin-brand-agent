/**
 * Deterministic factual-claim detector (defence in depth behind the model's own reporting).
 *
 * Flags sentences that look like checkable factual claims — numbers, percentages, money,
 * CVE references, certifications/compliance, absolute or superlative product claims,
 * customer outcomes, incidents — unless the sentence is covered by a citation to a verified
 * claim. It is intentionally conservative: false positives cost a reviewer a click,
 * false negatives risk publishing an unsupported security claim.
 */
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "percentage", re: /\d+(\.\d+)?\s?%|\bper\s?cent\b/i },
  { name: "number_with_scale", re: /\b\d[\d,.]*\s?(k|m|bn|million|billion|thousand|x)\b/i },
  { name: "currency", re: /[£$€]\s?\d|\b\d[\d,.]*\s?(gbp|usd|eur|pounds|dollars)\b/i },
  { name: "multiplier_or_time_saving", re: /\b\d+\s?(times|hours|days|minutes|weeks)\s+(faster|quicker|less|fewer|more)\b/i },
  { name: "cve", re: /\bCVE-\d{4}-\d{3,}\b/i },
  { name: "certification", re: /\b(ISO\s?\/?\s?(IEC\s?)?2700[0-9]|SOC\s?2|Cyber Essentials|CREST|PCI[\s-]?DSS|FedRAMP|certified|accredited|NCSC[\s-]assured)\b/i },
  { name: "compliance", re: /\b(GDPR|NIS\s?2|DORA|HIPAA)[\s-]?(compliant|compliance|ready|certified)\b|\bcompliant with\b/i },
  { name: "absolute", re: /\b(guarantee[sd]?|100% (safe|secure|protection)|never (breached|fails?)|unhackable|bullet-?proof|zero (risk|breaches))\b/i },
  { name: "superlative", re: /(#1\b|\bnumber one\b|\b(industry|market)[- ]leading\b|\bworld[- ]class\b|\bthe first to\b|\bthe (best|leading|fastest|only|first|largest|most trusted)\s+(\w+\s+){0,2}(provider|platform|company|vendor|solution|tool|service|firm|product|team)s?\b)/i },
  { name: "customer_outcome", re: /\b(our|their) (customers?|clients?) (saw|reduced|cut|saved|achieved|reported)\b|\bcase study\b|\btestimonial\b/i },
  { name: "incident", re: /\b(was|were|has been|have been) (breached|hacked|compromised)\b|\bransomware attack on\b/i },
  { name: "statistic_phrase", re: /\b(\d+ (in|out of) \d+|majority of|most (organisations|organizations|companies|businesses))\b/i },
];

export interface FlaggedStatement {
  sentence: string;
  reasons: string[];
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Returns sentences that contain factual-claim patterns and are not covered by any citation span. */
export function findUnsupportedStatements(body: string, citedSpans: readonly string[]): FlaggedStatement[] {
  const spans = citedSpans.map((s) => s.trim()).filter((s) => s.length > 0);
  const flagged: FlaggedStatement[] = [];
  for (const sentence of splitSentences(body)) {
    // A sentence wholly inside one citation is covered.
    if (spans.some((span) => span.includes(sentence))) continue;
    // Otherwise remove cited text and test what remains, so extra claims appended to a
    // cited sentence ("X is UK-registered and blocks 99% of attacks") are still caught.
    let remainder = sentence;
    for (const span of spans) remainder = remainder.split(span).join(" ");
    const reasons = PATTERNS.filter((p) => p.re.test(remainder)).map((p) => p.name);
    if (reasons.length > 0) flagged.push({ sentence, reasons });
  }
  return flagged;
}
