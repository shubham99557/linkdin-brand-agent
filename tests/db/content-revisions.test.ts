// P5-04: every version of a post's publication package is kept, immutably, with who changed it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentInReview, expectCode, freshDb, packageHash, type TestDb } from "../helpers/db.ts";

let t: TestDb;
let editor: string;
let approver: string;
beforeAll(async () => { t = await freshDb(); editor = await t.login("editor"); approver = await t.login("approver"); });
afterAll(async () => t.db.close());

type Rev = { version: number; body: string; is_current: boolean; actor_name: string; via: string | null; visibility: string;
  decisions: Array<{ decision: string; approver_name: string }> };
const history = (id: string, s = editor) => t.api<Rev[]>("select lbe.content_history($1, $2)", [s, id]);
const BODY = "[SYNTHETIC] ActTrident is a UK-registered cybersecurity company. Here is what we learned this week.";

describe("content revisions", () => {
  it("records the first version and each package change (not status-only changes), with the decision on each", async () => {
    const id = await contentInReview(t, editor);                   // create → set output → submit
    const v1 = await packageHash(t, id);
    await t.api("select lbe.decide_content($1, $2, $3, 'changes_requested', 'Shorter, please')", [approver, id, v1]);
    await t.api("select lbe.update_content($1, $2, $3::jsonb)", [editor, id, JSON.stringify({ body: `${BODY} Shorter now.` })]);
    await t.api("select lbe.update_content($1, $2, $3::jsonb)", [editor, id, JSON.stringify({ visibility: "CONNECTIONS" })]);
    await t.api("select lbe.submit_for_review($1, $2)", [editor, id]);   // status only → no new revision
    const h = await history(id);
    // create (v1) → draft text (v2) → claim citation (v3) → body edit (v4) → visibility (v5); submit/decide add none
    expect(h.map((r) => r.version)).toEqual([5, 4, 3, 2, 1]);
    expect(h[0]).toMatchObject({ is_current: true, visibility: "CONNECTIONS", body: `${BODY} Shorter now.` });
    expect(h[1]).toMatchObject({ visibility: "PUBLIC", body: `${BODY} Shorter now.` });
    const decided = h.find((r) => r.decisions.length > 0)!;
    expect(decided.body).toBe(BODY);
    expect(decided.decisions[0]).toMatchObject({ decision: "changes_requested" });
    expect(h.every((r) => r.actor_name === "Dev Editor" || r.actor_name.length > 0)).toBe(true);
    expect(h[0]!.via).toBe("lbe_api");
    // one revision per version, versions strictly increasing, last one current
    const versions = h.map((r) => r.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(h.filter((r) => r.is_current)).toHaveLength(1);
  });

  it("changes made by the agent are labelled as such", async () => {
    const id = await t.db.tx("lbe_agent", async (q) => (await q.query<{ id: string }>(
      "select lbe.create_content($1, $2, 'threat-landscape', 'agent brief', null, null) as id", [editor, t.ids.accounts.company]))[0]!.id);
    const h = await history(id);
    expect(h[0]!.via).toBe("lbe_agent");
  });

  it("revisions are immutable, even for the database owner", async () => {
    const id = await contentInReview(t, editor);
    await expectCode(t.db.query("update lbe.content_revisions set brief = 'x' where content_id = $1", [id]), "LBE01");
    await expectCode(t.db.query("delete from lbe.content_revisions where content_id = $1", [id]), "LBE01");
  });

  it("history of another organization's post is 'not found'", async () => {
    const id = await contentInReview(t, editor);
    const [o] = await t.db.query<{ id: string }>("insert into lbe.organizations(name, slug) values ('Org H', 'org-h') returning id");
    await t.db.query("select lbe.admin_create_user('h@lbe.test', 'H', 'admin', 'org-h-password-123', $1)", [o!.id]);
    const other = (await t.api<{ token: string }>("select lbe.login('h@lbe.test', 'org-h-password-123')")).token;
    await expectCode(history(id, other), "LBE04");
  });
});
