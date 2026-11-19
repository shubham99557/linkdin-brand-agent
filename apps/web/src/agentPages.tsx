import { useEffect, useRef, useState } from "react";
import { api, fmt, type Me } from "./api.ts";
import { Badge, ErrorText, useLoad } from "./components.tsx";

// ------------------------------------------------------------------ types
export interface SectionMeta { section: string; label: string; required: boolean; questions: string[]; listField?: { key: string; label: string } }
export interface Entry { id: string; section: string; key: string; title: string; body: string; structured: Record<string, unknown>; version: number; source: string; source_ref: string | null; approved_at: string }
export interface Brain {
  organization: { name: string }; entries: Entry[]; missing_sections: string[]; sections: SectionMeta[]; pending_proposals: number;
  onboarding_steps: string[]; claim_categories: string[];
  accounts: Array<{ id: string; kind: string; display_name: string; pillars: string[] }>; claims: Array<{ id: string; statement: string }>;
}
interface Proposal {
  id: string; section: string; key: string; title: string; body: string; rationale: string; proposer: string; status: string;
  evidence: Array<{ type: string; quote?: string; source?: string; id?: string }>; conflicts_with: string | null; current_body: string | null; created_at: string;
}
interface WorkflowSummary { id: string; goal: string; status: string; created_at: string; finished_at: string | null; drafts: number }

const go = (path: string) => { window.location.hash = path; };

// ------------------------------------------------------------------ Brand Brain
export function BrandBrainPage({ me }: { me: Me }) {
  const [brain, error, reload] = useLoad<Brain>("/brain");
  const [msg, setMsg] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const isOwner = me.role === "admin";
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setActionError(null); setMsg(null);
    try { await fn(); setMsg(ok); reload(); } catch (e) { setActionError((e as Error).message); }
  };
  if (error) return <ErrorText error={error} />;
  if (!brain) return <p className="muted">Loading…</p>;
  const required = brain.sections.filter((s) => s.required);
  const done = required.length - brain.missing_sections.length;

  return (
    <div>
      <h2>Brand Brain — {brain.organization.name}</h2>
      <p className="muted">What the agent knows about your brand. Only the owner (admin) can approve knowledge; agents can only <strong>propose</strong> changes.
        Anything missing is treated as <strong>UNKNOWN</strong> — the agent will not invent it.</p>
      <ErrorText error={actionError} />
      {msg && <div className="notice" role="status">{msg}</div>}

      <div className="panel" data-testid="brain-completeness">
        <div className="row"><strong>Onboarding: {done} of {required.length} required sections complete</strong>
          {brain.pending_proposals > 0 && <span className="badge warn">{brain.pending_proposals} proposal(s) waiting for review</span>}</div>
        {brain.missing_sections.length > 0 && <p className="small">Missing: {brain.missing_sections.map((s) => brain.sections.find((m) => m.section === s)?.label ?? s).join(", ")}</p>}
        {isOwner && (
          <div className="row">
            <a href="#/brain/onboarding" className="btn primary" data-testid="start-onboarding">
              {brain.missing_sections.length > 0 ? "Start guided setup" : "Review guided setup"}
            </a>
            <button onClick={() => act(() => api("/brain/import-voice-files", { method: "POST", body: {} }), "Imported the voice files into the Brand Brain.")}>
              Import brand/voice files
            </button>
          </div>
        )}
      </div>

      <ProposalsPanel isOwner={isOwner} onChange={reload} />
      <PillarsPanel accounts={brain.accounts} isOwner={isOwner}
        onSaved={(name) => { setMsg(`Saved content pillars for ${name}.`); reload(); }} />
      <IngestPanel onDone={(n) => { setMsg(`${n} proposal(s) created from your document — review them above.`); reload(); }} />

      {brain.sections.map((meta) => (
        <SectionCard key={meta.section} meta={meta} entries={brain.entries.filter((e) => e.section === meta.section)}
          missing={brain.missing_sections.includes(meta.section)} isOwner={isOwner}
          onSaved={() => { setMsg(`Saved "${meta.label}".`); reload(); }} onError={setActionError} />
      ))}
    </div>
  );
}

/** Turn "Threat landscape" into "threat-landscape" (the stored pillar id). */
export const pillarSlug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

export function PillarsPanel({ accounts, isOwner, onSaved }: {
  accounts: Brain["accounts"]; isOwner: boolean; onSaved: (accountName: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const preview = text.split("\n").map(pillarSlug).filter(Boolean);
  return (
    <div className="panel" data-testid="pillars">
      <h3 style={{ marginTop: 0 }}>Content pillars</h3>
      <p className="small muted">The themes posts rotate through, per account. The agent only plans and writes within these.
        Changing them does not alter posts that already exist.</p>
      <ErrorText error={error} />
      {accounts.map((a) => (
        <div key={a.id} style={{ marginTop: 8 }} data-testid={`pillars-${a.kind}`}>
          <div className="row"><strong>{a.display_name}</strong>
            {editing !== a.id && <span className="small">{a.pillars.join(" · ") || "none"}</span>}
            <span style={{ flex: 1 }} />
            {isOwner && editing !== a.id && <button onClick={() => { setEditing(a.id); setText(a.pillars.join("\n")); setError(null); }}>Edit pillars</button>}
          </div>
          {editing === a.id && (
            <div>
              <label htmlFor={`pillars-text-${a.kind}`}>One pillar per line (1–8), e.g. “Threat landscape”</label>
              <textarea id={`pillars-text-${a.kind}`} style={{ minHeight: 110 }} value={text} onChange={(e) => setText(e.target.value)} />
              <p className="small muted">Will be saved as: {preview.join(", ") || "—"}</p>
              <div className="row">
                <button className="primary" disabled={preview.length === 0} onClick={async () => {
                  setError(null);
                  try {
                    await api(`/accounts/${a.id}/pillars`, { method: "PUT", body: { pillars: preview } });
                    setEditing(null); onSaved(a.display_name);
                  } catch (e) { setError((e as Error).message); }
                }}>Save pillars</button>
                <button onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      ))}
      {!isOwner && <p className="small muted">Only the owner (admin) can change pillars.</p>}
    </div>
  );
}

function SectionCard({ meta, entries, missing, isOwner, onSaved, onError }: {
  meta: SectionMeta; entries: Entry[]; missing: boolean; isOwner: boolean; onSaved: () => void; onError: (m: string | null) => void;
}) {
  const [editing, setEditing] = useState<Entry | "new" | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [list, setList] = useState("");
  const [topics, setTopics] = useState("");
  const start = (e: Entry | "new") => {
    setEditing(e);
    setTitle(e === "new" ? meta.label : e.title);
    setBody(e === "new" ? "" : e.body);
    setList(e === "new" ? "" : ((e.structured.terms as string[] | undefined) ?? []).join("\n"));
    setTopics(e === "new" ? "" : ((e.structured.topics as string[] | undefined) ?? []).join("\n"));
  };
  const save = async () => {
    onError(null);
    const key = editing === "new" || !editing ? (entries.length === 0 ? "main" : title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "main") : editing.key;
    const structured = meta.listField ? { terms: list.split("\n").map((s) => s.trim()).filter(Boolean), topics: topics.split("\n").map((s) => s.trim()).filter(Boolean) } : undefined;
    try {
      await api("/brain/entries", { method: "POST", body: { section: meta.section, key, title, body, structured } });
      setEditing(null);
      onSaved();
    } catch (e) { onError((e as Error).message); }
  };
  return (
    <div className="panel" data-testid={`section-${meta.section}`}>
      <div className="row">
        <h3 style={{ margin: 0 }}>{meta.label}</h3>
        {missing ? <span className="badge bad">missing</span> : entries.length > 0 ? <span className="badge ok">approved</span> : <span className="badge">optional</span>}
        <span style={{ flex: 1 }} />
        {isOwner && !editing && <button onClick={() => start("new")}>{entries.length ? "Add entry" : "Fill in"}</button>}
      </div>
      {entries.map((e) => (
        <div key={e.id} style={{ marginTop: 8 }}>
          <div className="small"><strong>{e.title}</strong> · v{e.version} · {e.source}{e.source_ref ? ` (${e.source_ref.startsWith("proposal:") ? "from proposal" : e.source_ref})` : ""} · {fmt(e.approved_at)}
            {isOwner && !editing && <> · <button onClick={() => start(e)}>Edit (new version)</button></>}</div>
          <div style={{ whiteSpace: "pre-wrap" }}>{e.body}</div>
          {Array.isArray(e.structured.terms) && <div className="small">Prohibited terms: {(e.structured.terms as string[]).join(", ") || "—"}</div>}
          {Array.isArray(e.structured.topics) && <div className="small">Prohibited topics: {(e.structured.topics as string[]).join(", ") || "—"}</div>}
        </div>
      ))}
      {entries.length === 0 && (
        <ul className="small muted">{meta.questions.map((q) => <li key={q}>{q}</li>)}</ul>
      )}
      {entries.length === 0 && !isOwner && <p className="small muted">Ask the owner (admin) to complete this section, or paste a document below to create proposals.</p>}
      {editing && (
        <div>
          <ul className="small muted">{meta.questions.map((q) => <li key={q}>{q}</li>)}</ul>
          <label>Title</label><input value={title} onChange={(e) => setTitle(e.target.value)} />
          <label>Answer (approved knowledge — be factual)</label>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} data-testid={`answer-${meta.section}`} />
          {meta.listField && <>
            <label>{meta.listField.label}</label><textarea style={{ minHeight: 70 }} value={list} onChange={(e) => setList(e.target.value)} />
            <label>Prohibited topics (one per line)</label><textarea style={{ minHeight: 70 }} value={topics} onChange={(e) => setTopics(e.target.value)} />
          </>}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" disabled={!body.trim() || !title.trim()} onClick={save} data-testid={`save-${meta.section}`}>Approve & save</button>
            <button onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProposalsPanel({ isOwner, onChange }: { isOwner: boolean; onChange: () => void }) {
  const [items, error, reload] = useLoad<Proposal[]>("/brain/proposals?status=pending");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const decide = async (p: Proposal, decision: "accepted" | "rejected") => {
    setActionError(null);
    try {
      await api(`/brain/proposals/${p.id}/decision`, { method: "POST", body: {
        decision, body: decision === "accepted" && edits[p.id] !== undefined ? edits[p.id] : undefined,
        note: decision === "rejected" ? "Rejected by owner" : undefined } });
      reload(); onChange();
    } catch (e) { setActionError((e as Error).message); }
  };
  if (error) return <ErrorText error={error} />;
  if (!items || items.length === 0) return null;
  return (
    <div className="panel" data-testid="proposals">
      <h3 style={{ marginTop: 0 }}>Proposed changes ({items.length})</h3>
      <p className="small muted">Suggestions from the agent or teammates. Nothing changes until the owner accepts. You can edit before accepting.</p>
      <ErrorText error={actionError} />
      {items.map((p) => (
        <div key={p.id} className="notice">
          <div className="row"><strong>{p.title}</strong><span className="badge">{p.section}</span><span className="small muted">{p.proposer.replace(":", " ")} · {fmt(p.created_at)}</span>
            {p.conflicts_with && <span className="badge bad">conflicts with current knowledge</span>}</div>
          <p className="small">Why: {p.rationale}</p>
          {p.conflicts_with && <details open><summary>Current approved text</summary><pre>{p.current_body}</pre></details>}
          {isOwner
            ? <textarea value={edits[p.id] ?? p.body} onChange={(e) => setEdits({ ...edits, [p.id]: e.target.value })} />
            : <pre>{p.body}</pre>}
          {p.evidence.length > 0 && <ul className="small">{p.evidence.map((e, i) => <li key={i}>{e.type === "source_quote" ? `“${e.quote}” — ${e.source}` : `${e.type}: ${e.id ?? ""}`}</li>)}</ul>}
          {isOwner && (
            <div className="row">
              <button className="primary" onClick={() => decide(p, "accepted")}>Accept{edits[p.id] !== undefined ? " (edited)" : ""}</button>
              <button className="danger" onClick={() => decide(p, "rejected")}>Reject</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function IngestPanel({ onDone }: { onDone: (n: number) => void }) {
  const [name, setName] = useState("brand-notes.md");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <details className="panel">
      <summary><strong>Add knowledge from a document</strong> (website copy, pitch deck notes, brand guide)</summary>
      <p className="small muted">The agent extracts entries that are supported by a verbatim quote from your text and creates <strong>proposals</strong> for the owner to review. Nothing is approved automatically.</p>
      <label>Document name</label><input value={name} onChange={(e) => setName(e.target.value)} />
      <label>Paste text (headings like “## Positioning” help)</label>
      <textarea value={text} onChange={(e) => setText(e.target.value)} />
      <ErrorText error={error} />
      <button disabled={busy || text.trim().length < 20} onClick={async () => {
        setBusy(true); setError(null);
        try { const r = await api<{ proposalIds: string[] }>("/brain/ingest", { method: "POST", body: { name, text } }); setText(""); onDone(r.proposalIds.length); }
        catch (e) { setError((e as Error).message); } finally { setBusy(false); }
      }}>Create proposals</button>
    </details>
  );
}

// ------------------------------------------------------------------ Agent workspace
export function AgentPage({ me }: { me: Me }) {
  const [list, error, reload] = useLoad<WorkflowSummary[]>("/agent/workflows");
  const [goal, setGoal] = useState("Create a one-week LinkedIn strategy for ActTrident about phishing awareness for UK businesses.");
  const [start, setStart] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const [posts, setPosts] = useState(4);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const canRun = me.hints.canEdit;
  return (
    <div>
      <h2>Agent workspace</h2>
      <p className="muted">Give the Branding Agent a goal. It loads your Brand Brain, researches, plans the week, drafts posts in both voices, writes visual briefs and checks every claim.
        Drafts go to the <strong>review queue</strong> — nothing is published without human approval.</p>
      <ErrorText error={error ?? actionError} />
      {msg && <div className="notice" role="status">{msg}</div>}
      {canRun && (
        <div className="panel">
          <label htmlFor="goal">Goal</label>
          <textarea id="goal" style={{ minHeight: 70 }} value={goal} onChange={(e) => setGoal(e.target.value)} />
          <div className="row">
            <div style={{ flex: 1 }}><label htmlFor="start">Week starts</label><input id="start" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div style={{ flex: 1 }}><label htmlFor="posts">Posts (3–5)</label>
              <select id="posts" value={posts} onChange={(e) => setPosts(Number(e.target.value))}>{[3, 4, 5].map((n) => <option key={n}>{n}</option>)}</select></div>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary" disabled={busy || goal.trim().length < 3} data-testid="run-agent" onClick={async () => {
              setBusy(true); setActionError(null); setMsg(null);
              try {
                const r = await api<{ job_id: string }>("/agent/workflows", { method: "POST", body: { goal, start_date: start, days: 7, post_count: posts } });
                go(`/agent/job/${r.job_id}?new=1`);
              } catch (e) { setActionError((e as Error).message); reload(); } finally { setBusy(false); }
            }}>{busy ? "Queuing…" : "Run the Branding Agent"}</button>
            <button disabled={busy} onClick={async () => {
              setActionError(null); setMsg(null);
              try {
                const r = await api<{ observations: string[]; proposalIds: string[] }>("/agent/learning-review", { method: "POST" });
                setMsg(`Learning review: ${r.observations.join(" ")} ${r.proposalIds.length} learning proposal(s) sent to the Brand Brain for owner review.`);
              } catch (e) { setActionError((e as Error).message); }
            }}>Run learning review</button>
          </div>
        </div>
      )}
      <ActiveJobs />
      <RunHistory />
      <details className="panel table-wrap">
        <summary><strong>All results</strong> <span className="small muted">(every plan the agent produced, including runs from before background jobs)</span></summary>
        <table><thead><tr><th>Goal</th><th>Status</th><th>Drafts</th><th>Started</th></tr></thead>
          <tbody>{list?.map((w) => (
            <tr key={w.id} style={{ cursor: "pointer" }} onClick={() => go(`/agent/${w.id}`)}>
              <td>{w.goal}</td><td><Badge value={w.status === "completed" ? "succeeded" : w.status} /></td><td>{w.drafts}</td><td className="small">{fmt(w.created_at)}</td>
            </tr>
          ))}</tbody></table>
        {list?.length === 0 && <p className="muted">No agent runs yet.</p>}
      </details>
    </div>
  );
}

// ------------------------------------------------------------------ Durable agent jobs (P4-01)
interface Job {
  id: string; goal: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  workflow_id: string | null; progress: { stage?: string; done?: number | null; total?: number | null; estimated_usd?: number };
  cancel_requested: boolean; error: string | null; requested_by_name: string; created_at: string; started_at: string | null; finished_at: string | null;
  retry_of: string | null; retried_as: string | null; attempts: number;
  duration_seconds: number | null; drafts: number; in_review: number; estimated_usd: number;
}

const JOB_BADGE: Record<Job["status"], string> = {
  queued: "queued", running: "dispatching", succeeded: "succeeded", failed: "failed", cancelled: "cancelled", interrupted: "needs_reconciliation",
};
const JOB_LABEL: Record<Job["status"], string> = {
  queued: "waiting", running: "running", succeeded: "done", failed: "failed", cancelled: "cancelled", interrupted: "interrupted — can resume",
};
export const duration = (s: number | null) =>
  s === null ? "—" : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;

function RunHistory() {
  const [jobs, error] = useLoad<Job[]>("/agent/jobs");
  if (error) return <ErrorText error={error} />;
  return (
    <div className="panel table-wrap" data-testid="run-history">
      <h3 style={{ marginTop: 0 }}>Run history</h3>
      {jobs && jobs.length === 0 && <p className="muted">No runs yet. Give the agent a goal above.</p>}
      {jobs && jobs.length > 0 && (
        <table><thead><tr><th>Goal</th><th>Status</th><th>Started by</th><th>When</th><th>Took</th><th>Drafts (in review)</th><th>Est. cost</th></tr></thead>
          <tbody>{jobs.map((j) => (
            <tr key={j.id} style={{ cursor: "pointer" }} onClick={() => go(`/agent/job/${j.id}`)} data-testid="run-row">
              <td>{j.goal}{j.retry_of ? <span className="small muted"> (retry)</span> : null}</td>
              <td><Badge value={JOB_BADGE[j.status]} /> <span className="small">{JOB_LABEL[j.status]}</span></td>
              <td className="small">{j.requested_by_name}</td>
              <td className="small">{fmt(j.created_at)}</td>
              <td className="small">{duration(j.duration_seconds)}</td>
              <td className="small">{j.drafts} ({j.in_review})</td>
              <td className="small">${Number(j.estimated_usd ?? 0).toFixed(2)}</td>
            </tr>
          ))}</tbody></table>
      )}
    </div>
  );
}
const STAGE_TEXT: Record<string, string> = {
  starting: "Starting…", resuming: "Resuming where it stopped…", started: "Loading the Brand Brain…", research: "Researching sources…", strategy: "Planning the content…",
  drafting: "Writing drafts…", finishing: "Checking and saving…",
};
const ACTIVE = new Set(["queued", "running"]);

function ActiveJobs() {
  const [jobs, , reload] = useLoad<Job[]>("/agent/jobs");
  const active = (jobs ?? []).filter((j) => ACTIVE.has(j.status));
  useEffect(() => {
    if (active.length === 0) return;
    const t = setInterval(reload, 2000);
    return () => clearInterval(t);
  }, [active.length, reload]);
  if (active.length === 0) return null;
  return (
    <div className="panel" data-testid="active-jobs">
      <h3 style={{ marginTop: 0 }}>In progress</h3>
      {active.map((j) => (
        <div key={j.id} className="row"><a href={`#/agent/job/${j.id}`}>{j.goal}</a><Badge value={j.status === "running" ? "dispatching" : "queued"} />
          <span className="small muted">{j.status === "running" ? STAGE_TEXT[j.progress.stage ?? ""] ?? j.progress.stage : "waiting to start"}</span></div>
      ))}
    </div>
  );
}

/** `fresh` = the user just started this run here, so take them to the results when it finishes. */
export function JobPage({ id, fresh = false }: { id: string; fresh?: boolean }) {
  const [job, error, reload] = useLoad<Job>(`/agent/jobs/${id}`);
  const [actionError, setActionError] = useState<string | null>(null);
  const active = !!job && ACTIVE.has(job.status);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(reload, 1500);
    return () => clearInterval(t);
  }, [active, reload]);
  // Jump to the results only when this page watched the run finish (not when opening a finished run from history).
  const watched = useRef(fresh);
  useEffect(() => {
    if (active) watched.current = true;
    else if (watched.current && job?.status === "succeeded" && job.workflow_id) go(`/agent/${job.workflow_id}`);
  }, [active, job?.status, job?.workflow_id]);
  if (error) return <ErrorText error={error} />;
  if (!job) return <p className="muted">Loading…</p>;
  const p = job.progress;
  const pct = p.total ? Math.round(((p.done ?? 0) / p.total) * 100) : null;
  return (
    <div style={{ maxWidth: 760 }}>
      <h2>Branding Agent</h2>
      <div className="panel" data-testid="job-status">
        <div className="row"><strong>{job.goal}</strong><span style={{ flex: 1 }} /><Badge value={job.status === "running" ? "dispatching" : job.status === "succeeded" ? "succeeded" : job.status === "queued" ? "queued" : "failed"} />
          <span className="small">{job.status}</span></div>
        {job.status === "queued" && <p>Waiting to start…</p>}
        {job.status === "running" && <>
          <p>{job.cancel_requested ? "Stopping after the current step…" : STAGE_TEXT[p.stage ?? ""] ?? p.stage}
            {p.stage === "drafting" && p.total ? ` (${p.done ?? 0} of ${p.total})` : ""}</p>
          {pct !== null && <div className="progress" aria-label="progress"><div style={{ width: `${pct}%` }} /></div>}
          <p className="small muted">You can leave this page — the agent keeps working in the background. Estimated model cost so far: ${(p.estimated_usd ?? 0).toFixed(2)}.</p>
        </>}
        {job.status === "cancelled" && <p>Cancelled. Drafts created before cancelling were kept in the review queue.</p>}
        {(job.status === "failed" || job.status === "interrupted") && <p className="error">{job.error ?? "The job did not finish."}</p>}
        {job.workflow_id && !active && job.status !== "succeeded" && <p><a href={`#/agent/${job.workflow_id}`}>See what was produced</a></p>}
        {!active && (
          <p className="small muted" data-testid="job-summary">
            Started by {job.requested_by_name} · {fmt(job.started_at ?? job.created_at)} · took {duration(job.duration_seconds)} ·
            {" "}{job.drafts} draft(s), {job.in_review} in review · estimated model cost ${Number(job.estimated_usd ?? 0).toFixed(2)}
            {job.attempts > 1 ? ` · ${job.attempts} attempts (resumed after interruption)` : ""}
          </p>
        )}
        {job.status === "succeeded" && job.workflow_id && <p><a href={`#/agent/${job.workflow_id}`}>Open the results</a></p>}
        {job.retry_of && <p className="small">This is a retry of <a href={`#/agent/job/${job.retry_of}`}>an earlier run</a>.</p>}
        {job.retried_as && <p className="small">Retried as <a href={`#/agent/job/${job.retried_as}`}>a new run</a>.</p>}
        {(job.status === "failed" || job.status === "cancelled") && !job.retried_as && (
          <button className="primary" data-testid="retry-job" onClick={async () => {
            setActionError(null);
            try { const r = await api<{ job_id: string }>(`/agent/jobs/${job.id}/retry`, { method: "POST" }); go(`/agent/job/${r.job_id}?new=1`); }
            catch (e) { setActionError((e as Error).message); }
          }}>Retry</button>
        )}
        <ErrorText error={actionError} />
        {job.status === "interrupted" && (
          <button className="primary" data-testid="resume-job" onClick={async () => {
            setActionError(null);
            try { await api(`/agent/jobs/${job.id}/resume`, { method: "POST" }); reload(); } catch (e) { setActionError((e as Error).message); }
          }}>Resume where it stopped</button>
        )}
        {active && !job.cancel_requested && (
          <button className="danger" data-testid="cancel-job" onClick={async () => {
            setActionError(null);
            try { await api(`/agent/jobs/${job.id}/cancel`, { method: "POST" }); reload(); } catch (e) { setActionError((e as Error).message); }
          }}>Cancel</button>
        )}
      </div>
      <p><a href="#/agent">← Agent workspace</a></p>
    </div>
  );
}

interface Finding { id: string; statement: string; source_url: string; source_title: string | null; publisher: string | null; published_at: string | null;
  retrieved_at: string; confidence: string; stale: boolean; flags: string[]; status: string }
interface Draft { id: string; status: string; account_kind: string; account_name: string; pillar: string; topic: string; body: string;
  scheduled_for: string | null; variant_group: string; unsupported: string[]; citations: Array<{ claim_id: string; quoted_span: string }>;
  visual_brief: { format: string; headline: string; slides: Array<{ title: string; text: string }>; visual_direction: string; alt_text: string; avoid: string[]; warnings?: string[] } | null }
interface Workflow { id: string; goal: string; status: string; error: string | null; created_at: string; result: Record<string, any> | null;
  strategy: { summary: string; items: Array<{ day: number; topic: string; angle: string; objective: string; pillars: Record<string, string> }> } | null;
  findings: Finding[]; drafts: Draft[] }

export function WorkflowPage({ id, me }: { id: string; me: Me }) {
  const [w, error, reload] = useLoad<Workflow>(`/agent/workflows/${id}`);
  const [actionError, setActionError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (error) return <ErrorText error={error} />;
  if (!w) return <p className="muted">Loading…</p>;
  const r = w.result ?? {};
  const groups = new Map<string, Draft[]>();
  for (const d of w.drafts) groups.set(d.variant_group, [...(groups.get(d.variant_group) ?? []), d]);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setActionError(null); setMsg(null);
    try { await fn(); setMsg(ok); reload(); } catch (e) { setActionError((e as Error).message); }
  };
  return (
    <div>
      <p><a href="#/agent">← Agent workspace</a></p>
      <div className="row"><h2 style={{ margin: 0 }}>{w.goal}</h2><Badge value={w.status === "completed" ? "succeeded" : w.status} /></div>
      <p className="small muted">Started {fmt(w.created_at)} · {r.publishing ?? ""}</p>
      {w.error && <p className="error">{w.error}</p>}
      <ErrorText error={actionError} />
      {msg && <div className="notice" role="status">{msg}</div>}
      {Array.isArray(r.warnings) && r.warnings.length > 0 && (
        <div className="notice"><strong>Notes</strong><ul className="small">{r.warnings.map((x: string) => <li key={x}>{x}</li>)}</ul></div>
      )}

      <div className="panel" data-testid="research">
        <h3 style={{ marginTop: 0 }}>Research ({w.findings.length} sources kept{r.research?.rejected?.length ? `, ${r.research.rejected.length} rejected` : ""})</h3>
        <p className="small muted">External content is untrusted. Stale or suspicious findings are flagged and never used as evidence. A finding only becomes a claim after you create a draft claim and an approver verifies it.</p>
        <div className="table-wrap"><table><thead><tr><th>Finding</th><th>Source</th><th>Confidence</th><th>Status</th><th /></tr></thead>
          <tbody>{w.findings.map((f) => (
            <tr key={f.id}>
              <td>{f.statement}{f.flags.length > 0 && <div>{f.flags.map((x) => <span key={x} className="badge bad" style={{ marginRight: 4 }}>{x.replace(/_/g, " ")}</span>)}</div>}</td>
              <td className="small"><a href={f.source_url} target="_blank" rel="noopener noreferrer">{f.source_title ?? f.source_url}</a>
                <div className="muted">{f.publisher ?? ""} {f.published_at ? `· published ${f.published_at}` : "· undated"} · retrieved {fmt(f.retrieved_at)}</div></td>
              <td><Badge value={f.confidence === "high" ? "verified" : f.confidence === "low" ? "expired" : "pending"} /> <span className="small">{f.confidence}</span></td>
              <td><Badge value={f.status === "unreviewed" ? "pending" : f.status === "accepted" ? "approved" : "rejected"} /></td>
              <td className="small">
                {me.hints.canApprove && f.status === "unreviewed" && <>
                  <button onClick={() => act(() => api(`/research/${f.id}/review`, { method: "POST", body: { status: "accepted" } }), "Finding accepted.")}>Accept</button>{" "}
                  <button onClick={() => act(() => api(`/research/${f.id}/review`, { method: "POST", body: { status: "rejected" } }), "Finding rejected.")}>Reject</button></>}
                {me.hints.canEdit && !f.stale && !f.flags.includes("possible_prompt_injection") &&
                  <button onClick={() => act(() => api(`/research/${f.id}/to-claim`, { method: "POST", body: { category: "breach_statistic" } }), "Draft claim created — verify it in the Claims register.")}>Make draft claim</button>}
              </td>
            </tr>
          ))}</tbody></table></div>
        {r.research?.rejected?.length > 0 && <details><summary className="small">Rejected sources</summary><ul className="small">
          {r.research.rejected.map((x: { source_url: string; reason: string }) => <li key={x.source_url}>{x.source_url} — {x.reason}</li>)}</ul></details>}
      </div>

      {w.strategy && (
        <div className="panel" data-testid="strategy">
          <h3 style={{ marginTop: 0 }}>Content plan</h3>
          <p>{w.strategy.summary}</p>
          <div className="table-wrap"><table><thead><tr><th>Day</th><th>Topic</th><th>Angle</th><th>Pillars</th></tr></thead>
            <tbody>{w.strategy.items.map((i) => (
              <tr key={i.topic}><td>{i.day}</td><td>{i.topic}</td><td className="small">{i.angle}<div className="muted">{i.objective}</div></td>
                <td className="small">company: {i.pillars.company_page}<br />founder: {i.pillars.founder_profile}</td></tr>
            ))}</tbody></table></div>
          {r.strategy?.dropped?.length > 0 && <p className="small muted">Not planned: {r.strategy.dropped.map((d: { topic: string; reason: string }) => `${d.topic} (${d.reason})`).join("; ")}</p>}
        </div>
      )}

      <h3>Drafts — company and founder versions</h3>
      {[...groups.values()].map((pair) => (
        <div className="panel" key={pair[0]!.variant_group} data-testid="draft-pair">
          <div className="row"><strong>{pair[0]!.topic}</strong><span className="small muted">{pair[0]!.scheduled_for ? fmt(pair[0]!.scheduled_for) : ""}</span></div>
          <div className="grid2">
            {pair.map((d) => (
              <div key={d.id}>
                <div className="row"><span className="badge">{d.account_kind === "company_page" ? "Company page" : "Founder"}</span><Badge value={d.status} />
                  <a href={`#/content/${d.id}`}>Open for review →</a></div>
                <div className="preview" style={{ marginTop: 6 }}><div className="body">{d.body}</div></div>
                {d.unsupported.length > 0 && <ul className="unsupported small">{d.unsupported.map((u) => <li key={u}>{u}</li>)}</ul>}
                <p className="small">Claims cited: {d.citations.length}</p>
                {d.visual_brief && (
                  <details className="small"><summary>Visual brief: {d.visual_brief.format.replace(/_/g, " ")} — “{d.visual_brief.headline}”</summary>
                    {d.visual_brief.slides.length > 0 && <ol>{d.visual_brief.slides.map((s, i) => <li key={i}>{s.text}</li>)}</ol>}
                    <p>Direction: {d.visual_brief.visual_direction}</p><p>Alt text: {d.visual_brief.alt_text}</p>
                    <p>Avoid: {d.visual_brief.avoid.join(", ")}</p>
                    {d.visual_brief.warnings?.length ? <ul className="unsupported">{d.visual_brief.warnings.map((x) => <li key={x}>{x}</li>)}</ul> : null}
                  </details>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {r.claims_report && (
        <div className="panel" data-testid="claims-report">
          <h3 style={{ marginTop: 0 }}>Verified claims report</h3>
          <p className="small">Submitted for review: {r.claims_report.submitted_for_review} · Held as draft: {r.claims_report.held_as_draft} ·
            Drafts with unsupported statements: {r.claims_report.drafts_with_unsupported_statements}</p>
          {r.claims_report.verified_claims_used.length === 0
            ? <p className="small muted">No verified claims were used — posts rely on opinion and practical advice only.</p>
            : <ul className="small">{r.claims_report.verified_claims_used.map((c: { claim_id: string; statement: string; count: number }) =>
                <li key={c.claim_id}>{c.statement} — used {c.count}×</li>)}</ul>}
        </div>
      )}
    </div>
  );
}
