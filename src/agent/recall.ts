/**
 * Recall: deterministic memory retrieval (SQL only, no model call). Runs before the main model and
 * its result is injected as context, so memory is not a second tool and costs no extra round trip.
 */
import { config } from "../config";
import {
  claimsFor,
  evidenceByIds,
  historySpan,
  lastAssistantIds,
  nearestTurns,
  scoreTurns,
  scoreTurnsDetailed,
  turnsByIds,
  turnsInRange,
  type TurnRow,
} from "../db/repo";
import { embed } from "../llm/embed";
import { addDays } from "../time/local";
import type { DateRange, Resolution } from "../time/resolve";
import type { Plan } from "./planner";

export type RecalledClaim = { subject: string; attribute: string; value: string; observed_at: string; source_url: string | null; evidence_excerpt?: string };
export type RecalledTurn = {
  ref: string;
  assistant_id: string;
  conversation_id: string;
  local_date: string;
  conversation_title: string;
  question: string;
  answer_excerpt: string;
  claims: RecalledClaim[];
};
export type EvidenceBundle = {
  /** confirm: plausible matches by topic, but not certain enough to answer from; the model asks the user first. */
  status: "found" | "ambiguous" | "confirm" | "none" | "not_needed";
  resolved: Array<{ expr: string; date: string }>;
  turns: RecalledTurn[];
  history_span?: { first: string; last: string };
  nearest?: Array<{ local_date: string; question: string }>;
  note?: string;
};

const MAX_TURNS_PER_DAY = 8;
const MAX_TURNS = 8;
const ANSWER_CHARS = 1500;
const QUESTION_CHARS = 500;
const EVIDENCE_CHARS = 600;
const BUNDLE_CHARS = 14_000; // ~3.5k tokens

const PRICE_ATTR = /price|pricing|cost|plan|tier|seat|fee|limit|quota/i;

/** Vector similarity at or above this counts as a strong topic match. */
const HIGH_SIMILARITY = 0.75;
/** The best match must outscore the best match on any other date by this factor to be "clearly ahead". */
const CLEAR_LEAD = 1.5;
const TOPIC_CANDIDATES = 20;

export type Confidence = "high" | "medium" | "low";
export type ScoredTurn = { assistant_id: string; local_date: string; score: number; sim: number | null; fts: boolean };

/**
 * How sure are we that the best topic match is the conversation the user means?
 * high: a strong match (vector similarity >= 0.75, or a full-text hit when vectors are off) that is
 * clearly ahead of the best match on any other date. medium: a real match, but weaker or split across
 * dates, so the user is asked to confirm. low: nothing worth offering.
 */
export function judgeConfidence(matches: ScoredTurn[], vectorsOn: boolean): { level: Confidence; picks: ScoredTurn[] } {
  const sorted = [...matches].filter((m) => m.score > 0).sort((a, b) => b.score - a.score);
  const top = sorted[0];
  if (!top) return { level: "low", picks: [] };
  const strong = vectorsOn ? (top.sim ?? 0) >= HIGH_SIMILARITY : top.fts;
  const rival = sorted.find((m) => m.local_date !== top.local_date);
  const clearLead = !rival || top.score >= CLEAR_LEAD * rival.score;
  if (strong && clearLead) return { level: "high", picks: sorted.filter((m) => m.local_date === top.local_date).slice(0, 3) };
  if (top.fts || top.sim !== null) {
    // One best match per date, so the question can name each option by its date.
    const perDate = new Map<string, ScoredTurn>();
    for (const m of sorted) if (!perDate.has(m.local_date)) perDate.set(m.local_date, m);
    return { level: "medium", picks: [...perDate.values()].slice(0, 3) };
  }
  return { level: "low", picks: [] };
}

/**
 * queryEmbedding: the caller may start embedding the user's message while the planner runs, so the
 * vector side of hybrid recall adds no latency. Without it, the planner's keywords are embedded here.
 */
export async function recall(p: Plan, resolutions: Resolution[], conversationId: string, queryEmbedding?: Promise<number[] | null>): Promise<EvidenceBundle> {
  // Shown to the user as "Read as"; updated below when the topic matched a later candidate
  // (e.g. "last Tuesday" on a Wednesday: yesterday had nothing, the Tuesday before did).
  const resolved = resolutions.map((r) => ({ expr: r.expr, date: rangeLabel(r.candidates[0]!) }));
  if (!p.needs_memory) return { status: "not_needed", resolved, turns: [] };

  // Turns already visible in the replayed history don't need to be recalled again.
  const exclude = await lastAssistantIds(conversationId, config().limits.historyTurns);
  const keywords = [...p.topic_keywords, ...p.entities];
  const span = await historySpan();
  // Hybrid recall: full text always; vector similarity too when embeddings are configured.
  const qvec = keywords.length
    ? await (queryEmbedding ?? embed(keywords.join(", "))).catch((err) => {
        console.warn(`[recall] query embedding failed, full-text only: ${(err as Error).message.slice(0, 120)}`);
        return null;
      })
    : null;
  const vector = qvec ? { embedding: qvec, minSimilarity: config().embeddings.minSimilarity } : null;
  const score = (ids?: string[]) => (keywords.length ? scoreTurns(keywords, ids, vector) : Promise.resolve(new Map<string, number>()));
  /** Topic first, dates second: indexed full-text + vector lookup over all of this user's turns, judged for confidence. */
  const topicFirst = async (): Promise<{ level: Confidence; turns: TurnRow[] }> => {
    if (!keywords.length) return { level: "low", turns: [] };
    const detail = await scoreTurnsDetailed(keywords, undefined, vector);
    for (const id of exclude) detail.delete(id);
    const ids = [...detail.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, TOPIC_CANDIDATES).map(([id]) => id);
    const rows = await turnsByIds(ids);
    const scored = rows.map((r) => ({ assistant_id: r.assistant_id, local_date: r.local_date, ...detail.get(r.assistant_id)! }));
    const { level, picks } = judgeConfidence(scored, Boolean(vector));
    const byId = new Map(rows.map((r) => [r.assistant_id, r]));
    return { level, turns: picks.map((p) => byId.get(p.assistant_id)!).filter(Boolean) };
  };
  const confirmNote = (turns: TurnRow[], context: string) =>
    `${context}These earlier conversations match the topic, but not certainly enough to answer from. Don't answer from them yet: ask the user one short question naming each by date and topic (for example "Did you mean your chat on ${turns[0] ? turns[0].local_date : "that day"} about ...?"). When they confirm, answer from that record.`;
  const history_span = span ? { first: span.first, last: span.last } : undefined;

  let chosen: TurnRow[] = [];
  let status: EvidenceBundle["status"] = "found";
  let note: string | undefined;

  if (resolutions.length) {
    for (const r of resolutions) {
      const perCandidate = await Promise.all(
        r.candidates.map(async (range) => {
          const turns = await turnsInRange(range.start, range.end, exclude);
          const scores = turns.length ? await score(turns.map((t) => t.assistant_id)) : new Map<string, number>();
          const matched = turns.filter((t) => (scores.get(t.assistant_id) ?? 0) > 0).sort((a, b) => scores.get(b.assistant_id)! - scores.get(a.assistant_id)!);
          return { range, turns, matched };
        }),
      );
      const withMatches = perCandidate.filter((c) => c.matched.length);
      if (withMatches.length > 1) {
        status = "ambiguous";
        note = `"${r.expr}" could mean ${withMatches.map((c) => rangeLabel(c.range)).join(" or ")}; both have matching conversations.`;
        for (const c of withMatches) chosen.push(...c.matched.slice(0, 3));
      } else if (withMatches.length === 1) {
        chosen.push(...withMatches[0]!.matched.slice(0, MAX_TURNS_PER_DAY));
        const idx = perCandidate.indexOf(withMatches[0]!);
        if (idx > 0) {
          const k = resolutions.indexOf(r);
          if (k >= 0) resolved[k] = { expr: r.expr, date: rangeLabel(withMatches[0]!.range) };
        }
        if (idx > 0) note = `Matched "${r.expr}" to ${rangeLabel(withMatches[0]!.range)} (the more recent candidate had no matching conversation).`;
      } else {
        // No keyword match on the candidate days: widen by a day once.
        const first = r.candidates[0]!;
        const wide = { start: addDays(first.start, -1), end: addDays(first.end, 1) };
        const wideTurns = await turnsInRange(wide.start, wide.end, exclude);
        const wideScores = wideTurns.length ? await score(wideTurns.map((t) => t.assistant_id)) : new Map<string, number>();
        const wideMatched = wideTurns.filter((t) => (wideScores.get(t.assistant_id) ?? 0) > 0);
        const anyOnDay = perCandidate.find((c) => c.turns.length);
        const fallback = wideMatched.length ? null : await topicFirst();
        if (wideMatched.length) {
          chosen.push(...wideMatched.slice(0, MAX_TURNS_PER_DAY));
          note = `Nothing on ${rangeLabel(first)} matched; found a matching conversation one day off.`;
        } else if (fallback && fallback.level === "high") {
          // The user remembered the date wrong: the topic clearly lives on another day.
          chosen.push(...fallback.turns);
          const dates = [...new Set(fallback.turns.map((t) => t.local_date))];
          const k = resolutions.indexOf(r);
          if (k >= 0) resolved[k] = { expr: r.expr, date: dates[0]! };
          note = `Nothing about this topic on ${rangeLabel(first)}. The matching conversation is from ${dates.join(", ")}: tell the user plainly it was on that date, not ${rangeLabel(first)}.`;
        } else if (fallback && fallback.level === "medium") {
          chosen.push(...fallback.turns);
          status = "confirm";
          note = confirmNote(fallback.turns, `Nothing about this topic on ${rangeLabel(first)}. `);
        } else if (anyOnDay) {
          // The user named the day; show what happened then even if the words differ.
          chosen.push(...anyOnDay.turns.slice(0, MAX_TURNS_PER_DAY));
          note = `Conversations on ${rangeLabel(anyOnDay.range)} don't mention the topic keywords; showing everything from that day.`;
        } else if (wideTurns.length) {
          // Nothing on the named day at all, but the user talked to us the day before or after
          // (e.g. "this morning" asked just past midnight): show those, newest first.
          chosen.push(...[...wideTurns].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, MAX_TURNS_PER_DAY));
          note = `No conversation on ${rangeLabel(first)} itself; these are from the day next to it (${rangeLabel(wide)}). Say which date they are from.`;
        }
      }
    }
  } else if (keywords.length) {
    // No date: find the topic first, then read the dates off the matches.
    const fallback = await topicFirst();
    if (fallback.level !== "low") chosen = fallback.turns;
    if (fallback.level === "medium") {
      status = "confirm";
      note = confirmNote(fallback.turns, "");
    }
  }

  // De-duplicate, then order chronologically (reads naturally, and stable refs).
  const seen = new Set<string>();
  chosen = chosen.filter((t) => !seen.has(t.assistant_id) && seen.add(t.assistant_id)).slice(0, MAX_TURNS);
  chosen.sort((a, b) => a.created_at.localeCompare(b.created_at));

  if (!chosen.length) {
    const target = resolutions[0]?.candidates[0]?.start;
    const near = target ? await nearestTurns(target, 3, exclude) : [];
    return {
      status: "none",
      resolved,
      turns: [],
      history_span,
      nearest: near.map((t) => ({ local_date: t.local_date, question: clip(t.question, 160) })),
      note: span ? undefined : "There is no conversation history at all yet.",
    };
  }

  const turns = await buildTurns(chosen);
  return { status, resolved, turns: fitBudget(turns), history_span, note };
}

async function buildTurns(rows: TurnRow[]): Promise<RecalledTurn[]> {
  const claims = await claimsFor(rows.map((r) => r.assistant_id));
  const evidence = new Map((await evidenceByIds(claims.filter((c) => c.evidence_id && PRICE_ATTR.test(c.attribute)).map((c) => c.evidence_id!))).map((e) => [e.id, e]));
  return rows.map((r, i) => ({
    ref: `M${i + 1}`,
    assistant_id: r.assistant_id,
    conversation_id: r.conversation_id,
    local_date: r.local_date,
    conversation_title: r.conversation_title ?? "(untitled)",
    // Raw messages are the source of truth; digests are only used to find turns.
    question: clip(r.question, QUESTION_CHARS),
    answer_excerpt: clip(r.answer, ANSWER_CHARS),
    claims: claims
      .filter((c) => c.assistant_message_id === r.assistant_id)
      .map((c) => ({
        subject: c.subject,
        attribute: c.attribute,
        value: c.value,
        observed_at: c.observed_at.slice(0, 10),
        source_url: c.source_url,
        evidence_excerpt: c.evidence_id && evidence.has(c.evidence_id) ? clip(evidence.get(c.evidence_id)!.excerpt, EVIDENCE_CHARS) : undefined,
      })),
  }));
}

/** Keep the bundle compact: shorten answers, then drop evidence excerpts, then drop turns. */
function fitBudget(turns: RecalledTurn[]): RecalledTurn[] {
  const size = () => JSON.stringify(turns).length;
  if (size() <= BUNDLE_CHARS) return turns;
  turns = turns.map((t) => ({ ...t, answer_excerpt: clip(t.answer_excerpt, 700) }));
  if (size() <= BUNDLE_CHARS) return turns;
  turns = turns.map((t) => ({ ...t, claims: t.claims.map(({ evidence_excerpt: _e, ...c }) => c) }));
  while (size() > BUNDLE_CHARS && turns.length > 1) turns = turns.slice(0, -1);
  return turns;
}

function rangeLabel(r: DateRange): string {
  return r.start === r.end ? r.start : `${r.start}..${r.end}`;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
