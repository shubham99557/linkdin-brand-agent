import { useCallback, useEffect, useState } from "react";
import { api, type ControlFlag, type Me } from "./api.ts";

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
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(reload, [refreshKey, reload]);
  const global = flags?.find((f) => f.key === "global");
  const stoppedAccounts = flags?.filter((f) => f.key !== "global" && f.stopped) ?? [];

  const set = async (stopped: boolean) => {
    setBusy(true);
    setActionError(null);
    try {
      await api("/controls", { method: "POST", body: { key: "global", stopped, reason: reason || (stopped ? "Stopped from dashboard" : "Resumed from dashboard") } });
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
  return (
    <div className={global.stopped ? "stopbar" : "panel"} data-testid="stop-bar">
      <div className="row">
        <strong>{global.stopped ? "⛔ ALL PUBLISHING STOPPED" : "Publishing: running (mock provider only)"}</strong>
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
  );
}
