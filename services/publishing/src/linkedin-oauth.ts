import { assertAllowedUrl, LINKEDIN_HOSTS, safeErrorText } from "./http-guard.ts";

export const LINKEDIN_SCOPES = {
  // Founder: Share on LinkedIn + Sign In with LinkedIn (OIDC). Minimum needed to post and identify the member.
  founder_app: ["openid", "profile", "w_member_social"],
  // Company page: Community Management API. Write posts + read own posts (reconciliation). No analytics yet.
  company_app: ["w_organization_social", "r_organization_social"],
} as const;

export type LinkedInApp = keyof typeof LINKEDIN_SCOPES;

export interface OAuthEndpoints {
  authBase?: string;   // default https://www.linkedin.com
  apiBase?: string;    // default https://api.linkedin.com
  allowedHosts?: readonly string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function buildAuthorizeUrl(p: { clientId: string; redirectUri: string; app: LinkedInApp; state: string } & OAuthEndpoints): string {
  const base = assertAllowedUrl(`${p.authBase ?? "https://www.linkedin.com"}/oauth/v2/authorization`, p.allowedHosts ?? LINKEDIN_HOSTS);
  base.search = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: LINKEDIN_SCOPES[p.app].join(" "),
    state: p.state,
  }).toString();
  return base.toString();
}

export interface TokenResult {
  accessToken: string;
  expiresIn: number;
  scopes: string[];
}

export async function exchangeCode(p: { code: string; clientId: string; clientSecret: string; redirectUri: string } & OAuthEndpoints): Promise<TokenResult> {
  const url = assertAllowedUrl(`${p.authBase ?? "https://www.linkedin.com"}/oauth/v2/accessToken`, p.allowedHosts ?? LINKEDIN_HOSTS);
  const res = await (p.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code: p.code, client_id: p.clientId,
      client_secret: p.clientSecret, redirect_uri: p.redirectUri,
    }).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(p.timeoutMs ?? 20_000),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${safeErrorText(await res.text().catch(() => ""))}`);
  const data = (await res.json()) as { access_token?: unknown; expires_in?: unknown; scope?: unknown };
  if (typeof data.access_token !== "string" || data.access_token.length < 10 || typeof data.expires_in !== "number") {
    throw new Error("token exchange returned an unexpected response");
  }
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    scopes: typeof data.scope === "string" ? data.scope.split(/[\s,]+/).filter(Boolean) : [],
  };
}

/** Read-only token check (POST /oauth/v2/introspectToken). Returns LinkedIn's view of the token. */
export async function introspectToken(p: { token: string; clientId: string; clientSecret: string } & OAuthEndpoints): Promise<{
  active: boolean; status: string | null; expiresAt: number | null; scope: string | null;
}> {
  const url = assertAllowedUrl(`${p.authBase ?? "https://www.linkedin.com"}/oauth/v2/introspectToken`, p.allowedHosts ?? LINKEDIN_HOSTS);
  const res = await (p.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: p.clientId, client_secret: p.clientSecret, token: p.token }).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(p.timeoutMs ?? 20_000),
  });
  if (!res.ok) throw new Error(`introspection failed (${res.status})`);
  const d = (await res.json()) as { active?: unknown; status?: unknown; expires_at?: unknown; scope?: unknown };
  return {
    active: d.active === true,
    status: typeof d.status === "string" ? d.status : null,
    expiresAt: typeof d.expires_at === "number" ? d.expires_at : null,
    scope: typeof d.scope === "string" ? d.scope : null,
  };
}

export async function fetchUserInfo(p: { accessToken: string } & OAuthEndpoints): Promise<{ sub: string; name: string | null }> {
  const url = assertAllowedUrl(`${p.apiBase ?? "https://api.linkedin.com"}/v2/userinfo`, p.allowedHosts ?? LINKEDIN_HOSTS);
  const res = await (p.fetchImpl ?? fetch)(url, {
    headers: { Authorization: `Bearer ${p.accessToken}` },
    redirect: "manual",
    signal: AbortSignal.timeout(p.timeoutMs ?? 20_000),
  });
  if (!res.ok) throw new Error(`userinfo failed (${res.status})`);
  const data = (await res.json()) as { sub?: unknown; name?: unknown };
  if (typeof data.sub !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(data.sub)) throw new Error("userinfo returned no valid subject");
  return { sub: data.sub, name: typeof data.name === "string" ? data.name.slice(0, 200) : null };
}
