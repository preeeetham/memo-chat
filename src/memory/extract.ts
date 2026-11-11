/**
 * Post-turn extraction: a digest (for finding the turn later) and a claims ledger (for checking
 * "has it changed since?"). Claims link back to the exact web evidence the answer cited.
 */
import { z } from "zod";
import { evidenceFor, getMessage, saveExtraction, type NewClaim } from "../db/repo";
import { structured } from "../llm/client";

export const Extraction = z.object({
  question: z.string().describe("the user's request in one sentence"),
  answer_summary: z.string().describe("the answer in at most two sentences"),
  entities: z.array(z.string()).describe("named products, companies, people"),
  keywords: z.array(z.string()).describe("topic words someone might use to refer back to this exchange"),
  claims: z.array(
    z.object({
      speaker: z.enum(["assistant", "user"]),
      subject: z.string().describe('the thing the claim is about, specific: "HubSpot Sales Hub Professional"'),
      attribute: z.string().describe('snake_case: price_per_seat_month, free_tier, plan_name, feature, limit, release_date, decision, shortlist, ...'),
      value: z.string().describe('exact value as stated, with units and billing terms: "$100/seat/mo billed annually"'),
      source_ref: z.string().nullable().describe('the [S#] id cited for this claim, e.g. "S3", or null'),
    }),
  ),
});

const SYSTEM = `You index one exchange between a user and a research assistant so it can be found and re-checked later.
Extract only what is actually stated. Claims are concrete, checkable facts or decisions: prices, plan names, limits, features, dates, shortlists, recommendations, choices.
- One claim per item per attribute (a 5-vendor comparison gives at least 5 claims).
- Copy values exactly, with currency, unit and billing period.
- source_ref is the [S#] citation next to that fact in the answer, else null.
- Also extract decisions or lists the user states ("we shortlisted X, Y, Z", "we picked Neon") with speaker "user" and attribute "decision" or "shortlist".`;

export async function extractTurn(assistantMessageId: string): Promise<"done" | "skipped"> {
  const a = getMessage(assistantMessageId);
  if (!a || a.role !== "assistant" || !a.reply_to) return "skipped";
  const u = getMessage(a.reply_to);
  if (!u) return "skipped";
  const evidence = evidenceFor(a.id);
  const sources = evidence.map((e) => `[${e.ref}] ${e.title ?? ""} ${e.url} (published ${e.published_at ?? "n/a"})`).join("\n");

  const out = await structured(Extraction, "extraction", [
    { role: "system", content: SYSTEM },
    { role: "user", content: `User (${u.local_date}):\n${u.text}\n\nAssistant answer:\n${a.text}\n\nSources the answer could cite:\n${sources || "(none)"}` },
  ], { maxTokens: 4000, timeoutMs: 45_000 });

  const byRef = new Map(evidence.map((e) => [e.ref, e]));
  const claims: NewClaim[] = out.claims.map((c) => {
    const ev = c.source_ref ? byRef.get(c.source_ref.replace(/[\[\]\s]/g, "")) : undefined;
    return {
      assistant_message_id: a.id,
      speaker: c.speaker,
      subject: c.subject,
      attribute: c.attribute,
      value: c.value,
      observed_at: ev?.retrieved_at ?? a.created_at,
      published_at: ev?.published_at ?? null,
      source_url: ev?.url ?? null,
      evidence_id: ev?.id ?? null,
    } as NewClaim;
  });
  saveExtraction(
    { assistantId: a.id, conversationId: a.conversation_id, localDate: u.local_date, createdAt: a.created_at },
    { question: out.question, answer_summary: out.answer_summary, entities: out.entities, keywords: out.keywords },
    claims,
  );
  return "done";
}
