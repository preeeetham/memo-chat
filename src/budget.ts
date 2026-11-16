/**
 * Per-user rate limits and daily token budgets, counted in Redis so every app instance shares them.
 * If Redis is unreachable, each process counts on its own (looser, but a turn never fails for it).
 */
import { config } from "./config";
import { maybeUserId } from "./db/index";
import { soft, userKey } from "./redis";

const memory = new Map<string, { n: number; expires: number }>();

function memIncr(k: string, by: number, ttlSec: number): number {
  const nowMs = Date.now();
  const cur = memory.get(k);
  const entry = cur && cur.expires > nowMs ? cur : { n: 0, expires: nowMs + ttlSec * 1000 };
  entry.n += by;
  memory.set(k, entry);
  if (memory.size > 10_000) for (const [mk, v] of memory) if (v.expires <= nowMs) memory.delete(mk);
  return entry.n;
}

/** Atomic counter with expiry. */
async function incr(k: string, by: number, ttlSec: number): Promise<number> {
  const r = await soft(async (redis) => {
    const res = await redis.multi().incrby(k, by).expire(k, ttlSec, "NX").exec();
    return Number(res?.[0]?.[1] ?? NaN);
  }, NaN);
  return Number.isFinite(r) ? r : memIncr(k, by, ttlSec);
}

async function read(k: string): Promise<number> {
  const r = await soft((redis) => redis.get(k), null);
  if (r !== null) return Number(r);
  const m = memory.get(k);
  return m && m.expires > Date.now() ? m.n : 0;
}

const today = () => new Date().toISOString().slice(0, 10);

export type Admission = { ok: true } | { ok: false; status: 429; message: string; retryAfterSec: number };

/** Called before a turn starts: requests per minute, then the daily token budget. */
export async function admitTurn(userId: string): Promise<Admission> {
  const { requestsPerMinute, dailyTokens } = config().budgets;
  if (requestsPerMinute > 0) {
    const minute = Math.floor(Date.now() / 60_000);
    const n = await incr(userKey(userId, "rpm", String(minute)), 1, 90);
    if (n > requestsPerMinute)
      return { ok: false, status: 429, message: `You're sending messages faster than ${requestsPerMinute} a minute. Wait a moment and try again.`, retryAfterSec: 60 - (Math.floor(Date.now() / 1000) % 60) };
  }
  if (dailyTokens > 0) {
    const used = await read(userKey(userId, "tokens", today()));
    if (used >= dailyTokens)
      return { ok: false, status: 429, message: `You've used today's token budget (${dailyTokens.toLocaleString("en-US")} tokens). It resets at midnight UTC.`, retryAfterSec: secondsToUtcMidnight() };
  }
  return { ok: true };
}

/** Meter tokens to the current user (from the request or job context). No-op outside a user. */
export async function recordTokens(tokens: number | undefined | null, userId: string | null = maybeUserId()): Promise<void> {
  if (!userId || !tokens || tokens <= 0) return;
  await incr(userKey(userId, "tokens", today()), Math.round(tokens), 2 * 86_400);
}

export async function tokensUsedToday(userId: string): Promise<number> {
  return read(userKey(userId, "tokens", today()));
}

function secondsToUtcMidnight(): number {
  const d = new Date();
  return Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - d.getTime()) / 1000);
}
