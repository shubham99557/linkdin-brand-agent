// P9-05: health of the system on this PC (admin only, read-only), and the banner admins see on every page when
// something needs attention. What to do in an emergency: docs/incident-runbook.md.
import { useEffect, useState } from "react";
import { api, fmt } from "./api.ts";
import { ErrorText, useLoad } from "./components.tsx";

type CheckStatus = "ok" | "info" | "warn" | "bad";
interface Health { overall: CheckStatus; checked_at: string; checks: Array<{ id: string; label: string; status: CheckStatus; detail: string; action?: string }> }

const LABEL: Record<CheckStatus, string> = { ok: "OK", info: "Info", warn: "Needs attention", bad: "Problem" };
const BADGE: Record<CheckStatus, string> = { ok: "ok", info: "", warn: "warn", bad: "bad" };

export function SystemPage() {
  const [h, error, reload] = useLoad<Health>("/admin/system");
  if (error) return <ErrorText error={error} />;
  if (!h) return <p className="muted">Loading…</p>;
  return (
    <div>
      <h2>System health</h2>
      <div className="notice" role="status">
        {h.overall === "ok" || h.overall === "info" ? "✓ Everything is working." : h.overall === "warn" ? "⚠ Something needs attention (see below)." : "✖ There is a problem (see below)."}
        {" "}<span className="small muted">Checked {fmt(h.checked_at)}.</span> <button onClick={reload}>Check again</button>
      </div>
      <table>
        <thead><tr><th scope="col">Check</th><th scope="col">Status</th><th scope="col">Details and what to do</th></tr></thead>
        <tbody>
          {h.checks.map((c) => (
            <tr key={c.id} data-testid={`health-${c.id}`}>
              <th scope="row">{c.label}</th>
              <td><span className={`badge ${BADGE[c.status]}`}>{LABEL[c.status]}</span></td>
              <td>{c.detail}{c.action && <div className="small"><strong>What to do:</strong> {c.action}</div>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ConnectorPanel />
      <p className="small muted">In an emergency (lost PC, suspected break-in, wrong post published, leaked key) follow
        <code> docs\incident-runbook.md</code>. Security incidents involving LinkedIn data must be reported to LinkedIn
        within 24 hours.</p>
    </div>
  );
}

/** Shown to admins on every page while any check needs attention. */
export function AttentionBar({ refreshKey }: { refreshKey: number }) {
  const [h, , reload] = useLoad<Health>("/admin/system");
  useEffect(() => { reload(); }, [refreshKey, reload]);
  if (!h || (h.overall !== "warn" && h.overall !== "bad")) return null;
  const n = h.checks.filter((c) => c.status === "warn" || c.status === "bad").length;
  return (
    <div className="notice small" data-testid="attention-bar">
      {h.overall === "bad" ? "✖" : "⚠"} {n} item{n === 1 ? "" : "s"} need{n === 1 ? "s" : ""} attention: {h.checks.filter((c) => c.status === "warn" || c.status === "bad").map((c) => c.label).join(", ")}.{" "}
      <a href="#/system">Open System health</a>
    </div>
  );
}

interface ConnectorStatus {
  enabled: boolean; environment: string | null; key_file_present: boolean; tools: string[];
  bridge: { script: string; claude_desktop_entry: { command: string; args: string[] } } | null;
  keys: Array<{ id: string; user: string; created_at: string; expires_at: string; last_used_at: string }>;
  recent_calls: Array<{ at: string; action: string; details: { tool?: string; entries?: number; count?: number } }>;
}

/** P11-01a: read-only Claude connector (proof of concept). The key is written only to secrets\ on this PC. */
function ConnectorPanel() {
  const [s, error, reload] = useLoad<ConnectorStatus>("/connector/status");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (method: "POST" | "DELETE") => {
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ expires_at?: string; revoked?: number }>("/connector/key", { method });
      setMsg(method === "POST" ? `Key created; valid until ${fmt(r.expires_at)}. Claude Desktop can now read the approved Brand Brain.` : `${r.revoked} key(s) revoked; Claude can no longer read anything.`);
      reload();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  if (error) return <ErrorText error={error} />;
  if (!s) return null;
  const entry = s.bridge ? JSON.stringify({ mcpServers: { "acttrident-brand-brain": s.bridge.claude_desktop_entry } }, null, 2) : "";
  return (
    <section className="panel" aria-labelledby="connector-h">
      <h3 id="connector-h">Claude connector (read-only proof of concept)</h3>
      <p className="small">Lets Claude Desktop on this PC read your <strong>approved</strong> Brand Brain through one tool,
        <code> get_brand_brain</code>. It cannot change, approve or publish anything. Keys last 8 hours.</p>
      {!s.enabled ? <p className="small muted">Switched off on this server (setting <code>LBE_CONNECTOR=on</code> turns it on).</p> : (
        <>
          <p className="small">{s.keys.length ? `Active key: valid until ${fmt(s.keys[0]!.expires_at)}${s.keys[0]!.last_used_at ? `, last used ${fmt(s.keys[0]!.last_used_at)}` : ""}.` : "No active key."}</p>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => void act("POST")}>Create key (8 hours)</button>
            <button disabled={busy || s.keys.length === 0} onClick={() => void act("DELETE")}>Revoke all keys</button>
          </div>
          {msg && <p className="small" role="status">{msg}</p>}
          {s.recent_calls.length > 0 && (
            <details><summary>Recent connector activity</summary>
              <ul className="small">{s.recent_calls.map((c) => <li key={c.at + c.action}>{fmt(c.at)}: {c.action.replace("connector.", "")}{c.details.tool ? ` (${c.details.tool}, ${c.details.entries} entries)` : ""}</li>)}</ul>
            </details>
          )}
          <details><summary>Claude Desktop set-up (no secrets in it)</summary>
            <p className="small">Claude Desktop → Settings → Developer → Edit Config, add this, then quit Claude Desktop completely and reopen it:</p>
            <pre>{entry}</pre>
          </details>
        </>
      )}
    </section>
  );
}