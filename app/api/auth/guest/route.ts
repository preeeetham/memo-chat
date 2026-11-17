import { createGuest } from "../../../../src/auth/password";
import { sessionCookie, signSession } from "../../../../src/auth/session";
import { clientIp, throttle } from "../../../../src/auth/throttle";
import { config } from "../../../../src/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GUEST_TTL = 30 * 86_400;

/** Continue as a guest: a new, private, anonymous user whose history lasts as long as this browser's session. */
export async function POST(req: Request): Promise<Response> {
  if (config().auth.mode !== "password") return Response.json({ error: "Guest sign-in is not enabled here." }, { status: 404 });
  const limited = await throttle("guest", clientIp(req));
  if (limited) return limited;
  const user = await createGuest();
  const token = await signSession(user, GUEST_TTL);
  return Response.json({ user, token }, { headers: { "set-cookie": sessionCookie(token, GUEST_TTL) } });
}
