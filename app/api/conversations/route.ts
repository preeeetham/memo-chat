import { withUser } from "../../../src/auth";
import { listConversations, searchConversations } from "../../../src/db/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  // ?q=text searches titles and message text (sidebar search); otherwise the full list.
  const query = new URL(req.url).searchParams.get("q")?.trim().slice(0, 200) ?? "";
  return withUser(req, async () => Response.json({ conversations: query ? await searchConversations(query) : await listConversations() }));
}
