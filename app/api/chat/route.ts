import { z } from "zod";
import { runTurn } from "../../../src/agent/turn";
import { missingConfig } from "../../../src/config";
import { encodeEvent, type ChatEvent } from "../../../src/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  conversationId: z.string().nullable().optional(),
  text: z.string().min(1).max(8000),
  tz: z.string().optional(),
});

/** POST a user message; the reply streams back as server-sent events. */
export async function POST(req: Request): Promise<Response> {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Expected {conversationId?, text, tz?}" }, { status: 400 });
  const problems = missingConfig();
  if (problems.length) return Response.json({ error: problems.join(" ") }, { status: 503 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (e: ChatEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(encodeEvent(e)));
        } catch {
          open = false;
        }
      };
      try {
        await runTurn(parsed.data, emit, req.signal);
      } catch (err) {
        console.error("[chat] turn failed", err);
        emit({ type: "error", message: friendlyError(err) });
      } finally {
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
}

function friendlyError(err: unknown): string {
  const e = err as { status?: number; message?: string; name?: string };
  if (e?.name === "AbortError") return "Stopped.";
  if (e?.status === 401 || e?.status === 403) return "The LLM provider rejected the API key. Check LLM_API_KEY in .env.";
  if (e?.status === 429) return "The LLM provider is rate-limiting requests. Wait a moment and try again.";
  if (e?.status === 404) return "The model was not found. Check LLM_MODEL and LLM_BASE_URL in .env.";
  return `Something went wrong: ${e?.message?.slice(0, 200) ?? "unknown error"}`;
}
