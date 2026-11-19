import { useState } from "react";
import { api } from "./api.ts";
import { ErrorText } from "./components.tsx";

/** Change your own password. `forced` = first sign-in with an admin-issued temporary password. */
export function PasswordPage({ forced, onDone }: { forced: boolean; onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <form className={`panel${forced ? " login" : ""}`} onSubmit={async (e) => {
      e.preventDefault(); setError(null); setDone(null);
      if (next !== repeat) { setError("the new passwords don't match"); return; }
      try {
        const r = await api<{ other_sessions_ended: number }>("/auth/change-password", { method: "POST", body: { current_password: current, new_password: next } });
        setCurrent(""); setNext(""); setRepeat("");
        setDone(`Password changed.${r.other_sessions_ended ? ` ${r.other_sessions_ended} other session(s) were signed out.` : ""}`);
        onDone();
      } catch (err) { setError((err as Error).message); }
    }}>
      <h2>{forced ? "Choose your own password" : "Change password"}</h2>
      {forced && <p className="small">You signed in with a temporary password from an admin. Choose a new one before continuing.</p>}
      <p className="small muted">At least 12 characters. A short sentence you'll remember works well. Don't reuse a password from another site.</p>
      <label htmlFor="pw-current">{forced ? "Temporary password" : "Current password"}</label>
      <input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      <label htmlFor="pw-new">New password</label>
      <input id="pw-new" type="password" autoComplete="new-password" minLength={12} value={next} onChange={(e) => setNext(e.target.value)} required />
      <label htmlFor="pw-repeat">Repeat new password</label>
      <input id="pw-repeat" type="password" autoComplete="new-password" minLength={12} value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
      <ErrorText error={error} />
      {done && <p className="small" role="status">{done}</p>}
      <div style={{ marginTop: 12 }}><button className="primary" type="submit">Change password</button></div>
    </form>
  );
}
