/** Brute-force and abuse limits for the sign-in endpoints, counted in Redis (shared by every instance). */
import { incr } from "../budget";
import { key } from "../redis";

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
}

const LIMITS = {
  signup: { max: 10, windowSec: 3600 }, // new accounts per IP per hour
  guest: { max: 10, windowSec: 3600 }, // new guests per IP per hour (each guest gets its own token budget)
  signinIp: { max: 30, windowSec: 900 }, // sign-in attempts per IP per 15 minutes
  signinEmail: { max: 10, windowSec: 900 }, // sign-in attempts per email per 15 minutes
} as const;

/** Count one attempt; returns a 429 response once over the limit, else null. */
export async function throttle(kind: keyof typeof LIMITS, id: string): Promise<Response | null> {
  const { max, windowSec } = LIMITS[kind];
  const n = await incr(key("auth", kind, id), 1, windowSec);
  if (n <= max) return null;
  return Response.json(
    { error: "Too many attempts. Try again in a few minutes." },
    { status: 429, headers: { "retry-after": String(windowSec) } },
  );
}
