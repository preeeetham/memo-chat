/**
 * Planner: a small structured call on the helper model that classifies the turn and pulls out
 * time expressions, keywords and entities. It never blocks the turn: on timeout or error we use
 * a regex fallback, and time expressions are always backstopped by the deterministic finder.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { config } from "../config";
import { maybeUserId } from "../db/index";
import { cacheGet, cacheSet, userKey } from "../redis";
import { structured } from "../llm/client";
import { findTimeExpressions } from "../time/resolve";

export const Plan = z.object({
  task: z.enum(["chat", "lookup", "recall_only", "recall_and_verify", "research"]),
  needs_memory: z.boolean().describe("true if the user refers to an earlier conversation, outside the visible history"),
  time_expressions: z.array(z.string()).describe('verbatim spans like "on Monday", "last Tuesday", "3 November"'),
  topic_keywords: z.array(z.string()).describe('topic words useful to find the past conversation, e.g. "CRM", "Postgres hosting", "pricing"'),
  entities: z.array(z.string()).describe("named products/companies/people in this message"),
  needs_web: z.boolean().describe("true if answering needs current information from the web"),
});
export type Plan = z.infer<typeof Plan> & { source: "model" | "fallback" | "fast_path" };

const GREETING = /^\s*(hi|hey|hello|yo|thanks|thank you|thx|ok|okay|cool|great|nice|good (morning|evening|night)|bye|cheers)[\s!.?]*$/i;
const MEMORY_HINT =
  /\b(you said|you told|i asked|we (discussed|talked|decided|picked|chose|shortlisted)|earlier|before|last time|previous(ly)?|ago|last (mon|tue|wed|thu|fri|sat|sun|week|month)|yesterday|on (mon|tue|wed|thu|fri|sat|sun)|remember|your (answer|recommendation))/i;

export function isFastPath(text: string): boolean {
  return GREETING.test(text);
}

export function fallbackPlan(text: string): Plan {
  const time = findTimeExpressions(text);
  const needsMemory = time.length > 0 || MEMORY_HINT.test(text);
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}.+-]{2,}/gu) ?? [];
  return {
    task: needsMemory ? "recall_and_verify" : "research",
    needs_memory: needsMemory,
    time_expressions: time,
    topic_keywords: words.slice(0, 12),
    entities: words.filter((w) => /^[A-Z]/.test(w)).slice(0, 8),
    needs_web: true,
    source: "fallback",
  };
}

const SYSTEM = `You classify one chat message for a research assistant that remembers past conversations and can search the web.
Tasks:
- chat: small talk or a question answerable from general knowledge with no lookup.
- lookup: a question about current facts (needs the web) with no reference to past conversations.
- recall_only: asks what was said/decided before; no need to check the web.
- recall_and_verify: refers to a past conversation AND asks whether it is still true / what changed / to re-check.
- research: a multi-part current question needing several searches.
needs_memory is true only when the message refers to an earlier conversation that may not be in the recent history shown.
Copy time expressions verbatim from the message. Keywords should be topic words, not filler.`;

export async function plan(text: string, recent: string[], nowLine: string): Promise<Plan> {
  if (isFastPath(text)) {
    return { task: "chat", needs_memory: false, time_expressions: [], topic_keywords: [], entities: [], needs_web: false, source: "fast_path" };
  }
  // Same message with the same recent context: reuse the plan (per user, 10 minutes).
  const uid = maybeUserId();
  const cacheKey = uid ? userKey(uid, "plan", createHash("sha256").update(JSON.stringify([text, recent])).digest("hex").slice(0, 32)) : null;
  if (cacheKey) {
    const hit = await cacheGet<Plan>(cacheKey);
    if (hit) return hit;
  }
  try {
    const p = await structured(
      Plan,
      "plan",
      [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `Now: ${nowLine}\n\nRecent messages in this conversation:\n${recent.length ? recent.join("\n") : "(none)"}\n\nNew message:\n${text}`,
        },
      ],
      { timeoutMs: config().limits.plannerTimeoutMs, maxTokens: 600 },
    );
    // Deterministic backstop: never lose a time expression the model missed.
    const extra = findTimeExpressions(text).filter((t) => !p.time_expressions.some((e) => e.toLowerCase().includes(t)));
    const time_expressions = [...p.time_expressions, ...extra];
    const out: Plan = { ...p, time_expressions, needs_memory: p.needs_memory || (extra.length > 0 && MEMORY_HINT.test(text)), source: "model" };
    if (cacheKey) await cacheSet(cacheKey, out, 600);
    return out;
  } catch {
    return fallbackPlan(text);
  }
}
