export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`);
  return data as T;
}

export type Role = "admin" | "approver" | "editor" | "viewer";
export interface Me {
  id: string; email: string; display_name: string; role: Role; approver_for: string[];
  hints: { canEdit: boolean; canApprove: boolean; canStop: boolean; canResume: boolean; canReconcile: boolean };
}
export interface Credential {
  app: string; status: "valid" | "invalid" | "revoked" | "expired"; expires_at: string; subject_urn: string | null;
  subject_name: string | null; scopes: string[]; invalid_reason: string | null; connected_at: string;
}
export interface Account {
  id: string; kind: "company_page" | "founder_profile"; display_name: string; linkedin_urn: string | null;
  voice_profile: string; pillars: string[]; enabled: boolean; publishing_mode: "mock" | "live"; release_mode: "manual" | "scheduled";
  live_enabled_at: string | null; credential: Credential | null; stopped: boolean;
  stop_reason: string | null; approvers: Array<{ id: string; display_name: string }>;
}
export interface Health { ok: boolean; publishing_provider: string; drafter: string; live_publishing: boolean }

export const daysUntil = (iso: string) => Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000);
export interface ContentSummary {
  id: string; account_id: string; account_name: string; account_kind: string; pillar: string; status: string;
  scheduled_for: string | null; updated_at: string; version: number; excerpt: string; unsupported_count: number;
}
export interface Claim {
  id: string; statement: string; category: string; evidence_url: string | null; evidence_note: string | null;
  status: string; usable: boolean; created_by_name: string; verified_by_name: string | null; expires_at: string | null;
}
export interface ControlFlag {
  key: string; stopped: boolean; reason: string | null; changed_at: string; changed_by_name: string | null; account_name: string | null;
}

export const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—";
