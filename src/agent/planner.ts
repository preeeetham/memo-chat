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
import { findTimeExpressions, VAGUE_PAST } from "../time/resolve";

export const Plan = z.object({
  task: z.enum(["chat", "lookup", "recall_only", "recall_and_verify", "research"]),
  needs_memory: z.boolean().describe("true if the user refers to an earlier conversation, outside the visible history"),
  time_expressions: z.array(z.string()).describe('verbatim spans like "on Monday", "last Tuesday", "3 November"'),
  topic_keywords: z.array(z.string()).describe('topic words useful to find the past conversation, e.g. "CRM", "Postgres hosting", "pricing"'),
  entities: z.array(z.string()).describe("named products/companies/people in this message"),
  needs_web: z.boolean().describe("true if answering needs current information from the web"),
  date_guesses: z
    .array(z.object({ expr: z.string(), start: z.string(), end: z.string() }))
    .describe('only for time references a simple parser may not know (holidays like "around Diwali", seasons, "during the exams"): your best local date range, YYYY-MM-DD, never after today; [] otherwise'),
  recency: z.enum(["any", "first", "latest"]).describe('"first" for "the first time I asked about X", "latest" for "the last time we talked about X", else "any"'),
});
export type Plan = z.infer<typeof Plan> & { source: "model" | "fallback" | "fast_path" };

const GREETING = /^\s*(hi|hey|hello|yo|thanks|thank you|thx|ok|okay|cool|great|nice|good (morning|evening|night)|bye|cheers)[\s!.?]*$/i;
const MEMORY_HINT =
  /\b(you said|you told|i asked|i told you|we (discussed|talked|decided|picked|chose|shortlisted|spoke|looked at)|earlier|before|last time|first time|previous(ly)?|ago|back|a while|last (mon|tue|wed|thu|fri|sat|sun|week|month|year|quarter|weekend)|yesterday|on (mon|tue|wed|thu|fri|sat|sun)|remember|recall|your (answer|recommendation))/i;

/** Does the message point back at an earlier conversation, judged without the model? */
export function looksLikeMemory(text: string): boolean {
  return MEMORY_HINT.test(text) || VAGUE_PAST.test(text);
}

export function recencyOf(text: string): "any" | "first" | "latest" {
  if (/\b(first time|the first|originally|initially)\b/i.test(text)) return "first";
  if (/\b(last time|latest|most recent(ly)?|the last we)\b/i.test(text)) return "latest";
  return "any";
}

/**
 * Merge the planner's time phrases with the deterministic finder's. The finder's longer phrase wins:
 * if the planner wrote "last Tuesday" for "last to last Tuesday", keep only the latter.
 */
export function mergeTimeExpressions(model: string[], found: string[]): string[] {
  const lower = (s: string) => s.toLowerCase().trim();
  const keep = model.filter((e) => !found.some((t) => t !== lower(e) && t.includes(lower(e))));
  const extra = found.filter((t) => !keep.some((e) => lower(e).includes(t)));
  return [...keep, ...extra];
}

export function isFastPath(text: string): boolean {
  return GREETING.test(text);
}

export function fallbackPlan(text: string): Plan {
  const time = findTimeExpressions(text);
  const needsMemory = time.length > 0 || looksLikeMemory(text);
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}.+-]{2,}/gu) ?? [];
  return {
    task: needsMemory ? "recall_and_verify" : "research",
    needs_memory: needsMemory,
    time_expressions: time,
    topic_keywords: words.slice(0, 12),
    entities: words.filter((w) => /^[A-Z]/.test(w)).slice(0, 8),
    needs_web: true,
    date_guesses: [],
    recency: recencyOf(text),
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
Copy time expressions verbatim from the message, the whole phrase ("last to last Tuesday", "the week before last", "around Diwali").
For holidays, festivals, seasons or events whose date depends on the year, add date_guesses with your best local date range using the current date given.
Keywords should be topic words, not filler.`;

export async function plan(text: string, recent: string[], nowLine: string): Promise<Plan> {
  if (isFastPath(text)) {
    return { task: "chat", needs_memory: false, time_expressions: [], topic_keywords: [], entities: [], needs_web: false, date_guesses: [], recency: "any", source: "fast_path" };
  }
  // Same message with the same recent context: reuse the plan (per user, 10 minutes).
  const uid = maybeUserId();
  const cacheKey = uid ? userKey(uid, "plan", createHash("sha256").update(JSON.stringify([text, recent])).digest("hex").slice(0, 32)) : null;
  if (cacheKey) {
    const hit = await cacheGet<Plan>(cacheKey);
    if (hit) return { ...hit, date_guesses: hit.date_guesses ?? [], recency: hit.recency ?? "any" };
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
    const found = findTimeExpressions(text);
    const time_expressions = mergeTimeExpressions(p.time_expressions, found);
    const extra = found.filter((t) => !p.time_expressions.some((e) => e.toLowerCase().includes(t)));
    const recency = p.recency === "any" ? recencyOf(text) : p.recency;
    const out: Plan = { ...p, time_expressions, recency, needs_memory: p.needs_memory || (extra.length > 0 && looksLikeMemory(text)), source: "model" };
    if (cacheKey) await cacheSet(cacheKey, out, 600);
    return out;
  } catch {
    return fallbackPlan(text);
  }
}
