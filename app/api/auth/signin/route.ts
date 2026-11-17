import { normaliseEmail, signIn } from "../../../../src/auth/password";
import { sessionCookie, signSession } from "../../../../src/auth/session";
import { clientIp, throttle } from "../../../../src/auth/throttle";
import { config } from "../../../../src/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Email + password sign-in. Returns the session token too, for API clients. */
export async function POST(req: Request): Promise<Response> {
  if (config().auth.mode !== "password") return Response.json({ error: "Email sign-in is not enabled here." }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
  const email = String(body.email ?? "");
  const limited = (await throttle("signinIp", clientIp(req))) ?? (await throttle("signinEmail", normaliseEmail(email) ?? "invalid"));
  if (limited) return limited;
  const r = await signIn(email, String(body.password ?? ""));
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  const token = await signSession(r.user);
  return Response.json({ user: r.user, token }, { headers: { "set-cookie": sessionCookie(token) } });
}
