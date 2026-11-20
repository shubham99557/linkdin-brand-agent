import { useEffect, useState } from "react";
import { api, ApiError, setSessionEndedHandler, type Me } from "./api.ts";
import { ErrorText, StopBar } from "./components.tsx";
import { ContentPage } from "./ContentPage.tsx";
import { AgentPage, BrandBrainPage, CampaignPage, JobPage, WorkflowPage } from "./agentPages.tsx";
import { UsersPage } from "./UsersPage.tsx";
import { BackupsPage } from "./BackupsPage.tsx";
import { AttentionBar, SystemPage } from "./SystemPage.tsx";
import { PasswordPage } from "./PasswordPage.tsx";
import { OnboardingWizard } from "./OnboardingWizard.tsx";
import { AccountsPage, AuditPage, CalendarPage, CapabilitiesPage, ClaimsPage, MockPostsPage, NewContentPage, OAuthCompletePage, OutboxPage } from "./pages.tsx";

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
  ["/agent", "Agent workspace"], ["/brain", "Brand Brain"],
  ["/", "Content calendar"], ["/new", "New post"], ["/claims", "Claims register"], ["/accounts", "Accounts & voices"],
  ["/outbox", "Publishing outbox"], ["/mock", "Mock LinkedIn"], ["/audit", "Audit log"], ["/capabilities", "LinkedIn capabilities"],
];

function Login({ onLogin, notice }: { onLogin: () => void; notice?: string | null }) {
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
      {notice && <p className="small" role="status">{notice}</p>}
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
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => setSessionEndedHandler(() => {
    setMe(null);
    setNotice("Your session ended (inactive for 60 minutes or signed out elsewhere). Please sign in again.");
  }), []);

  const loadMe = () => {
    setNotice(null);
    api<Me>("/me").then(setMe).catch((e) => {
      if (!(e instanceof ApiError && e.status === 401)) console.error(e);
      setMe(null);
    }).finally(() => setChecked(true));
  };
  useEffect(loadMe, []);
  useEffect(() => setRefreshKey((k) => k + 1), [route]);

  if (!checked) return null;
  if (!me) return <Login onLogin={loadMe} notice={notice} />;
  // Temporary password: nothing else is available until the user picks their own (also enforced in the database).
  if (me.must_change_password) {
    return (
      <div>
        <PasswordPage forced onDone={loadMe} />
        <p className="small" style={{ textAlign: "center" }}>
          <button onClick={async () => { await api("/auth/logout", { method: "POST" }); setMe(null); }}>Sign out</button>
        </p>
      </div>
    );
  }

  const contentMatch = route.match(/^\/content\/([0-9a-f-]{36})$/);
  const workflowMatch = route.match(/^\/agent\/([0-9a-f-]{36})$/);
  const jobMatch = route.match(/^\/agent\/job\/([0-9a-f-]{36})(\?new=1)?$/);
  const campaignMatch = route.match(/^\/agent\/campaign\/([0-9a-f-]{36})$/);
  let page;
  if (contentMatch) page = <ContentPage id={contentMatch[1]!} me={me} onChange={() => setRefreshKey((k) => k + 1)} />;
  else if (workflowMatch) page = <WorkflowPage id={workflowMatch[1]!} me={me} />;
  else if (campaignMatch) page = <CampaignPage key={campaignMatch[1]} id={campaignMatch[1]!} />;
  else if (jobMatch) page = <JobPage key={jobMatch[1]} id={jobMatch[1]!} fresh={!!jobMatch[2]} />;
  else if (route === "/agent") page = <AgentPage me={me} />;
  else if (route === "/brain") page = <BrandBrainPage me={me} />;
  else if (route.startsWith("/brain/onboarding")) page = <OnboardingWizard me={me} route={route} />;
  else if (route.startsWith("/oauth/complete")) page = <OAuthCompletePage query={route.split("?")[1] ?? ""} />;
  else if (route === "/new") page = <NewContentPage />;
  else if (route === "/claims") page = <ClaimsPage me={me} />;
  else if (route === "/accounts") page = <AccountsPage me={me} />;
  else if (route === "/outbox") page = <OutboxPage me={me} />;
  else if (route === "/mock") page = <MockPostsPage />;
  else if (route === "/audit") page = <AuditPage />;
  else if (route === "/capabilities") page = <CapabilitiesPage />;
  else if (route === "/users") page = <UsersPage me={me} />;
  else if (route === "/backups" && me.role === "admin") page = <BackupsPage />;
  else if (route === "/system" && me.role === "admin") page = <SystemPage />;
  else if (route === "/password") page = <PasswordPage forced={false} onDone={() => undefined} />;
  else page = <CalendarPage />;

  return (
    <div className="shell">
      {/* Keyboard users can jump past the navigation (a plain #anchor would clash with the hash router). */}
      <a href="#main-content" className="skip-link" onClick={(e) => { e.preventDefault(); document.getElementById("main-content")?.focus(); }}>
        Skip to main content
      </a>
      <nav className="side" aria-label="Main">
        <h1>LinkedIn Brand Engine</h1>
        <div className="sub">Phase 1 · mock publishing</div>
        {[...NAV, ...(me.role === "admin" ? [["/users", "Users"], ["/system", "System health"], ["/backups", "Backups"]] as Array<[string, string]> : [])].map(([href, label]) => (
          <a key={href} href={`#${href}`} className={route === href ? "active" : ""}>{label}</a>
        ))}
        <div className="who">
          Signed in as <strong>{me.display_name}</strong><br />{me.email} · {me.role}<br />
          <a href="#/password" className="small">Change password</a>
          <div style={{ marginTop: 8 }}>
            <button onClick={async () => { await api("/auth/logout", { method: "POST" }); setMe(null); }}>Sign out</button>{" "}
            <button title="Ends your sessions in every browser and device" onClick={async () => {
              await api("/auth/logout-all", { method: "POST" }); setMe(null); setNotice("Signed out on all devices.");
            }}>Sign out everywhere</button>
          </div>
        </div>
      </nav>
      <main id="main-content" tabIndex={-1}>
        <StopBar me={me} refreshKey={refreshKey} />
        {me.role === "admin" && route !== "/system" && <AttentionBar refreshKey={refreshKey} />}
        {page}
      </main>
    </div>
  );
}
