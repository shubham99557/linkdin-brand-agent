// End-to-end demonstration against a RUNNING local server (npm start), using the synthetic dev users.
// Brief → AI draft (mock) → claims validation → review → approval → outbox → mock publish → audit.
// Makes no external network calls. Passwords are read from .env and never printed.
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
if (existsSync(path.join(root, ".env"))) process.loadEnvFile(path.join(root, ".env"));
const BASE = process.env.LBE_DEMO_URL ?? `http://127.0.0.1:${process.env.LBE_PORT ?? 8787}`;

class Session {
  cookie = "";
  constructor(readonly who: string) {}
  async call<T = any>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE}/api${url}`, {
      method,
      headers: { origin: BASE, cookie: this.cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!;
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${this.who} ${method} ${url} → ${res.status} ${data?.error ?? ""}`);
    return data as T;
  }
  async login(email: string, passwordVar: string) {
    const pw = process.env[passwordVar];
    if (!pw) throw new Error(`${passwordVar} missing — run npm run setup:local && npm run db:seed`);
    await this.call("POST", "/auth/login", { email, password: pw });
    return this;
  }
}

const step = (n: number, text: string) => console.log(`\n[${n}] ${text}`);

const editor = await new Session("editor").login("editor@lbe.test", "LBE_DEV_EDITOR_PASSWORD");
const approver = await new Session("approver").login("marketing@lbe.test", "LBE_DEV_APPROVER_PASSWORD");
const admin = await new Session("admin").login("admin@lbe.test", "LBE_DEV_ADMIN_PASSWORD");

const accounts = await editor.call<Array<{ id: string; kind: string; display_name: string }>>("GET", "/accounts");
const company = accounts.find((a) => a.kind === "company_page")!;

step(1, `Brief created for "${company.display_name}" (pillar: security-culture)`);
const { id } = await editor.call("POST", "/content", {
  account_id: company.id, pillar: "security-culture",
  brief: "Encourage staff to report suspicious emails quickly, without blame.",
});
console.log(`    content id ${id}`);

step(2, "AI draft generated (mock drafter — no network call) and validated against the claims register");
const draft = await editor.call("POST", `/content/${id}/draft`);
let detail = await editor.call("GET", `/content/${id}`);
console.log(`    citations: ${detail.citations.length} verified claim(s); unsupported statements: ${draft.unsupported.length}`);
console.log(`    body: ${detail.item.body.replace(/\n+/g, " ").slice(0, 140)}…`);

step(3, "Submitted for human review");
await editor.call("POST", `/content/${id}/submit`);

step(4, "Approver previews the exact publication package and approves it");
detail = await approver.call("GET", `/content/${id}`);
console.log(`    package sha256 ${detail.item.package_hash}`);
await approver.call("POST", `/content/${id}/decision`, { decision: "approved", expected_package_hash: detail.item.package_hash });

step(5, "Approved package placed in the transactional outbox");
const { outbox_id } = await approver.call("POST", `/content/${id}/enqueue`);
console.log(`    outbox ${outbox_id}`);

step(6, "Publisher run (admin) → mock LinkedIn provider");
const tick = await admin.call("POST", "/jobs/publisher-tick");
console.log(`    claimed ${tick.claimed}, succeeded ${tick.succeeded}, released ${tick.released}, ambiguous ${tick.ambiguous}`);

step(7, "Mock confirmation");
detail = await admin.call("GET", `/content/${id}`);
console.log(`    status: ${detail.item.status}; mock post: ${detail.item.provider_post_ref}`);

step(8, "Audit trail for this post");
for (const a of [...detail.audit].reverse()) console.log(`    ${a.at}  ${a.action.padEnd(22)} ${a.actor}`);

console.log(`\nDone. Open ${BASE}/#/content/${id} to see it in the dashboard.`);
