import { deleteConversation, getConversation, getMessages } from "../../../../src/db/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  const conv = getConversation(id);
  if (!conv) return Response.json({ error: "not found" }, { status: 404 });
  const messages = getMessages(id).map((m) => {
    const meta = m.meta_json ? JSON.parse(m.meta_json) : {};
    return { id: m.id, role: m.role, text: m.text, created_at: m.created_at, local_date: m.local_date, sources: meta.sources ?? [], memory: meta.memory ?? null, timings: meta.timings ?? null };
  });
  return Response.json({ conversation: conv, messages });
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  deleteConversation(id);
  return Response.json({ ok: true });
}
