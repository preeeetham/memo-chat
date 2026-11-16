import { devUserId, ensureUser } from "../../../../src/auth";
import { sessionCookie, signSession } from "../../../../src/auth/session";
import { config } from "../../../../src/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Development sign-in: pick a username, no password. Only when AUTH_MODE=dev (the default for local
 * runs). Use AUTH_MODE=oidc with a real identity provider for anything shared.
 * Returns the session token too, for API clients and tests (curl -H "authorization: Bearer ...").
 */
export async function POST(req: Request): Promise<Response> {
  if (config().auth.mode !== "dev") return Response.json({ error: "dev sign-in is disabled (AUTH_MODE=oidc)" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { username?: string };
  const id = devUserId(body.username ?? "");
  if (!id) return Response.json({ error: "Username: 1-32 characters, letters, digits, . _ -" }, { status: 400 });
  const user = { id, name: id.slice(4) };
  await ensureUser(user, "dev", user.name);
  const token = await signSession(user);
  return Response.json({ user, token }, { headers: { "set-cookie": sessionCookie(token) } });
}
