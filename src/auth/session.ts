/**
 * Sessions: a short JWT signed with AUTH_SECRET (HS256) in an HttpOnly cookie, or sent as a
 * bearer token by API clients. sub is the user id, which becomes app.user_id for row-level security.
 */
import { jwtVerify, SignJWT } from "jose";
import { config } from "../config";

export const COOKIE = "mc_session";
const ISSUER = "mini-chat";
const TTL_SECONDS = 7 * 86_400;

export type SessionUser = { id: string; name: string | null };

const secret = () => new TextEncoder().encode(config().auth.secret);

export async function signSession(u: SessionUser, ttlSeconds = TTL_SECONDS): Promise<string> {
  return new SignJWT({ name: u.name })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setSubject(u.id)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret());
}

export async function verifySession(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER, algorithms: ["HS256"] });
    if (!payload.sub) return null;
    return { id: payload.sub, name: typeof payload.name === "string" ? payload.name : null };
  } catch {
    return null;
  }
}

export function sessionCookie(token: string, maxAge = TTL_SECONDS): string {
  const secure = config().auth.publicUrl.startsWith("https://") ? "; Secure" : "";
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function clearCookie(name = COOKIE): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}
