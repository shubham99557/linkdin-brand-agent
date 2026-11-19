import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentInReview, expectCode, freshDb, packageHash, type TestDb } from "../helpers/db.ts";

let t: TestDb;
let editor: string;
let approver: string;
let admin: string;
let founder: string;

beforeAll(async () => {
  t = await freshDb();
  [editor, approver, admin, founder] = await Promise.all(
    [t.login("editor"), t.login("approver"), t.login("admin"), t.login("founder")]);
});
afterAll(async () => t.db.close());

interface Outbox { id: string; status: string; attempts: number; content_id: string; available_at: string }

async function approvedAndQueued(account: "company" | "founder" = "company") {
  const id = await contentInReview(t, editor, account);
  const who = account === "company" ? approver : founder;
  await t.api("select lbe.decide_content($1, $2, $3, 'approved', null)", [who, id, await packageHash(t, id)]);
  const outboxId = await t.api<string>("select lbe.enqueue_publication($1, $2)", [who, id]);
  return { id, outboxId };
}
const claim = (worker = "w1", limit = 10) =>
  t.worker<Outbox>("select * from lbe.claim_outbox($1, $2, 60, array['mock'])", [worker, limit]);
const complete = (id: string, outcome: string, ref: string | null = null, worker = "w1", retryAfter: number | null = null) =>
  t.worker<Outbox>("select * from lbe.complete_outbox($1, $2, $3, $4, 'test', $5)", [id, worker, outcome, ref, retryAfter]);
const contentStatus = async (id: string) =>
  (await t.db.query<{ status: string }>("select status from lbe.content_items where id = $1", [id]))[0]!.status;
const outbox = async (id: string) =>
  (await t.db.query<Outbox>("select * from lbe.publication_outbox where id = $1", [id]))[0]!;
const drain = async () => {
  // Clear any due entries left by earlier tests so each test sees only its own.
  for (const o of await claim("drain", 50)) await complete(o.id, "success", `drain-${o.id}`, "drain");
};

describe("outbox creation", () => {
  it("enqueue creates exactly one pending entry and locks the content", async () => {
    const { id, outboxId } = await approvedAndQueued();
    expect((await outbox(outboxId)).status).toBe("pending");
    expect(await contentStatus(id)).toBe("queued");
    await expectCode(t.api("select lbe.update_content($1, $2, '{\"body\":\"x\"}'::jsonb)", [editor, id]), "LBE01");
  });

  it("a second enqueue for the same content is refused (duplicate protection)", async () => {
    const { id } = await approvedAndQueued();
    await expectCode(t.api("select lbe.enqueue_publication($1, $2)", [approver, id]), "LBE01");
    const rows = await t.db.query("select 1 from lbe.publication_outbox where content_id = $1", [id]);
    expect(rows).toHaveLength(1);
  });

  it("only the account's approvers can enqueue", async () => {
    const id = await contentInReview(t, editor, "founder");
    await t.api("select lbe.decide_content($1, $2, $3, 'approved', null)", [founder, id, await packageHash(t, id)]);
    await expectCode(t.api("select lbe.enqueue_publication($1, $2)", [approver, id]), "LBE11");
  });
});

describe("dispatch lifecycle", () => {
  it("success publishes the content with the provider reference", async () => {
    await drain();
    const { id, outboxId } = await approvedAndQueued();
    const claimed = await claim();
    expect(claimed.map((o) => o.id)).toEqual([outboxId]);
    await complete(outboxId, "success", "urn:li:share:mock-1");
    expect((await outbox(outboxId)).status).toBe("succeeded");
    expect(await contentStatus(id)).toBe("published");
  });

  it("a claimed entry is not claimed twice", async () => {
    await drain();
    const { outboxId } = await approvedAndQueued();
    expect((await claim("w1")).map((o) => o.id)).toEqual([outboxId]);
    expect(await claim("w2")).toEqual([]);
    await complete(outboxId, "success", "urn:li:share:mock-2");
  });

  it("another worker cannot complete a leased entry", async () => {
    await drain();
    const { outboxId } = await approvedAndQueued();
    await claim("w1");
    await expectCode(complete(outboxId, "success", "r", "w2"), "LBE01");
    await complete(outboxId, "success", "urn:li:share:mock-3", "w1");
  });

  it("retryable failure schedules a backoff retry", async () => {
    await drain();
    const { id, outboxId } = await approvedAndQueued();
    await claim();
    await complete(outboxId, "retryable", null, "w1", 120);
    const o = await outbox(outboxId);
    expect(o.status).toBe("pending");
    expect(new Date(o.available_at).getTime()).toBeGreaterThan(Date.now() + 100_000);
    expect(await contentStatus(id)).toBe("queued");
    expect(await claim()).toEqual([]);   // not due yet
  });

  it("exceeding max attempts fails the publication", async () => {
    await drain();
    const { id, outboxId } = await approvedAndQueued();
    for (let i = 0; i < 5; i++) {
      await t.db.query("update lbe.publication_outbox set available_at = now() where id = $1", [outboxId]);
      expect((await claim()).map((o) => o.id)).toEqual([outboxId]);
      await complete(outboxId, "retryable");
    }
    expect((await outbox(outboxId)).status).toBe("failed");
    expect(await contentStatus(id)).toBe("failed");
  });

  it("ambiguous result goes to reconciliation and is never retried automatically", async () => {
    await drain();
    const { id, outboxId } = await approvedAndQueued();
    await claim();
    await complete(outboxId, "ambiguous");
    expect((await outbox(outboxId)).status).toBe("needs_reconciliation");
    expect(await contentStatus(id)).toBe("needs_reconciliation");
    await t.db.query("update lbe.publication_outbox set available_at = now() - interval '1 hour' where id = $1", [outboxId]);
    expect(await claim()).toEqual([]);
  });

  it("expired lease is treated as ambiguous, not retried", async () => {
    await drain();
    const { outboxId } = await approvedAndQueued();
    await claim();
    await t.db.query("update lbe.publication_outbox set lease_expires_at = now() - interval '1 second' where id = $1", [outboxId]);
    const n = await t.worker<{ expire_stale_dispatches: number }>("select lbe.expire_stale_dispatches('w1')");
    expect(n[0]!.expire_stale_dispatches).toBe(1);
    expect((await outbox(outboxId)).status).toBe("needs_reconciliation");
  });

  it("only an admin can reconcile; confirmed_not_published re-queues", async () => {
    await drain();
    const { id, outboxId } = await approvedAndQueued();
    await claim();
    await complete(outboxId, "ambiguous");
    await expectCode(t.api("select lbe.reconcile_publication($1, $2, 'confirmed_not_published', null, 'checked')",
      [approver, outboxId]), "LBE11");
    await t.api("select lbe.reconcile_publication($1, $2, 'confirmed_not_published', null, 'checked mock store')",
      [admin, outboxId]);
    expect((await outbox(outboxId)).status).toBe("pending");
    expect(await contentStatus(id)).toBe("queued");
  });

  it("reconcile confirmed_published requires a provider reference", async () => {
    await drain();
    const { id, outboxId } = await approvedAndQueued();
    await claim();
    await complete(outboxId, "ambiguous");
    await expectCode(t.api("select lbe.reconcile_publication($1, $2, 'confirmed_published', '', 'seen')",
      [admin, outboxId]), "LBE02");
    await t.api("select lbe.reconcile_publication($1, $2, 'confirmed_published', 'urn:li:share:found', 'seen it')",
      [admin, outboxId]);
    expect(await contentStatus(id)).toBe("published");
  });

  it("cancel returns content to approved", async () => {
    await drain();
    const { id, outboxId } = await approvedAndQueued();
    await t.api("select lbe.cancel_publication($1, $2)", [approver, outboxId]);
    expect((await outbox(outboxId)).status).toBe("cancelled");
    expect(await contentStatus(id)).toBe("approved");
  });

  it("owner cannot jump an outbox entry straight to succeeded", async () => {
    await drain();
    const { outboxId } = await approvedAndQueued();
    await expectCode(t.db.query(
      "update lbe.publication_outbox set status = 'succeeded', provider_ref = 'x' where id = $1", [outboxId]), "LBE01");
    await expectCode(t.db.query("delete from lbe.publication_outbox where id = $1", [outboxId]), "LBE01");
    await t.api("select lbe.cancel_publication($1, $2)", [approver, outboxId]);
  });
});

describe("STOP controls", () => {
  it("global STOP prevents claiming; resume allows it", async () => {
    await drain();
    const { outboxId } = await approvedAndQueued();
    await t.api("select lbe.set_stop($1, 'global', true, 'incident drill')", [editor]);
    expect(await claim()).toEqual([]);
    await expectCode(t.api("select lbe.set_stop($1, 'global', false, 'resume')", [approver]), "LBE11");
    await t.api("select lbe.set_stop($1, 'global', false, 'drill over')", [admin]);
    expect((await claim()).map((o) => o.id)).toEqual([outboxId]);
    await complete(outboxId, "success", "urn:li:share:after-stop");
  });

  it("account STOP blocks only that account", async () => {
    await drain();
    const company = await approvedAndQueued("company");
    const founderItem = await approvedAndQueued("founder");
    await t.api("select lbe.set_stop($1, $2, true, 'founder travelling')", [founder, `account:${t.ids.accounts.founder}`]);
    expect((await claim()).map((o) => o.id)).toEqual([company.outboxId]);
    await complete(company.outboxId, "success", "urn:li:share:company-ok");
    await t.api("select lbe.set_stop($1, $2, false, 'back')", [admin, `account:${t.ids.accounts.founder}`]);
    expect((await claim()).map((o) => o.id)).toEqual([founderItem.outboxId]);
    await complete(founderItem.outboxId, "success", "urn:li:share:founder-ok");
  });

  it("STOP is enforced in the database even for the connection owner", async () => {
    await drain();
    const { outboxId } = await approvedAndQueued();
    await t.api("select lbe.set_stop($1, 'global', true, 'bypass test')", [admin]);
    await expectCode(t.db.query("update lbe.publication_outbox set status = 'dispatching' where id = $1", [outboxId]), "LBE03");
    await t.api("select lbe.set_stop($1, 'global', false, 'done')", [admin]);
    await t.api("select lbe.cancel_publication($1, $2)", [approver, outboxId]);
  });

  it("disabling an account also stops its publishing", async () => {
    await drain();
    const { outboxId } = await approvedAndQueued();
    await t.db.query("update lbe.social_accounts set enabled = false where id = $1", [t.ids.accounts.company]);
    expect(await claim()).toEqual([]);
    await t.db.query("update lbe.social_accounts set enabled = true where id = $1", [t.ids.accounts.company]);
    await t.api("select lbe.cancel_publication($1, $2)", [approver, outboxId]);
  });

  it("a STOP requires a reason and is audited", async () => {
    await expectCode(t.api("select lbe.set_stop($1, 'global', true, '')", [editor]), "LBE02");
    await t.api("select lbe.set_stop($1, 'global', true, 'audit check')", [editor]);
    await t.api("select lbe.set_stop($1, 'global', false, 'audit check done')", [admin]);
    const rows = await t.db.query<{ action: string }>(
      "select action from lbe.audit_events where subject_type = 'control_flag' and details->>'reason' like 'audit check%' order by id");
    expect(rows.map((r) => r.action)).toEqual(["control.stop", "control.resume"]);
  });
});
