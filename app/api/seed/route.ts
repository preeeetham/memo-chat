import { seedDemo } from "../../../src/demo/seed";
import { kickJobs } from "../../../src/memory/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Dev/demo only: load backdated demo conversations. */
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { tz?: string };
  const result = seedDemo(body.tz ?? "UTC");
  kickJobs();
  return Response.json(result);
}
