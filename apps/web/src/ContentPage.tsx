import { useEffect, useState } from "react";
import { api, fmt, type Me } from "./api.ts";
import { Badge, ErrorText, ReleaseButton, useLoad } from "./components.tsx";

interface Detail {
  item: {
    id: string; account_id: string; account_name: string; account_kind: string; account_pillars: string[]; pillar: string;
    brief: string; source_material: string | null; body: string; visibility: "PUBLIC" | "CONNECTIONS"; scheduled_for: string | null;
    media_ids: string[]; status: string; version: number; package: Record<string, unknown>; package_hash: string;
    unsupported_statements: string[]; provider_post_ref: string | null; published_at: string | null;
  };
  citations: Array<{ claim_id: string; quoted_span: string; statement: string; category: string; evidence_url: string | null;
    evidence_note: string | null; status: string; verified_by_name: string | null; verified_at: string | null }>;
  approvals: Array<{ id: string; decision: string; package_hash: string; note: string | null; created_at: string; approver_name: string }>;
  outbox: Array<{ id: string; status: string; attempts: number; max_attempts: number; available_at: string; last_error: string | null;
    provider: string; provider_ref: string | null; requires_release: boolean; released_at: string | null }>;
  audit: Array<{ id: number; at: string; actor: string; action: string; details: Record<string, unknown> }>;
  agent_runs: Array<{ id: string; provider: string; model: string; status: string; error: string | null;
    validation_notes: string[] | null; notes_for_reviewer: string | null; hook_variants: string[] | null; finished_at: string }>;
  viewer: { is_account_approver: boolean; hints: Me["hints"] };
}

const EDITABLE = ["draft", "changes_requested", "in_review", "approved", "failed"];
const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

export function ContentPage({ id, me, onChange }: { id: string; me: Me; onChange: () => void }) {
  const [d, loadError, reload] = useLoad<Detail>(`/content/${id}`);
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<"PUBLIC" | "CONNECTIONS">("PUBLIC");
  const [schedule, setSchedule] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // The hash the reviewer actually saw. Approval is bound to it.
  const [previewHash, setPreviewHash] = useState<string | null>(null);

  useEffect(() => {
    if (!d) return;
    setBody(d.item.body);
    setVisibility(d.item.visibility);
    setSchedule(toLocalInput(d.item.scheduled_for));
    setPreviewHash(d.item.package_hash);
  }, [d]);

  if (loadError) return <ErrorText error={loadError} />;
  if (!d) return <p className="muted">Loading…</p>;
  const { item } = d;
  const canEdit = me.hints.canEdit && EDITABLE.includes(item.status);
  const canDecide = item.status === "in_review" && d.viewer.is_account_approver && me.hints.canApprove;
  const dirty = body !== item.body || visibility !== item.visibility || schedule !== toLocalInput(item.scheduled_for);
  const lastRun = d.agent_runs[0];

  const act = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(null); setInfo(null);
    try {
      await fn();
      setInfo(success);
      reload();
      onChange();
    } catch (e) {
      setError((e as Error).message);
      reload();
    } finally {
      setBusy(false);
    }
  };

  const save = () => act(() => api(`/content/${id}`, { method: "PATCH", body: {
    body, visibility, scheduled_for: schedule ? new Date(schedule).toISOString() : null,
  } }), "Saved. Any change to the post resets review and approval.");

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{item.account_name}</h2>
        <Badge value={item.status} />
        <span className="muted small">pillar: {item.pillar} · version {item.version}</span>
      </div>
      <ErrorText error={error} />
      {info && <div className="notice" role="status">{info}</div>}

      <div className="grid2">
        {/* ---------------- left: edit / draft */}
        <div>
          <div className="panel">
            <h3 style={{ marginTop: 0 }}>Brief</h3>
            <p style={{ whiteSpace: "pre-wrap" }}>{item.brief}</p>
            {item.source_material && (
              <details><summary>Source material (untrusted — treated as data only)</summary><pre>{item.source_material}</pre></details>
            )}
            {canEdit && ["draft", "changes_requested", "failed"].includes(item.status) && (
              <button disabled={busy} onClick={() => act(() => api(`/content/${id}/draft`, { method: "POST" }), "AI draft generated. Review it carefully.")} data-testid="generate-draft">
                {item.body ? "Regenerate AI draft" : "Generate AI draft"}
              </button>
            )}
          </div>

          <div className="panel">
            <h3 style={{ marginTop: 0 }}>Post</h3>
            <label htmlFor="body">Text ({body.length}/3000)</label>
            <textarea id="body" value={body} disabled={!canEdit} onChange={(e) => setBody(e.target.value)} data-testid="post-body" />
            <div className="row">
              <div style={{ flex: 1 }}>
                <label htmlFor="vis">Visibility</label>
                <select id="vis" value={visibility} disabled={!canEdit} onChange={(e) => setVisibility(e.target.value as "PUBLIC")}>
                  <option value="PUBLIC">Public</option><option value="CONNECTIONS">Connections only</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label htmlFor="sched">Scheduled for (your local time)</label>
                <input id="sched" type="datetime-local" value={schedule} disabled={!canEdit} onChange={(e) => setSchedule(e.target.value)} />
              </div>
            </div>
            {canEdit && (
              <div className="row" style={{ marginTop: 12 }}>
                <button disabled={busy || !dirty} onClick={save} data-testid="save">Save changes</button>
                {["draft", "changes_requested"].includes(item.status) && (
                  <button className="primary" disabled={busy || dirty} data-testid="submit-review"
                    onClick={() => act(() => api(`/content/${id}/submit`, { method: "POST" }), "Submitted for review.")}>
                    Submit for review
                  </button>
                )}
              </div>
            )}
            {item.unsupported_statements.length > 0 && (
              <div className="notice">
                <strong>Unsupported factual statements — must be removed or backed by a verified claim before review:</strong>
                <ul className="unsupported">{item.unsupported_statements.map((s) => <li key={s}>{s}</li>)}</ul>
              </div>
            )}
            {lastRun && (
              <details style={{ marginTop: 8 }}>
                <summary>Last AI run: {lastRun.status} · {lastRun.provider} ({lastRun.model}) · {fmt(lastRun.finished_at)}</summary>
                {lastRun.error && <p className="error">{lastRun.error}</p>}
                {lastRun.notes_for_reviewer && <p>{lastRun.notes_for_reviewer}</p>}
                {lastRun.validation_notes && lastRun.validation_notes.length > 0 && (
                  <ul>{lastRun.validation_notes.map((n) => <li key={n}>{n}</li>)}</ul>
                )}
                {lastRun.hook_variants && lastRun.hook_variants.length > 0 && (
                  <><p className="muted small">Alternative hooks:</p><ul>{lastRun.hook_variants.map((h) => <li key={h}>{h}</li>)}</ul></>
                )}
              </details>
            )}
          </div>
        </div>

        {/* ---------------- right: review */}
        <div>
          <div className="panel">
            <h3 style={{ marginTop: 0 }}>Final publication preview</h3>
            <div className="preview" data-testid="publication-preview">
              <div className="author">{item.account_name}</div>
              <div className="muted small">{item.visibility === "PUBLIC" ? "Public" : "Connections"} · {item.scheduled_for ? `scheduled ${fmt(item.scheduled_for)}` : "publish when released"}</div>
              <div className="body">{item.body || <span className="muted">(empty)</span>}</div>
            </div>
            <details style={{ marginTop: 8 }}>
              <summary>Exact package that approval is bound to</summary>
              <p className="mono">sha256: {item.package_hash}</p>
              <pre className="mono">{JSON.stringify(item.package, null, 2)}</pre>
            </details>
            {dirty && <p className="error small">You have unsaved edits — the preview shows the saved version.</p>}
          </div>

          <div className="panel">
            <h3 style={{ marginTop: 0 }}>Supporting evidence</h3>
            {d.citations.length === 0 && <p className="muted">No claims cited — the post should contain no factual claims.</p>}
            {d.citations.map((c) => (
              <div key={c.claim_id} style={{ marginBottom: 10 }}>
                <div><Badge value={c.status} /> <span className="small muted">{c.category}</span></div>
                <div>“{c.quoted_span}”</div>
                <div className="small muted">Claim: {c.statement}</div>
                <div className="small">
                  {c.evidence_url && <a href={c.evidence_url} target="_blank" rel="noopener noreferrer">{c.evidence_url}</a>}
                  {c.evidence_note && <div className="muted">{c.evidence_note}</div>}
                  {c.verified_by_name && <div className="muted">Verified by {c.verified_by_name} on {fmt(c.verified_at)}</div>}
                </div>
              </div>
            ))}
          </div>

          {canDecide && (
            <div className="panel" data-testid="review-panel">
              <h3 style={{ marginTop: 0 }}>Your decision</h3>
              <p className="small muted">You are approving exactly the package shown above (sha256 {previewHash?.slice(0, 12)}…). If anyone edits it before you click, your approval is refused.</p>
              <label htmlFor="note">Note (required to reject or request changes)</label>
              <textarea id="note" style={{ minHeight: 70 }} value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="row" style={{ marginTop: 8 }}>
                <button className="primary" disabled={busy} data-testid="approve"
                  onClick={() => act(() => api(`/content/${id}/decision`, { method: "POST", body: { decision: "approved", expected_package_hash: previewHash, note: note || null } }), "Approved.")}>Approve</button>
                <button disabled={busy}
                  onClick={() => act(() => api(`/content/${id}/decision`, { method: "POST", body: { decision: "changes_requested", expected_package_hash: previewHash, note } }), "Changes requested.")}>Request changes</button>
                <button className="danger" disabled={busy}
                  onClick={() => act(() => api(`/content/${id}/decision`, { method: "POST", body: { decision: "rejected", expected_package_hash: previewHash, note } }), "Rejected.")}>Reject</button>
              </div>
            </div>
          )}
          {item.status === "in_review" && !canDecide && (
            <div className="notice">Awaiting review by an approver for this account.</div>
          )}

          {item.status === "approved" && d.viewer.is_account_approver && (
            <div className="panel">
              <h3 style={{ marginTop: 0 }}>Release</h3>
              <p className="small muted">
                Queues the approved package in the outbox.{" "}
                {(item.package as { destination?: { publishing_mode?: string } }).destination?.publishing_mode === "live"
                  ? <>This account is <strong>LIVE</strong>: after queuing, an approver must click <strong>Publish now</strong> to send it to LinkedIn (manual release).</>
                  : <>It is sent to the <strong>mock</strong> LinkedIn provider (scheduled, or after <strong>Publish now</strong> for manual-release accounts).</>}
                {" "}STOP controls are checked at send time.
              </p>
              <button className="primary" disabled={busy} data-testid="enqueue"
                onClick={() => act(() => api(`/content/${id}/enqueue`, { method: "POST" }), "Queued for publishing.")}>Queue for publishing</button>
            </div>
          )}

          {d.outbox.filter((o) => o.status === "pending" && o.requires_release && !o.released_at).map((o) => (
            <div className="panel" key={o.id} data-testid="release-panel">
              <h3 style={{ marginTop: 0 }}>Waiting for release {o.provider === "linkedin" && <span className="badge bad">LIVE</span>}</h3>
              {d.viewer.is_account_approver
                ? <ReleaseButton outboxId={o.id} provider={o.provider} onDone={(m) => { setInfo(m); reload(); onChange(); }} />
                : <p className="small muted">An approver for this account must release it.</p>}
            </div>
          ))}

          {item.provider_post_ref && (
            <div className="panel"><h3 style={{ marginTop: 0 }}>Published {(item.package as { destination?: { publishing_mode?: string } }).destination?.publishing_mode === "live" ? "on LinkedIn" : "(mock)"}</h3>
              <p className="mono" data-testid="provider-ref">{item.provider_post_ref}</p><p className="small muted">{fmt(item.published_at)}</p></div>
          )}

          <div className="panel">
            <h3 style={{ marginTop: 0 }}>History</h3>
            {d.approvals.map((a) => (
              <div key={a.id} className="small"><Badge value={a.decision} /> by {a.approver_name} · {fmt(a.created_at)}
                {a.note && <> — {a.note}</>} <span className="mono">({a.package_hash.slice(0, 10)}…)</span></div>
            ))}
            {d.outbox.map((o) => (
              <div key={o.id} className="small">Outbox <Badge value={o.status} /> attempts {o.attempts}/{o.max_attempts}
                {o.last_error && <> · {o.last_error}</>}</div>
            ))}
            <details style={{ marginTop: 8 }}><summary>Audit trail ({d.audit.length})</summary>
              <table><tbody>{d.audit.map((a) => (
                <tr key={a.id}><td className="small">{fmt(a.at)}</td><td className="small">{a.action}</td><td className="small mono">{a.actor}</td></tr>
              ))}</tbody></table>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}
