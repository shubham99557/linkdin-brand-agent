// Admin-only user management. Every rule (admin-only, own organization, no self-demotion, sessions ended on
// disable/reset, approver roles) is enforced in the database; this page only presents it.
import { useState } from "react";
import { api, fmt, type Account, type Me, type Role } from "./api.ts";
import { ErrorText, useLoad } from "./components.tsx";

interface ManagedUser {
  id: string; email: string; display_name: string; role: Role; disabled: boolean; locked: boolean; is_me: boolean;
  created_at: string; last_seen_at: string | null; active_sessions: number; running_jobs: number;
  approver_for: Array<{ id: string; display_name: string }>;
}

const ROLES: Array<[Role, string]> = [
  ["admin", "Admin — everything, incl. users, LinkedIn connections, resume STOP"],
  ["approver", "Approver — approves posts for the accounts assigned below"],
  ["editor", "Editor — creates and edits drafts, runs the agent"],
  ["viewer", "Viewer — read only"],
];

function AddUser({ onDone }: { onDone: (msg: string) => void }) {
  const [form, setForm] = useState({ email: "", display_name: "", role: "editor" as Role, password: "" });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <form className="panel" onSubmit={async (e) => {
      e.preventDefault(); setError(null);
      try {
        await api("/users", { method: "POST", body: form });
        onDone(`Added ${form.display_name}. Give them the temporary password in person or by phone — not by email or chat. They must choose their own password when they first sign in.`);
        setForm({ email: "", display_name: "", role: "editor", password: "" });
      } catch (err) { setError((err as Error).message); }
    }}>
      <h3>Add a user</h3>
      <label htmlFor="nu-name">Name</label>
      <input id="nu-name" value={form.display_name} onChange={set("display_name")} required maxLength={120} />
      <label htmlFor="nu-email">Email (used to sign in)</label>
      <input id="nu-email" type="email" value={form.email} onChange={set("email")} required />
      <label htmlFor="nu-role">Role</label>
      <select id="nu-role" value={form.role} onChange={set("role")}>
        {ROLES.map(([r, label]) => <option key={r} value={r}>{label}</option>)}
      </select>
      <label htmlFor="nu-password">Temporary password (12+ characters)</label>
      <input id="nu-password" type="password" autoComplete="new-password" minLength={12} value={form.password} onChange={set("password")} required />
      <ErrorText error={error} />
      <div style={{ marginTop: 8 }}><button className="primary" type="submit">Add user</button></div>
    </form>
  );
}

function UserCard({ u, accounts, onChange, onMessage }: {
  u: ManagedUser; accounts: Account[]; onChange: () => void; onMessage: (m: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [pw, setPw] = useState("");
  const run = async (fn: () => Promise<unknown>, msg: string): Promise<boolean> => {
    setError(null);
    try { await fn(); onMessage(msg); onChange(); return true; } catch (e) { setError((e as Error).message); return false; }
  };
  const canApprove = !u.disabled && (u.role === "approver" || u.role === "admin");
  return (
    <div className="panel" data-testid={`user-${u.email}`}>
      <div className="row">
        <strong>{u.display_name}</strong><span className="muted small">{u.email}</span>
        {u.is_me && <span className="badge">you</span>}
        {u.disabled ? <span className="badge bad">disabled</span> : <span className="badge ok">active</span>}
        {u.locked && <span className="badge warn">locked (too many failed sign-ins)</span>}
        <span style={{ flex: 1 }} />
        <span className="small muted" data-testid="user-activity">last active {fmt(u.last_seen_at)} · {u.active_sessions} open session(s)
          {u.running_jobs > 0 ? ` · ${u.running_jobs} agent run(s) in progress` : ""}</span>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <label htmlFor={`role-${u.id}`} className="small">Role</label>
        <select id={`role-${u.id}`} style={{ maxWidth: 200 }} value={u.role} disabled={u.is_me}
          onChange={(e) => run(() => api(`/users/${u.id}`, { method: "PATCH", body: { role: e.target.value } }), `${u.display_name} is now ${e.target.value}.`)}>
          {ROLES.map(([r]) => <option key={r} value={r}>{r}</option>)}
        </select>
        {!u.is_me && (
          <button className={u.disabled ? "" : "danger"} onClick={() => run(
            () => api(`/users/${u.id}`, { method: "PATCH", body: { disabled: !u.disabled } }),
            u.disabled ? `${u.display_name} can sign in again.` : `${u.display_name} is disabled and signed out everywhere.`)}>
            {u.disabled ? "Enable" : "Disable"}
          </button>
        )}
        {!u.is_me && u.active_sessions > 0 && (
          <button onClick={() => run(() => api(`/users/${u.id}/end-sessions`, { method: "POST" }), `${u.display_name} was signed out everywhere.`)}>
            Sign out everywhere
          </button>
        )}
        {!u.is_me && <button onClick={() => setResetting(!resetting)}>Reset password</button>}
      </div>
      {resetting && (
        <form className="row" style={{ marginTop: 8 }} onSubmit={(e) => {
          e.preventDefault();
          void run(() => api(`/users/${u.id}/reset-password`, { method: "POST", body: { password: pw } }),
            `Password reset for ${u.display_name}; they were signed out. Tell them the temporary password in person or by phone — they must change it when they sign in.`)
            .then((ok) => { if (ok) { setPw(""); setResetting(false); } });
        }}>
          <label htmlFor={`pw-${u.id}`} className="small">New temporary password</label>
          <input id={`pw-${u.id}`} type="password" autoComplete="new-password" minLength={12} style={{ maxWidth: 260 }} value={pw} onChange={(e) => setPw(e.target.value)} required />
          <button type="submit">Set password</button>
        </form>
      )}
      <div className="small" style={{ marginTop: 8 }}>
        <strong>Approves posts for:</strong>{" "}
        {accounts.map((a) => {
          const on = u.approver_for.some((x) => x.id === a.id);
          return (
            <label key={a.id} style={{ display: "inline-flex", gap: 4, marginRight: 12, color: "inherit" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={on} disabled={!on && !canApprove}
                aria-label={`${u.display_name} approves ${a.display_name}`}
                onChange={() => run(() => api(`/users/${u.id}/approver/${a.id}`, { method: "PUT", body: { approver: !on } }),
                  on ? `${u.display_name} no longer approves ${a.display_name}.` : `${u.display_name} now approves ${a.display_name}.`)} />
              {a.display_name}
            </label>
          );
        })}
        {!canApprove && <span className="muted"> (only enabled approvers or admins can approve)</span>}
      </div>
      <ErrorText error={error} />
    </div>
  );
}

export function UsersPage({ me }: { me: Me }) {
  const [users, error, reload] = useLoad<ManagedUser[]>("/users");
  const [accounts] = useLoad<Account[]>("/accounts");
  const [message, setMessage] = useState<string | null>(null);
  if (me.role !== "admin") return <p>Only admins can manage users.</p>;
  return (
    <div>
      <h2>Users</h2>
      <p className="small muted">
        People who can sign in to this organization. Disabling someone or resetting their password signs them out
        everywhere immediately. You can't change your own role or disable yourself — ask another admin.
      </p>
      {message && <div className="notice" role="status">{message}</div>}
      <ErrorText error={error} />
      {users?.map((u) => <UserCard key={u.id} u={u} accounts={accounts ?? []} onChange={reload} onMessage={setMessage} />)}
      <AddUser onDone={(m) => { setMessage(m); reload(); }} />
    </div>
  );
}
