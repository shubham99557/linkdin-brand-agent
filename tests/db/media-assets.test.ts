// P5-03: visuals are stored as immutable assets and are part of the approved publication package.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentInReview, expectCode, freshDb, packageHash, type TestDb } from "../helpers/db.ts";

let t: TestDb;
let editor: string;
let approver: string;
// Smallest valid PNG and a minimal PDF header (the database checks the file signature).
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const PDF = Buffer.from("%PDF-1.3\n%test\n").toString("base64");
const asset = (over: Record<string, unknown> = {}) => JSON.stringify({ kind: "image/png", data_base64: PNG, width: 1, height: 1, page_count: 1,
  alt_text: "A test visual", title: "T", ...over });

beforeAll(async () => { t = await freshDb(); editor = await t.login("editor"); approver = await t.login("approver"); });
afterAll(async () => t.db.close());

const status = async (id: string) => (await t.db.query<{ status: string }>("select status from lbe.content_items where id = $1", [id]))[0]!.status;
const attach = (id: string, a: string | null, s = editor) => t.api<{ media_ids: string[]; status: string; package_hash: string }>(
  "select lbe.attach_media($1, $2, $3::jsonb)", [s, id, a]);

describe("attaching visuals", () => {
  it("stores the exact bytes with a database-computed SHA-256 and puts the asset id in the package", async () => {
    const id = await contentInReview(t, editor);
    const r = await attach(id, asset());
    expect(r.media_ids).toHaveLength(1);
    const [m] = await t.db.query<{ sha256: string; byte_size: number; data: Uint8Array }>(
      "select sha256, byte_size, data from lbe.media_assets where id = $1", [r.media_ids[0]]);
    const { createHash } = await import("node:crypto");
    expect(m!.sha256).toBe(createHash("sha256").update(Buffer.from(PNG, "base64")).digest("hex"));
    expect(m!.byte_size).toBe(Buffer.from(PNG, "base64").length);
    const [pkg] = await t.db.query<{ package: { media_ids: string[] } }>("select package from lbe.content_items where id = $1", [id]);
    expect(pkg!.package.media_ids).toEqual(r.media_ids);
  });

  it("attaching, replacing or removing a visual after approval invalidates the approval", async () => {
    for (const change of ["attach", "replace", "remove"] as const) {
      const id = await contentInReview(t, editor);
      if (change !== "attach") { await attach(id, asset()); await t.api("select lbe.submit_for_review($1, $2)", [editor, id]); }
      const hash = await packageHash(t, id);
      await t.api("select lbe.decide_content($1, $2, $3, 'approved', null)", [approver, id, hash]);
      expect(await status(id)).toBe("approved");
      const r = await attach(id, change === "remove" ? null : asset({ kind: "application/pdf", data_base64: PDF }));
      expect(r.status, change).toBe("draft");
      expect(r.package_hash, change).not.toBe(hash);
      await expectCode(t.api("select lbe.enqueue_publication($1, $2)", [approver, id]), "LBE01");      // old approval is useless
    }
  });

  it("assets are immutable — even the database owner cannot change or delete them", async () => {
    const id = await contentInReview(t, editor);
    const r = await attach(id, asset());
    await expectCode(t.db.query("update lbe.media_assets set alt_text = 'x' where id = $1", [r.media_ids[0]]), "LBE01");
    await expectCode(t.db.query("delete from lbe.media_assets where id = $1", [r.media_ids[0]]), "LBE01");
  });

  it("only real visuals of the same post can be referenced (no free-text or borrowed media ids)", async () => {
    const a = await contentInReview(t, editor);
    const b = await contentInReview(t, editor);
    const ra = await attach(a, asset());
    await expectCode(t.api("select lbe.update_content($1, $2, $3::jsonb)", [editor, b, JSON.stringify({ media_ids: ["media-1"] })]), "LBE02");
    await expectCode(t.api("select lbe.update_content($1, $2, $3::jsonb)", [editor, b, JSON.stringify({ media_ids: ra.media_ids })]), "LBE02");
  });

  it("checks the file signature and kind", async () => {
    const id = await contentInReview(t, editor);
    await expectCode(attach(id, asset({ data_base64: PDF })), "LBE02");                                 // PDF bytes labelled PNG
    await expectCode(attach(id, asset({ kind: "application/pdf", data_base64: PNG })), "LBE02");
    await expectCode(attach(id, asset({ kind: "text/html", data_base64: PNG })), "LBE02");
  });

  it("published or queued posts cannot have their visual changed; viewers cannot attach; agents can attach but not approve", async () => {
    const id = await contentInReview(t, editor);
    const hash = await packageHash(t, id);
    await t.api("select lbe.decide_content($1, $2, $3, 'approved', null)", [approver, id, hash]);
    await t.api("select lbe.enqueue_publication($1, $2)", [approver, id]);
    await expectCode(attach(id, asset()), "LBE01");                                                      // locked while queued
    const other = await contentInReview(t, editor);
    await t.db.query("select lbe.admin_create_user('v@lbe.test', 'V', 'viewer', 'viewer-password-123')");
    const viewer = (await t.api<{ token: string }>("select lbe.login('v@lbe.test', 'viewer-password-123')")).token;
    await expectCode(attach(other, asset(), viewer), "LBE11");
    await t.db.tx("lbe_agent", (q) => q.query("select lbe.attach_media($1, $2, $3::jsonb)", [editor, other, asset()]));
    await expectCode(t.db.tx("lbe_agent", (q) => q.query("select lbe.decide_content($1, $2, 'x', 'approved', null)", [editor, other])), "42501");
  });

  it("media of another organization is 'not found'", async () => {
    const id = await contentInReview(t, editor);
    const r = await attach(id, asset());
    const [o] = await t.db.query<{ id: string }>("insert into lbe.organizations(name, slug) values ('Org M', 'org-m') returning id");
    await t.db.query("select lbe.admin_create_user('m@lbe.test', 'M', 'admin', 'org-m-password-123', $1)", [o!.id]);
    const otherAdmin = (await t.api<{ token: string }>("select lbe.login('m@lbe.test', 'org-m-password-123')")).token;
    await expectCode(t.db.tx("lbe_api", (q) => q.query("select * from lbe.media_get($1, $2)", [otherAdmin, r.media_ids[0]])), "LBE04");
    await expectCode(t.api("select lbe.media_list($1, $2)", [otherAdmin, id]), "LBE04");
    await expectCode(attach(id, asset(), otherAdmin), "LBE04");
  });
});
