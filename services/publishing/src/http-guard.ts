/** Outbound HTTP guard: only allow-listed HTTPS hosts (test hosts must be passed explicitly). */
export const LINKEDIN_HOSTS = ["api.linkedin.com", "www.linkedin.com"] as const;

export function assertAllowedUrl(url: string, allowedHosts: readonly string[]): URL {
  const u = new URL(url);
  const isLoopbackTest = (u.hostname === "127.0.0.1" || u.hostname === "localhost") && allowedHosts.includes(u.hostname);
  if (!allowedHosts.includes(u.hostname)) throw new Error(`outbound host not allowed: ${u.hostname}`);
  if (u.protocol !== "https:" && !isLoopbackTest) throw new Error("outbound requests must use HTTPS");
  return u;
}

/** Errors raised before any request bytes could have reached the server. */
const BEFORE_SEND_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT",
]);

export function wasDefinitelyNotSent(err: unknown): boolean {
  const e = err as { name?: string; code?: string; cause?: { code?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return false;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" && BEFORE_SEND_CODES.has(code);
}

/** Trim and strip anything token-like from provider error text before it is stored or shown. */
export function safeErrorText(text: string): string {
  return text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/\s+/g, " ").slice(0, 300);
}
