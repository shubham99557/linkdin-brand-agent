import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import pg from "pg";

/** Database roles the application assumes per transaction. `null` = connection owner (migrations/CLI only). */
export type DbRole = "lbe_api" | "lbe_worker" | "lbe_agent" | null;

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  readonly kind: "pglite" | "pg";
  /** Run `fn` inside one transaction, after `SET LOCAL ROLE role` when a role is given. */
  tx<T>(role: DbRole, fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Execute a multi-statement SQL script inside a transaction (owner only). */
  execScript(sql: string): Promise<void>;
  close(): Promise<void>;
}

const ROLE_SQL: Record<Exclude<DbRole, null>, string> = {
  lbe_api: "set local role lbe_api",
  lbe_worker: "set local role lbe_worker",
  lbe_agent: "set local role lbe_agent",
};

class PgliteDb implements Db {
  readonly kind = "pglite" as const;
  constructor(private readonly pglite: PGlite) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pglite.query<T>(sql, params as never[]);
    return r.rows;
  }

  async tx<T>(role: DbRole, fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.pglite.transaction(async (t) => {
      if (role) await t.query(ROLE_SQL[role]);
      return fn({
        query: async <R>(sql: string, params: unknown[] = []) => (await t.query<R>(sql, params as never[])).rows,
      });
    });
  }

  async execScript(sql: string): Promise<void> {
    await this.pglite.transaction(async (t) => {
      await t.exec(sql);
    });
  }

  async close(): Promise<void> {
    await this.pglite.close();
  }
}

class NodePgDb implements Db {
  readonly kind = "pg" as const;
  constructor(private readonly pool: pg.Pool) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pool.query(sql, params);
    return r.rows as T[];
  }

  async tx<T>(role: DbRole, fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      if (role) await client.query(ROLE_SQL[role]);
      const result = await fn({
        query: async <R>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as R[],
      });
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async execScript(sql: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export interface DbConfig {
  /** `pglite` (embedded, default for local dev/tests) or a postgres:// URL. */
  url: string;
  /** Directory for PGlite persistence; omitted = in-memory. */
  dataDir?: string;
}

export async function openDb(cfg: DbConfig): Promise<Db> {
  if (cfg.url === "pglite") {
    if (cfg.dataDir) await mkdir(cfg.dataDir, { recursive: true });
    const pglite = await PGlite.create({ dataDir: cfg.dataDir, extensions: { pgcrypto } });
    return new PgliteDb(pglite);
  }
  if (!/^postgres(ql)?:\/\//.test(cfg.url)) {
    throw new Error("LBE_DATABASE_URL must be 'pglite' or a postgres:// URL");
  }
  return new NodePgDb(new pg.Pool({ connectionString: cfg.url, max: 10 }));
}

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../../supabase/migrations");

/** Apply pending migrations in filename order. Refuses to run if an applied file was modified. */
export async function migrate(db: Db, dir = MIGRATIONS_DIR, opts: { until?: string } = {}): Promise<string[]> {
  await db.query(`create table if not exists public.lbe_schema_migrations (
    version text primary key, checksum text not null, applied_at timestamptz not null default now())`);
  const applied = new Map(
    (await db.query<{ version: string; checksum: string }>("select version, checksum from public.lbe_schema_migrations"))
      .map((r) => [r.version, r.checksum]),
  );
  // `until` (inclusive) lets tests and operators stop at a given version, e.g. to rehearse an upgrade.
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()
    .filter((f) => !opts.until || f <= opts.until);
  const ran: string[] = [];
  for (const file of files) {
    const sql = await readFile(path.join(dir, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const prior = applied.get(file);
    if (prior) {
      if (prior !== checksum) throw new Error(`Migration ${file} was modified after being applied`);
      continue;
    }
    await db.execScript(
      `${sql}\n;insert into public.lbe_schema_migrations(version, checksum) values ('${file.replace(/'/g, "''")}', '${checksum}');`,
    );
    ran.push(file);
  }
  return ran;
}

/** Map database errors raised by our functions/triggers to HTTP semantics. */
export function dbErrorStatus(err: unknown): { status: number; message: string } | null {
  const e = err as { code?: string; message?: string };
  const map: Record<string, number> = {
    LBE01: 409, LBE02: 422, LBE03: 423, LBE04: 404, LBE10: 401, LBE11: 403, LBE12: 403,
    "23505": 409, "42501": 403,
  };
  if (e?.code && map[e.code]) {
    const message = e.code === "42501" ? "permission denied" : e.code === "23505" ? "duplicate" : (e.message ?? "error");
    return { status: map[e.code]!, message };
  }
  return null;
}
