import { authenticate } from "../../../../src/auth";
import { firebaseWebConfig } from "../../../../src/auth/firebase";
import { config } from "../../../../src/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const user = await authenticate(req);
  const mode = config().auth.mode;
  // Public Firebase web config, so the login page can offer Google / GitHub (null when not set up).
  const firebase = mode === "password" ? firebaseWebConfig() : null;
  return Response.json({ user, mode, firebase }, { status: user ? 200 : 401 });
}
