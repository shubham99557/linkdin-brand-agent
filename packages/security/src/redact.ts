// Redaction for log lines. Logs must never contain session tokens, API keys, OAuth codes/tokens, passwords in
// connection strings, or email addresses. UUIDs are kept (they identify records, not people or secrets).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RULES: Array<[RegExp, string | ((m: string) => string)]> = [
  [/\b(postgres(?:ql)?|https?):\/\/[^\s/@:]+:[^\s/@]+@/gi, "$1://[redacted]@"],                       // credentials in URLs
  [/\b(bearer|basic)\s+[^\s,;"']+/gi, "$1 [redacted]"],                                             // auth headers
  [/\b(code|state|access_token|refresh_token|id_token|client_secret|password|token|api[_-]?key)=([^&\s"']+)/gi, "$1=[redacted]"],
  [/("(?:password|token|access_token|client_secret|api_key|secret)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"'],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],                                            // email addresses
  [/[A-Za-z0-9_\-+/=]{32,}/g, (m) => (UUID.test(m) ? m : "[redacted]")],                             // long tokens/keys/hashes (JWT parts too)
];

export const MAX_LOG_TEXT = 500;

/** Redact secrets and personal data from free text destined for logs, and cap its length. */
export function redactForLog(text: unknown): string {
  let s = typeof text === "string" ? text : text instanceof Error ? text.message : String(text);
  for (const [re, rep] of RULES) s = s.replace(re, rep as string);
  return s.length > MAX_LOG_TEXT ? `${s.slice(0, MAX_LOG_TEXT)}…[truncated]` : s;
}
