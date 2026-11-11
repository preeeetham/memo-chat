import { listConversations } from "../../../src/db/repo";
import { kickJobs } from "../../../src/memory/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  kickJobs(); // resume any extraction jobs left from a previous run
  return Response.json({ conversations: listConversations() });
}
