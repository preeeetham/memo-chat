import { ImportPayload, importConversations } from "../../../src/memory/import";
import { kickJobs } from "../../../src/memory/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Load backdated transcripts: {tz, conversations: [{title, messages: [{role, text, created_at}]}]}. For testing/eval. */
export async function POST(req: Request): Promise<Response> {
  const parsed = ImportPayload.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });
  const result = importConversations(parsed.data);
  kickJobs();
  return Response.json(result);
}
