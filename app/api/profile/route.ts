import { withUser } from "../../../src/auth";
import { cleanName, setPreferredName } from "../../../src/db/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Set (or clear) the name used in the home greeting: {"name": "Rishi"}. */
export async function POST(req: Request): Promise<Response> {
  return withUser(req, async () => {
    const body = (await req.json().catch(() => ({}))) as { name?: unknown };
    const name = cleanName(body.name);
    await setPreferredName(name);
    return Response.json({ preferredName: name });
  });
}
