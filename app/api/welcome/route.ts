import { withUser } from "../../../src/auth";
import { markWelcomed } from "../../../src/db/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The home page showed the first-visit welcome: never show it to this user again. */
export async function POST(req: Request): Promise<Response> {
  return withUser(req, async () => {
    await markWelcomed();
    return Response.json({ ok: true });
  });
}
