// P9-04: backup status for the owner (admin only). Read-only: the server backs itself up automatically; the
// weekly USB copy is made with `npm run backup:external` (docs/local-operations.md).
import { fmt } from "./api.ts";
import { ErrorText, useLoad } from "./components.tsx";

interface BackupStatus {
  automatic: {
    enabled: boolean; interval_hours: number; keep: number; count: number;
    newest: { created_at: string; rows: number; migrations: number; bytes: number } | null;
    last_attempt_at: string | null; last_result: "ok" | "failed" | null; last_error: string | null;
  };
  external: { last_copy_at: string; days_since: number; separate_disk: string; due_after_days: number } | null;
  warnings: string[];
}

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function BackupsPage() {
  const [s, error] = useLoad<BackupStatus>("/admin/backups");
  if (error) return <ErrorText error={error} />;
  if (!s) return <p className="muted">Loading…</p>;
  const a = s.automatic;
  return (
    <div>
      <h2>Backups</h2>
      {s.warnings.length > 0
        ? <div className="notice" role="status">{s.warnings.map((w) => <div key={w}>⚠ {w}</div>)}</div>
        : <div className="notice" role="status">✓ Backups are up to date.</div>}

      <section className="panel" aria-labelledby="auto-h">
        <h3 id="auto-h">Automatic backups (on this PC)</h3>
        {a.enabled ? (
          <>
            <p>The server backs up its database every <strong>{a.interval_hours} hours</strong> while it runs, test-restores
              each backup, and keeps the newest <strong>{a.keep}</strong>.</p>
            <dl className="small">
              <dt>Newest backup</dt>
              <dd>{a.newest ? `${fmt(a.newest.created_at)} · ${a.newest.rows.toLocaleString("en-GB")} rows · ${mb(a.newest.bytes)} · restore test passed` : "none yet"}</dd>
              <dt>Backups kept</dt><dd>{a.count}</dd>
              <dt>Last attempt</dt>
              <dd>{a.last_attempt_at ? `${fmt(a.last_attempt_at)} · ${a.last_result === "ok" ? "succeeded" : "failed"}` : "—"}</dd>
            </dl>
          </>
        ) : <p>Automatic backups are switched off for this server.</p>}
        <p className="small muted">These copies are on this PC's own disk. They protect against mistakes and a damaged
          database, not against losing the PC — that is what the USB copy is for.</p>
      </section>

      <section className="panel" aria-labelledby="usb-h">
        <h3 id="usb-h">Copy on a USB drive</h3>
        <p>{s.external
          ? <>Last copy: <strong>{fmt(s.external.last_copy_at)}</strong> ({s.external.days_since === 0 ? "today" : `${s.external.days_since} day(s) ago`}).</>
          : <>No USB copy has been made yet.</>}</p>
        <p className="small">Make one at least every {s.external?.due_after_days ?? 7} days: plug in the drive, then in PowerShell in
          the project folder run <code>npm run backup:external -- --to E:\LBE-backups</code> (use your drive's letter). The
          server can keep running. Then unplug the drive and keep it somewhere safe.</p>
      </section>
    </div>
  );
}
