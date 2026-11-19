/**
 * Tenant isolation: two users share one database; neither can see, find, recall, change or delete
 * the other's history, through any repo function or through raw SQL as the app role.
 * Needs Postgres: `docker compose up -d postgres redis`, then `npm run test:integration`.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, postgresAvailable } from "./setup";

const available = await postgresAvailable();
if (!available) console.warn("[integration] Postgres not reachable on the compose port; skipping. Run `docker compose up -d postgres redis`.");

describe.skipIf(!available)("per-user isolation (row-level security)", () => {
  let env: Awaited<ReturnType<typeof freshDatabase>>;
  let db: typeof import("../../src/db/index");
  let repo: typeof import("../../src/db/repo");
  let auth: typeof import("../../src/auth");
  const ALICE = "dev|alice";
  const BOB = "dev|bob";
  let aliceConv = "";
  let aliceAssistant = "";

  beforeAll(async () => {
    env = await freshDatabase("isolation");
    process.env.DATABASE_URL = env.appUrl;
    process.env.REDIS_PREFIX = `test:${Date.now()}:`;
    db = await import("../../src/db/index");
    repo = await import("../../src/db/repo");
    auth = await import("../../src/auth");
    await auth.ensureUser({ id: ALICE, name: "alice" }, "dev", "alice");
    await auth.ensureUser({ id: BOB, name: "bob" }, "dev", "bob");

    // Alice: one turn about CRM pricing, with web evidence, a digest and claims.
    await db.asUser(ALICE, async () => {
      const at = "2026-11-09T04:42:00.000Z";
      const conv = await repo.createConversation("CRM shortlist", at);
      aliceConv = conv.id;
      const u = await repo.insertMessage({ conversation_id: conv.id, role: "user", text: "Shortlist five CRM tools with per-seat pricing", content_json: "[]", created_at: at, tz: "Asia/Kolkata", local_date: "2026-11-09", reply_to: null });
      aliceAssistant = "a_alice0000000001";
      const call = await repo.insertSearchCall({ assistantId: aliceAssistant, query: "hubspot pricing", since: null, domains: null, provider: "mock", at });
      const ev = await repo.insertEvidence({ search_call_id: call, assistant_message_id: aliceAssistant, ref: "S1", url: "https://hubspot.com/pricing", title: "HubSpot", published_at: null, retrieved_at: "2026-11-09", excerpt: "Sales Hub Professional $90/seat/mo" });
      await repo.insertMessage(
        { id: aliceAssistant, conversation_id: conv.id, role: "assistant", text: "HubSpot Sales Hub Professional is $90/seat/mo [S1]", content_json: "[]", created_at: at, tz: "Asia/Kolkata", local_date: "2026-11-09", reply_to: u.id },
        { type: "extract_turn", payload: { assistantMessageId: aliceAssistant } },
      );
      await repo.saveExtraction(
        { assistantId: aliceAssistant, conversationId: conv.id, localDate: "2026-11-09", createdAt: at },
        { question: "CRM shortlist", answer_summary: "HubSpot $90/seat", entities: ["HubSpot"], keywords: ["CRM", "pricing"] },
        [{ assistant_message_id: aliceAssistant, speaker: "assistant", subject: "HubSpot Sales Hub Professional", attribute: "price_per_seat_month", value: "$90", observed_at: "2026-11-09", published_at: null, source_url: "https://hubspot.com/pricing", evidence_id: ev }],
        Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)),
      );
    });
  });

  afterAll(async () => {
    if (!env) return;
    await db?.closePool();
    const { closeRedis } = await import("../../src/redis");
    await closeRedis();
    await env.drop();
  });

  it("alice sees her own history", async () => {
    await db.asUser(ALICE, async () => {
      expect((await repo.listConversations()).map((c) => c.id)).toEqual([aliceConv]);
      expect(await repo.getMessages(aliceConv)).toHaveLength(2);
      expect((await repo.scoreTurns(["CRM", "pricing"])).has(aliceAssistant)).toBe(true);
      expect(await repo.turnsInRange("2026-11-09", "2026-11-09", [])).toHaveLength(1);
      expect(await repo.claimsFor([aliceAssistant])).toHaveLength(1);
      expect(await repo.evidenceFor(aliceAssistant)).toHaveLength(1);
    });
  });

  it("bob sees none of it through any read path", async () => {
    await db.asUser(BOB, async () => {
      expect(await repo.listConversations()).toEqual([]);
      expect(await repo.getConversation(aliceConv)).toBeUndefined();
      expect(await repo.getMessages(aliceConv)).toEqual([]);
      expect(await repo.getMessage(aliceAssistant)).toBeUndefined();
      expect(await repo.turnsInRange("2000-01-01", "2100-01-01", [])).toEqual([]);
      expect(await repo.turnsByIds([aliceAssistant])).toEqual([]);
      expect(await repo.nearestTurns("2026-11-09", 5, [])).toEqual([]);
      expect(await repo.historySpan()).toBeNull();
      expect((await repo.scoreTurns(["CRM", "pricing", "HubSpot"])).size).toBe(0);
      const vec = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
      expect((await repo.scoreTurns([], undefined, { embedding: vec, minSimilarity: 0 })).size).toBe(0);
      expect(await repo.claimsFor([aliceAssistant])).toEqual([]);
      expect(await repo.evidenceFor(aliceAssistant)).toEqual([]);
      expect(await repo.getDigest(aliceAssistant)).toBeUndefined();
      expect(await repo.searchCallsFor(aliceAssistant)).toEqual([]);
    });
  });

  it("bob's recall finds nothing of alice's", async () => {
    const { recall } = await import("../../src/agent/recall");
    const { resolveAll } = await import("../../src/time/resolve");
    const plan = { task: "recall_and_verify" as const, needs_memory: true, time_expressions: ["on Monday"], topic_keywords: ["CRM", "pricing"], entities: ["HubSpot"], needs_web: true, date_guesses: [], recency: "any" as const, source: "model" as const };
    const at = new Date("2026-11-11T08:35:00Z");
    const asAlice = await db.asUser(ALICE, () => recall(plan, resolveAll(plan.time_expressions, at, "Asia/Kolkata"), "c_none"));
    expect(asAlice.status).toBe("found");
    const asBob = await db.asUser(BOB, () => recall(plan, resolveAll(plan.time_expressions, at, "Asia/Kolkata"), "c_none"));
    expect(asBob.status).toBe("none");
    expect(asBob.turns).toEqual([]);
    expect(asBob.history_span).toBeUndefined();
  });

  it("bob cannot change, delete or write into alice's history", async () => {
    await db.asUser(BOB, async () => {
      expect(await repo.deleteConversation(aliceConv)).toBe(false);
      await repo.setConversationTitle(aliceConv, "pwned"); // updates zero rows
      // Writing into her conversation fails: (bob, her conversation id) does not exist.
      await expect(
        repo.insertMessage({ conversation_id: aliceConv, role: "user", text: "x", content_json: "[]", created_at: new Date().toISOString(), tz: "UTC", local_date: "2026-11-11", reply_to: null }),
      ).rejects.toThrow(/foreign key/i);
      // Naming her user id explicitly is rejected by the policy.
      await expect(db.q("INSERT INTO conversations (user_id, id, title, created_at, updated_at) VALUES ($1, 'c_x', 'x', now(), now())", [ALICE])).rejects.toThrow(/row-level security/i);
      await expect(db.q("UPDATE messages SET text = 'pwned' RETURNING id")).resolves.toEqual([]);
    });
    await db.asUser(ALICE, async () => {
      expect((await repo.getConversation(aliceConv))?.title).toBe("CRM shortlist");
      expect((await repo.getMessages(aliceConv)).map((m) => m.text)).not.toContain("pwned");
    });
  });

  it("raw SQL as the app role with no user set sees nothing", async () => {
    const c = new pg.Client({ connectionString: env.appUrl });
    await c.connect();
    try {
      for (const t of ["users", "conversations", "messages", "search_calls", "web_evidence", "turn_digests", "claims"]) {
        expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
      }
      const role = (await c.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")).rows[0];
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      await expect(c.query("ALTER TABLE messages DISABLE ROW LEVEL SECURITY")).rejects.toThrow(/owner/i);
      await expect(c.query("SELECT * FROM schema_migrations")).rejects.toThrow(/permission/i);
    } finally {
      await c.end();
    }
  });

  it("the outbox row was written with alice's id, and the worker runs it as alice", async () => {
    const jobs = await db.sys<{ user_id: string; payload: { assistantMessageId: string } }>("SELECT user_id, payload FROM jobs");
    expect(jobs).toEqual([{ user_id: ALICE, payload: { assistantMessageId: aliceAssistant } }]);
  });

  it("resumable turn streams are per user", async () => {
    const { TurnBuffer, turnExists } = await import("../../src/stream");
    const buf = new TurnBuffer(ALICE, new AbortController());
    buf.push({ type: "start", conversationId: aliceConv, userMessageId: "u_1", assistantMessageId: "a_turn_1" });
    buf.push({ type: "done", assistantMessageId: "a_turn_1", timings: {} });
    buf.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(await turnExists(ALICE, "a_turn_1")).toBe(true);
    expect(await turnExists(BOB, "a_turn_1")).toBe(false);
  });

  it("deleting alice's conversation removes everything derived from it", async () => {
    await db.asUser(ALICE, async () => {
      expect(await repo.deleteConversation(aliceConv)).toBe(true);
      expect(await repo.listConversations()).toEqual([]);
      expect(await repo.claimsFor([aliceAssistant])).toEqual([]);
      expect(await repo.evidenceFor(aliceAssistant)).toEqual([]);
      expect(await repo.getDigest(aliceAssistant)).toBeUndefined();
    });
  });
});
