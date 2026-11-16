import { withUser } from "../../../../../src/auth";
import { requestStop } from "../../../../../src/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Stop a running turn, on whichever app instance runs it. Only the caller's own turns (keys are per user). */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  return withUser(req, async (user) => {
    const { id } = await ctx.params;
    await requestStop(user.id, id);
    return Response.json({ ok: true });
  });
}
