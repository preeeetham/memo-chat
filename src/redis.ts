/**
 * Redis: caches, rate limits and token budgets, SSE stream buffers, and the job queue.
 * Redis is an accelerator, not a source of truth: if it is down, caches are skipped, limits fall
 * back to per-process counters, and the worker's Postgres sweep still picks up every job.
 * User-scoped keys always start with u:<user_id>: so no cache entry can cross tenants.
 */
import { Redis } from "ioredis";
import { config } from "./config";

const g = globalThis as unknown as { __memochatRedis?: { url: string; client: Redis; settled: boolean } };

export function redis(): Redis {
  const url = config().redisUrl;
  if (g.__memochatRedis?.url === url) return g.__memochatRedis.client;
  g.__memochatRedis?.client.disconnect();
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
    connectTimeout: 2000,
    retryStrategy: (n) => Math.min(n * 500, 5000),
  });
  // settled: the first connection attempt has succeeded or failed; after that we never wait for Redis.
  const entry = { url, client, settled: false };
  let warned = false;
  client.on("error", (err) => {
    if (!warned) console.warn(`[redis] ${err.message} (continuing without Redis where possible)`);
    warned = true;
    entry.settled = true;
  });
  client.on("ready", () => {
    warned = false;
    entry.settled = true;
  });
  g.__memochatRedis = entry;
  return client;
}

/** A dedicated connection for blocking reads (XREAD BLOCK would stall every other command). */
export function blockingRedis(): Redis {
  return redis().duplicate();
}

export async function closeRedis(): Promise<void> {
  const c = g.__memochatRedis?.client;
  g.__memochatRedis = undefined;
  await c?.quit().catch(() => c.disconnect());
}

export const key = (...parts: string[]) => config().redisPrefix + parts.join(":");
export const userKey = (userId: string, ...parts: string[]) => key("u", userId, ...parts);

/**
 * Is Redis usable right now? While it is down we answer at once (no per-call timeout), so an outage
 * costs nothing on the request path. Only the very first connection is waited for, briefly.
 */
async function usable(r: Redis): Promise<boolean> {
  if (r.status === "ready") return true;
  if (g.__memochatRedis?.settled || r.status === "end") return false;
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      r.off("ready", onReady);
      r.off("error", onError);
      resolve(ok);
    };
    const onReady = () => done(true);
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), 1000);
    r.once("ready", onReady);
    r.once("error", onError);
  });
}

/** Run a Redis call; on any error return the fallback (Redis down never fails a request). */
export async function soft<T>(fn: (r: Redis) => Promise<T>, fallback: T, timeoutMs = 1500): Promise<T> {
  try {
    const r = redis();
    if (!(await usable(r))) return fallback;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), timeoutMs)));
    try {
      return await Promise.race([fn(r), timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return fallback;
  }
}

/** JSON cache helpers. */
export async function cacheGet<T>(k: string): Promise<T | null> {
  const raw = await soft((r) => r.get(k), null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function cacheSet(k: string, value: unknown, ttlSeconds: number): Promise<void> {
  await soft((r) => r.set(k, JSON.stringify(value), "EX", ttlSeconds), null);
}
