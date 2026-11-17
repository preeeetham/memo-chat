/**
 * Turn stream buffer. Every SSE event of a turn is also appended to a Redis stream, keyed by user and
 * turn, so a client whose connection drops can resume from its last event id on any app instance
 * (the turn keeps running and is saved either way). Stop requests go through Redis too, so the
 * Stop button works whichever instance is running the turn.
 */
import { blockingRedis, soft, userKey } from "./redis";
import type { ChatEvent } from "./sse";

const TTL_SECONDS = 15 * 60;
const streamKey = (userId: string, turnId: string) => userKey(userId, "turn", turnId);
const stopKey = (userId: string, turnId: string) => userKey(userId, "turn", turnId, "stop");

/** In-process registry so a stop on the same instance is immediate. */
const g = globalThis as unknown as { __memochatTurns?: Map<string, AbortController> };
const running = (g.__memochatTurns ??= new Map());

export class TurnBuffer {
  private seq = 0;
  private turnId: string | null = null;
  private pending: Array<{ seq: number; e: ChatEvent }> = [];
  private stopTimer: NodeJS.Timeout | undefined;

  constructor(
    private userId: string,
    private abort: AbortController,
  ) {}

  /** Record an event; returns its sequence number (the SSE id). */
  push(e: ChatEvent): number {
    const seq = ++this.seq;
    if (e.type === "start") this.begin(e.assistantMessageId);
    if (this.turnId) this.append(seq, e);
    else this.pending.push({ seq, e });
    return seq;
  }

  private begin(turnId: string): void {
    this.turnId = turnId;
    running.set(`${this.userId}:${turnId}`, this.abort);
    // Poll for a stop issued on another instance.
    this.stopTimer = setInterval(() => {
      void soft((r) => r.exists(stopKey(this.userId, turnId)), 0).then((n) => {
        if (n) this.abort.abort();
      });
    }, 1000);
    for (const p of this.pending.splice(0)) this.append(p.seq, p.e);
  }

  private append(seq: number, e: ChatEvent): void {
    const k = streamKey(this.userId, this.turnId!);
    // Explicit ids 0-<seq> keep Redis ids equal to SSE ids. Commands on one connection run in order.
    void soft((r) => r.multi().xadd(k, `0-${seq}`, "e", JSON.stringify(e)).expire(k, TTL_SECONDS).exec(), null);
  }

  close(): void {
    clearInterval(this.stopTimer);
    if (this.turnId) running.delete(`${this.userId}:${this.turnId}`);
  }
}

/** Stop a running turn (this instance immediately, others within a second). */
export async function requestStop(userId: string, turnId: string): Promise<void> {
  running.get(`${userId}:${turnId}`)?.abort();
  await soft((r) => r.set(stopKey(userId, turnId), "1", "EX", TTL_SECONDS), null);
}

/** Does this user have a buffered stream for this turn? (Another user's turn id finds nothing.) */
export async function turnExists(userId: string, turnId: string): Promise<boolean> {
  return (await soft((r) => r.exists(streamKey(userId, turnId)), 0)) > 0;
}

/**
 * Replay a turn's events after `afterSeq`, then follow it live until it ends (done/error),
 * the client goes away, or nothing arrives for a while.
 */
export async function replayTurn(
  userId: string,
  turnId: string,
  afterSeq: number,
  onEvent: (seq: number, e: ChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const k = streamKey(userId, turnId);
  const blocking = blockingRedis();
  blocking.on("error", () => {});
  let last = `0-${afterSeq}`;
  let idleSince = Date.now();
  try {
    while (!signal.aborted && Date.now() - idleSince < 120_000) {
      const res = (await blocking.xread("COUNT", 200, "BLOCK", 5000, "STREAMS", k, last)) as Array<[string, Array<[string, string[]]>]> | null;
      for (const [, entries] of res ?? []) {
        for (const [id, fields] of entries) {
          last = id;
          idleSince = Date.now();
          const e = JSON.parse(fields[1]!) as ChatEvent;
          onEvent(Number(id.split("-")[1]), e);
          if (e.type === "done" || e.type === "error") return;
        }
      }
    }
  } finally {
    blocking.disconnect();
  }
}

