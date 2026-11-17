import { signUp } from "../../../../src/auth/password";
import { sessionCookie, signSession } from "../../../../src/auth/session";
import { clientIp, throttle } from "../../../../src/auth/throttle";
import { config } from "../../../../src/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create an email + password account and sign it in. Returns the session token too, for API clients. */
export async function POST(req: Request): Promise<Response> {
  if (config().auth.mode !== "password") return Response.json({ error: "Email sign-up is not enabled here." }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
  const limited = await throttle("signup", clientIp(req));
  if (limited) return limited;
  const r = await signUp(String(body.email ?? ""), String(body.password ?? ""));
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  const token = await signSession(r.user);
  return Response.json({ user: r.user, token }, { headers: { "set-cookie": sessionCookie(token) } });
}
