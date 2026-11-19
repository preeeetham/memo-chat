import { describe, expect, it } from "vitest";
import { fallbackPlan, looksLikeMemory, mergeTimeExpressions, recencyOf } from "../src/agent/planner";
import { guessedResolutions } from "../src/time/resolve";

const NOW = new Date("2026-11-19T10:00:00Z");
const TZ = "Asia/Kolkata";

describe("planner: merging time phrases", () => {
  it("the finder's longer phrase replaces the model's shorter one", () =>
    expect(mergeTimeExpressions(["last Tuesday"], ["last to last tuesday"])).toEqual(["last to last tuesday"]));
  it("keeps the model's phrase when it already covers the finder's", () =>
    expect(mergeTimeExpressions(["last to last Tuesday"], ["last to last tuesday"])).toEqual(["last to last Tuesday"]));
  it("keeps phrases only the model saw (holidays)", () =>
    expect(mergeTimeExpressions(["around Diwali"], [])).toEqual(["around Diwali"]));
  it("adds phrases the model missed", () => expect(mergeTimeExpressions([], ["in october"])).toEqual(["in october"]));
});

describe("planner fallback: memory triggers", () => {
  for (const t of [
    "What did we talk about a while back on CRMs?",
    "the first time I asked you about Neon",
    "In October you recommended Supabase",
    "Last year we picked HubSpot",
    "what did I tell you previously about pricing",
    "last to last Tuesday we discussed Postgres hosting",
  ]) it(t, () => expect(fallbackPlan(t).needs_memory).toBe(true));
  it("a plain question is not memory", () => expect(looksLikeMemory("Compare Neon and Supabase pricing")).toBe(false));
});

describe("planner: first or latest", () => {
  it("first time", () => expect(recencyOf("the first time I asked about CRMs")).toBe("first"));
  it("last time", () => expect(recencyOf("what did we talk about last time")).toBe("latest"));
  it("neither", () => expect(recencyOf("what did we say about CRMs")).toBe("any"));
});

describe("planner date guesses (Diwali, seasons)", () => {
  it("uses the guess for a phrase the code can't read", () =>
    expect(guessedResolutions([{ expr: "around Diwali", start: "2026-11-05", end: "2026-11-12" }], ["around Diwali"], NOW, TZ)).toEqual([
      { expr: "around Diwali", label: "around Diwali (Thu 5 Nov to Thu 12 Nov)", candidates: [{ start: "2026-11-05", end: "2026-11-12" }] },
    ]));
  it("drops a future guess", () => expect(guessedResolutions([{ expr: "Holi", start: "2027-03-20", end: "2027-03-22" }], ["Holi"], NOW, TZ)).toEqual([]));
  it("clamps a guess that runs past today", () =>
    expect(guessedResolutions([{ expr: "this winter", start: "2026-11-01", end: "2027-02-28" }], ["this winter"], NOW, TZ)[0]!.candidates).toEqual([
      { start: "2026-11-01", end: "2026-11-19" },
    ]));
  it("drops malformed dates", () => expect(guessedResolutions([{ expr: "x", start: "Nov 5", end: "2026-11-12" }], ["x"], NOW, TZ)).toEqual([]));
});
