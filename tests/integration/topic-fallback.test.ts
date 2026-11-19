/**
 * Topic first when the date is wrong: the user names a day, the topic lives on another day.
 * Confident -> answer from that day and say the real date. Unsure -> ask the user to confirm. Needs Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, postgresAvailable } from "./setup";

const available = await postgresAvailable();
const USER = "pw|topicfirst";
const TZ = "Asia/Kolkata";
const AT = new Date("2026-11-19T06:00:00Z"); // Thu 19 Nov, 11:30 Kolkata

describe.skipIf(!available)("topic-first recall fallback", () => {
  let env: Awaited<ReturnType<typeof freshDatabase>>;
  let db: typeof import("../../src/db/index");
  let recall: typeof import("../../src/agent/recall").recall;
  let resolveAll: typeof import("../../src/time/resolve").resolveAll;

  const say = async (repo: typeof import("../../src/db/repo"), title: string, date: string, q: string, a: string) => {
    const conv = await repo.createConversation(title, `${date}T06:00:00Z`);
    const u = await repo.insertMessage({ conversation_id: conv.id, role: "user", text: q, content_json: "[]", created_at: `${date}T06:00:00Z`, tz: TZ, local_date: date, reply_to: null });
    await repo.insertMessage({ conversation_id: conv.id, role: "assistant", text: a, content_json: "[]", created_at: `${date}T06:00:05Z`, tz: TZ, local_date: date, reply_to: u.id });
  };

  beforeAll(async () => {
    env = await freshDatabase("topicfirst");
    process.env.DATABASE_URL = env.appUrl;
    delete process.env.EMBEDDING_MODEL;
    db = await import("../../src/db/index");
    const repo = await import("../../src/db/repo");
    const auth = await import("../../src/auth");
    ({ recall } = await import("../../src/agent/recall"));
    ({ resolveAll } = await import("../../src/time/resolve"));
    await auth.ensureUser({ id: USER, name: "rishi" }, "pw", "topicfirst");
    await db.asUser(USER, async () => {
      await say(repo, "CRM shortlist", "2026-10-27", "Shortlist five CRM tools for a 10-person sales team", "HubSpot, Pipedrive, Zoho, Close and Attio [S1].");
      await say(repo, "Lunch", "2026-11-17", "Suggest a quick vegetarian lunch", "Try a chickpea salad.");
      await say(repo, "Neon pricing", "2026-11-03", "What does Neon Postgres hosting cost?", "Neon Launch starts at $5/month [S1].");
      await say(repo, "Supabase pricing", "2026-11-05", "What does Supabase Postgres hosting cost?", "Supabase Pro is $25/month [S1].");
    });
  });

  afterAll(async () => {
    await db?.closePool();
    await env?.drop();
  });

  const plan = (time: string[], keywords: string[]) => ({
    task: "recall_only" as const, needs_memory: true, time_expressions: time, topic_keywords: keywords, entities: [], needs_web: false,
    date_guesses: [], recency: "any" as const, source: "model" as const,
  });

  it("wrong date, clear topic: answers from the real day and says so", async () => {
    const p = plan(["last Tuesday"], ["CRM", "shortlist"]); // last Tuesday = 17 Nov (lunch) or 10 Nov (nothing)
    const b = await db.asUser(USER, () => recall(p, resolveAll(p.time_expressions, AT, TZ), "c_new"));
    expect(b.status).toBe("found");
    expect(b.turns.map((t) => t.local_date)).toEqual(["2026-10-27"]);
    expect(b.resolved[0]?.date).toBe("2026-10-27");
    expect(b.note).toMatch(/not 2026-11-17/);
  });

  it("wrong date, two plausible chats on different days: asks which one", async () => {
    const p = plan(["last Tuesday"], ["Postgres", "hosting", "cost"]);
    const b = await db.asUser(USER, () => recall(p, resolveAll(p.time_expressions, AT, TZ), "c_new"));
    expect(b.status).toBe("confirm");
    expect(new Set(b.turns.map((t) => t.local_date))).toEqual(new Set(["2026-11-03", "2026-11-05"]));
    expect(b.note).toMatch(/Did you mean/);
  });

  it("no date at all, clear topic: found with its date", async () => {
    const p = plan([], ["CRM", "shortlist"]);
    const b = await db.asUser(USER, () => recall(p, [], "c_new"));
    expect(b.status).toBe("found");
    expect(b.turns[0]?.local_date).toBe("2026-10-27");
  });

  it("nothing about the topic anywhere: falls back to what happened that day", async () => {
    const p = plan(["last Tuesday"], ["kubernetes"]);
    const b = await db.asUser(USER, () => recall(p, resolveAll(p.time_expressions, AT, TZ), "c_new"));
    expect(b.turns.every((t) => t.local_date === "2026-11-17")).toBe(true);
  });
});
