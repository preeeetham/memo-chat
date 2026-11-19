/**
 * Changed decisions: "we picked Neon" then later "we went with Supabase instead". The old claim is
 * retired (shown as superseded, with the new value), and deleting the newer chat restores it. Needs Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, postgresAvailable } from "./setup";

const available = await postgresAvailable();
const USER = "pw|superseded";
const TZ = "Asia/Kolkata";

describe.skipIf(!available)("superseded claims", () => {
  let env: Awaited<ReturnType<typeof freshDatabase>>;
  let db: typeof import("../../src/db/index");
  let repo: typeof import("../../src/db/repo");
  let first = "", second = "", secondConv = "";

  const turn = async (date: string, q: string, a: string, value: string) => {
    const conv = await repo.createConversation(q, `${date}T06:00:00Z`);
    const u = await repo.insertMessage({ conversation_id: conv.id, role: "user", text: q, content_json: "[]", created_at: `${date}T06:00:00Z`, tz: TZ, local_date: date, reply_to: null });
    const m = await repo.insertMessage({ conversation_id: conv.id, role: "assistant", text: a, content_json: "[]", created_at: `${date}T06:00:05Z`, tz: TZ, local_date: date, reply_to: u.id });
    await repo.saveExtraction(
      { assistantId: m.id, conversationId: conv.id, localDate: date, createdAt: `${date}T06:00:05Z` },
      { question: q, answer_summary: a, entities: [value], keywords: ["postgres", "hosting"] },
      [
        { assistant_message_id: m.id, speaker: "user", subject: "Postgres hosting provider", attribute: "decision", value, observed_at: `${date}T06:00:05Z`, published_at: null, source_url: null, evidence_id: null },
        { assistant_message_id: m.id, speaker: "assistant", subject: "Neon Launch", attribute: "price_per_month", value: "$5/month", observed_at: `${date}T06:00:05Z`, published_at: null, source_url: null, evidence_id: null },
      ],
    );
    return { id: m.id, conv: conv.id };
  };

  beforeAll(async () => {
    env = await freshDatabase("superseded");
    process.env.DATABASE_URL = env.appUrl;
    db = await import("../../src/db/index");
    await db.closePool();
    repo = await import("../../src/db/repo");
    const auth = await import("../../src/auth");
    await auth.ensureUser({ id: USER, name: "rishi" }, "pw", "superseded");
    await db.asUser(USER, async () => {
      first = (await turn("2026-11-03", "We picked Neon for Postgres hosting", "Noted: Neon.", "Neon")).id;
      const t = await turn("2026-11-10", "We went with Supabase instead", "Noted: Supabase.", "Supabase");
      second = t.id;
      secondConv = t.conv;
    });
  });

  afterAll(async () => {
    await db?.closePool();
    await env?.drop();
  });

  it("the older decision is retired, with the new value", async () => {
    const claims = await db.asUser(USER, () => repo.claimsFor([first]));
    const decision = claims.find((c) => c.attribute === "decision")!;
    expect(decision.superseded_by).toBeTruthy();
    expect(decision.superseded_value).toBe("Supabase");
  });

  it("an unchanged fact (same price) is not retired", async () => {
    const claims = await db.asUser(USER, () => repo.claimsFor([first]));
    expect(claims.find((c) => c.attribute === "price_per_month")!.superseded_by).toBeNull();
  });

  it("only open decisions are offered to extraction", async () => {
    const subjects = await db.asUser(USER, () => repo.openDecisionSubjects());
    expect(subjects).toEqual(["Postgres hosting provider"]);
  });

  it("deleting the newer chat makes the old decision current again", async () => {
    await db.asUser(USER, () => repo.deleteConversation(secondConv));
    const claims = await db.asUser(USER, () => repo.claimsFor([first]));
    expect(claims.find((c) => c.attribute === "decision")!.superseded_by).toBeNull();
    expect(second).toBeTruthy();
  });
});
