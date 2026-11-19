// P2-02 Guided Brand Brain onboarding for a non-technical owner: one question group at a time, in a sensible
// order, with progress, "skip = UNKNOWN" guidance, and a final proof (claims) step. Saving uses the same
// owner-only endpoints as the Brand Brain page; nothing here bypasses approval rules.
import { useEffect, useState } from "react";
import { api, type Claim, type Me } from "./api.ts";
import { isVisualEntry, PillarsPanel, type Brain, type Entry } from "./agentPages.tsx";
import { ErrorText, useLoad } from "./components.tsx";

const STEP_HELP: Record<string, string> = {
  identity: "Start with the basics: who ActTrident is, in your own words.",
  positioning: "Who it's for and why you're different. Only differences you could prove if asked.",
  icp: "Describe your best customers so the agent writes for the right people.",
  audience_problems: "The problems your buyers have — the agent builds posts around these.",
  product: "What the product does today. Leave out roadmap and anything not yet public.",
  messaging: "The few messages you want repeated. Proof for them goes in the Claims step at the end.",
  voice_company: "How the company page should sound. Example posts help a lot.",
  voice_founder: "How the founder sounds when writing personally, in the first person.",
  pillars: "The themes posts rotate through, per account. Use plain words; they're saved as short ids.",
  pillars_goals: "What LinkedIn should achieve this quarter and why the pillars matter.",
  prohibited: "Words, claims and topics that must never appear. The agent's checks block these.",
  audience_language: "Optional: phrases your buyers really use, and jargon to avoid.",
  communication_rules: "Optional: formatting, hashtags, emoji, length or legal wording rules.",
  claims: "Facts with numbers or strong statements need evidence. Add them here; an approver verifies each one.",
};
const STEP_LABEL: Record<string, string> = { pillars: "Content pillars", claims: "Proof (claims)" };

const stepFromRoute = (route: string) => Number(new URLSearchParams(route.split("?")[1] ?? "").get("step") ?? NaN);
const goStep = (n: number) => { window.location.hash = `/brain/onboarding?step=${n}`; };

export function OnboardingWizard({ me, route }: { me: Me; route: string }) {
  const [brain, error, reload] = useLoad<Brain>("/brain");
  const [msg, setMsg] = useState<string | null>(null);
  if (me.role !== "admin") {
    return <p>Only the owner (admin) can complete the Brand Brain. You can paste documents on the <a href="#/brain">Brand Brain</a> page to create proposals.</p>;
  }
  if (error) return <ErrorText error={error} />;
  if (!brain) return <p className="muted">Loading…</p>;

  const steps = brain.onboarding_steps;
  const meta = (s: string) => brain.sections.find((m) => m.section === s);
  const label = (s: string) => STEP_LABEL[s] ?? meta(s)?.label ?? s;
  const textEntries = brain.entries.filter((e) => !isVisualEntry(e));     // colours/logo don't answer "Brand identity"
  const isDone = (s: string) => s === "pillars" ? brain.accounts.every((a) => a.pillars.length > 0)
    : s === "claims" ? brain.claims.length > 0 : textEntries.some((e) => e.section === s);
  const required = brain.sections.filter((m) => m.required);
  const requiredDone = required.length - brain.missing_sections.length;
  // Default: first step whose section is still missing (resume where you left off).
  const firstOpen = Math.max(0, steps.findIndex((s) => !isDone(s)));
  const fromUrl = stepFromRoute(route);
  const index = Number.isInteger(fromUrl) && fromUrl >= 1 && fromUrl <= steps.length + 1 ? fromUrl - 1 : firstOpen;
  const finished = index === steps.length;
  const step = steps[index];

  const next = () => { setMsg(null); goStep(index + 2); };
  const saved = (text: string) => { setMsg(text); reload(); };

  return (
    <div style={{ maxWidth: 820 }}>
      <h2>Guided setup — {brain.organization.name}</h2>
      <div className="panel" data-testid="onboarding-progress">
        <div className="row"><strong>{finished ? "Review" : `Step ${index + 1} of ${steps.length}: ${label(step!)}`}</strong>
          <span style={{ flex: 1 }} />
          <span className="small">{requiredDone} of {required.length} required sections complete</span></div>
        <div className="progress" aria-hidden="true"><div style={{ width: `${Math.round((requiredDone / Math.max(1, required.length)) * 100)}%` }} /></div>
        <ol className="steps" aria-label="Setup steps">
          {steps.map((s, i) => (
            <li key={s}><a href={`#/brain/onboarding?step=${i + 1}`} className={`${i === index ? "current" : ""} ${isDone(s) ? "done" : ""}`}
              aria-current={i === index ? "step" : undefined}>{isDone(s) ? "✓ " : ""}{label(s)}{meta(s)?.required ? "" : s === "pillars" || s === "claims" ? "" : " (optional)"}</a></li>
          ))}
          <li><a href={`#/brain/onboarding?step=${steps.length + 1}`} className={finished ? "current" : ""}>Review</a></li>
        </ol>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Not sure about something? <strong>Skip it.</strong> Anything left empty stays <strong>UNKNOWN</strong>, and the agent
          will not invent it. Write only facts you could defend publicly, and no customer names or personal data.
        </p>
      </div>
      {msg && <div className="notice" role="status">{msg}</div>}

      {finished ? <ReviewStep brain={brain} label={label} isDone={isDone} />
        : step === "pillars" ? (
          <>
            <p>{STEP_HELP.pillars}</p>
            <PillarsPanel accounts={brain.accounts} isOwner onSaved={(n) => saved(`Saved content pillars for ${n}.`)} />
            <Nav index={index} onNext={next} nextLabel="Next" />
          </>
        ) : step === "claims" ? (
          <ClaimsStep categories={brain.claim_categories} verified={brain.claims.length} onSaved={saved} onNext={next} index={index} />
        ) : (
          <SectionStep key={step} section={step!} help={STEP_HELP[step!] ?? ""} meta={meta(step!)!}
            entries={textEntries.filter((e) => e.section === step)} onSaved={saved} onNext={next} index={index} />
        )}
    </div>
  );
}

function Nav({ index, onNext, nextLabel, children }: { index: number; onNext: () => void; nextLabel: string; children?: React.ReactNode }) {
  return (
    <div className="row" style={{ marginTop: 12 }}>
      {index > 0 && <button type="button" onClick={() => goStep(index)}>← Back</button>}
      <span style={{ flex: 1 }} />
      {children}
      <button type="button" onClick={onNext} data-testid="wizard-next">{nextLabel}</button>
    </div>
  );
}

function SectionStep({ section, help, meta, entries, onSaved, onNext, index }: {
  section: string; help: string; meta: NonNullable<Brain["sections"][number]>; entries: Entry[];
  onSaved: (m: string) => void; onNext: () => void; index: number;
}) {
  const current = entries[0];
  const [body, setBody] = useState(current?.body ?? "");
  const [terms, setTerms] = useState(((current?.structured.terms as string[] | undefined) ?? []).join("\n"));
  const [topics, setTopics] = useState(((current?.structured.topics as string[] | undefined) ?? []).join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setError(null); }, [section]);
  const changed = body.trim() !== (current?.body ?? "").trim() || !!meta.listField;
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const structured = meta.listField
        ? { terms: terms.split("\n").map((s) => s.trim()).filter(Boolean), topics: topics.split("\n").map((s) => s.trim()).filter(Boolean) }
        : undefined;
      await api("/brain/entries", { method: "POST", body: { section, key: current?.key ?? "main", title: current?.title ?? meta.label, body: body.trim(), structured } });
      onSaved(`Saved "${meta.label}"${current ? ` as version ${current.version + 1}` : ""}.`);
      goStep(index + 2);                       // advance but keep the "saved" message visible
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="panel" data-testid={`wizard-step-${section}`}>
      <h3 style={{ marginTop: 0 }}>{meta.label} {meta.required ? <span className="badge">required</span> : <span className="badge">optional</span>}
        {current && <span className="badge ok">approved v{current.version}</span>}</h3>
      <p>{help}</p>
      <p className="small"><strong>Questions to answer:</strong></p>
      <ul className="small">{meta.questions.map((q) => <li key={q}>{q}</li>)}</ul>
      {entries.length > 1 && <p className="small muted">This section has {entries.length} entries; the wizard edits “{current!.title}”. Use the Brand Brain page for the others.</p>}
      <label htmlFor={`wiz-${section}`}>Your answer (saving approves it as brand knowledge)</label>
      <textarea id={`wiz-${section}`} style={{ minHeight: 160 }} value={body} onChange={(e) => setBody(e.target.value)} />
      {meta.listField && <>
        <label htmlFor={`wiz-${section}-terms`}>{meta.listField.label}</label>
        <textarea id={`wiz-${section}-terms`} style={{ minHeight: 70 }} value={terms} onChange={(e) => setTerms(e.target.value)} />
        <label htmlFor={`wiz-${section}-topics`}>Prohibited topics (one per line)</label>
        <textarea id={`wiz-${section}-topics`} style={{ minHeight: 70 }} value={topics} onChange={(e) => setTopics(e.target.value)} />
      </>}
      <ErrorText error={error} />
      <Nav index={index} onNext={onNext} nextLabel={current ? "Next (keep as is)" : "Skip for now (stays UNKNOWN)"}>
        <button type="button" className="primary" disabled={busy || !body.trim() || !changed} onClick={save} data-testid="wizard-save">Approve & continue</button>
      </Nav>
    </div>
  );
}

function ClaimsStep({ categories, verified, onSaved, onNext, index }: {
  categories: string[]; verified: number; onSaved: (m: string) => void; onNext: () => void; index: number;
}) {
  const [claims, , reload] = useLoad<Claim[]>("/claims");
  const [statement, setStatement] = useState("");
  const [category, setCategory] = useState("company_fact");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const drafts = (claims ?? []).filter((c) => c.status === "draft").length;
  return (
    <div className="panel" data-testid="wizard-step-claims">
      <h3 style={{ marginTop: 0 }}>Proof (claims)</h3>
      <p>{STEP_HELP.claims} Posts may only state facts that are in the claims register and verified. Aim for 3–5 to start.</p>
      <p className="small"><strong>{verified}</strong> verified · <strong>{drafts}</strong> waiting for verification · <a href="#/claims">open the Claims register</a></p>
      <form onSubmit={async (e) => {
        e.preventDefault(); setError(null);
        try {
          await api("/claims", { method: "POST", body: { statement, category, evidence_url: url || null, evidence_note: note || null } });
          setStatement(""); setUrl(""); setNote(""); reload();
          onSaved("Claim added as a draft. An approver must verify it in the Claims register before posts can use it.");
        } catch (err) { setError((err as Error).message); }
      }}>
        <label htmlFor="wiz-claim">Claim (one specific, checkable statement)</label>
        <textarea id="wiz-claim" style={{ minHeight: 60 }} value={statement} onChange={(e) => setStatement(e.target.value)} required minLength={3} maxLength={1000} />
        <label htmlFor="wiz-claim-cat">Category</label>
        <select id="wiz-claim-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
          {categories.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}
        </select>
        <label htmlFor="wiz-claim-url">Evidence link (https://…, optional)</label>
        <input id="wiz-claim-url" type="url" pattern="https://.*" value={url} onChange={(e) => setUrl(e.target.value)} />
        <label htmlFor="wiz-claim-note">Evidence note (where the proof is, e.g. "Companies House record")</label>
        <input id="wiz-claim-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        <ErrorText error={error} />
        <div style={{ marginTop: 8 }}><button type="submit">Add claim (draft)</button></div>
      </form>
      <Nav index={index} onNext={onNext} nextLabel="Finish → review" />
    </div>
  );
}

function ReviewStep({ brain, label, isDone }: { brain: Brain; label: (s: string) => string; isDone: (s: string) => boolean }) {
  const missingRequired = brain.missing_sections;
  return (
    <div className="panel" data-testid="wizard-review">
      <h3 style={{ marginTop: 0 }}>{missingRequired.length === 0 ? "Required sections complete" : "Almost there"}</h3>
      {missingRequired.length > 0
        ? <p>Still UNKNOWN (the agent will say so rather than guess): {missingRequired.map((s) => label(s)).join(", ")}. You can come back any time.</p>
        : <p>The agent now has everything it needs to plan and draft. You can refine any section later; each save creates a new version.</p>}
      <ul className="small">
        {brain.onboarding_steps.map((s, i) => (
          <li key={s}>{isDone(s) ? "✓" : "○"} <a href={`#/brain/onboarding?step=${i + 1}`}>{label(s)}</a></li>
        ))}
      </ul>
      {brain.claims.length === 0 && <p className="small">No verified claims yet — posts will avoid specific facts and numbers until an approver verifies some.</p>}
      <div className="row"><a className="btn" href="#/brain">Back to Brand Brain</a>
        <a className="btn primary" href="#/agent">Go to the Agent workspace</a></div>
    </div>
  );
}
