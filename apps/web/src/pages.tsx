import { useMemo, useState } from "react";
import { api, fmt, type Account, type Claim, type ContentSummary, type Me } from "./api.ts";
import { Badge, ErrorText, useLoad } from "./components.tsx";

const go = (path: string) => { window.location.hash = path; };

// ------------------------------------------------------------------ calendar
export function CalendarPage() {
  const [items, error] = useLoad<ContentSummary[]>("/content");
  const [accounts] = useLoad<Account[]>("/accounts");
  const [account, setAccount] = useState("all");
  const groups = useMemo(() => {
    const m = new Map<string, ContentSummary[]>();
    for (const i of items ?? []) {
      if (account !== "all" && i.account_id !== account) continue;
      const key = i.scheduled_for ? new Date(i.scheduled_for).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "Unscheduled";
      m.set(key, [...(m.get(key) ?? []), i]);
    }
    return [...m.entries()];
  }, [items, account]);

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Content calendar</h2>
        <span style={{ flex: 1 }} />
        <select style={{ maxWidth: 260 }} value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Filter by account">
          <option value="all">All accounts</option>
          {accounts?.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
        </select>
        <button className="primary" onClick={() => go("/new")}>New post</button>
      </div>
      <ErrorText error={error} />
      {items && items.length === 0 && <div className="panel muted">No content yet. Create a post to get started.</div>}
      {groups.map(([day, list]) => (
        <div className="panel" key={day}>
          <h3 style={{ marginTop: 0 }}>{day}</h3>
          <div className="table-wrap"><table><tbody>
            {list.map((i) => (
              <tr key={i.id} style={{ cursor: "pointer" }} onClick={() => go(`/content/${i.id}`)} data-testid="calendar-row">
                <td style={{ width: 70 }} className="small">{i.scheduled_for ? new Date(i.scheduled_for).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : ""}</td>
                <td style={{ width: 210 }}><div>{i.account_name}</div><div className="small muted">{i.pillar}</div></td>
                <td>{i.excerpt}{i.unsupported_count > 0 && <span className="badge bad" style={{ marginLeft: 6 }}>{i.unsupported_count} unsupported</span>}</td>
                <td style={{ width: 150 }}><Badge value={i.status} /></td>
              </tr>
            ))}
          </tbody></table></div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ new content
export function NewContentPage() {
  const [accounts, loadError] = useLoad<Account[]>("/accounts");
  const [accountId, setAccountId] = useState("");
  const [pillar, setPillar] = useState("");
  const [brief, setBrief] = useState("");
  const [source, setSource] = useState("");
  const [schedule, setSchedule] = useState("");
  const [error, setError] = useState<string | null>(null);
  const account = accounts?.find((a) => a.id === accountId);

  return (
    <form className="panel" style={{ maxWidth: 720 }} onSubmit={async (e) => {
      e.preventDefault();
      setError(null);
      try {
        const r = await api<{ id: string }>("/content", { method: "POST", body: {
          account_id: accountId, pillar, brief, source_material: source || null,
          scheduled_for: schedule ? new Date(schedule).toISOString() : null,
        } });
        go(`/content/${r.id}`);
      } catch (err) {
        setError((err as Error).message);
      }
    }}>
      <h2>New post</h2>
      <ErrorText error={loadError} />
      <label htmlFor="acct">Account</label>
      <select id="acct" required value={accountId} onChange={(e) => { setAccountId(e.target.value); setPillar(""); }}>
        <option value="">Choose…</option>
        {accounts?.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
      </select>
      <label htmlFor="pillar">Content pillar (approved pillars for this account)</label>
      <select id="pillar" required value={pillar} onChange={(e) => setPillar(e.target.value)} disabled={!account}>
        <option value="">Choose…</option>
        {account?.pillars.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
      <label htmlFor="brief">Brief — what should this post say, and why now?</label>
      <textarea id="brief" required maxLength={4000} value={brief} onChange={(e) => setBrief(e.target.value)} style={{ minHeight: 100 }} />
      <label htmlFor="source">Source material (optional) — pasted article or notes. Treated as untrusted data, never as instructions or approved facts.</label>
      <textarea id="source" maxLength={20000} value={source} onChange={(e) => setSource(e.target.value)} style={{ minHeight: 80 }} />
      <label htmlFor="when">Scheduled for (optional)</label>
      <input id="when" type="datetime-local" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
      <ErrorText error={error} />
      <div style={{ marginTop: 12 }}><button className="primary" type="submit">Create</button></div>
    </form>
  );
}

// ------------------------------------------------------------------ claims
const CATEGORIES = ["product_capability", "security_effectiveness", "vulnerability_reference", "breach_statistic",
  "customer_outcome", "regulatory", "company_fact", "other"];

export function ClaimsPage({ me }: { me: Me }) {
  const [claims, error, reload] = useLoad<Claim[]>("/claims");
  const [statement, setStatement] = useState("");
  const [category, setCategory] = useState("company_fact");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try { await fn(); reload(); } catch (e) { setActionError((e as Error).message); }
  };

  return (
    <div>
      <h2>Claims register</h2>
      <p className="muted">The only source of factual statements the AI may use. Claims start as draft and must be verified (with evidence) by an approver. Verified claims cannot be edited — create a new one instead.</p>
      <ErrorText error={error ?? actionError} />
      {me.hints.canEdit && (
        <form className="panel" onSubmit={(e) => { e.preventDefault(); act(async () => {
          await api("/claims", { method: "POST", body: { statement, category, evidence_url: url || null, evidence_note: note || null } });
          setStatement(""); setUrl(""); setNote("");
        }); }}>
          <h3 style={{ marginTop: 0 }}>Propose a claim</h3>
          <label htmlFor="cs">Statement</label>
          <input id="cs" required minLength={3} value={statement} onChange={(e) => setStatement(e.target.value)} />
          <div className="row">
            <div style={{ flex: 1 }}><label htmlFor="cc">Category</label>
              <select id="cc" value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></div>
            <div style={{ flex: 2 }}><label htmlFor="cu">Evidence URL (https)</label>
              <input id="cu" type="url" value={url} onChange={(e) => setUrl(e.target.value)} /></div>
          </div>
          <label htmlFor="cn">Evidence note</label>
          <input id="cn" value={note} onChange={(e) => setNote(e.target.value)} />
          <div style={{ marginTop: 10 }}><button className="primary" type="submit">Add as draft</button></div>
        </form>
      )}
      <div className="panel table-wrap"><table>
        <thead><tr><th>Status</th><th>Statement</th><th>Evidence</th><th>Verified</th><th /></tr></thead>
        <tbody>{claims?.map((c) => (
          <tr key={c.id}>
            <td><Badge value={c.status} /><div className="small muted">{c.category}</div></td>
            <td>{c.statement}</td>
            <td className="small">{c.evidence_url && <a href={c.evidence_url} target="_blank" rel="noopener noreferrer">link</a>} {c.evidence_note}</td>
            <td className="small">{c.verified_by_name ?? "—"}</td>
            <td className="small">
              {me.hints.canApprove && c.status === "draft" && <>
                <button onClick={() => act(() => api(`/claims/${c.id}/status`, { method: "POST", body: { status: "verified" } }))}>Verify</button>{" "}
                <button onClick={() => act(() => api(`/claims/${c.id}/status`, { method: "POST", body: { status: "rejected" } }))}>Reject</button>
              </>}
              {me.hints.canApprove && c.status === "verified" &&
                <button onClick={() => act(() => api(`/claims/${c.id}/status`, { method: "POST", body: { status: "expired" } }))}>Expire</button>}
            </td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

// ------------------------------------------------------------------ accounts & voices
export function AccountsPage({ me }: { me: Me }) {
  const [accounts, error, reload] = useLoad<Account[]>("/accounts");
  const [voice, setVoice] = useState<{ id: string; markdown: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const toggle = async (a: Account) => {
    setActionError(null);
    try {
      await api("/controls", { method: "POST", body: { key: `account:${a.id}`, stopped: !a.stopped, reason: a.stopped ? "Resumed from accounts page" : "Stopped from accounts page" } });
      reload();
    } catch (e) { setActionError((e as Error).message); }
  };
  return (
    <div>
      <h2>Accounts & voices</h2>
      <ErrorText error={error ?? actionError} />
      {accounts?.map((a) => (
        <div className="panel" key={a.id}>
          <div className="row">
            <strong>{a.display_name}</strong><span className="badge">{a.kind.replace("_", " ")}</span>
            <span className="badge">mode: {a.publishing_mode}</span>
            {a.stopped ? <span className="badge bad">stopped</span> : <span className="badge ok">running</span>}
            <span style={{ flex: 1 }} />
            {((!a.stopped && me.hints.canStop) || (a.stopped && me.hints.canResume)) &&
              <button className={a.stopped ? "" : "danger"} onClick={() => toggle(a)} data-testid={`stop-account-${a.kind}`}>{a.stopped ? "Resume this account" : "Stop this account"}</button>}
          </div>
          <p className="small muted">LinkedIn URN: {a.linkedin_urn ?? "not configured (unverified — Phase 2)"} · approvers: {a.approvers.map((x) => x.display_name).join(", ") || "none"}</p>
          <p className="small">Approved pillars: {a.pillars.join(", ")}</p>
          <button onClick={async () => {
            const r = await api<{ markdown: string }>(`/accounts/${a.id}/voice`);
            setVoice({ id: a.id, markdown: r.markdown });
          }}>View voice profile</button>
          {voice?.id === a.id && <pre>{voice.markdown}</pre>}
        </div>
      ))}
      <p className="small muted">Voice profiles live in <span className="mono">brand/voice/*.md</span> and are owner-controlled (edit them in the repository, not here).</p>
    </div>
  );
}

// ------------------------------------------------------------------ outbox
interface OutboxRow { id: string; content_id: string; status: string; attempts: number; max_attempts: number; available_at: string;
  last_error: string | null; provider_ref: string | null; account_name: string; excerpt: string }

export function OutboxPage({ me }: { me: Me }) {
  const [rows, error, reload] = useLoad<OutboxRow[]>("/outbox");
  const [msg, setMsg] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [recon, setRecon] = useState<{ id: string; ref: string; note: string } | null>(null);
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setActionError(null); setMsg(null);
    try { await fn(); if (ok) setMsg(ok); reload(); } catch (e) { setActionError((e as Error).message); }
  };
  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Publishing outbox</h2>
        <span style={{ flex: 1 }} />
        {me.role === "admin" && (
          <button data-testid="run-publisher" onClick={() => act(async () => {
            const s = await api<{ claimed: number; succeeded: number; released: number }>("/jobs/publisher-tick", { method: "POST" });
            setMsg(`Publisher run: claimed ${s.claimed}, succeeded ${s.succeeded}, released ${s.released}.`);
          })}>Run publisher now</button>
        )}
      </div>
      <p className="muted small">Every external action goes through this outbox. Ambiguous results (e.g. a timeout after sending) are never retried automatically — an admin must reconcile them.</p>
      <ErrorText error={error ?? actionError} />
      {msg && <div className="notice">{msg}</div>}
      <div className="panel table-wrap"><table>
        <thead><tr><th>Status</th><th>Account</th><th>Post</th><th>Attempts</th><th>Next / result</th><th /></tr></thead>
        <tbody>{rows?.map((r) => (
          <tr key={r.id}>
            <td><Badge value={r.status} /></td>
            <td className="small">{r.account_name}</td>
            <td className="small"><a href={`#/content/${r.content_id}`}>{r.excerpt}</a></td>
            <td className="small">{r.attempts}/{r.max_attempts}</td>
            <td className="small">{r.provider_ref ? <span className="mono">{r.provider_ref}</span> : fmt(r.available_at)}{r.last_error && <div className="error">{r.last_error}</div>}</td>
            <td className="small">
              {r.status === "pending" && me.hints.canApprove && <button onClick={() => act(() => api(`/outbox/${r.id}/cancel`, { method: "POST" }), "Cancelled.")}>Cancel</button>}
              {r.status === "needs_reconciliation" && me.hints.canReconcile && <button onClick={() => setRecon({ id: r.id, ref: "", note: "" })}>Reconcile…</button>}
            </td>
          </tr>
        ))}</tbody>
      </table></div>
      {recon && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Reconcile ambiguous publication</h3>
          <p className="small muted">Check the destination (here: the Mock LinkedIn page) and record what actually happened.</p>
          <label>Provider post reference (if it was published)</label>
          <input value={recon.ref} onChange={(e) => setRecon({ ...recon, ref: e.target.value })} />
          <label>Note (required)</label>
          <input value={recon.note} onChange={(e) => setRecon({ ...recon, note: e.target.value })} />
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={() => act(() => api(`/outbox/${recon.id}/reconcile`, { method: "POST", body: { resolution: "confirmed_published", provider_ref: recon.ref, note: recon.note } }).then(() => setRecon(null)), "Marked as published.")}>It was published</button>
            <button onClick={() => act(() => api(`/outbox/${recon.id}/reconcile`, { method: "POST", body: { resolution: "confirmed_not_published", note: recon.note } }).then(() => setRecon(null)), "Re-queued.")}>Not published — re-queue</button>
            <button className="danger" onClick={() => act(() => api(`/outbox/${recon.id}/reconcile`, { method: "POST", body: { resolution: "abandon", note: recon.note } }).then(() => setRecon(null)), "Abandoned.")}>Abandon</button>
            <button onClick={() => setRecon(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ mock posts, audit, capabilities
export function MockPostsPage() {
  const [rows, error] = useLoad<Array<{ id: number; mock_post_urn: string; author: string; commentary: string; visibility: string; received_at: string }>>("/mock/posts");
  return (
    <div>
      <h2>Mock LinkedIn</h2>
      <p className="muted">What the mock provider “received”. Nothing here was sent to LinkedIn.</p>
      <ErrorText error={error} />
      {rows?.length === 0 && <div className="panel muted">No mock posts yet.</div>}
      {rows?.map((r) => (
        <div className="panel preview" key={r.id} data-testid="mock-post">
          <div className="author">{r.author}</div>
          <div className="muted small">{r.visibility} · {fmt(r.received_at)} · <span className="mono">{r.mock_post_urn}</span></div>
          <div className="body">{r.commentary}</div>
        </div>
      ))}
    </div>
  );
}

export function AuditPage() {
  const [rows, error] = useLoad<Array<{ id: number; at: string; actor: string; action: string; subject_type: string; subject_id: string | null; details: unknown }>>("/audit?limit=300");
  return (
    <div>
      <h2>Audit log</h2>
      <p className="muted small">Append-only. Written by the database for every state change.</p>
      <ErrorText error={error} />
      <div className="panel table-wrap"><table>
        <thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Subject</th><th>Details</th></tr></thead>
        <tbody>{rows?.map((r) => (
          <tr key={r.id}>
            <td className="small">{fmt(r.at)}</td><td className="small">{r.action}</td><td className="small mono">{r.actor}</td>
            <td className="small">{r.subject_type}{r.subject_id && <div className="mono">{r.subject_id.slice(0, 18)}</div>}</td>
            <td className="small mono">{JSON.stringify(r.details)}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

export function CapabilitiesPage() {
  const [caps, error] = useLoad<Array<{ id: string; label: string; companyPage: string; founderProfile: string; linkedinProduct: string; notes: string; source: string }>>("/capabilities");
  return (
    <div>
      <h2>LinkedIn capabilities</h2>
      <p className="muted small">“documented” means LinkedIn describes it — not that ActTrident has been granted access. Unverified items must be confirmed before they are relied on.</p>
      <ErrorText error={error} />
      <div className="panel table-wrap"><table>
        <thead><tr><th>Capability</th><th>Company page</th><th>Founder profile</th><th>Notes</th></tr></thead>
        <tbody>{caps?.map((c) => (
          <tr key={c.id}>
            <td>{c.label}<div className="small muted">{c.linkedinProduct}</div></td>
            <td><span className="badge">{c.companyPage.replace(/_/g, " ")}</span></td>
            <td><span className="badge">{c.founderProfile.replace(/_/g, " ")}</span></td>
            <td className="small">{c.notes} <a href={c.source} target="_blank" rel="noopener noreferrer">source</a></td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}
