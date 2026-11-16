/**
 * The outbox and its consumers.
 *
 * The app writes a job row in the same transaction as the assistant message, then (after commit)
 * publishes the job id to a Redis stream so a worker picks it up within milliseconds. Postgres is the
 * source of truth: the worker claims a job with an atomic UPDATE (so a job published twice runs once),
 * and a periodic sweep claims anything due that the stream missed (Redis down, crash, retry backoff,
 * expired lease). Jobs run as their user, under row-level security.
 */
import { hostname } from "node:os";
import { asUser, sys } from "../db/index";
import { blockingRedis, key, soft } from "../redis";
import { extractTurn } from "./extract";

const MAX_ATTEMPTS = 5;
const LEASE = "5 minutes";
export const STREAM = () => key("jobs");
export const GROUP = "workers";

export type JobRow = { id: string; user_id: string; type: string; payload: Record<string, string>; status: string; attempts: number };

const handlers: Record<string, (payload: Record<string, string>) => Promise<"done" | "skipped">> = {
  extract_turn: (p) => extractTurn(p.assistantMessageId!),
};

/** After commit: tell the workers. Best effort; the sweep covers a lost publish. */
export async function publishJob(jobId: string | null | undefined): Promise<void> {
  if (!jobId) return;
  await soft((r) => r.xadd(STREAM(), "MAXLEN", "~", "10000", "*", "job", jobId), null);
}

const CLAIM_SET = `status = 'running', attempts = attempts + 1, locked_until = now() + interval '${LEASE}'`;

/** Claim one specific job if it is due (from a stream message). */
export async function claimJob(id: string): Promise<JobRow | undefined> {
  return (
    await sys<JobRow>(
      `UPDATE jobs SET ${CLAIM_SET}
       WHERE id = $1 AND ((status = 'pending' AND run_after <= now()) OR (status = 'running' AND locked_until < now()))
       RETURNING id, user_id, type, payload, status, attempts`,
      [id],
    )
  )[0];
}

/** Claim the next due job, or a running job whose lease expired (its worker died). */
export async function claimNextDue(): Promise<JobRow | undefined> {
  return (
    await sys<JobRow>(
      `UPDATE jobs SET ${CLAIM_SET}
       WHERE id = (
         SELECT id FROM jobs
         WHERE (status = 'pending' AND run_after <= now()) OR (status = 'running' AND locked_until < now())
         ORDER BY run_after LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING id, user_id, type, payload, status, attempts`,
    )
  )[0];
}

/** Run one claimed job as its user and record the outcome. Never throws. */
export async function runJob(job: JobRow): Promise<void> {
  const handler = handlers[job.type];
  try {
    if (!handler) throw new Error(`unknown job type ${job.type}`);
    const status = await asUser(job.user_id, () => handler(job.payload));
    await sys("UPDATE jobs SET status = $2, last_error = NULL, locked_until = NULL WHERE id = $1", [job.id, status]);
  } catch (err) {
    const e = err as { status?: number; message?: string };
    const message = (e.message ?? String(err)).slice(0, 1000);
    // Rate limits (e.g. free-tier requests/minute) back off longer than other errors.
    const backoffMs = e.status === 429 ? 20_000 * job.attempts : 2 ** job.attempts * 1000;
    const final = job.attempts >= MAX_ATTEMPTS;
    console.warn(`[jobs] ${job.type} ${job.id} attempt ${job.attempts} failed${final ? " (giving up: dead-lettered)" : ""}: ${message.slice(0, 160)}`);
    await sys(
      `UPDATE jobs SET status = $2, last_error = $3, locked_until = NULL, run_after = now() + ($4::int * interval '1 millisecond') WHERE id = $1`,
      [job.id, final ? "failed" : "pending", message, backoffMs],
    );
  }
}

/** Run every job that is due right now. Returns how many ran. */
export async function drainDue(): Promise<number> {
  let n = 0;
  for (let job = await claimNextDue(); job; job = await claimNextDue()) {
    await runJob(job);
    n++;
  }
  return n;
}

export async function pendingJobCount(): Promise<number> {
  return (await sys<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending', 'running')"))[0]!.n;
}

/** For scripts (seed, eval) with no worker running: drain until nothing is pending. */
export async function drainAll(timeoutMs = 120_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while ((await pendingJobCount()) > 0 && Date.now() < until) {
    if ((await drainDue()) === 0) await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * The worker loop: block on the Redis stream for new job ids, and sweep Postgres every few seconds.
 * Several workers can run side by side (docker compose up --scale worker=3).
 */
export async function runWorker(opts: { signal: AbortSignal; sweepMs?: number }): Promise<void> {
  const consumer = `${hostname()}-${process.pid}`;
  const r = blockingRedis();
  r.on("error", () => {});
  const ensureGroup = () =>
    r.xgroup("CREATE", STREAM(), GROUP, "$", "MKSTREAM").catch((e: Error) => {
      if (!/BUSYGROUP/.test(e.message)) console.warn(`[worker] xgroup: ${e.message}`);
    });
  await ensureGroup();
  let lastSweep = 0;
  const sweepMs = opts.sweepMs ?? 5000;
  console.log(`[worker] ${consumer} listening on ${STREAM()}`);
  while (!opts.signal.aborted) {
    try {
      const res = (await r.xreadgroup("GROUP", GROUP, consumer, "COUNT", 10, "BLOCK", 2000, "STREAMS", STREAM(), ">")) as
        | Array<[string, Array<[string, string[]]>]>
        | null;
      for (const [, entries] of res ?? []) {
        for (const [entryId, fields] of entries) {
          const jobId = fields[fields.indexOf("job") + 1];
          const job = jobId ? await claimJob(jobId) : undefined;
          if (job) await runJob(job);
          await r.xack(STREAM(), GROUP, entryId);
        }
      }
    } catch (err) {
      if (opts.signal.aborted) break;
      // Redis restarted without persistence: the stream and group are gone; recreate them.
      if (/NOGROUP/.test((err as Error).message)) {
        await ensureGroup();
        continue;
      }
      console.warn(`[worker] stream read failed (${(err as Error).message}); relying on the Postgres sweep`);
      await new Promise((res) => setTimeout(res, 2000));
    }
    if (Date.now() - lastSweep > sweepMs) {
      lastSweep = Date.now();
      try {
        const n = await drainDue();
        if (n) console.log(`[worker] sweep ran ${n} job(s)`);
      } catch (err) {
        console.warn(`[worker] sweep failed: ${(err as Error).message}`);
      }
    }
  }
  r.disconnect();
}
