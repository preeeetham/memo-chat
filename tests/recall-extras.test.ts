import { describe, expect, it } from "vitest";
import { pickFromRange } from "../src/agent/recall";
import { relativeToLastRecall } from "../src/agent/turn";

const turns = Array.from({ length: 20 }, (_, i) => ({ id: i, created_at: `2026-10-${String(i + 1).padStart(2, "0")}T10:00:00Z` }));

describe("long ranges", () => {
  it("spreads picks across the range instead of taking the first eight", () => {
    const ids = pickFromRange(turns, 8).map((t) => t.id);
    expect(ids[0]).toBe(0);
    expect(ids[7]).toBe(19);
    expect(ids).toHaveLength(8);
  });
  it("'before that' takes the newest", () => expect(pickFromRange(turns, 3, "before that").map((t) => t.id)).toEqual([17, 18, 19]));
  it("'after that' takes the oldest", () => expect(pickFromRange(turns, 3, "after that").map((t) => t.id)).toEqual([0, 1, 2]));
  it("short lists are returned whole, in order", () => expect(pickFromRange(turns.slice(0, 3).reverse(), 8).map((t) => t.id)).toEqual([0, 1, 2]));
});

describe("before that / after that", () => {
  const prior = [
    { role: "user" as const, meta_json: null },
    { role: "assistant" as const, meta_json: JSON.stringify({ memory: { recalled: [{ local_date: "2026-10-27" }], resolved: [{ date: "2026-10-27" }] } }) },
  ];
  it("before that -> the 30 days before the last recalled date", () =>
    expect(relativeToLastRecall("and what did we discuss before that?", prior, "2026-11-19")?.candidates).toEqual([{ start: "2026-09-27", end: "2026-10-26" }]));
  it("after that -> from the day after until today", () =>
    expect(relativeToLastRecall("anything after that?", prior, "2026-11-19")?.candidates).toEqual([{ start: "2026-10-28", end: "2026-11-19" }]));
  it("nothing recalled yet -> null", () => expect(relativeToLastRecall("before that?", [{ role: "assistant" as const, meta_json: "{}" }], "2026-11-19")).toBeNull());
  it("no phrase -> null", () => expect(relativeToLastRecall("what about CRMs", prior, "2026-11-19")).toBeNull());
});
