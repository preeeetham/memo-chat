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
const WD = "(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?"; // same, non-capturing
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, couple: 2, "a couple of": 2, "a couple": 2,
};
const COUNT = "(\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a couple of|a couple|couple)";
const COUNT_NC = "(?:\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a couple of|a couple|couple)";
const MONTHS = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const MON = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const MONTH_KEYS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ORDINALS: Record<string, number> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4 };
// "early/mid/late" parts of a month or year.
const PART = "(early|beginning of|start of|the start of|the beginning of|mid|middle of|the middle of|late|end of|the end of)";

const day = (d: string): DateRange => ({ start: d, end: d });
const range = (start: string, end: string): DateRange => ({ start, end });
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const minD = (a: string, b: string) => (a < b ? a : b);

function weekdayIndex(word: string): number {
  const w = word.toLowerCase().slice(0, 3);
  return WEEKDAYS.findIndex((x) => x.startsWith(w));
}

function monthIndex(word: string): number {
  return MONTH_KEYS.indexOf(word.toLowerCase().slice(0, 3)) + 1; // 1..12
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

/** Weekday `wd` in the ISO week `weeksBack` weeks before the one containing today. */
function weekdayInWeek(today: string, wd: number, weeksBack: number): string {
  return addDays(isoWeekStart(today), -7 * weeksBack + ((wd + 6) % 7));
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function monthRange(y: number, m: number): DateRange {
  return range(ymd(y, m, 1), ymd(y, m, daysInMonth(y, m)));
}

/** Year and month `n` months before (y, m). */
function shiftMonth(y: number, m: number, n: number): [number, number] {
  const idx = y * 12 + (m - 1) - n;
  return [Math.floor(idx / 12), (idx % 12) + 1];
}

/** The same day of month, `n` months back (clamped to the month's length). */
function monthsAgo(today: string, n: number): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const [py, pm] = shiftMonth(y, m, n);
  return ymd(py, pm, Math.min(d, daysInMonth(py, pm)));
}

/** First, middle or last third of a range. */
function part(r: DateRange, which: string): DateRange {
  const len = Math.round((Date.parse(r.end) - Date.parse(r.start)) / 86_400_000) + 1;
  const third = Math.ceil(len / 3);
  if (/early|beginning|start/.test(which)) return range(r.start, addDays(r.start, third - 1));
  if (/mid|middle/.test(which)) return range(addDays(r.start, third), addDays(r.start, 2 * third - 1));
  return range(addDays(r.start, 2 * third), r.end);
}

/** The most recent past (or current) occurrence of month m, unless a year is given. `last` forces the year before when m is the current month. */
function pastMonth(today: string, m: number, year?: number, last = false): DateRange {
  const [y, cm] = today.split("-").map(Number) as [number, number];
  if (year) return monthRange(year, m);
  const yy = m < cm || (m === cm && !last) ? y : y - 1;
  return monthRange(yy, m);
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

/** US-style month/day for numeric dates only in US timezones; day/month elsewhere (e.g. India, UK). */
function monthFirst(tz: string): boolean {
  return /^America\/(?!Sao_Paulo|Argentina|Bogota|Lima|Santiago|Caracas|Montevideo|La_Paz|Asuncion|Guayaquil)/.test(tz) || tz === "US/Pacific" || tz === "US/Eastern" || tz === "US/Central" || tz === "US/Mountain";
}

/**
 * Resolve one time expression relative to `now` in timezone `tz`.
 * Returns candidates in order of likelihood; empty if the expression is not a time reference we understand.
 */
export function resolve(expr: string, now: Date, tz: string): Resolution {
  const e = expr.trim().toLowerCase().replace(/[?.!,]+$/g, "").replace(/’/g, "'").replace(/\s+/g, " ");
  const today = localDate(now, tz);
  const [ty, tm] = today.split("-").map(Number) as [number, number];
  const out = (candidates: Array<DateRange | null>): Resolution => {
    const seen = new Set<string>();
    const list = candidates.filter((c): c is DateRange => {
      if (!c || c.start > today) return false;
      const k = `${c.start}|${c.end}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).map((c) => range(c.start, minD(c.end, today)));
    return { expr: expr.trim(), label: labelFor(expr.trim(), list), candidates: list };
  };
  let m: RegExpMatchArray | null;

  // Before 5 am the user is usually still in "their" day: "this morning" or "today" at 1 am means the
  // day that just ended (or the last hour), so search yesterday and today together.
  const lateNight = localHour(now, tz) < 5;
  const todayish = lateNight ? range(addDays(today, -1), today) : day(today);
  if (/\b(today|earlier today|this (morning|afternoon|evening)|tonight|just now|an hour ago|few hours ago)\b/.test(e)) return out([todayish]);
  if (/\bday before yesterday\b/.test(e)) return out([day(addDays(today, -2))]);
  if (/\blast night\b/.test(e)) return out([lateNight ? range(addDays(today, -1), today) : day(addDays(today, -1))]);
  if (/\byesterday\b/.test(e)) return out([day(addDays(today, -1))]);

  // ---- Weekdays further back -------------------------------------------------------------
  // "last to last Tuesday", "the last but one Tuesday", "the Tuesday before last"
  if ((m = e.match(new RegExp(`\\b(?:last to last|last but one|the last but one|the one before last) ${WEEKDAY_RE}\\b`))) ||
      (m = e.match(new RegExp(`\\b${WEEKDAY_RE} before last\\b`)))) {
    const first = addDays(previousWeekday(today, weekdayIndex(m[1]!)), -7);
    return out([day(first), day(addDays(first, -7))]);
  }
  // "two Tuesdays ago", "3 Tuesdays back"
  if ((m = e.match(new RegExp(`\\b${COUNT} ${WEEKDAY_RE}s (?:ago|back)\\b`)))) {
    const k = parseCount(m[1]!);
    const first = addDays(previousWeekday(today, weekdayIndex(m[2]!)), -7 * (k - 1));
    return out([day(first), day(addDays(first, -7))]);
  }
  // "Tuesday the week before last", "the week before last on Tuesday"
  if ((m = e.match(new RegExp(`\\b${WEEKDAY_RE},? (?:of |in )?the week before last\\b`))) ||
      (m = e.match(new RegExp(`\\bthe week before last(?:'s)?,? (?:on )?${WEEKDAY_RE}\\b`)))) {
    return out([day(weekdayInWeek(today, weekdayIndex(m[1]!), 2))]);
  }
  // "Tuesday last week", "last week on Tuesday", "Tuesday of last week"
  if ((m = e.match(new RegExp(`\\b${WEEKDAY_RE},? (?:of |in )?last week\\b`))) ||
      (m = e.match(new RegExp(`\\blast week(?:'s)?,? (?:on )?${WEEKDAY_RE}\\b`)))) {
    return out([day(weekdayInWeek(today, weekdayIndex(m[1]!), 1))]);
  }
  // "Tuesday this week", "this week on Tuesday"
  if ((m = e.match(new RegExp(`\\b${WEEKDAY_RE},? (?:of )?this week\\b`))) ||
      (m = e.match(new RegExp(`\\bthis week(?:'s)?,? (?:on )?${WEEKDAY_RE}\\b`)))) {
    return out([day(weekdayInWeek(today, weekdayIndex(m[1]!), 0))]);
  }
  // "Tuesday 3 weeks ago", "3 weeks ago on Tuesday"
  if ((m = e.match(new RegExp(`\\b${WEEKDAY_RE},? ${COUNT} weeks? (?:ago|back)\\b`)))) {
    const wd = weekdayIndex(m[1]!), n = parseCount(m[2]!);
    return out([day(weekdayInWeek(today, wd, n)), day(addDays(previousWeekday(today, wd), -7 * n))]);
  }
  if ((m = e.match(new RegExp(`\\b${COUNT} weeks? (?:ago|back),? (?:on )?(?:a |the )?${WEEKDAY_RE}\\b`)))) {
    const wd = weekdayIndex(m[2]!), n = parseCount(m[1]!);
    return out([day(weekdayInWeek(today, wd, n)), day(addDays(previousWeekday(today, wd), -7 * n))]);
  }

  const lastMonth = (() => { const [y, mo] = shiftMonth(ty, tm, 1); return monthRange(y, mo); })();
  const thisMonth = monthRange(ty, tm);
  // "first week of November", "the last week of last month"
  if ((m = e.match(new RegExp(`\\b(first|1st|second|2nd|third|3rd|fourth|4th|last|final) week (?:of|in) (last month|this month|${MONTHS}(?: (\\d{4}))?)\\b`)))) {
    const r = m[2] === "last month" ? lastMonth : m[2] === "this month" ? thisMonth : pastMonth(today, monthIndex(m[3]!), m[4] ? Number(m[4]) : undefined);
    if (/last|final/.test(m[1]!)) return out([range(addDays(r.end, -6), r.end)]);
    const k = ORDINALS[m[1]!]!;
    return out([range(addDays(r.start, 7 * (k - 1)), minD(addDays(r.start, 7 * k - 1), r.end))]);
  }
  // ---- Weeks --------------------------------------------------------------------------
  if (/\b(?:the )?week before last\b/.test(e)) {
    const start = addDays(isoWeekStart(today), -14);
    return out([range(start, addDays(start, 6))]);
  }
  // "the past week", "in the last week", "the last 7 days", "past few days", "last few days"
  if ((m = e.match(/\b(?:the |in the |over the |within the )?(?:past|last) (\d+|two|three|four|five|six|seven|ten|fourteen|few|couple of) days\b/))) {
    const n = /few|couple/.test(m[1]!) ? 4 : parseCount(m[1]!) || 4;
    return out([range(addDays(today, -n), today)]);
  }
  if (/\b(?:the past week|past week|(?:in|over|within) the (?:past|last) week|the last seven days|past 7 days)\b/.test(e)) return out([range(addDays(today, -7), today)]);
  if ((m = e.match(/\b(?:the |in the |over the )?(?:past|last) (\d+|two|three|four|few|couple of) weeks\b/))) {
    const n = /few|couple/.test(m[1]!) ? 3 : parseCount(m[1]!);
    return out([range(addDays(today, -7 * n), today)]);
  }
  if (/\b(?:a )?fortnight ago\b/.test(e)) {
    const d = addDays(today, -14);
    return out([range(addDays(d, -3), addDays(d, 3))]);
  }
  if (/\bthe other week\b/.test(e)) return out([range(addDays(today, -21), addDays(today, -5))]);
  if (/\bthis week\b/.test(e)) return out([range(isoWeekStart(today), today)]);
  if (/\blast week\b/.test(e)) {
    const start = addDays(isoWeekStart(today), -7);
    return out([range(start, addDays(start, 6))]);
  }
  // "last weekend", "over the weekend", "this weekend"
  if (/\b(?:last|this past|over the|on the|at the) weekend\b|\bthis weekend\b/.test(e)) {
    const wd = weekday(today); // 0 Sun .. 6 Sat
    if (/\bthis weekend\b/.test(e) && (wd === 6 || wd === 0)) return out([range(wd === 6 ? today : addDays(today, -1), today)]);
    const sat = previousWeekday(wd === 0 ? addDays(today, -6) : today, 6);
    return out([range(sat, addDays(sat, 1))]);
  }

  // ---- Weekdays (recent) -------------------------------------------------------------
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

  // ---- Months -------------------------------------------------------------------------
  // "early last month", "end of this month", "mid October", "late October 2025"
  if ((m = e.match(new RegExp(`\\b${PART} (last month|this month|the month|${MONTHS}(?: (\\d{4}))?)\\b`)))) {
    const r = m[2] === "last month" ? lastMonth : m[2] === "this month" || m[2] === "the month" ? thisMonth : pastMonth(today, monthIndex(m[3]!), m[4] ? Number(m[4]) : undefined);
    return out([part(r, m[1]!)]);
  }
  if (/\bearlier this month\b/.test(e)) return out([range(thisMonth.start, addDays(today, -1))]);
  if (/\b(?:the )?month before last\b/.test(e)) {
    const [y, mo] = shiftMonth(ty, tm, 2);
    return out([monthRange(y, mo)]);
  }
  if ((m = e.match(new RegExp(`\\b${COUNT} months? (?:ago|back)\\b`)))) {
    const d = monthsAgo(today, parseCount(m[1]!));
    return out([range(addDays(d, -10), addDays(d, 10))]);
  }
  if (/\b(?:a few|few|several) months? (?:ago|back)\b/.test(e)) return out([range(monthsAgo(today, 5), monthsAgo(today, 1))]);
  if (/\b(?:the|in the|over the|within the) (?:past|last) month\b|\bpast month\b|\blast 30 days\b/.test(e)) return out([range(addDays(today, -30), today)]);
  if (/\b(?:the |in the |over the )?(?:past|last) (?:few|couple of|two|three|2|3|six|6) months\b/.test(e)) {
    const n = /two|2|couple/.test(e) ? 2 : /six|6/.test(e) ? 6 : 3;
    return out([range(monthsAgo(today, n), today)]);
  }
  if (/\blast month\b/.test(e)) return out([lastMonth]);
  if (/\bthis month\b/.test(e)) return out([range(thisMonth.start, today)]);
  // "in October", "last October", "October 2025", "during Sept"
  if ((m = e.match(new RegExp(`\\b(in|during|last|this|back in) ${MONTHS}(?: (\\d{4}))?\\b`))) && !(m[2] === "may" && /^(last|this)$/.test(m[1]!) && !m[3])) {
    return out([pastMonth(today, monthIndex(m[2]!), m[3] ? Number(m[3]) : undefined, m[1] === "last")]);
  }
  if ((m = e.match(new RegExp(`^(?:in |during )?${MONTHS} (\\d{4})$`)))) return out([monthRange(Number(m[2]), monthIndex(m[1]!))]);
  if ((m = e.match(new RegExp(`^(?:the )?(january|february|march|april|june|july|august|september|october|november|december)$`)))) {
    return out([pastMonth(today, monthIndex(m[1]!))]);
  }

  // ---- Quarters and years --------------------------------------------------------------
  const quarter = (y: number, q: number) => range(ymd(y, 3 * q - 2, 1), ymd(y, 3 * q, daysInMonth(y, 3 * q)));
  const curQ = Math.ceil(tm / 3);
  if (/\blast quarter\b|\bprevious quarter\b/.test(e)) return out([curQ === 1 ? quarter(ty - 1, 4) : quarter(ty, curQ - 1)]);
  if (/\bthis quarter\b/.test(e)) return out([quarter(ty, curQ)]);
  if ((m = e.match(/\bq([1-4])(?:\s*(?:of\s*)?'?(\d{2,4}))?\b/))) {
    const q = Number(m[1]);
    const y = m[2] ? (m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2])) : q <= curQ ? ty : ty - 1;
    return out([quarter(y, q)]);
  }
  const yearOf = (y: number) => range(ymd(y, 1, 1), ymd(y, 12, 31));
  if ((m = e.match(new RegExp(`\\b${PART} (?:of )?(?:the year|this year|the year|last year|(\\d{4}))\\b`)))) {
    const y = /last year/.test(e) ? ty - 1 : m[2] ? Number(m[2]) : ty;
    return out([part(yearOf(y), m[1]!)]);
  }
  if (/\b(?:early|earlier) this year\b|\bearlier in the year\b/.test(e)) return out([range(ymd(ty, 1, 1), today)]);
  if (/\b(?:this year|so far this year|year to date)\b/.test(e)) return out([range(ymd(ty, 1, 1), today)]);
  if (/\blast year\b/.test(e)) return out([yearOf(ty - 1)]);
  if ((m = e.match(new RegExp(`\\b(?:a|one|${COUNT_NC}) years? (?:ago|back)\\b`)))) {
    const n = (e.match(new RegExp(`\\b${COUNT} years?`)) ?? [])[1];
    const d = monthsAgo(today, 12 * (n ? parseCount(n) : 1));
    return out([range(addDays(d, -20), addDays(d, 20))]);
  }

  // ---- N days/weeks ago, vague ----------------------------------------------------------
  if ((m = e.match(/\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a couple of|couple) days? (?:ago|back)\b/))) {
    const d = addDays(today, -parseCount(m[1]!));
    return out([day(d), range(addDays(d, -1), addDays(d, 1))]);
  }
  if ((m = e.match(/\b(\d+|a|an|one|two|three|four|five|six|a couple of|couple) weeks? (?:ago|back)\b/))) {
    const d = addDays(today, -7 * parseCount(m[1]!));
    return out([range(addDays(d, -3), addDays(d, 3))]);
  }
  if (/\b(a few|few|several) days (?:ago|back)\b|\bthe other day\b|\bearlier this week\b/.test(e)) return out([range(addDays(today, -7), addDays(today, -1))]);
  if (/\b(a few|few|several) weeks (?:ago|back)\b|\brecently\b|\blately\b/.test(e)) return out([range(addDays(today, -30), today)]);
  if (/\b(?:a while|some time|a long time|long) (?:ago|back)\b|\bmonths ago\b/.test(e)) return out([range(monthsAgo(today, 12), addDays(today, -7))]);

  // ---- Absolute dates --------------------------------------------------------------------
  // "between 3 and 5 November", "from 3 to 5 Nov", "3-5 November"
  if ((m = e.match(new RegExp(`\\b(?:between |from )?(\\d{1,2})(?:st|nd|rd|th)?(?: and | to |\\s?-\\s?|\\s?–\\s?)(\\d{1,2})(?:st|nd|rd|th)? (?:of )?${MONTHS}(?: (\\d{4}))?\\b`)))) {
    const mo = monthIndex(m[3]!);
    const r = pastMonth(today, mo, m[4] ? Number(m[4]) : undefined);
    const y = Number(r.start.slice(0, 4));
    const a = Math.min(Number(m[1]), daysInMonth(y, mo)), b = Math.min(Number(m[2]), daysInMonth(y, mo));
    return out([range(ymd(y, mo, Math.min(a, b)), ymd(y, mo, Math.max(a, b)))]);
  }
  // Numeric d/m or m/d: day first outside the US, with the other reading as a backup.
  if ((m = e.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/)) || (m = e.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/))) {
    const a = Number(m[1]), b = Number(m[2]);
    const yr = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : undefined;
    const mk = (d: number, mo: number): string | null => {
      if (mo < 1 || mo > 12 || d < 1) return null;
      let y = yr ?? ty;
      if (d > daysInMonth(y, mo)) return null;
      if (!yr && ymd(y, mo, d) > today) y -= 1;
      return d > daysInMonth(y, mo) ? null : ymd(y, mo, d);
    };
    const dayFirst = mk(a, b), monthFirstD = mk(b, a);
    const order = monthFirst(tz) ? [monthFirstD, dayFirst] : [dayFirst, monthFirstD];
    const cands = order.filter((x): x is string => Boolean(x)).map(day);
    if (cands.length) return out(cands);
  }
  // "on the 3rd": the most recent past 3rd of a month.
  if ((m = e.match(/\bon the (\d{1,2})(?:st|nd|rd|th)\b/))) {
    const dd = Number(m[1]);
    for (let k = 0; k < 3; k++) {
      const [y, mo] = shiftMonth(ty, tm, k);
      if (dd <= daysInMonth(y, mo) && ymd(y, mo, dd) <= today) return out([day(ymd(y, mo, dd))]);
    }
  }
  // Fixed-date holidays ("on Christmas", "around New Year"); movable ones (Diwali, Eid) come from the planner's guess.
  for (const [re, mo, dd] of HOLIDAYS) {
    if (re.test(e)) {
      const y = ymd(ty, mo, dd) <= today ? ty : ty - 1;
      const d = ymd(y, mo, dd);
      return out(/\baround\b|\bnear\b|\bbefore\b|\bafter\b/.test(e) ? [range(addDays(d, -4), addDays(d, 4))] : [day(d), range(addDays(d, -3), addDays(d, 3))]);
    }
  }
  // "3 November", "Nov 3", "2026-11-03".
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

const HOLIDAYS: Array<[RegExp, number, number]> = [
  [/\bnew year'?s eve\b/, 12, 31],
  [/\bchristmas eve\b/, 12, 24],
  [/\b(?:christmas|xmas)\b/, 12, 25],
  [/\bnew year'?s(?: day)?\b|\bnew year\b/, 1, 1],
  [/\bvalentine'?s(?: day)?\b/, 2, 14],
  [/\bhalloween\b/, 10, 31],
  [/\bindependence day\b/, 8, 15],
  [/\brepublic day\b/, 1, 26],
];
const HOLIDAY_RE = "(?:(?:around|on|at|near|before|after|during) )?(?:new year'?s eve|christmas eve|christmas|xmas|new year'?s(?: day)?|new year|valentine'?s(?: day)?|halloween|independence day|republic day)";

/**
 * Find time expressions in free text. Used as a deterministic backstop to the planner
 * (and as the whole mechanism when the planner is unavailable). Longer, more specific patterns
 * come first so that "last to last Tuesday" is not also found as "last Tuesday".
 */
export function findTimeExpressions(text: string): string[] {
  const t = text.toLowerCase().replace(/’/g, "'");
  const W = "(?:last week|this week|the week before last)";
  const patterns = [
    new RegExp(`\\b(?:last to last|last but one|the last but one|the one before last) ${WD}\\b`, "g"),
    new RegExp(`\\b(?:the )?${WD} before last\\b`, "g"),
    new RegExp(`\\b${COUNT_NC} ${WD}s (?:ago|back)\\b`, "g"),
    new RegExp(`\\b${WD},? (?:of |in )?${W}\\b`, "g"),
    new RegExp(`\\b${W}(?:'s)?,? (?:on )?${WD}\\b`, "g"),
    new RegExp(`\\b${WD},? ${COUNT_NC} weeks? (?:ago|back)\\b`, "g"),
    new RegExp(`\\b${COUNT_NC} weeks? (?:ago|back),? (?:on )?(?:a |the )?${WD}\\b`, "g"),
    new RegExp(`\\b(?:first|1st|second|2nd|third|3rd|fourth|4th|last|final) week (?:of|in) (?:last month|this month|${MON}(?: \\d{4})?)\\b`, "g"),
    new RegExp(`\\b(?:early|the beginning of|beginning of|the start of|start of|mid|the middle of|middle of|late|the end of|end of) (?:last month|this month|the month|${MON}(?: \\d{4})?|(?:of )?(?:the year|this year|last year|\\d{4}))\\b`, "g"),
    /\b(?:between |from )?\d{1,2}(?:st|nd|rd|th)?(?: and | to |\s?-\s?|\s?–\s?)\d{1,2}(?:st|nd|rd|th)? (?:of )?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?: \d{4})?\b/g,
    /\b(?:the )?(?:week|month) before last\b/g,
    /\b(?:the |in the |over the |within the )?(?:past|last) (?:\d+|two|three|four|five|six|seven|ten|fourteen|few|couple of) (?:days|weeks|months)\b/g,
    /\b(?:the past week|past week|(?:in|over|within) the (?:past|last) (?:week|month)|the past month|past month|the last seven days|past 7 days|last 30 days)\b/g,
    /\b(?:earlier this (?:week|month|year)|earlier in the year|so far this year|this year|last year|year to date)\b/g,
    /\b(?:last|previous|this) quarter\b|\bq[1-4](?:\s*(?:of\s*)?'?\d{2,4})?\b/g,
    /\b(?:a )?fortnight ago\b|\bthe other (?:day|week)\b/g,
    /\b(?:last|this past|over the|on the|at the|this) weekend\b/g,
    /\b(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a couple of|couple|a few|few|several) (?:days?|weeks?|months?|years?) (?:ago|back)\b/g,
    /\b(?:a while|some time|a long time|long) (?:ago|back)\b/g,
    /\b(earlier today|today|this (?:morning|afternoon|evening)|tonight|yesterday|last night|day before yesterday)\b/g,
    new RegExp(`\\b(?:last|this|on|past) ${WEEKDAY_RE}\\b`, "g"),
    /\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g, // bare weekdays: full names only
    /\b(?:this|last) (?:week|month)\b/g,
    new RegExp(`\\b(?:in|during|back in) ${MON}(?: \\d{4})?\\b`, "g"),
    new RegExp(`\\b(?:last|this) (?!may\\b)${MON}\\b`, "g"),
    /\b(?:january|february|march|april|june|july|august|september|october|november|december) \d{4}\b/g,
    /\b(?:the other day|earlier this week|recently|lately)\b/g,
    new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)? (?:of )?${MONTHS}(?: \\d{4})?\\b`, "g"),
    new RegExp(`\\b${MONTHS} \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?\\b`, "g"),
    /\bon the \d{1,2}(?:st|nd|rd|th)\b/g,
    new RegExp(`\\b${HOLIDAY_RE}\\b`, "g"),
    /\b\d{4}-\d{2}-\d{2}\b/g,
    /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
    /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g,
  ];
  const found: Array<{ i: number; s: string }> = [];
  for (const re of patterns) {
    for (const m of t.matchAll(re)) {
      const i = m.index ?? 0;
      const end = i + m[0].length;
      // Skip spans that overlap one already found (earlier patterns are the more specific ones).
      if (found.some((f) => i < f.i + f.s.length && end > f.i)) continue;
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
