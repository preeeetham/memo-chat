import { withUser } from "../../../src/auth";
import { config } from "../../../src/config";
import { seedDemo } from "../../../src/demo/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Demo only: load backdated demo conversations into the caller's own history. */
export async function POST(req: Request): Promise<Response> {
  return withUser(req, async () => {
    if (!config().demoTools) return Response.json({ error: "demo tools are off (DEMO_TOOLS=false)" }, { status: 403 });
    const body = (await req.json().catch(() => ({}))) as { tz?: string };
    return Response.json(await seedDemo(body.tz ?? "UTC"));
  });
}
