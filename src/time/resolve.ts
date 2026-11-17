/**
 * Time-expression resolution: "last Tuesday" -> concrete local date ranges.
 * Pure and deterministic (no model involved) so it can be unit-tested against a fixed clock.
 */
import * as chrono from "chrono-node";
import { addDays, localDate, localHour, shortLabel, weekday } from "./local";

export type DateRange = { start: string; end: string }; // inclusive local dates, YYYY-MM-DD
export type Resolution = { expr: string; label: string; candidates: DateRange[] };

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_RE = "(sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?";
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  couple: 2, "a couple of": 2,
};
const MONTHS = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

const day = (d: string): DateRange => ({ start: d, end: d });
const range = (start: string, end: string): DateRange => ({ start, end });

function weekdayIndex(word: string): number {
  const w = word.toLowerCase().slice(0, 3);
  return WEEKDAYS.findIndex((x) => x.startsWith(w));
}

/** Most recent date strictly before `today` that falls on weekday `wd`. */
function previousWeekday(today: string, wd: number): string {
  let diff = (weekday(today) - wd + 7) % 7;
  if (diff === 0) diff = 7;
  return addDays(today, -diff);
}

/** Monday of the ISO week containing d. */
function isoWeekStart(d: string): string {
  return addDays(d, -((weekday(d) + 6) % 7));
}

function parseCount(s: string): number {
  const n = Number(s);
  if (!Number.isNaN(n)) return n;
  return NUMBER_WORDS[s.toLowerCase()] ?? 1;
}

function labelFor(expr: string, candidates: DateRange[]): string {
  const first = candidates[0];
  if (!first) return expr;
  const span = first.start === first.end ? shortLabel(first.start) : `${shortLabel(first.start)} to ${shortLabel(first.end)}`;
  return `${expr} (${span})`;
}

/**
 * Resolve one time expression relative to `now` in timezone `tz`.
 * Returns candidates in order of likelihood; empty if the expression is not a time reference we understand.
 */
export function resolve(expr: string, now: Date, tz: string): Resolution {
  const e = expr.trim().toLowerCase().replace(/[?.!,]+$/g, "").replace(/\s+/g, " ");
  const today = localDate(now, tz);
  const out = (candidates: DateRange[]): Resolution => ({ expr: expr.trim(), label: labelFor(expr.trim(), candidates), candidates });
  let m: RegExpMatchArray | null;

  // Before 5 am the user is usually still in "their" day: "this morning" or "today" at 1 am means the
  // day that just ended (or the last hour), so search yesterday and today together.
  const lateNight = localHour(now, tz) < 5;
  const todayish = lateNight ? range(addDays(today, -1), today) : day(today);
  if (/\b(today|earlier today|this (morning|afternoon|evening)|tonight|just now|an hour ago|few hours ago)\b/.test(e)) return out([todayish]);
  if (/\bday before yesterday\b/.test(e)) return out([day(addDays(today, -2))]);
  if (/\blast night\b/.test(e)) return out([lateNight ? range(addDays(today, -1), today) : day(addDays(today, -1))]);
  if (/\byesterday\b/.test(e)) return out([day(addDays(today, -1))]);

  if ((m = e.match(new RegExp(`\\blast ${WEEKDAY_RE}\\b`)))) {
    const wd = weekdayIndex(m[1]!);
    const first = previousWeekday(today, wd);
    return out([day(first), day(addDays(first, -7))]);
  }
  if ((m = e.match(new RegExp(`\\b(?:this|on|past)? ?${WEEKDAY_RE}\\b`))) && !/\bnext\b/.test(e)) {
    const wd = weekdayIndex(m[1]!);
    const prev = previousWeekday(today, wd);
    return out(weekday(today) === wd ? [day(today), day(prev)] : [day(prev)]);
  }

  if (/\bthis week\b/.test(e)) return out([range(isoWeekStart(today), today)]);
  if (/\blast week\b/.test(e)) {
    const start = addDays(isoWeekStart(today), -7);
    return out([range(start, addDays(start, 6))]);
  }
  if (/\blast month\b/.test(e)) {
    const [y, mo] = today.split("-").map(Number) as [number, number];
    const py = mo === 1 ? y - 1 : y;
    const pm = mo === 1 ? 12 : mo - 1;
    const start = `${py}-${String(pm).padStart(2, "0")}-01`;
    const end = addDays(`${y}-${String(mo).padStart(2, "0")}-01`, -1);
    return out([range(start, end)]);
  }
  if (/\bthis month\b/.test(e)) return out([range(`${today.slice(0, 7)}-01`, today)]);

  if ((m = e.match(/\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|a couple of|couple) days? ago\b/))) {
    const d = addDays(today, -parseCount(m[1]!));
    return out([day(d), range(addDays(d, -1), addDays(d, 1))]);
  }
  if ((m = e.match(/\b(\d+|a|an|one|two|three|four|five|six|a couple of|couple) weeks? ago\b/))) {
    const d = addDays(today, -7 * parseCount(m[1]!));
    return out([range(addDays(d, -3), addDays(d, 3))]);
  }
  if (/\b(a few|few|several) days ago\b|\bthe other day\b|\bearlier this week\b/.test(e)) return out([range(addDays(today, -7), addDays(today, -1))]);
  if (/\b(a few|few|several) weeks ago\b|\brecently\b|\bearlier\b|\blately\b/.test(e)) return out([range(addDays(today, -30), today)]);

  // Absolute dates: "3 November", "Nov 3", "11/3", "2026-11-03".
  const abs = absoluteDate(expr, today);
  if (abs) return out([day(abs)]);

  return out([]);
}

/** Parse an absolute calendar date, choosing the most recent past occurrence when the year is omitted. */
function absoluteDate(expr: string, today: string): string | null {
  const ref = new Date(`${today}T12:00:00Z`);
  const results = chrono.parse(expr, { instant: ref, timezone: 0 }, { forwardDate: false });
  const r = results[0];
  if (!r || !r.start.isCertain("day") || !r.start.isCertain("month")) return null;
  const dd = r.start.get("day")!;
  const mm = r.start.get("month")!;
  let yy = r.start.isCertain("year") ? r.start.get("year")! : Number(today.slice(0, 4));
  const fmt = (y: number) => `${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  if (!r.start.isCertain("year") && fmt(yy) > today) yy -= 1;
  return fmt(yy);
}

/**
 * Find time expressions in free text. Used as a deterministic backstop to the planner
 * (and as the whole mechanism when the planner is unavailable).
 */
export function findTimeExpressions(text: string): string[] {
  const t = text.toLowerCase();
  const patterns = [
    /\b(earlier today|today|this (?:morning|afternoon|evening)|tonight|yesterday|last night|day before yesterday)\b/g,
    new RegExp(`\\b(?:last|this|on|past) ${WEEKDAY_RE}\\b`, "g"),
    /\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g, // bare weekdays: full names only
    /\b(?:this|last) (?:week|month)\b/g,
    /\b(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|a couple of|couple|a few|few|several) (?:days?|weeks?) ago\b/g,
    /\b(?:the other day|earlier this week|recently|lately)\b/g,
    new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)? (?:of )?${MONTHS}(?: \\d{4})?\\b`, "g"),
    new RegExp(`\\b${MONTHS} \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?\\b`, "g"),
    /\b\d{4}-\d{2}-\d{2}\b/g,
    /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
  ];
  const found: Array<{ i: number; s: string }> = [];
  for (const re of patterns) {
    for (const m of t.matchAll(re)) {
      const i = m.index ?? 0;
      // Skip spans already covered by a longer match (e.g. "monday" inside "last monday").
      if (found.some((f) => i >= f.i && i < f.i + f.s.length)) continue;
      found.push({ i, s: m[0] });
    }
  }
  return found.sort((a, b) => a.i - b.i).map((f) => f.s);
}

/** Resolve many expressions, dropping ones that produce no dates and merging duplicates. */
export function resolveAll(exprs: string[], now: Date, tz: string): Resolution[] {
  const seen = new Set<string>();
  const out: Resolution[] = [];
  for (const expr of exprs) {
    const r = resolve(expr, now, tz);
    if (!r.candidates.length) continue;
    const key = JSON.stringify(r.candidates);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
