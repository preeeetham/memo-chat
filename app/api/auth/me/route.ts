import { authenticate } from "../../../../src/auth";
import { config } from "../../../../src/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const user = await authenticate(req);
  const mode = config().auth.mode;
  return Response.json({ user, mode }, { status: user ? 200 : 401 });
}
