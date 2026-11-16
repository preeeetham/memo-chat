import { withUser } from "../../../../src/auth";
import { deleteConversation, getConversation, getMessages } from "../../../../src/db/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Another user's conversation id is invisible under row-level security, so it is a plain 404. */
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  return withUser(req, async () => {
    const { id } = await ctx.params;
    const conv = await getConversation(id);
    if (!conv) return Response.json({ error: "not found" }, { status: 404 });
    const messages = (await getMessages(id)).map((m) => {
      const meta = m.meta_json ? JSON.parse(m.meta_json) : {};
      return {
        id: m.id,
        role: m.role,
        text: m.text,
        created_at: m.created_at,
        local_date: m.local_date,
        sources: meta.sources ?? [],
        memory: meta.memory ?? null,
        timings: meta.timings ?? null,
        degraded: meta.fallbackModel ?? null,
      };
    });
    return Response.json({ conversation: conv, messages });
  });
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  return withUser(req, async () => {
    const { id } = await ctx.params;
    const ok = await deleteConversation(id);
    return ok ? Response.json({ ok: true }) : Response.json({ error: "not found" }, { status: 404 });
  });
}
