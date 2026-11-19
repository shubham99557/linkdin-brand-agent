import { createHash, timingSafeEqual } from "node:crypto";
import type { Role } from "@lbe/domain";

export * from "./token-crypto.ts";
export * from "./redact.ts";

export const SESSION_COOKIE = "lbe_session";

/** Session token format produced by lbe.login(): 64 lowercase hex chars. */
export function looksLikeSessionToken(v: string | undefined | null): v is string {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
}

/**
 * CSRF defence for cookie-authenticated, state-changing requests.
 * Requires an Origin header from the allow-list, or (if a browser omitted Origin)
 * Sec-Fetch-Site: same-origin. Cookies are also SameSite=Strict.
 */
export function isTrustedOrigin(
  headers: { origin?: string | null; secFetchSite?: string | null },
  allowedOrigins: readonly string[],
): boolean {
  if (headers.origin) return allowedOrigins.includes(headers.origin);
  return headers.secFetchSite === "same-origin";
}

/** Constant-time comparison for bearer tokens (hash first so lengths always match). */
export function safeTokenEqual(provided: string | undefined | null, expected: string): boolean {
  if (!provided || expected.length === 0) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * UI hints only. Authoritative checks happen in the database functions
 * (lbe.require_user + per-account approver membership).
 */
export const ROLE_HINTS: Record<Role, { canEdit: boolean; canApprove: boolean; canStop: boolean; canResume: boolean; canReconcile: boolean }> = {
  admin: { canEdit: true, canApprove: true, canStop: true, canResume: true, canReconcile: true },
  approver: { canEdit: true, canApprove: true, canStop: true, canResume: false, canReconcile: false },
  editor: { canEdit: true, canApprove: false, canStop: true, canResume: false, canReconcile: false },
  viewer: { canEdit: false, canApprove: false, canStop: false, canResume: false, canReconcile: false },
};
