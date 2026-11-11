/** Durable job queue in SQLite, drained in-process after each response and on boot. Never blocks a reply. */
import { claimNextJob, failJob, finishJob, pendingJobCount, resetRunningJobs } from "../db/repo";
import { extractTurn } from "./extract";

const MAX_ATTEMPTS = 5;
const g = globalThis as unknown as { __minichatJobs?: { running: boolean; booted: boolean; timer?: NodeJS.Timeout } };
const state = (g.__minichatJobs ??= { running: false, booted: false });

const handlers: Record<string, (payload: Record<string, string>) => Promise<"done" | "skipped">> = {
  extract_turn: (p) => extractTurn(p.assistantMessageId!),
};

/** Schedule a drain on the next tick. Safe to call often. */
export function kickJobs(): void {
  if (!state.booted) {
    state.booted = true;
    resetRunningJobs(); // jobs left running by a crashed process
  }
  if (state.running) return;
  setImmediate(() => void drain());
}

/** Process jobs until none are due. Returns when the queue is empty or only has backed-off jobs. */
export async function drain(): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    for (let job = claimNextJob(); job; job = claimNextJob()) {
      const handler = handlers[job.type];
      try {
        if (!handler) throw new Error(`unknown job type ${job.type}`);
        finishJob(job.id, await handler(JSON.parse(job.payload)));
      } catch (err) {
        const e = err as { status?: number; message?: string };
        const rateLimited = e.status === 429;
        console.warn(`[jobs] ${job.type} ${job.id} attempt ${job.attempts} failed: ${(e.message ?? String(err)).slice(0, 160)}`);
        // Rate limits (e.g. free-tier requests/minute) back off longer than other errors.
        failJob(job.id, e.message ?? String(err), job.attempts, MAX_ATTEMPTS, rateLimited ? 20_000 * job.attempts : 2 ** job.attempts * 1000);
      }
    }
  } finally {
    state.running = false;
  }
  // Retry backed-off jobs later.
  if (pendingJobCount() > 0 && !state.timer) {
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void drain();
    }, 10_000);
  }
}

/** For scripts: drain until everything pending is done or failed. */
export async function drainAll(timeoutMs = 120_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (pendingJobCount() > 0 && Date.now() < until) {
    await drain();
    if (pendingJobCount() > 0) await new Promise((r) => setTimeout(r, 1000));
  }
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
}
