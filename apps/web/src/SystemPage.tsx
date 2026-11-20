// P9-05: health of the system on this PC (admin only, read-only), and the banner admins see on every page when
// something needs attention. What to do in an emergency: docs/incident-runbook.md.
import { useEffect } from "react";
import { fmt } from "./api.ts";
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
