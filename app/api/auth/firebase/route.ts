import { firebaseWebConfig, userForFirebase, verifyFirebaseToken } from "../../../../src/auth/firebase";
import { sessionCookie, signSession } from "../../../../src/auth/session";
import { clientIp, throttle } from "../../../../src/auth/throttle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Google / GitHub sign-in: exchange a Firebase ID token for a Memo Chat session. */
export async function POST(req: Request): Promise<Response> {
  if (!firebaseWebConfig()) return Response.json({ error: "Google and GitHub sign-in are not set up here." }, { status: 404 });
  const limited = await throttle("signinIp", clientIp(req));
  if (limited) return limited;
  const body = (await req.json().catch(() => ({}))) as { idToken?: unknown };
  const identity = await verifyFirebaseToken(String(body.idToken ?? ""));
  if (!identity) return Response.json({ error: "Sign-in could not be verified. Please try again." }, { status: 401 });
  const user = await userForFirebase(identity);
  const token = await signSession(user);
  return Response.json({ user, token }, { headers: { "set-cookie": sessionCookie(token) } });
}
