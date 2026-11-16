/** Query building, the search gateway (cache, coalescing, fallback) and per-user limits without Redis. */
import { describe, expect, it, vi } from "vitest";

// No Redis in unit tests: point at a closed port so every Redis call falls back.
process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.RATE_LIMIT_PER_MINUTE = "3";
process.env.DAILY_TOKEN_BUDGET = "1000";

const { ftsQuery } = await import("../src/db/repo");
const { cachedProvider, withFallback } = await import("../src/search/gateway");
const { admitTurn, recordTokens } = await import("../src/budget");

describe("ftsQuery", () => {
  it("builds a prefix OR query from letters and digits only", () => {
    expect(ftsQuery(["Postgres hosting", "pricing"])).toBe("postgres:* | hosting:* | pricing:*");
    expect(ftsQuery(["Node.js 22"])).toBe("node:* | js:* | 22:*");
  });
  it("drops stop words, one-letter tokens and tsquery syntax", () => {
    expect(ftsQuery(["what did you about the", "a"])).toBeNull();
    expect(ftsQuery(["x' | !y & (z:*)"])).toBeNull();
    expect(ftsQuery(["crm' | evil & (drop)"])).toBe("crm:* | evil:* | drop:*");
  });
});

describe("search gateway", () => {
  const req = { query: "neon pricing", numResults: 5, timeoutMs: 1000 };
  it("coalesces identical in-flight queries", async () => {
    const search = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return [{ url: "https://neon.com/pricing", title: "Neon", publishedAt: null, excerpt: "x" }];
    });
    const p = cachedProvider({ name: "t", search });
    const [a, b] = await Promise.all([p.search(req), p.search({ ...req, query: "  Neon   PRICING " })]);
    expect(a).toEqual(b);
    expect(search).toHaveBeenCalledTimes(1);
  });
  it("falls back to the second provider when the first fails", async () => {
    const primary = { name: "exa", search: vi.fn(async () => Promise.reject(new Error("503"))) };
    const secondary = { name: "tavily", search: vi.fn(async () => [{ url: "u", title: "t", publishedAt: null, excerpt: "e" }]) };
    expect(await withFallback(primary, secondary).search(req)).toHaveLength(1);
    expect(secondary.search).toHaveBeenCalledOnce();
  });
});

describe("per-user limits (Redis down: per-process counters)", () => {
  it("rate-limits requests per minute per user", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await admitTurn("dev|rl")).ok);
    expect(results).toEqual([true, true, true, false]);
    expect((await admitTurn("dev|other")).ok).toBe(true);
  });
  it("stops a user at the daily token budget", async () => {
    expect((await admitTurn("dev|budget")).ok).toBe(true);
    await recordTokens(1200, "dev|budget");
    const a = await admitTurn("dev|budget");
    expect(a.ok).toBe(false);
    expect(!a.ok && a.message).toMatch(/token budget/);
  });
});
