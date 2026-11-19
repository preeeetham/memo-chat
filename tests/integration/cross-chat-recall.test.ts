/**
 * Memory across chats: a question in a new chat about "this morning" finds what the user discussed in
 * another chat, including just after midnight, when "this morning" means the day that just ended.
 * Also checks the prompt rules that stop the model denying its memory. Needs Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, postgresAvailable } from "./setup";

const available = await postgresAvailable();
const USER = "pw|crosschat";
const TZ = "Asia/Kolkata";

describe.skipIf(!available)("cross-chat recall by time", () => {
  let env: Awaited<ReturnType<typeof freshDatabase>>;
  let db: typeof import("../../src/db/index");
  let recall: typeof import("../../src/agent/recall").recall;
  let resolveAll: typeof import("../../src/time/resolve").resolveAll;
  let firstChat = "";

  beforeAll(async () => {
    env = await freshDatabase("crosschat");
    process.env.DATABASE_URL = env.appUrl;
    db = await import("../../src/db/index");
    const repo = await import("../../src/db/repo");
    const auth = await import("../../src/auth");
    ({ recall } = await import("../../src/agent/recall"));
    ({ resolveAll } = await import("../../src/time/resolve"));
    await auth.ensureUser({ id: USER, name: "rishi" }, "pw", "crosschat");
    // Chat 1, Wed 11 Nov, 15:00 in Kolkata: who is Nvidia's CEO.
    await db.asUser(USER, async () => {
      const conv = await repo.createConversation("Nvidia CEO", "2026-11-11T09:30:00Z");
      firstChat = conv.id;
      const u = await repo.insertMessage({ conversation_id: conv.id, role: "user", text: "Who is the CEO of Nvidia and why is he in the news?", content_json: "[]", created_at: "2026-11-11T09:30:00Z", tz: TZ, local_date: "2026-11-11", reply_to: null });
      await repo.insertMessage({ conversation_id: conv.id, role: "assistant", text: "Jensen Huang is Nvidia's CEO; he is in the news for stepping down [S1].", content_json: "[]", created_at: "2026-11-11T09:30:05Z", tz: TZ, local_date: "2026-11-11", reply_to: u.id });
    });
  });

  afterAll(async () => {
    await db?.closePool();
    await env?.drop();
  });

  const plan = {
    task: "recall_only" as const,
    needs_memory: true,
    time_expressions: ["today morning or after noon"],
    topic_keywords: ["discussing", "whom"],
    entities: [],
    needs_web: false,
    date_guesses: [],
    recency: "any" as const,
    source: "model" as const,
  };

  it("finds the other chat when asked the same afternoon", async () => {
    const at = new Date("2026-11-11T12:00:00Z"); // 17:30 Kolkata
    const b = await db.asUser(USER, () => recall(plan, resolveAll(plan.time_expressions, at, TZ), "c_new_chat"));
    expect(b.status).toBe("found");
    expect(b.turns[0]?.conversation_id).toBe(firstChat);
    expect(b.turns[0]?.question).toMatch(/Nvidia/);
  });

  it("finds it just after midnight too, when 'today morning' means the day that just ended", async () => {
    const at = new Date("2026-11-11T19:29:00Z"); // Thu 12 Nov, 00:59 Kolkata
    const b = await db.asUser(USER, () => recall(plan, resolveAll(plan.time_expressions, at, TZ), "c_new_chat"));
    expect(b.status).toBe("found");
    expect(b.turns[0]?.question).toMatch(/Nvidia/);
  });

  it("'Read as' shows the day that actually matched, not the first candidate", async () => {
    // Thu 19 Nov: "last Wednesday" could be 18 Nov (yesterday) or 11 Nov. Only 11 Nov has a chat.
    const at = new Date("2026-11-19T06:00:00Z"); // Thu 19 Nov, 11:30 Kolkata
    const p = { ...plan, time_expressions: ["last Wednesday"], topic_keywords: ["Nvidia", "CEO"] };
    const b = await db.asUser(USER, () => recall(p, resolveAll(p.time_expressions, at, TZ), "c_new_chat"));
    expect(b.status).toBe("found");
    expect(b.resolved[0]?.date).toBe("2026-11-11");
  });

  it("falls back to the adjacent day when the named day has no chats at all", async () => {
    const at = new Date("2026-11-12T03:00:00Z"); // Thu 12 Nov, 08:30 Kolkata: "today" is empty
    const b = await db.asUser(USER, () => recall({ ...plan, time_expressions: ["today"] }, resolveAll(["today"], at, TZ), "c_new_chat"));
    expect(b.status).toBe("found");
    expect(b.turns[0]?.local_date).toBe("2026-11-11");
  });
});

describe("prompt: the model is told it has memory and must not deny it", () => {
  it("states cross-chat memory and forbids 'each session starts fresh'", async () => {
    const { SYSTEM_PROMPT } = await import("../../src/agent/prompt");
    expect(SYSTEM_PROMPT).toMatch(/across all of their chats/);
    expect(SYSTEM_PROMPT).toMatch(/Never say you have no memory/);
    expect(SYSTEM_PROMPT).toMatch(/how you know/);
  });
});
