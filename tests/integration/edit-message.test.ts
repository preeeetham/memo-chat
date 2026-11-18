/**
 * Editing a sent message: the message and everything after it in that chat are removed, together with
 * the memory derived from the removed answers, so recall can never surface a deleted turn.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, postgresAvailable } from "./setup";

const available = await postgresAvailable();
const USER = "pw|editor";
const OTHER = "pw|someoneelse";
const TZ = "UTC";

describe.skipIf(!available)("edit = truncate from that message", () => {
  let env: Awaited<ReturnType<typeof freshDatabase>>;
  let db: typeof import("../../src/db/index");
  let repo: typeof import("../../src/db/repo");
  let conv = "";
  const turns: Array<{ user: string; assistant: string }> = [];

  const claim = (assistant: string, value: string) => ({
    assistant_message_id: assistant,
    speaker: "assistant",
    subject: "Topic",
    attribute: "fact",
    value,
    observed_at: "2026-11-18T10:00:00Z",
    published_at: null,
    source_url: null,
    evidence_id: null,
  }) as unknown as import("../../src/db/repo").NewClaim;

  beforeAll(async () => {
    env = await freshDatabase("edit");
    process.env.DATABASE_URL = env.appUrl;
    db = await import("../../src/db/index");
    repo = await import("../../src/db/repo");
    const auth = await import("../../src/auth");
    await auth.ensureUser({ id: USER, name: "editor" }, "pw", "editor");
    await auth.ensureUser({ id: OTHER, name: "other" }, "pw", "other");
    await db.asUser(USER, async () => {
      conv = (await repo.createConversation("Three turns", "2026-11-18T10:00:00Z")).id;
      for (let i = 1; i <= 3; i++) {
        const at = `2026-11-18T10:0${i}:00Z`;
        const u = await repo.insertMessage({ conversation_id: conv, role: "user", text: `question ${i} about zebras`, content_json: "[]", created_at: at, tz: TZ, local_date: "2026-11-18", reply_to: null });
        const a = await repo.insertMessage({ conversation_id: conv, role: "assistant", text: `answer ${i}`, content_json: "[]", created_at: at, tz: TZ, local_date: "2026-11-18", reply_to: u.id }, { type: "extract_turn", payload: { assistantMessageId: `pending-${i}` } });
        turns.push({ user: u.id, assistant: a.id });
        await repo.saveExtraction({ assistantId: a.id, conversationId: conv, localDate: "2026-11-18", createdAt: at }, { question: `question ${i} about zebras`, answer_summary: `answer ${i}`, entities: ["Zebra"], keywords: ["zebras"] }, [claim(a.id, `value ${i}`)]);
      }
    });
  });

  afterAll(async () => {
    await db?.closePool();
    await env?.drop();
  });

  it("another user cannot truncate this chat", async () => {
    expect(await db.asUser(OTHER, () => repo.truncateFrom(conv, turns[1]!.user))).toBeNull();
    expect((await db.asUser(USER, () => repo.getMessages(conv))).length).toBe(6);
  });

  it("only a user message in this chat can be the edit point", async () => {
    expect(await db.asUser(USER, () => repo.truncateFrom(conv, turns[1]!.assistant))).toBeNull();
    expect(await db.asUser(USER, () => repo.truncateFrom("c_other", turns[1]!.user))).toBeNull();
  });

  it("editing turn 2 removes turns 2 and 3 and their memory, keeps turn 1", async () => {
    const removed = await db.asUser(USER, () => repo.truncateFrom(conv, turns[1]!.user));
    expect(removed).toBe(4);
    const left = await db.asUser(USER, () => repo.getMessages(conv));
    expect(left.map((m) => m.text)).toEqual(["question 1 about zebras", "answer 1"]);

    const admin = new pg.Client({ connectionString: env.adminUrl });
    await admin.connect();
    const digests = (await admin.query("SELECT assistant_message_id FROM turn_digests ORDER BY assistant_message_id")).rows.map((r) => r.assistant_message_id);
    const claims = (await admin.query("SELECT value FROM claims")).rows.map((r) => r.value);
    await admin.end();
    expect(digests).toEqual([turns[0]!.assistant]);
    expect(claims).toEqual(["value 1"]);
  });

  it("an extraction that finishes after the edit saves nothing", async () => {
    await db.asUser(USER, () =>
      repo.saveExtraction({ assistantId: turns[2]!.assistant, conversationId: conv, localDate: "2026-11-18", createdAt: "2026-11-18T10:03:00Z" }, { question: "late", answer_summary: "late", entities: [], keywords: ["late"] }, [claim(turns[2]!.assistant, "late value")]),
    );
    const admin = new pg.Client({ connectionString: env.adminUrl });
    await admin.connect();
    const late = (await admin.query("SELECT count(*)::int AS n FROM turn_digests WHERE assistant_message_id = $1", [turns[2]!.assistant])).rows[0].n;
    await admin.end();
    expect(late).toBe(0);
  });

  it("sidebar search finds this user's chat by title or message text, and nobody else's", async () => {
    expect((await db.asUser(USER, () => repo.searchConversations("ZEBRAS"))).map((c) => c.id)).toEqual([conv]);
    expect((await db.asUser(USER, () => repo.searchConversations("three turns"))).map((c) => c.id)).toEqual([conv]);
    expect(await db.asUser(USER, () => repo.searchConversations("question 2"))).toEqual([]); // removed by the edit
    expect(await db.asUser(USER, () => repo.searchConversations("%"))).toEqual([]); // wildcards are literal
    expect(await db.asUser(OTHER, () => repo.searchConversations("zebras"))).toEqual([]);
  });

  it("recall no longer finds the removed turns", async () => {
    const scores = await db.asUser(USER, () => repo.scoreTurns(["zebras"]));
    expect([...scores.keys()]).toEqual([turns[0]!.assistant]);
  });
});
