import { describe, expect, it } from "vitest";
import { findTimeExpressions, resolve } from "../src/time/resolve";
import { localDate } from "../src/time/local";

// Wed 11 Nov 2026, 14:05 in Asia/Kolkata (08:35 UTC)
const NOW = new Date("2026-11-11T08:35:00Z");
const TZ = "Asia/Kolkata";
const r = (expr: string, now = NOW, tz = TZ) => resolve(expr, now, tz).candidates;
const d = (s: string) => ({ start: s, end: s });

describe("resolve: relative days", () => {
  it("today", () => expect(r("today")).toEqual([d("2026-11-11")]));
  it("earlier today", () => expect(r("earlier today")).toEqual([d("2026-11-11")]));
  it("this morning", () => expect(r("this morning")).toEqual([d("2026-11-11")]));
  it("yesterday", () => expect(r("yesterday")).toEqual([d("2026-11-10")]));
  it("day before yesterday", () => expect(r("the day before yesterday")).toEqual([d("2026-11-09")]));
});

describe("resolve: just after midnight the user's 'today' includes the day that just ended", () => {
  // Thu 12 Nov 2026, 00:59 in Asia/Kolkata (Wed 11 Nov 19:29 UTC)
  const AFTER_MIDNIGHT = new Date("2026-11-11T19:29:00Z");
  const both = { start: "2026-11-11", end: "2026-11-12" };
  it("today morning or afternoon", () => expect(r("today morning or after noon", AFTER_MIDNIGHT)).toEqual([both]));
  it("this morning", () => expect(r("this morning", AFTER_MIDNIGHT)).toEqual([both]));
  it("earlier today", () => expect(r("earlier today", AFTER_MIDNIGHT)).toEqual([both]));
  it("last night", () => expect(r("last night", AFTER_MIDNIGHT)).toEqual([both]));
  it("yesterday is still yesterday", () => expect(r("yesterday", AFTER_MIDNIGHT)).toEqual([d("2026-11-11")]));
  it("after 5 am, today is just today", () => expect(r("this morning", new Date("2026-11-12T01:00:00Z"))).toEqual([d("2026-11-12")]));
});

describe("resolve: weekdays", () => {
  it("bare Monday -> most recent Monday", () => expect(r("Monday")).toEqual([d("2026-11-09")]));
  it("on Monday", () => expect(r("on Monday")).toEqual([d("2026-11-09")]));
  it("on Wednesday when today is Wednesday -> today first, then last week", () =>
    expect(r("on Wednesday")).toEqual([d("2026-11-11"), d("2026-11-04")]));
  it("last Tuesday -> yesterday first, then 7 days earlier (ambiguous)", () =>
    expect(r("last Tuesday")).toEqual([d("2026-11-10"), d("2026-11-03")]));
  it("last Wednesday when today is Wednesday -> a week ago", () =>
    expect(r("last Wednesday")).toEqual([d("2026-11-04"), d("2026-10-28")]));
  it("last Thursday", () => expect(r("last thursday")).toEqual([d("2026-11-05"), d("2026-10-29")]));
  it("abbreviation: tues", () => expect(r("last tues")).toEqual([d("2026-11-10"), d("2026-11-03")]));
  it("Friday", () => expect(r("Friday")).toEqual([d("2026-11-06")]));
  it("Sunday", () => expect(r("sunday")).toEqual([d("2026-11-08")]));
});

describe("resolve: weeks and months", () => {
  it("this week (ISO, Monday start)", () => expect(r("this week")).toEqual([{ start: "2026-11-09", end: "2026-11-11" }]));
  it("last week", () => expect(r("last week")).toEqual([{ start: "2026-11-02", end: "2026-11-08" }]));
  it("last month", () => expect(r("last month")).toEqual([{ start: "2026-10-01", end: "2026-10-31" }]));
  it("last month in January rolls the year", () =>
    expect(r("last month", new Date("2026-01-15T10:00:00Z"))).toEqual([{ start: "2025-12-01", end: "2025-12-31" }]));
});

describe("resolve: N ago", () => {
  it("3 days ago -> exact then +/-1", () =>
    expect(r("3 days ago")).toEqual([d("2026-11-08"), { start: "2026-11-07", end: "2026-11-09" }]));
  it("two days ago (word)", () => expect(r("two days ago")[0]).toEqual(d("2026-11-09")));
  it("a week ago", () => expect(r("a week ago")).toEqual([{ start: "2026-11-01", end: "2026-11-07" }]));
  it("a few weeks ago -> last 30 days", () => expect(r("a few weeks ago")).toEqual([{ start: "2026-10-12", end: "2026-11-11" }]));
  it("recently -> last 30 days", () => expect(r("recently")).toEqual([{ start: "2026-10-12", end: "2026-11-11" }]));
});

describe("resolve: absolute dates", () => {
  it("3 November", () => expect(r("3 November")).toEqual([d("2026-11-03")]));
  it("on 3rd November", () => expect(r("on 3rd November")).toEqual([d("2026-11-03")]));
  it("Nov 3", () => expect(r("Nov 3")).toEqual([d("2026-11-03")]));
  it("future date this year -> last year", () => expect(r("25 December")).toEqual([d("2025-12-25")]));
  it("3 November asked in January -> previous year", () =>
    expect(r("3 November", new Date("2027-01-05T09:00:00Z"))).toEqual([d("2026-11-03")]));
  it("explicit year is kept", () => expect(r("November 3, 2025")).toEqual([d("2025-11-03")]));
  it("ISO date", () => expect(r("2026-11-03")).toEqual([d("2026-11-03")]));
  it("unknown text -> no candidates", () => expect(r("the CRM thing")).toEqual([]));
});

describe("resolve: timezone boundaries", () => {
  // 23:30 UTC on Tue 10 Nov is already Wed 11 Nov 05:00 in Kolkata.
  const late = new Date("2026-11-10T23:30:00Z");
  it("local date flips in Asia/Kolkata", () => expect(localDate(late, TZ)).toBe("2026-11-11"));
  it("but not in UTC", () => expect(localDate(late, "UTC")).toBe("2026-11-10"));
  it("today depends on tz", () => {
    expect(r("today", late, TZ)).toEqual([d("2026-11-11")]);
    expect(r("today", late, "UTC")).toEqual([d("2026-11-10")]);
  });
  it("Monday from Kolkata vs Los Angeles at the same instant", () => {
    const mondayLateUTC = new Date("2026-11-09T20:00:00Z"); // Tue 01:30 in Kolkata, Mon 12:00 in LA
    expect(r("on Monday", mondayLateUTC, TZ)).toEqual([d("2026-11-09")]);
    expect(r("on Monday", mondayLateUTC, "America/Los_Angeles")).toEqual([d("2026-11-09"), d("2026-11-02")]);
  });
  it("labels state the resolved date", () => expect(resolve("last Tuesday", NOW, TZ).label).toBe("last Tuesday (Tue 10 Nov)"));
});

describe("findTimeExpressions", () => {
  it("finds weekday phrases", () =>
    expect(findTimeExpressions("On Monday I asked you to shortlist 5 CRM tools")).toEqual(["on monday"]));
  it("finds last Tuesday once", () =>
    expect(findTimeExpressions("What did we decide last Tuesday about Postgres?")).toEqual(["last tuesday"]));
  it("finds absolute dates", () =>
    expect(findTimeExpressions("What did I ask you on 3 November?")).toEqual(["3 november"]));
  it("ignores normal text", () => expect(findTimeExpressions("Compare Neon and Supabase pricing")).toEqual([]));
  it("finds several", () =>
    expect(findTimeExpressions("yesterday and 2 days ago")).toEqual(["yesterday", "2 days ago"]));
});

describe("resolve: weekdays further back (today is Wed 11 Nov)", () => {
  it("last to last Tuesday -> 3 Nov, then 27 Oct", () => expect(r("last to last Tuesday")).toEqual([d("2026-11-03"), d("2026-10-27")]));
  it("the Tuesday before last", () => expect(r("the Tuesday before last")).toEqual([d("2026-11-03"), d("2026-10-27")]));
  it("Tuesday before last", () => expect(r("tuesday before last")).toEqual([d("2026-11-03"), d("2026-10-27")]));
  it("last but one Tuesday", () => expect(r("last but one Tuesday")).toEqual([d("2026-11-03"), d("2026-10-27")]));
  it("two Tuesdays ago", () => expect(r("two Tuesdays ago")).toEqual([d("2026-11-03"), d("2026-10-27")]));
  it("3 Fridays back", () => expect(r("3 fridays back")[0]).toEqual(d("2026-10-23")));
  it("Tuesday last week", () => expect(r("Tuesday last week")).toEqual([d("2026-11-03")]));
  it("last week on Tuesday", () => expect(r("last week on Tuesday")).toEqual([d("2026-11-03")]));
  it("Friday of last week", () => expect(r("Friday of last week")).toEqual([d("2026-11-06")]));
  it("Tuesday the week before last", () => expect(r("Tuesday the week before last")).toEqual([d("2026-10-27")]));
  it("Monday this week", () => expect(r("Monday this week")).toEqual([d("2026-11-09")]));
  it("Friday this week has not happened yet", () => expect(r("Friday this week")).toEqual([]));
  it("3 weeks ago on Tuesday", () => expect(r("3 weeks ago on Tuesday")).toEqual([d("2026-10-20")]));
  it("Tuesday two weeks ago", () => expect(r("Tuesday two weeks ago")).toEqual([d("2026-10-27")]));
});

describe("resolve: week ranges", () => {
  it("the week before last (ISO)", () => expect(r("the week before last")).toEqual([{ start: "2026-10-26", end: "2026-11-01" }]));
  it("past week is the last 7 days", () => expect(r("past week")).toEqual([{ start: "2026-11-04", end: "2026-11-11" }]));
  it("in the last week is the last 7 days", () => expect(r("in the last week")).toEqual([{ start: "2026-11-04", end: "2026-11-11" }]));
  it("last week is still the previous calendar week", () => expect(r("last week")).toEqual([{ start: "2026-11-02", end: "2026-11-08" }]));
  it("last few days", () => expect(r("last few days")).toEqual([{ start: "2026-11-07", end: "2026-11-11" }]));
  it("past 3 days", () => expect(r("past 3 days")).toEqual([{ start: "2026-11-08", end: "2026-11-11" }]));
  it("past 2 weeks", () => expect(r("the past 2 weeks")).toEqual([{ start: "2026-10-28", end: "2026-11-11" }]));
  it("a fortnight ago", () => expect(r("a fortnight ago")).toEqual([{ start: "2026-10-25", end: "2026-10-31" }]));
  it("the other week", () => expect(r("the other week")).toEqual([{ start: "2026-10-21", end: "2026-11-06" }]));
  it("last weekend", () => expect(r("last weekend")).toEqual([{ start: "2026-11-07", end: "2026-11-08" }]));
  it("over the weekend", () => expect(r("over the weekend")).toEqual([{ start: "2026-11-07", end: "2026-11-08" }]));
  it("this weekend on a Sunday is Sat-Sun so far", () =>
    expect(r("this weekend", new Date("2026-11-15T06:00:00Z"))).toEqual([{ start: "2026-11-14", end: "2026-11-15" }]));
});

describe("findTimeExpressions: longer phrases win", () => {
  it("last to last Tuesday is one phrase", () =>
    expect(findTimeExpressions("What did we discuss last to last Tuesday about CRMs?")).toEqual(["last to last tuesday"]));
  it("Tuesday last week is one phrase", () => expect(findTimeExpressions("Tuesday last week we talked about Neon")).toEqual(["tuesday last week"]));
  it("several", () =>
    expect(findTimeExpressions("on Monday and the Tuesday before last")).toEqual(["on monday", "the tuesday before last"]));
  it("3 weeks ago on Tuesday", () => expect(findTimeExpressions("3 weeks ago on Tuesday I asked")).toEqual(["3 weeks ago on tuesday"]));
  it("past week and last weekend", () => expect(findTimeExpressions("in the past week or last weekend")).toEqual(["in the past week", "last weekend"]));
});
