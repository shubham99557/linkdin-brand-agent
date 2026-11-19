// P5-02: visual identity in the Brand Brain + rendered previews of a draft's visual, through the API.
import { createHash } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockDrafter } from "@lbe/drafting";
import { MockLinkedInProvider } from "@lbe/publishing";
import { createApp } from "../../services/api/src/app.ts";
import { dbMockStore } from "../../services/api/src/jobs/publisher.ts";
import { freshDb, TEST_PASSWORDS, type TestDb } from "../helpers/db.ts";

const ORIGIN = "http://localhost:5173";
let t: TestDb;
let app: ReturnType<typeof createApp>;
let carouselId: string;
let textOnlyId: string;
let otherOrgContent: string;
const LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const sha = (b: ArrayBuffer) => createHash("sha256").update(Buffer.from(b)).digest("hex");

async function login(email: string, pw: string) {
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: pw }) });
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
const req = (cookie: string, url: string, init: { method?: string; body?: unknown } = {}) => app.request(url, {
  method: init.method ?? "GET", headers: { cookie, origin: ORIGIN, ...(init.body ? { "content-type": "application/json" } : {}) },
  body: init.body ? JSON.stringify(init.body) : undefined });

beforeAll(async () => {
  t = await freshDb();
  app = createApp({ db: t.db, drafter: new MockDrafter(), provider: new MockLinkedInProvider(dbMockStore(t.db)),
    appOrigins: [ORIGIN], cookieSecure: false, voiceDir: path.resolve(import.meta.dirname, "../../brand/voice"), workerId: "cs", log: () => undefined });
  const s = await t.login("editor");
  const mk = async (brief: unknown) => {
    const id = await t.api<string>("select lbe.create_content($1, $2, 'threat-landscape', 'visual test', null, null)", [s, t.ids.accounts.company]);
    await t.db.tx("lbe_agent", (q) => q.query("select lbe.set_agent_metadata($1, $2, $3::jsonb)", [s, id, JSON.stringify({ visual_brief: brief })]));
    return id;
  };
  carouselId = await mk({ format: "document_carousel", headline: "Spot phishing fast", slides: [{ title: "Check sender", text: "Look closely." }, { title: "Pause", text: "Slow down." }],
    visual_direction: "calm", alt_text: "A carousel", avoid: [] });
  textOnlyId = await mk({ format: "text_only", headline: "x", slides: [], visual_direction: "", alt_text: "", avoid: [] });
  const [o] = await t.db.query<{ id: string }>("insert into lbe.organizations(name, slug) values ('Org V', 'org-v') returning id");
  const [a] = await t.db.query<{ id: string }>(
    "insert into lbe.social_accounts(kind, display_name, voice_profile, pillars, organization_id) values ('company_page', 'V', 'company', array['news'], $1) returning id", [o!.id]);
  otherOrgContent = (await t.db.query<{ id: string }>(
    "insert into lbe.content_items(account_id, pillar, brief, visual_brief, created_by) values ($1, 'news', 'b', $2::jsonb, $3) returning id",
    [a!.id, JSON.stringify({ format: "single_image", headline: "secret", slides: [] }), t.ids.users.admin]))[0]!.id;
}, 120_000);
afterAll(async () => t.db.close());

describe("draft visual previews", () => {
  it("renders each slide as PNG and the carousel as PDF; placeholder branding is flagged", async () => {
    const editor = await login("editor@lbe.test", TEST_PASSWORDS.editor);
    const png = await req(editor, `/api/content/${carouselId}/visual?slide=1`);
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("x-placeholder-branding")).toBe("true");
    expect(png.headers.get("x-request-id")).toBeTruthy();
    expect(new Uint8Array(await png.arrayBuffer()).slice(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47]));
    expect((await req(editor, `/api/content/${carouselId}/visual?slide=3`)).status).toBe(200);         // cover + 2
    expect((await req(editor, `/api/content/${carouselId}/visual?slide=4`)).status).toBe(404);
    const pdf = await req(editor, `/api/content/${carouselId}/visual?format=pdf`);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await pdf.arrayBuffer()).toString("latin1")).toContain("/Count 3");
  }, 60_000);

  it("text-only drafts have no visual; other organizations' drafts are 'not found'; sign-in required", async () => {
    const editor = await login("editor@lbe.test", TEST_PASSWORDS.editor);
    expect((await req(editor, `/api/content/${textOnlyId}/visual?slide=1`)).status).toBe(404);
    expect((await req(editor, `/api/content/${otherOrgContent}/visual?slide=1`)).status).toBe(404);
    expect((await app.request(`/api/content/${carouselId}/visual?slide=1`)).status).toBe(401);
  });
});

describe("visual identity (owner-controlled, in the Brand Brain)", () => {
  it("only the owner can set it; invalid colours and remote logos are refused", async () => {
    const editor = await login("editor@lbe.test", TEST_PASSWORDS.editor);
    const body = { background: "#102030", foreground: "#ffffff", accent: "#ff6600" };
    expect((await req(editor, "/api/brand/visual-identity", { method: "PUT", body })).status).toBe(403);
    const admin = await login("admin@lbe.test", TEST_PASSWORDS.admin);
    expect((await req(admin, "/api/brand/visual-identity", { method: "PUT", body: { ...body, accent: "orange" } })).status).toBe(422);
    const remote = await req(admin, "/api/brand/visual-identity", { method: "PUT", body: { ...body, logo_data_uri: "https://evil.example/logo.png" } });
    expect(remote.status).toBe(422);
    expect((await remote.json() as { error: string }).error).toMatch(/data:image/);
  });

  it("saving it changes the previews, removes the placeholder flag, and does NOT complete 'Brand identity'", async () => {
    const admin = await login("admin@lbe.test", TEST_PASSWORDS.admin);
    const before = await (await req(admin, `/api/content/${carouselId}/visual?slide=2`)).arrayBuffer();
    const saved = await req(admin, "/api/brand/visual-identity", { method: "PUT",
      body: { background: "#102030", foreground: "#ffffff", accent: "#ff6600", logo_data_uri: LOGO } });
    expect(saved.status).toBe(201);
    const after = await req(admin, `/api/content/${carouselId}/visual?slide=2`);
    expect(after.headers.get("x-placeholder-branding")).toBe("false");
    expect(sha(await after.arrayBuffer())).not.toBe(sha(before));
    const vi = await (await req(admin, "/api/brand/visual-identity")).json() as { placeholder: boolean; identity: { accent: string } };
    expect(vi).toMatchObject({ placeholder: false, identity: { accent: "#ff6600" } });
    const brain = await (await req(admin, "/api/brain")).json() as { missing_sections: string[]; entries: Array<{ key: string; body: string; source: string }> };
    expect(brain.missing_sections).toContain("identity");                 // colours are not a brand description
    const visual = brain.entries.find((e) => e.key === "visual")!;
    expect(visual.source).toBe("owner");
    expect(visual.body).not.toContain("base64");
    const sample = await req(admin, "/api/brand/visual-identity/sample.png");
    expect(sample.headers.get("content-type")).toBe("image/png");
  }, 60_000);
});
