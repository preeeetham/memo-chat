import { withUser } from "../../../src/auth";
import { ImportPayload, importConversations } from "../../../src/memory/import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Load backdated transcripts into the caller's history: {tz, conversations: [{title, messages: [{role, text, created_at}]}]}. */
export async function POST(req: Request): Promise<Response> {
  return withUser(req, async () => {
    const parsed = ImportPayload.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });
    return Response.json(await importConversations(parsed.data));
  });
}
