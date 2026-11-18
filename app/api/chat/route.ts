import { z } from "zod";
import { runTurn } from "../../../src/agent/turn";
import { withUser } from "../../../src/auth";
import { admitTurn } from "../../../src/budget";
import { truncateFrom } from "../../../src/db/repo";
import { missingConfig } from "../../../src/config";
import { encodeEvent, type ChatEvent } from "../../../src/sse";
import { TurnBuffer } from "../../../src/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  conversationId: z.string().nullable().optional(),
  text: z.string().min(1).max(8000),
  tz: z.string().optional(),
  // Edit: replace this earlier user message (and everything after it) with `text`.
  editOf: z.string().optional(),
});

/**
 * POST a user message; the reply streams back as server-sent events with ids. Every event is also
 * buffered in Redis, so a dropped connection resumes via GET /api/chat/<turn id>/events.
 * The turn runs to completion even if the client disconnects; POST /api/chat/<turn id>/stop stops it.
 */
export async function POST(req: Request): Promise<Response> {
  return withUser(req, async (user) => {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Expected {conversationId?, text, tz?}" }, { status: 400 });
    const problems = missingConfig();
    if (problems.length) return Response.json({ error: problems.join(" ") }, { status: 503 });
    const admission = await admitTurn(user.id);
    if (!admission.ok) return Response.json({ error: admission.message }, { status: admission.status, headers: { "retry-after": String(admission.retryAfterSec) } });

    if (parsed.data.editOf) {
      if (!parsed.data.conversationId) return Response.json({ error: "Editing needs the conversation id." }, { status: 400 });
      const removed = await truncateFrom(parsed.data.conversationId, parsed.data.editOf);
      if (removed === null) return Response.json({ error: "That message can't be edited (not found in this chat)." }, { status: 404 });
    }

    const encoder = new TextEncoder();
    const abort = new AbortController();
    const buffer = new TurnBuffer(user.id, abort);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let open = true;
        req.signal.addEventListener("abort", () => (open = false));
        const emit = (e: ChatEvent) => {
          const seq = buffer.push(e);
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(encodeEvent(e, seq)));
          } catch {
            open = false;
          }
        };
        try {
          await runTurn(parsed.data, emit, abort.signal);
        } catch (err) {
          console.error("[chat] turn failed", err);
          emit({ type: "error", message: friendlyError(err) });
        } finally {
          buffer.close();
          open = false;
          try {
            controller.close();
          } catch {}
        }
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
    });
  });
}

function friendlyError(err: unknown): string {
  const e = err as { status?: number; message?: string; name?: string };
  if (e?.name === "AbortError") return "Stopped.";
  if (e?.status === 401 || e?.status === 403) return "The LLM provider rejected the API key. Check LLM_API_KEY in .env.";
  if (e?.status === 429) return "The AI model is getting too many requests right now. Wait a few seconds and try again.";
  if (typeof e?.status === "number" && e.status >= 500) return "The AI model is busy right now (high demand). Wait a few seconds and try again.";
  if (e?.status === 404) return "The model was not found. Check LLM_MODEL and LLM_BASE_URL in .env.";
  return `Something went wrong: ${e?.message?.slice(0, 200) ?? "unknown error"}`;
}
