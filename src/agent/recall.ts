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
  turnsByIds,
  turnsInRange,
  type TurnRow,
} from "../db/repo";
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
  status: "found" | "ambiguous" | "none" | "not_needed";
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

export function recall(p: Plan, resolutions: Resolution[], conversationId: string): EvidenceBundle {
  const resolved = resolutions.map((r) => ({ expr: r.expr, date: rangeLabel(r.candidates[0]!) }));
  if (!p.needs_memory) return { status: "not_needed", resolved, turns: [] };

  // Turns already visible in the replayed history don't need to be recalled again.
  const exclude = lastAssistantIds(conversationId, config().limits.historyTurns);
  const keywords = [...p.topic_keywords, ...p.entities];
  const span = historySpan();
  const history_span = span ? { first: span.first, last: span.last } : undefined;

  let chosen: TurnRow[] = [];
  let status: EvidenceBundle["status"] = "found";
  let note: string | undefined;

  if (resolutions.length) {
    for (const r of resolutions) {
      const perCandidate = r.candidates.map((range) => {
        const turns = turnsInRange(range.start, range.end, exclude);
        const scores = keywords.length ? scoreTurns(keywords, turns.map((t) => t.assistant_id)) : new Map<string, number>();
        const matched = turns.filter((t) => (scores.get(t.assistant_id) ?? 0) > 0).sort((a, b) => scores.get(b.assistant_id)! - scores.get(a.assistant_id)!);
        return { range, turns, matched };
      });
      const withMatches = perCandidate.filter((c) => c.matched.length);
      if (withMatches.length > 1) {
        status = "ambiguous";
        note = `"${r.expr}" could mean ${withMatches.map((c) => rangeLabel(c.range)).join(" or ")}; both have matching conversations.`;
        for (const c of withMatches) chosen.push(...c.matched.slice(0, 3));
      } else if (withMatches.length === 1) {
        chosen.push(...withMatches[0]!.matched.slice(0, MAX_TURNS_PER_DAY));
        const idx = perCandidate.indexOf(withMatches[0]!);
        if (idx > 0) note = `Matched "${r.expr}" to ${rangeLabel(withMatches[0]!.range)} (the more recent candidate had no matching conversation).`;
      } else {
        // No keyword match on the candidate days: widen by a day once.
        const first = r.candidates[0]!;
        const wide = { start: addDays(first.start, -1), end: addDays(first.end, 1) };
        const wideTurns = turnsInRange(wide.start, wide.end, exclude);
        const wideScores = keywords.length ? scoreTurns(keywords, wideTurns.map((t) => t.assistant_id)) : new Map<string, number>();
        const wideMatched = wideTurns.filter((t) => (wideScores.get(t.assistant_id) ?? 0) > 0);
        const anyOnDay = perCandidate.find((c) => c.turns.length);
        if (wideMatched.length) {
          chosen.push(...wideMatched.slice(0, MAX_TURNS_PER_DAY));
          note = `Nothing on ${rangeLabel(first)} matched; found a matching conversation one day off.`;
        } else if (anyOnDay) {
          // The user named the day; show what happened then even if the words differ.
          chosen.push(...anyOnDay.turns.slice(0, MAX_TURNS_PER_DAY));
          note = `Conversations on ${rangeLabel(anyOnDay.range)} don't mention the topic keywords; showing everything from that day.`;
        }
      }
    }
  } else if (keywords.length) {
    const scores = scoreTurns(keywords);
    for (const id of exclude) scores.delete(id);
    const ids = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id);
    chosen = turnsByIds(ids);
  }

  // De-duplicate, then order chronologically (reads naturally, and stable refs).
  const seen = new Set<string>();
  chosen = chosen.filter((t) => !seen.has(t.assistant_id) && seen.add(t.assistant_id)).slice(0, MAX_TURNS);
  chosen.sort((a, b) => a.created_at.localeCompare(b.created_at));

  if (!chosen.length) {
    const target = resolutions[0]?.candidates[0]?.start;
    const near = target ? nearestTurns(target, 3, exclude) : [];
    return {
      status: "none",
      resolved,
      turns: [],
      history_span,
      nearest: near.map((t) => ({ local_date: t.local_date, question: clip(t.question, 160) })),
      note: span ? undefined : "There is no conversation history at all yet.",
    };
  }

  const turns = buildTurns(chosen);
  return { status, resolved, turns: fitBudget(turns), history_span, note };
}

function buildTurns(rows: TurnRow[]): RecalledTurn[] {
  const claims = claimsFor(rows.map((r) => r.assistant_id));
  const evidence = new Map(evidenceByIds(claims.filter((c) => c.evidence_id && PRICE_ATTR.test(c.attribute)).map((c) => c.evidence_id!)).map((e) => [e.id, e]));
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
