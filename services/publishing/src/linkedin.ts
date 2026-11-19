import { PublicationPackageSchema } from "@lbe/domain";
import { assertAllowedUrl, LINKEDIN_HOSTS, safeErrorText, wasDefinitelyNotSent } from "./http-guard.ts";
import { escapeLittleText, LINKEDIN_COMMENTARY_MAX } from "./linkedin-text.ts";
import type { PublishingProvider, PublishOutcome, PublishRequest } from "./provider.ts";

export interface LinkedInProviderOptions {
  /** Returns a decrypted access token for the account, or null if none is valid. */
  getAccessToken(accountId: string): Promise<string | null>;
  apiBase?: string;
  version?: string;
  allowedHosts?: readonly string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Endpoint for PERSON authors. "ugcPosts" (default) is what the Share on LinkedIn product documents
   * (POST /v2/ugcPosts, verified 2026-11-19). "posts" uses the newer /rest/posts — unconfirmed for w_member_social-only apps.
   * Organization authors always use /rest/posts (Community Management API).
   */
  memberEndpoint?: "ugcPosts" | "posts";
}

export interface LinkedInPostSummary {
  id: string;
  commentary: string;
  createdAt: number | null;
}

/**
 * Live LinkedIn provider (Posts API). Built in Stage 2.1 and exercised ONLY against a local fake server.
 * It is registered by the application only when LBE_LIVE_PUBLISHING=on.
 */
export class LinkedInProvider implements PublishingProvider {
  readonly name = "linkedin" as const;
  private readonly apiBase: string;
  private readonly version: string;
  private readonly allowedHosts: readonly string[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly memberEndpoint: "ugcPosts" | "posts";

  constructor(private readonly opts: LinkedInProviderOptions) {
    this.memberEndpoint = opts.memberEndpoint ?? "ugcPosts";
    this.apiBase = opts.apiBase ?? "https://api.linkedin.com";
    this.version = opts.version ?? "202611";
    this.allowedHosts = opts.allowedHosts ?? LINKEDIN_HOSTS;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (!/^\d{6}$/.test(this.version)) throw new Error("LinkedIn API version must be YYYYMM");
    assertAllowedUrl(this.apiBase, this.allowedHosts);
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "Linkedin-Version": this.version,
      "X-Restli-Protocol-Version": "2.0.0",
      "Content-Type": "application/json",
    };
  }

  async publish(req: PublishRequest): Promise<PublishOutcome> {
    const parsed = PublicationPackageSchema.safeParse(req.pkg);
    if (!parsed.success) return { kind: "rejected", error: "invalid publication package" };
    const pkg = parsed.data;
    if (pkg.destination.publishing_mode !== "live") {
      return { kind: "rejected", error: "live provider refuses packages that were not approved for live publishing" };
    }
    const author = pkg.destination.linkedin_urn;
    if (!author || !/^urn:li:(person|organization):[A-Za-z0-9_-]{1,64}$/.test(author)) {
      return { kind: "rejected", error: "approved package has no valid LinkedIn author URN" };
    }
    if (pkg.media_ids.length > 0) return { kind: "rejected", error: "media posts are not supported until Stage 2.4" };
    const useUgc = author.startsWith("urn:li:person:") && this.memberEndpoint === "ugcPosts";
    // UGC shareCommentary is plain text (documented examples send hashtags unescaped);
    // the Posts API uses "little text format", which needs reserved characters escaped.
    const commentary = useUgc ? pkg.body : escapeLittleText(pkg.body);
    if (commentary.trim().length === 0) return { kind: "rejected", error: "empty commentary" };
    if (commentary.length > LINKEDIN_COMMENTARY_MAX) {
      return { kind: "rejected", error: `commentary exceeds ${LINKEDIN_COMMENTARY_MAX} characters${useUgc ? "" : " after escaping"}` };
    }

    const token = await this.opts.getAccessToken(pkg.destination.account_id);
    if (!token) {
      return { kind: "rejected", error: "no valid LinkedIn credential", alert: { kind: "credential_invalid", detail: "no valid credential at send time" } };
    }

    let url: URL;
    let body: unknown;
    let headers: Record<string, string>;
    if (useUgc) {
      // Documented request for Share on LinkedIn (learn.microsoft.com/.../share-on-linkedin, verified 2026-11-19).
      url = assertAllowedUrl(`${this.apiBase}/v2/ugcPosts`, this.allowedHosts);
      headers = { Authorization: `Bearer ${token}`, "X-Restli-Protocol-Version": "2.0.0", "Content-Type": "application/json" };
      body = {
        author,
        lifecycleState: "PUBLISHED",
        specificContent: { "com.linkedin.ugc.ShareContent": { shareCommentary: { text: commentary }, shareMediaCategory: "NONE" } },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": pkg.visibility },
      };
    } else {
      url = assertAllowedUrl(`${this.apiBase}/rest/posts`, this.allowedHosts);
      headers = this.headers(token);
      body = {
        author,
        commentary,
        visibility: pkg.visibility,
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      };
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (wasDefinitelyNotSent(err)) return { kind: "retryable", error: `connection failed before sending: ${safeErrorText(String((err as Error).message))}` };
      return { kind: "ambiguous", error: `request outcome unknown: ${safeErrorText(String((err as Error).message))}` };
    }

    const detail = async () => safeErrorText(await res.text().catch(() => ""));
    const s = res.status;
    if (s === 201) {
      const id = res.headers.get("x-restli-id");   // header names are case-insensitive (X-RestLi-Id)
      if (id && /^urn:li:(share|ugcPost):[0-9A-Za-z_-]+$/.test(id)) return { kind: "success", providerRef: id };
      return { kind: "ambiguous", error: "201 Created without a valid x-restli-id header" };
    }
    if (s === 429) {
      const ra = Number(res.headers.get("retry-after"));
      return { kind: "retryable", error: "LinkedIn rate limit (429)", retryAfterSeconds: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) : 600 };
    }
    if (s === 401) return { kind: "rejected", error: `LinkedIn 401: ${await detail()}`, alert: { kind: "credential_invalid", detail: "401 Unauthorized" } };
    if (s === 403) return { kind: "rejected", error: `LinkedIn 403: ${await detail()}`, alert: { kind: "permission_denied", detail: "403 Forbidden" } };
    if (s === 426) return { kind: "rejected", error: `LinkedIn API version ${this.version} is no longer supported`, alert: { kind: "version_sunset", detail: `426 for ${this.version}` } };
    if (s === 404 && useUgc) return { kind: "rejected", error: `LinkedIn 404 on /v2/ugcPosts — try LBE_LINKEDIN_MEMBER_ENDPOINT=posts: ${await detail()}` };
    if (s === 400 || s === 422) return { kind: "rejected", error: `LinkedIn ${s}: ${await detail()}` };
    // 409, 5xx, redirects and anything unexpected: the post may exist.
    return { kind: "ambiguous", error: `LinkedIn ${s}: ${await detail()}` };
  }

  /**
   * Reconciliation assist for ORGANIZATION authors (needs r_organization_social). Founder posts cannot
   * be read back (r_member_social is closed) — a human must check the profile.
   */
  async findRecentPostsByAuthor(accountId: string, authorUrn: string): Promise<LinkedInPostSummary[]> {
    if (!/^urn:li:organization:\d{1,20}$/.test(authorUrn)) throw new Error("find-by-author is only supported for organization pages");
    const token = await this.opts.getAccessToken(accountId);
    if (!token) throw new Error("no valid LinkedIn credential");
    const url = assertAllowedUrl(
      `${this.apiBase}/rest/posts?author=${encodeURIComponent(authorUrn)}&q=author&count=20&sortBy=LAST_MODIFIED`, this.allowedHosts);
    const res = await this.fetchImpl(url, {
      headers: { ...this.headers(token), "X-RestLi-Method": "FINDER" },
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`LinkedIn ${res.status} while listing posts`);
    const data = (await res.json()) as { elements?: Array<{ id?: string; commentary?: string; createdAt?: number }> };
    return (data.elements ?? []).filter((e) => typeof e.id === "string")
      .map((e) => ({ id: e.id!, commentary: e.commentary ?? "", createdAt: e.createdAt ?? null }));
  }
}
