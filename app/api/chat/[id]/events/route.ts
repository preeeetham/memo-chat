import { withUser } from "../../../../../src/auth";
import { encodeEvent } from "../../../../../src/sse";
import { replayTurn, turnExists } from "../../../../../src/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Resume a turn's event stream after a dropped connection: Last-Event-ID header or ?after=<seq>. */
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  return withUser(req, async (user) => {
    const { id } = await ctx.params;
    if (!(await turnExists(user.id, id))) return Response.json({ error: "not found" }, { status: 404 });
    const after = Number(req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("after") ?? 0) || 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          await replayTurn(user.id, id, after, (seq, e) => controller.enqueue(encoder.encode(encodeEvent(e, seq))), req.signal);
        } catch (err) {
          console.warn("[chat] resume failed", (err as Error).message);
        } finally {
          try {
            controller.close();
          } catch {}
        }
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" } });
  });
}
