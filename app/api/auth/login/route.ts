import { beginLogin } from "../../../../src/auth/oidc";
import { config } from "../../../../src/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Start OIDC sign-in: remember state/nonce/PKCE verifier in a short-lived cookie, redirect to the provider. */
export async function GET(): Promise<Response> {
  if (config().auth.mode !== "oidc") return Response.redirect(`${config().auth.publicUrl}/login`, 302);
  const { url, state, verifier, nonce } = await beginLogin();
  const secure = config().auth.publicUrl.startsWith("https://") ? "; Secure" : "";
  const flow = Buffer.from(JSON.stringify({ state, verifier, nonce })).toString("base64url");
  return new Response(null, { status: 302, headers: { location: url, "set-cookie": `mc_oidc=${flow}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=600${secure}` } });
}
