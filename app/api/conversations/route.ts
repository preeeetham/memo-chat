import { withUser } from "../../../src/auth";
import { listConversations } from "../../../src/db/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return withUser(req, async () => Response.json({ conversations: await listConversations() }));
}
