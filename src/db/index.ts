/**
 * Postgres access. Every user-scoped query runs inside a transaction that first sets app.user_id,
 * which is what the row-level security policies check. The current user lives in AsyncLocalStorage,
 * set once per request (from the verified token) or per job (by the worker), so repo functions
 * cannot forget it, and there is no way to pass a different user id per query.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { config } from "../config";

// timestamptz -> ISO string, date -> "YYYY-MM-DD" (the code compares these as strings).
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString());
pg.types.setTypeParser(1114, (v) => new Date(`${v}Z`).toISOString());
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v)); // bigint counts

type Ctx = { userId: string; client?: pg.PoolClient };
const als = new AsyncLocalStorage<Ctx>();
const g = globalThis as unknown as { __memochatPool?: { url: string; pool: pg.Pool } };

export function pool(): pg.Pool {
  const url = config().databaseUrl;
  if (g.__memochatPool?.url === url) return g.__memochatPool.pool;
  void g.__memochatPool?.pool.end().catch(() => {});
  const p = new pg.Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX || 10), idleTimeoutMillis: 30_000 });
  p.on("error", (err) => console.warn("[db] idle client error", err.message));
  g.__memochatPool = { url, pool: p };
  return p;
}

export async function closePool(): Promise<void> {
  const p = g.__memochatPool?.pool;
  g.__memochatPool = undefined;
  await p?.end();
}

/** Run fn as this user. All repo calls inside see only this user's rows. */
export function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  if (!userId) throw new Error("asUser: empty user id");
  return als.run({ userId }, fn);
}

export function currentUserId(): string {
  const id = als.getStore()?.userId;
  if (!id) throw new Error("No user in context: wrap the call in asUser()");
  return id;
}

export function maybeUserId(): string | null {
  return als.getStore()?.userId ?? null;
}

export type Q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

/** One transaction as the current user. Nested calls reuse the outer transaction. */
export async function tx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  const ctx = als.getStore();
  if (!ctx) throw new Error("No user in context: wrap the call in asUser()");
  if (ctx.client) {
    const c = ctx.client;
    return fn(async (sql, params) => (await c.query(sql, params)).rows);
  }
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [ctx.userId]);
    const result = await als.run({ ...ctx, client }, () => fn(async (sql, params) => (await client.query(sql, params)).rows));
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** A single query as the current user. */
export function q<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
  return tx((run) => run<T>(sql, params));
}

/** System queries outside any user (the jobs table, health checks). Never touches user-owned tables: RLS hides them. */
export async function sys<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
  return (await pool().query(sql, params)).rows as T[];
}
