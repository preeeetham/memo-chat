/** Server-sent events between /api/chat and the UI. */
import type { Source } from "./search/tool";

export type RecalledRef = { ref: string; local_date: string; conversation_id: string; conversation_title: string | null; question: string };

export type ChatEvent =
  | { type: "start"; conversationId: string; userMessageId: string; assistantMessageId: string }
  | { type: "status"; text: string }
  | { type: "memory"; status: string; resolved: Array<{ expr: string; date: string }>; recalled: RecalledRef[] }
  | { type: "text"; delta: string }
  | { type: "sources"; sources: Source[] }
  | { type: "done"; assistantMessageId: string; timings: Record<string, number>; title?: string }
  | { type: "error"; message: string };

export function encodeEvent(e: ChatEvent, id?: number): string {
  return `${id !== undefined ? `id: ${id}\n` : ""}event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
}
