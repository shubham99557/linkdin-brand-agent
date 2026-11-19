import { useEffect, useState } from "react";
import { api, ApiError, type Me } from "./api.ts";
import { ErrorText, StopBar } from "./components.tsx";
import { ContentPage } from "./ContentPage.tsx";
import { AccountsPage, AuditPage, CalendarPage, CapabilitiesPage, ClaimsPage, MockPostsPage, NewContentPage, OutboxPage } from "./pages.tsx";

function useHashRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || "/");
  useEffect(() => {
    const on = () => setRoute(window.location.hash.slice(1) || "/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const go = (path: string) => { window.location.hash = path; };

const NAV: Array<[string, string]> = [
  ["/", "Content calendar"], ["/new", "New post"], ["/claims", "Claims register"], ["/accounts", "Accounts & voices"],
  ["/outbox", "Publishing outbox"], ["/mock", "Mock LinkedIn"], ["/audit", "Audit log"], ["/capabilities", "LinkedIn capabilities"],
];

function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="panel login" onSubmit={async (e) => {
      e.preventDefault();
      setError(null);
      try {
        await api("/auth/login", { method: "POST", body: { email, password } });
        onLogin();
      } catch (err) {
        setError((err as Error).message);
      }
    }}>
      <h2>LinkedIn Brand Engine</h2>
      <p className="muted small">Phase 1 · development build · mock publishing only</p>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <label htmlFor="password">Password</label>
      <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      <ErrorText error={error} />
      <div style={{ marginTop: 12 }}><button className="primary" type="submit">Sign in</button></div>
    </form>
  );
}

export function App() {
  const route = useHashRoute();
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadMe = () => {
    api<Me>("/me").then(setMe).catch((e) => {
      if (!(e instanceof ApiError && e.status === 401)) console.error(e);
      setMe(null);
    }).finally(() => setChecked(true));
  };
  useEffect(loadMe, []);
  useEffect(() => setRefreshKey((k) => k + 1), [route]);

  if (!checked) return null;
  if (!me) return <Login onLogin={loadMe} />;

  const contentMatch = route.match(/^\/content\/([0-9a-f-]{36})$/);
  let page;
  if (contentMatch) page = <ContentPage id={contentMatch[1]!} me={me} onChange={() => setRefreshKey((k) => k + 1)} />;
  else if (route === "/new") page = <NewContentPage />;
  else if (route === "/claims") page = <ClaimsPage me={me} />;
  else if (route === "/accounts") page = <AccountsPage me={me} />;
  else if (route === "/outbox") page = <OutboxPage me={me} />;
  else if (route === "/mock") page = <MockPostsPage />;
  else if (route === "/audit") page = <AuditPage />;
  else if (route === "/capabilities") page = <CapabilitiesPage />;
  else page = <CalendarPage />;

  return (
    <div className="shell">
      <nav className="side" aria-label="Main">
        <h1>LinkedIn Brand Engine</h1>
        <div className="sub">Phase 1 · mock publishing</div>
        {NAV.map(([href, label]) => (
          <a key={href} href={`#${href}`} className={route === href ? "active" : ""}>{label}</a>
        ))}
        <div className="who">
          Signed in as <strong>{me.display_name}</strong><br />{me.email} · {me.role}
          <div style={{ marginTop: 8 }}>
            <button onClick={async () => { await api("/auth/logout", { method: "POST" }); setMe(null); }}>Sign out</button>
          </div>
        </div>
      </nav>
      <main>
        <StopBar me={me} refreshKey={refreshKey} />
        {page}
      </main>
    </div>
  );
}
