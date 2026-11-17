/**
 * OpenID Connect sign-in (authorization code flow with PKCE) against any OIDC provider:
 * Auth0, Okta, Cognito, Keycloak, Google, Microsoft Entra, Clerk...
 * The ID token is verified against the provider's JWKS; then we issue our own session (session.ts).
 * API clients may instead send the provider's access/ID token as a bearer token (verifyProviderToken).
 */
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { config } from "../config";

type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };

const g = globalThis as unknown as { __memochatOidc?: { issuer: string; d: Discovery; jwks: ReturnType<typeof createRemoteJWKSet> } };

async function discover(): Promise<{ d: Discovery; jwks: ReturnType<typeof createRemoteJWKSet> }> {
  const issuer = config().auth.oidcIssuer;
  if (g.__memochatOidc?.issuer === issuer) return g.__memochatOidc;
  const res = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const d = (await res.json()) as Discovery;
  const entry = { issuer, d, jwks: createRemoteJWKSet(new URL(d.jwks_uri)) }; // jose caches keys and refetches on rotation
  g.__memochatOidc = entry;
  return entry;
}

const b64url = (b: Buffer) => b.toString("base64url");
export const redirectUri = () => `${config().auth.publicUrl}/api/auth/callback`;

/** Start sign-in: the URL to send the browser to, plus state/verifier to keep in a short-lived cookie. */
export async function beginLogin(): Promise<{ url: string; state: string; verifier: string; nonce: string }> {
  const { d } = await discover();
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const u = new URL(d.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: config().auth.oidcClientId,
    redirect_uri: redirectUri(),
    scope: "openid profile email",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return { url: u.toString(), state, verifier, nonce };
}

export type ProviderIdentity = { issuer: string; subject: string; name: string | null; email: string | null };

/** Finish sign-in: exchange the code, verify the ID token, return who signed in. */
export async function completeLogin(code: string, verifier: string, nonce: string): Promise<ProviderIdentity> {
  const { d, jwks } = await discover();
  const c = config().auth;
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri(), client_id: c.oidcClientId, code_verifier: verifier });
  if (c.oidcClientSecret) body.set("client_secret", c.oidcClientSecret);
  const res = await fetch(d.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error("token response had no id_token");
  const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: d.issuer, audience: c.oidcClientId });
  if (payload.nonce !== nonce) throw new Error("ID token nonce mismatch");
  return identity(d.issuer, payload);
}

/** Verify a provider-issued bearer token (for API clients). Returns null if it isn't valid. */
export async function verifyProviderToken(token: string): Promise<ProviderIdentity | null> {
  const c = config().auth;
  if (c.mode !== "oidc" || !c.oidcIssuer) return null;
  try {
    const { d, jwks } = await discover();
    const { payload } = await jwtVerify(token, jwks, { issuer: d.issuer, audience: c.oidcAudience });
    return identity(d.issuer, payload);
  } catch {
    return null;
  }
}

function identity(issuer: string, p: JWTPayload): ProviderIdentity {
  if (!p.sub) throw new Error("token has no sub");
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return { issuer, subject: p.sub, name: str(p.name) ?? str(p.preferred_username) ?? str(p.email), email: str(p.email) };
}

/** Our user id for a provider identity. One issuer per deployment, so the subject is unique. */
export const oidcUserId = (subject: string) => `oidc|${subject}`;
