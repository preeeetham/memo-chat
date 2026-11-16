/**
 * Who is calling. Every API route goes through withUser(): it verifies the session cookie or bearer
 * token, makes sure the user row exists, and runs the handler as that user (row-level security).
 */
import { config } from "../config";
import { asUser } from "../db/index";
import { upsertUser } from "../db/repo";
import { oidcUserId, verifyProviderToken } from "./oidc";
import { COOKIE, readCookie, verifySession, type SessionUser } from "./session";

export type { SessionUser };

/** Resolve the caller, or null. */
export async function authenticate(req: Request): Promise<SessionUser | null> {
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = bearer ?? readCookie(req, COOKIE);
  if (!token) return null;
  const own = await verifySession(token);
  if (own) return own;
  if (bearer) {
    const p = await verifyProviderToken(bearer);
    if (p) {
      const user = { id: oidcUserId(p.subject), name: p.name };
      await ensureUser(user, p.issuer, p.subject, p.email);
      return user;
    }
  }
  return null;
}

const known = new Set<string>();

/** Create the user row on first sight (sessions are only issued after it exists, but a DB may be reset). */
export async function ensureUser(u: SessionUser, issuer: string, subject: string, email: string | null = null): Promise<void> {
  if (known.has(u.id)) return;
  await asUser(u.id, () => upsertUser({ issuer, subject, displayName: u.name, email }));
  known.add(u.id);
}

export function unauthorized(): Response {
  return Response.json({ error: "Sign in first.", login: config().auth.mode === "oidc" ? "/api/auth/login" : "/login" }, { status: 401 });
}

/** Wrap a route handler: 401 without a valid session, otherwise run as the user. */
export async function withUser(req: Request, fn: (user: SessionUser) => Promise<Response>): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return unauthorized();
  const [issuer, ...rest] = user.id.split("|");
  await ensureUser(user, issuer === "dev" ? "dev" : config().auth.oidcIssuer || issuer!, rest.join("|") || user.id);
  return asUser(user.id, () => fn(user));
}

/** Dev sign-in usernames: short, lowercase, safe. */
export function devUserId(username: string): string | null {
  const u = username.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,31}$/.test(u) ? `dev|${u}` : null;
}
