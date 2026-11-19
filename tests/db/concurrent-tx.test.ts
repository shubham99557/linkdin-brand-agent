// P4-05 precondition: overlapping work in one process (pipelined drafting, API requests, the publisher worker)
// shares one PGlite instance. Concurrent transactions must never interleave on it: no role leaking from one
// transaction into another, and a failing transaction never rolls back another one's work.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../helpers/db.ts";

let t: TestDb;
beforeAll(async () => { t = await freshDb(); });
afterAll(async () => t.db.close());

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("concurrent transactions on one database handle", () => {
  it("each transaction keeps its own role even when another is mid-flight", async () => {
    const seen: string[] = [];
    const slowAgent = t.db.tx("lbe_agent", async (q) => {
      seen.push(`agent-start:${(await q.query<{ u: string }>("select current_user as u"))[0]!.u}`);
      await pause(30);                                                     // yields while the transaction is open
      seen.push(`agent-end:${(await q.query<{ u: string }>("select current_user as u"))[0]!.u}`);
    });
    const api = t.db.tx("lbe_api", async (q) => {
      seen.push(`api:${(await q.query<{ u: string }>("select current_user as u"))[0]!.u}`);
    });
    const worker = t.db.tx("lbe_worker", async (q) => {
      await pause(5);
      seen.push(`worker:${(await q.query<{ u: string }>("select current_user as u"))[0]!.u}`);
    });
    await Promise.all([slowAgent, api, worker]);
    expect(seen).toContain("agent-start:lbe_agent");
    expect(seen).toContain("agent-end:lbe_agent");
    expect(seen).toContain("api:lbe_api");
    expect(seen).toContain("worker:lbe_worker");
    // After all of them, the connection is back to its owner (no role left set).
    const [after] = await t.db.query<{ u: string }>("select current_user as u");
    expect(after!.u).not.toMatch(/^lbe_(agent|api|worker)$/);
  });

  it("a failing transaction does not roll back a concurrent one", async () => {
    await t.db.query("create table if not exists public.tx_probe (n int)");
    const failing = t.db.tx(null, async (q) => {
      await q.query("insert into public.tx_probe values (1)");
      await pause(20);
      throw new Error("boom");
    }).catch((e: Error) => e.message);
    const ok = t.db.tx(null, async (q) => { await q.query("insert into public.tx_probe values (2)"); });
    expect(await failing).toBe("boom");
    await ok;
    const rows = await t.db.query<{ n: number }>("select n from public.tx_probe order by n");
    expect(rows.map((r) => r.n)).toEqual([2]);
  });
});
