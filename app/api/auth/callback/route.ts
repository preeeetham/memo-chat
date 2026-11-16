import { ensureUser } from "../../../../src/auth";
import { completeLogin, oidcUserId } from "../../../../src/auth/oidc";
import { readCookie, sessionCookie, signSession } from "../../../../src/auth/session";
import { config } from "../../../../src/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** OIDC redirect target: check state, exchange the code, verify the ID token, start our session. */
export async function GET(req: Request): Promise<Response> {
  const base = config().auth.publicUrl;
  const url = new URL(req.url);
  const raw = readCookie(req, "mc_oidc");
  const fail = (why: string) => {
    console.warn(`[auth] sign-in failed: ${why}`);
    return Response.redirect(`${base}/login?error=${encodeURIComponent("Sign-in failed. Try again.")}`, 302);
  };
  if (!raw) return fail("no flow cookie");
  let flow: { state: string; verifier: string; nonce: string };
  try {
    flow = JSON.parse(Buffer.from(raw, "base64url").toString());
  } catch {
    return fail("bad flow cookie");
  }
  if (url.searchParams.get("state") !== flow.state) return fail("state mismatch");
  const code = url.searchParams.get("code");
  if (!code) return fail(url.searchParams.get("error") ?? "no code");
  try {
    const who = await completeLogin(code, flow.verifier, flow.nonce);
    const user = { id: oidcUserId(who.subject), name: who.name };
    await ensureUser(user, who.issuer, who.subject, who.email);
    const token = await signSession(user);
    const headers = new Headers({ location: `${base}/` });
    headers.append("set-cookie", sessionCookie(token));
    headers.append("set-cookie", "mc_oidc=; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=0");
    return new Response(null, { status: 302, headers });
  } catch (err) {
    return fail((err as Error).message);
  }
}
