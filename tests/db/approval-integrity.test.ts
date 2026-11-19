import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentInReview, expectCode, freshDb, packageHash, type TestDb } from "../helpers/db.ts";

let t: TestDb;
let editor: string;
let approver: string;
let founder: string;

beforeAll(async () => {
  t = await freshDb();
  [editor, approver, founder] = await Promise.all([t.login("editor"), t.login("approver"), t.login("founder")]);
});
afterAll(async () => t.db.close());

const status = async (id: string) =>
  (await t.db.query<{ status: string }>("select status from lbe.content_items where id = $1", [id]))[0]!.status;

describe("approval binds to the immutable publication package", () => {
  it("package includes destination, body, media, visibility, schedule and claim ids", async () => {
    const id = await contentInReview(t, editor);
    const [row] = await t.db.query<{ package: Record<string, unknown> }>(
      "select package from lbe.content_items where id = $1", [id]);
    expect(Object.keys(row!.package).sort()).toEqual(
      ["body", "claim_ids", "content_id", "destination", "media_ids", "scheduled_for", "schema", "visibility"]);
    expect((row!.package.destination as Record<string, unknown>).account_id).toBe(t.ids.accounts.company);
  });

  it("approves when the previewed hash matches and snapshots the package", async () => {
    const id = await contentInReview(t, editor);
    const hash = await packageHash(t, id);
    const approvalId = await t.api<string>("select lbe.decide_content($1, $2, $3, 'approved', null)", [approver, id, hash]);
    expect(await status(id)).toBe("approved");
    const [a] = await t.db.query<{ package_hash: string; package: unknown }>(
      "select package_hash, package from lbe.content_approvals where id = $1", [approvalId]);
    expect(a!.package_hash).toBe(hash);
    expect(a!.package).toEqual((await t.db.query<{ package: unknown }>(
      "select package from lbe.content_items where id = $1", [id]))[0]!.package);
  });

  it("rejects an approval made against a stale preview", async () => {
    const id = await contentInReview(t, editor);
    await expectCode(t.api("select lbe.decide_content($1, $2, $3, 'approved', null)", [approver, id, "0".repeat(64)]), "LBE01");
  });

  for (const [field, patch] of [
    ["body", { body: "[SYNTHETIC] ActTrident is a UK-registered cybersecurity company. Edited." }],
    ["visibility", { visibility: "CONNECTIONS" }],
    ["scheduled_for", { scheduled_for: "2030-01-01T09:00:00Z" }],
    // media_ids: covered in tests/db/media-assets.test.ts (only real attached visuals are accepted since P5-03)
  ] as const) {
    it(`editing ${field} after approval invalidates the approval`, async () => {
      const id = await contentInReview(t, editor);
      const hash = await packageHash(t, id);
      await t.api("select lbe.decide_content($1, $2, $3, 'approved', null)", [approver, id, hash]);
      await t.api("select lbe.update_content($1, $2, $3::jsonb)", [editor, id, JSON.stringify(patch)]);
      expect(await status(id)).toBe("draft");
      expect(await packageHash(t, id)).not.toBe(hash);
      await expectCode(t.api("select lbe.enqueue_publication($1, $2)", [approver, id]), "LBE01");
    });
  }

  it("editing a non-package field (brief) does not invalidate approval", async () => {
    const id = await contentInReview(t, editor);
    const hash = await packageHash(t, id);
    await t.api("select lbe.decide_content($1, $2, $3, 'approved', null)", [approver, id, hash]);
    await t.api("select lbe.update_content($1, $2, $3::jsonb)", [editor, id, JSON.stringify({ brief: "new brief" })]);
    expect(await status(id)).toBe("approved");
  });

  it("changing claim citations invalidates the approval", async () => {
    const id = await contentInReview(t, editor);
    const hash = await packageHash(t, id);
    await t.api("select lbe.decide_content($1, $2, $3, 'approved', null)", [approver, id, hash]);
    await t.api("select lbe.set_draft_output($1, $2, $3, '[]'::jsonb, '[]'::jsonb)", [editor, id,
      "[SYNTHETIC] ActTrident is a UK-registered cybersecurity company. Here is what we learned this week."]);
    expect(await status(id)).toBe("draft");
  });

  it("changing the destination account URN invalidates approved content", async () => {
    const id = await contentInReview(t, editor);
    const hash = await packageHash(t, id);
    await t.api("select lbe.decide_content($1, $2, $3, 'approved', null)", [approver, id, hash]);
    await t.db.query("update lbe.social_accounts set linkedin_urn = 'urn:li:organization:000000' where id = $1",
      [t.ids.accounts.company]);
    expect(await status(id)).toBe("draft");
    await t.db.query("update lbe.social_accounts set linkedin_urn = null where id = $1", [t.ids.accounts.company]);
  });

  it("cannot submit content with unsupported factual statements", async () => {
    const id = await t.api<string>("select lbe.create_content($1, $2, 'threat-landscape', 'b', null, null)",
      [editor, t.ids.accounts.company]);
    await t.api("select lbe.set_draft_output($1, $2, 'We stop 99% of attacks.', '[]'::jsonb, $3::jsonb)",
      [editor, id, JSON.stringify(["We stop 99% of attacks."])]);
    await expectCode(t.api("select lbe.submit_for_review($1, $2)", [editor, id]), "LBE02");
  });

  it("cannot cite an unverified claim", async () => {
    const id = await t.api<string>("select lbe.create_content($1, $2, 'threat-landscape', 'b', null, null)",
      [editor, t.ids.accounts.company]);
    await expectCode(t.api("select lbe.set_draft_output($1, $2, 'x', $3::jsonb, '[]'::jsonb)",
      [editor, id, JSON.stringify([{ claim_id: t.ids.claims[3], quoted_span: "x" }])]), "LBE02");
  });

  it("citation must still appear verbatim in the body at submission", async () => {
    const id = await t.api<string>("select lbe.create_content($1, $2, 'threat-landscape', 'b', null, null)",
      [editor, t.ids.accounts.company]);
    await t.api("select lbe.set_draft_output($1, $2, 'Totally different text', $3::jsonb, '[]'::jsonb)",
      [editor, id, JSON.stringify([{ claim_id: t.ids.claims[0], quoted_span: "UK-registered" }])]);
    await expectCode(t.api("select lbe.submit_for_review($1, $2)", [editor, id]), "LBE02");
  });

  it("rejects content pillars that are not approved for the account", async () => {
    await expectCode(t.api("select lbe.create_content($1, $2, 'random-pillar', 'b', null, null)",
      [editor, t.ids.accounts.company]), "LBE02");
  });

  it("rejection and change requests require a note", async () => {
    const id = await contentInReview(t, editor);
    const hash = await packageHash(t, id);
    await expectCode(t.api("select lbe.decide_content($1, $2, $3, 'rejected', '')", [approver, id, hash]), "LBE02");
    await t.api("select lbe.decide_content($1, $2, $3, 'changes_requested', 'tighten the hook')", [approver, id, hash]);
    expect(await status(id)).toBe("changes_requested");
  });
});

describe("approval authority", () => {
  it("an editor cannot approve", async () => {
    const id = await contentInReview(t, editor);
    await expectCode(t.api("select lbe.decide_content($1, $2, $3, 'approved', null)",
      [editor, id, await packageHash(t, id)]), "LBE11");
  });

  it("the company approver cannot approve founder-profile content", async () => {
    const id = await contentInReview(t, editor, "founder");
    await expectCode(t.api("select lbe.decide_content($1, $2, $3, 'approved', null)",
      [approver, id, await packageHash(t, id)]), "LBE11");
  });

  it("the founder can approve founder-profile content", async () => {
    const id = await contentInReview(t, editor, "founder");
    await t.api("select lbe.decide_content($1, $2, $3, 'approved', null)", [founder, id, await packageHash(t, id)]);
    expect(await status(id)).toBe("approved");
  });

  it("an invalid or revoked session cannot act", async () => {
    const id = await contentInReview(t, editor);
    await expectCode(t.api("select lbe.decide_content($1, $2, $3, 'approved', null)",
      ["f".repeat(64), id, await packageHash(t, id)]), "LBE10");
    const s = await t.login("approver");
    await t.api("select lbe.logout($1)", [s]);
    await expectCode(t.api("select lbe.decide_content($1, $2, $3, 'approved', null)",
      [s, id, await packageHash(t, id)]), "LBE10");
  });
});

describe("service-role / direct SQL bypass protection (connection owner)", () => {
  it("cannot set status to approved without an approval row", async () => {
    const id = await contentInReview(t, editor);
    await expectCode(t.db.query("update lbe.content_items set status = 'approved' where id = $1", [id]), "LBE01");
  });

  it("cannot forge an approval for a different package", async () => {
    const id = await contentInReview(t, editor);
    await expectCode(t.db.query(
      `insert into lbe.content_approvals(content_id, decision, package_hash, package, approver_id)
       values ($1, 'approved', 'forged', '{}', $2)`, [id, t.ids.users.approver]), "LBE01");
  });

  it("cannot forge an approval by a non-approver user", async () => {
    const id = await contentInReview(t, editor);
    await expectCode(t.db.query(
      `insert into lbe.content_approvals(content_id, decision, package_hash, package, approver_id)
       values ($1, 'approved', $2, '{}', $3)`, [id, await packageHash(t, id), t.ids.users.editor]), "LBE11");
  });

  it("approval rows cannot be updated or deleted", async () => {
    const id = await contentInReview(t, editor);
    const approvalId = await t.api<string>("select lbe.decide_content($1, $2, $3, 'approved', null)",
      [approver, id, await packageHash(t, id)]);
    await expectCode(t.db.query("update lbe.content_approvals set decision = 'rejected' where id = $1", [approvalId]), "LBE01");
    await expectCode(t.db.query("delete from lbe.content_approvals where id = $1", [approvalId]), "LBE01");
  });

  it("cannot insert an outbox row for unapproved content", async () => {
    const id = await contentInReview(t, editor);
    const [anyApproval] = await t.db.query<{ id: string }>("select id from lbe.content_approvals limit 1");
    await expectCode(t.db.query(
      `insert into lbe.publication_outbox(content_id, account_id, approval_id, package, package_hash, idempotency_key)
       values ($1, $2, $3, '{}', 'x', 'x')`, [id, t.ids.accounts.company, anyApproval!.id]), "LBE01");
  });

  it("audit events are append-only", async () => {
    await expectCode(t.db.query("delete from lbe.audit_events"), "LBE01");
    await expectCode(t.db.query("update lbe.audit_events set actor = 'x'"), "LBE01");
  });

  it("verified claims cannot be edited", async () => {
    await expectCode(t.db.query("update lbe.claims set statement = 'changed' where id = $1", [t.ids.claims[0]]), "LBE01");
  });

  it("live publishing mode cannot be switched on directly (no credential → gate refuses)", async () => {
    await expectCode(t.db.query("update lbe.social_accounts set publishing_mode = 'live' where id = $1",
      [t.ids.accounts.company]), "LBE01");
  });
});
