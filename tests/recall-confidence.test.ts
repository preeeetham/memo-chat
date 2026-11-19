import { describe, expect, it } from "vitest";
import { judgeConfidence, type ScoredTurn } from "../src/agent/recall";

const t = (id: string, date: string, score: number, sim: number | null, fts = true): ScoredTurn => ({ assistant_id: id, local_date: date, score, sim, fts });

describe("recall confidence", () => {
  it("nothing -> low", () => expect(judgeConfidence([], true).level).toBe("low"));
  it("a strong vector match clearly ahead -> high, keeping that day's turns", () => {
    const r = judgeConfidence([t("a", "2026-10-27", 0.06, 0.82), t("b", "2026-10-27", 0.03, 0.7), t("c", "2026-11-03", 0.016, 0.61)], true);
    expect(r.level).toBe("high");
    expect(r.picks.map((p) => p.assistant_id)).toEqual(["a", "b"]);
  });
  it("strong but two dates neck and neck -> medium, one option per date", () => {
    const r = judgeConfidence([t("a", "2026-10-27", 0.05, 0.8), t("b", "2026-11-03", 0.045, 0.79), t("c", "2026-11-03", 0.02, 0.7)], true);
    expect(r.level).toBe("medium");
    expect(r.picks.map((p) => p.local_date)).toEqual(["2026-10-27", "2026-11-03"]);
  });
  it("a weak vector match -> medium (ask)", () => expect(judgeConfidence([t("a", "2026-10-27", 0.02, 0.65, false)], true).level).toBe("medium"));
  it("with vectors on, a keyword-only hit is not enough to answer", () => expect(judgeConfidence([t("a", "2026-10-27", 0.04, null)], true).level).toBe("medium"));
  it("with vectors off, a single-date keyword hit -> high", () => expect(judgeConfidence([t("a", "2026-10-27", 0.04, null)], false).level).toBe("high"));
  it("at most three options to choose from", () =>
    expect(judgeConfidence(["01", "02", "03", "04"].map((d, i) => t(`x${i}`, `2026-10-${d}`, 0.03, 0.7)), true).picks).toHaveLength(3));
});
