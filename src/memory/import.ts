/** Import backdated transcripts (testing/eval/demo). Writes raw messages, optional evidence, and queues extraction. */
import { z } from "zod";
import { createConversation, insertEvidence, insertMessage, insertSearchCall } from "../db/repo";
import { localDate, safeTz } from "../time/local";

export const ImportPayload = z.object({
  tz: z.string().optional(),
  conversations: z.array(
    z.object({
      title: z.string(),
      messages: z.array(
        z.object({
          role: z.enum(["user", "assistant"]),
          text: z.string().min(1),
          created_at: z.string(),
          sources: z
            .array(z.object({ url: z.string(), title: z.string(), published_at: z.string().nullable().optional(), excerpt: z.string() }))
            .optional(),
        }),
      ),
    }),
  ),
});
export type ImportPayload = z.infer<typeof ImportPayload>;

export function importConversations(payload: ImportPayload): { conversations: number; messages: number } {
  const tz = safeTz(payload.tz);
  let messages = 0;
  for (const c of payload.conversations) {
    const first = c.messages[0]?.created_at ?? new Date().toISOString();
    const conv = createConversation(c.title, new Date(first).toISOString());
    let lastUserId: string | null = null;
    for (const m of c.messages) {
      const at = new Date(m.created_at);
      if (Number.isNaN(at.getTime())) throw new Error(`bad created_at: ${m.created_at}`);
      const base = { conversation_id: conv.id, text: m.text, created_at: at.toISOString(), tz, local_date: localDate(at, tz) };
      if (m.role === "user") {
        lastUserId = insertMessage({ ...base, role: "user", reply_to: null, content_json: JSON.stringify([{ role: "user", content: m.text }]) }).id;
      } else {
        // Reserve the id so evidence rows can point at it before the message (and its job) is written.
        const id = `a_imp${Math.random().toString(36).slice(2, 14)}`;
        const srcMeta: Array<Record<string, unknown>> = [];
        (m.sources ?? []).forEach((s, i) => {
          const call = insertSearchCall({ assistantId: id, query: "(imported)", since: null, domains: null, provider: "import", at: at.toISOString() });
          const evidenceId = insertEvidence({
            search_call_id: call,
            assistant_message_id: id,
            ref: `S${i + 1}`,
            url: s.url,
            title: s.title,
            published_at: s.published_at ?? null,
            retrieved_at: at.toISOString().slice(0, 10),
            excerpt: s.excerpt,
          });
          srcMeta.push({ ref: `S${i + 1}`, url: s.url, title: s.title, publishedAt: s.published_at ?? null, retrievedAt: at.toISOString().slice(0, 10), evidenceId });
        });
        insertMessage(
          { ...base, id, role: "assistant", reply_to: lastUserId, content_json: JSON.stringify([{ role: "assistant", content: m.text }]), meta: { imported: true, sources: srcMeta } },
          { type: "extract_turn", payload: { assistantMessageId: id } },
        );
      }
      messages++;
    }
  }
  return { conversations: payload.conversations.length, messages };
}
