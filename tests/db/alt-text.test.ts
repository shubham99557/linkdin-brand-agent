// P5-06: a visual needs a real description (alt text) before review; editing it is part of the approval.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentInReview, expectCode, freshDb, packageHash, type TestDb } from "../helpers/db.ts";

let t: TestDb;
let editor: string;
let approver: string;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const GOOD = "Navy slide reading: report suspicious emails within five minutes";

beforeAll(async () => { t = await freshDb(); editor = await t.login("editor"); approver = await t.login("approver"); });
afterAll(async () => t.db.close());

const status = async (id: string) => (await t.db.query<{ status: string }>("select status from lbe.content_items where id = $1", [id]))[0]!.status;
const attach = (id: string, alt: string | null) => t.api("select lbe.attach_media($1, $2, $3::jsonb)",
  [editor, id, JSON.stringify({ kind: "image/png", data_base64: PNG, width: 1, height: 1, page_count: 1, alt_text: alt })]);
const setAlt = (id: string, alt: string, s = editor) => t.api<{ media_ids: string[]; status: string; package_hash: string }>(
  "select lbe.set_media_alt_text($1, $2, $3)", [s, id, alt]);
const submit = (id: string) => t.api("select lbe.submit_for_review($1, $2)", [editor, id]);

describe("alt text is required before review", () => {
  it("missing (generic placeholder) or too-short descriptions block review; a real one passes", async () => {
    for (const [alt, why] of [[null, /generic placeholder/], ["Image", /too short/]] as const) {
      const id = await contentInReview(t, editor);
      await attach(id, alt);                                         // → back to draft
      await expectCode(submit(id), "LBE02");
      await expect(submit(id)).rejects.toThrow(why);
      expect(await status(id)).toBe("draft");
    }
    const ok = await contentInReview(t, editor);
    await attach(ok, GOOD);
    await submit(ok);
    expect(await status(ok)).toBe("in_review");
  });

  it("posts without a visual are not affected", async () => {
    const id = await contentInReview(t, editor);
    expect(await status(id)).toBe("in_review");
  });
});

describe("editing alt text", () => {
  it("creates a new immutable copy with the new description; after approval this needs a new approval", async () => {
    const id = await contentInReview(t, editor);
    await attach(id, GOOD);
    await submit(id);
    const hash = await packageHash(t, id);
    await t.api("select lbe.decide_content($1, $2, $3, 'approved', null)", [approver, id, hash]);
    const before = (await t.db.query<{ media_ids: string[] }>("select media_ids from lbe.content_items where id = $1", [id]))[0]!.media_ids;
    const r = await setAlt(id, "Navy slide reading: report suspicious emails quickly and without blame");
    expect(r.status).toBe("draft");
    expect(r.package_hash).not.toBe(hash);
    expect(r.media_ids).not.toEqual(before);
    const [oldRow] = await t.db.query<{ alt_text: string; sha256: string }>("select alt_text, sha256 from lbe.media_assets where id = $1", [before[0]]);
    const [newRow] = await t.db.query<{ alt_text: string; sha256: string }>("select alt_text, sha256 from lbe.media_assets where id = $1", [r.media_ids[0]]);
    expect(oldRow!.alt_text).toBe(GOOD);                             // the approved original is untouched
    expect(newRow!.sha256).toBe(oldRow!.sha256);                     // same image bytes, new description
    await expectCode(t.api("select lbe.enqueue_publication($1, $2)", [approver, id]), "LBE01");
  });

  it("refuses poor descriptions, posts without a visual, and other organizations", async () => {
    const id = await contentInReview(t, editor);
    await expectCode(setAlt(id, GOOD), "LBE01");                                     // nothing attached
    await attach(id, GOOD);
    await expectCode(setAlt(id, "pic"), "LBE02");
    await expectCode(setAlt(id, "Visual for this post"), "LBE02");
    const [o] = await t.db.query<{ id: string }>("insert into lbe.organizations(name, slug) values ('Org A', 'org-a') returning id");
    await t.db.query("select lbe.admin_create_user('a@lbe.test', 'A', 'admin', 'org-a-password-123', $1)", [o!.id]);
    const other = (await t.api<{ token: string }>("select lbe.login('a@lbe.test', 'org-a-password-123')")).token;
    await expectCode(setAlt(id, GOOD, other), "LBE04");
  });
});
