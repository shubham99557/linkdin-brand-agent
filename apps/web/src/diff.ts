// Word-level diff for comparing post versions (P5-04). Longest-common-subsequence over word/whitespace tokens.
// Posts are ≤ 3,000 characters, so the O(n·m) table is small; very long inputs fall back to "replace all".
export type DiffPart = { type: "same" | "add" | "del"; text: string };

const tokens = (s: string) => s.split(/(\s+)/).filter((t) => t.length > 0);
const MAX_TOKENS = 3000;

export function diffWords(before: string, after: string): DiffPart[] {
  const a = tokens(before), b = tokens(after);
  if (a.length * b.length > MAX_TOKENS * MAX_TOKENS / 4) {
    return [...(before ? [{ type: "del" as const, text: before }] : []), ...(after ? [{ type: "add" as const, text: after }] : [])];
  }
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: Uint16Array[] = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffPart[] = [];
  const push = (type: DiffPart["type"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text; else out.push({ type, text });
  };
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push("same", a[i]!); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { push("del", a[i]!); i++; }
    else { push("add", b[j]!); j++; }
  }
  while (i < a.length) push("del", a[i++]!);
  while (j < b.length) push("add", b[j++]!);
  return tidy(out);
}

/**
 * Readability: a bare space between two changes would otherwise "match" and chop a replaced phrase into
 * alternating removed/added words. Fold such whitespace into the change so each change block reads as one
 * removal followed by one addition. Both texts are still reconstructed exactly.
 */
function tidy(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  const emit = (type: DiffPart["type"], text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text; else out.push({ type, text });
  };
  let i = 0;
  while (i < parts.length) {
    if (parts[i]!.type === "same") { emit("same", parts[i]!.text); i++; continue; }
    let del = "", add = "";
    while (i < parts.length) {
      const p = parts[i]!;
      if (p.type === "del") del += p.text;
      else if (p.type === "add") add += p.text;
      else if (/^\s+$/.test(p.text) && i + 1 < parts.length && parts[i + 1]!.type !== "same") { del += p.text; add += p.text; }
      else break;
      i++;
    }
    emit("del", del);
    emit("add", add);
  }
  return out;
}
