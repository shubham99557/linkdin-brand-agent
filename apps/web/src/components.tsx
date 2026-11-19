import { useCallback, useEffect, useState } from "react";
import { api, daysUntil, type Account, type ControlFlag, type Health, type Me } from "./api.ts";

const TONE: Record<string, string> = {
  published: "ok", approved: "ok", succeeded: "ok", verified: "ok",
  in_review: "warn", queued: "warn", pending: "warn", dispatching: "warn", changes_requested: "warn", draft: "",
  rejected: "bad", failed: "bad", needs_reconciliation: "bad", expired: "bad", cancelled: "",
};

export function Badge({ value }: { value: string }) {
  return <span className={`badge ${TONE[value] ?? ""}`} data-testid="status-badge">{value.replace(/_/g, " ")}</span>;
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? <div className="error" role="alert">{error}</div> : null;
}

/** Load data; returns [data, error, reload]. */
export function useLoad<T>(path: string): [T | null, string | null, () => void] {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<T>(path).then((d) => { setData(d); setError(null); }).catch((e: Error) => setError(e.message));
  }, [path]);
  useEffect(load, [load]);
  return [data, error, load];
}

/** Global STOP banner + controls, shown on every page. */
export function StopBar({ me, refreshKey }: { me: Me; refreshKey: number }) {
  const [flags, error, reload] = useLoad<ControlFlag[]>("/controls");
  const [health] = useLoad<Health>("/health");
  const [accounts, , reloadAccounts] = useLoad<Account[]>("/accounts");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => { reload(); reloadAccounts(); }, [refreshKey, reload, reloadAccounts]);
  const credentialWarnings = (accounts ?? []).filter((a) => a.credential && (a.credential.status !== "valid" || daysUntil(a.credential.expires_at) <= 14))
    .map((a) => a.credential!.status !== "valid"
      ? `${a.display_name}: LinkedIn connection ${a.credential!.status} — reconnect`
      : `${a.display_name}: LinkedIn connection expires in ${daysUntil(a.credential!.expires_at)} day(s) — reconnect soon`);
  const liveAccounts = (accounts ?? []).filter((a) => a.publishing_mode === "live");
  // "Stop all publishing" = the caller's organization. The platform flag is operator-only (shown, not editable).
  const global = flags?.find((f) => f.scope === "organization");
  const platform = flags?.find((f) => f.scope === "platform");
  const stoppedAccounts = flags?.filter((f) => f.scope === "account" && f.stopped) ?? [];

  const set = async (stopped: boolean) => {
    setBusy(true);
    setActionError(null);
    try {
      await api("/controls", { method: "POST", body: { key: "organization", stopped, reason: reason || (stopped ? "Stopped from dashboard" : "Resumed from dashboard") } });
      setReason("");
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorText error={error} />;
  if (!global) return null;
  const runningText = health?.live_publishing && liveAccounts.length > 0
    ? `Publishing: running — LIVE LinkedIn for ${liveAccounts.map((a) => a.display_name).join(", ")} (manual release)`
    : "Publishing: running (mock provider only)";
  return (
    <>
    {health?.live_publishing && <div className="stopbar" data-testid="live-banner"><strong>LIVE LinkedIn publishing is enabled on this server.</strong> Released posts become public on LinkedIn.</div>}
    {credentialWarnings.map((w) => <div className="notice" key={w}>⚠ {w}</div>)}
    {platform?.stopped && <div className="stopbar"><strong>⛔ Platform-wide STOP (operator):</strong> {platform.reason}. Nothing is sent for any organization until an operator lifts it.</div>}
    <div className={global.stopped ? "stopbar" : "panel"} data-testid="stop-bar">
      <div className="row">
        <strong>{global.stopped ? "⛔ ALL PUBLISHING STOPPED" : runningText}</strong>
        {global.stopped && <span className="muted small">Reason: {global.reason} · by {global.changed_by_name ?? "system"}</span>}
        {stoppedAccounts.length > 0 && (
          <span className="badge bad">{stoppedAccounts.length} account(s) stopped</span>
        )}
        <span style={{ flex: 1 }} />
        <input style={{ maxWidth: 240 }} placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
        {!global.stopped && me.hints.canStop && (
          <button className="danger" disabled={busy} onClick={() => set(true)} data-testid="stop-all">Stop all publishing</button>
        )}
        {global.stopped && me.hints.canResume && (
          <button disabled={busy} onClick={() => set(false)} data-testid="resume-all">Resume publishing</button>
        )}
      </div>
      <ErrorText error={actionError} />
    </div>
    </>
  );
}

/** Rendered preview of a draft's visual (P5-02): one thumbnail per slide, plus the PDF for carousels. */
export function VisualPreview({ contentId, brief, version = 0 }: {
  contentId: string; brief: { format: string; slides: unknown[] } | null | undefined; version?: number;
}) {
  if (!brief || brief.format === "text_only") return null;
  const count = brief.format === "single_image" ? 1 : 1 + Math.min(brief.slides.length, 9);
  return (
    <div data-testid="visual-preview">
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        {Array.from({ length: count }, (_, i) => (
          <a key={i} href={`/api/content/${contentId}/visual?slide=${i + 1}&v=${version}`} target="_blank" rel="noreferrer">
            <img src={`/api/content/${contentId}/visual?slide=${i + 1}&v=${version}`} alt={`Visual slide ${i + 1}`} loading="lazy"
              style={{ width: 120, height: brief.format === "single_image" ? 120 : 150, objectFit: "cover", borderRadius: 4, border: "1px solid var(--border)" }} />
          </a>
        ))}
      </div>
      {brief.format === "document_carousel" && (
        <p className="small"><a href={`/api/content/${contentId}/visual?format=pdf&v=${version}`} target="_blank" rel="noreferrer">Open the PDF carousel</a></p>
      )}
      <p className="small muted">Preview only, in your saved brand colours (set them in Brand Brain → Visual identity). Visuals are not yet part of what gets approved and published (that comes next).</p>
    </div>
  );
}

/** "Publish now" for a pending outbox entry that needs manual release. Live jobs need an explicit confirmation. */
export function ReleaseButton({ outboxId, provider, onDone }: { outboxId: string; provider: string; onDone: (msg: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = provider === "linkedin";
  return (
    <div>
      {live && (
        <label style={{ display: "flex", gap: 6, alignItems: "center", color: "inherit" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={confirm} onChange={(e) => setConfirm(e.target.checked)} data-testid="confirm-public" />
          I confirm this will be posted publicly on LinkedIn now
        </label>
      )}
      <button className="primary" disabled={busy || (live && !confirm)} data-testid="publish-now" onClick={async () => {
        setBusy(true); setError(null);
        try {
          await api(`/outbox/${outboxId}/release`, { method: "POST", body: live ? { confirm_public_post: true } : {} });
          onDone(live ? "Released — it will be sent to LinkedIn on the next publisher run." : "Released — it will be sent to the mock on the next publisher run.");
        } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
      }}>Publish now</button>
      <ErrorText error={error} />
    </div>
  );
}
