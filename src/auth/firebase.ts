/**
 * Google and GitHub sign-in through Firebase Authentication. The browser signs in with Firebase and
 * sends us the Firebase ID token once; we verify it here against Google's public keys (no service
 * account or admin SDK needed) and then issue our own session, so everything after sign-in works
 * exactly like the other sign-in methods (row-level security, memory, name).
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import { asUser, sys, tx } from "../db/index";
import type { SessionUser } from "./session";

const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Public web config (safe to send to browsers). Null when Firebase is not configured. */
export function firebaseWebConfig(): { apiKey: string; authDomain: string; projectId: string; appId: string } | null {
  const apiKey = process.env.FIREBASE_API_KEY?.trim() ?? "";
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim() ?? "";
  if (!apiKey || !projectId) return null;
  return {
    apiKey,
    projectId,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN?.trim() || `${projectId}.firebaseapp.com`,
    appId: process.env.FIREBASE_APP_ID?.trim() ?? "",
  };
}

export type FirebaseIdentity = { uid: string; email: string | null; emailVerified: boolean; name: string | null; provider: string };

/** Verify a Firebase ID token: signature, issuer, audience, expiry. Null if invalid. */
export async function verifyFirebaseToken(
  idToken: string,
  projectId = firebaseWebConfig()?.projectId,
  keys?: Parameters<typeof jwtVerify>[1], // tests pass their own key; production uses Google's
): Promise<FirebaseIdentity | null> {
  if (!projectId || !idToken) return null;
  try {
    const key = keys ?? (jwks ??= createRemoteJWKSet(new URL(JWKS_URL)));
    const { payload } = await jwtVerify(idToken, key as Parameters<typeof jwtVerify>[1] & CryptoKey, { issuer: `https://securetoken.google.com/${projectId}`, audience: projectId, algorithms: ["RS256"] });
    if (!payload.sub || typeof payload.sub !== "string") return null;
    const fb = (payload.firebase ?? {}) as { sign_in_provider?: string };
    return {
      uid: payload.sub,
      email: typeof payload.email === "string" ? payload.email.toLowerCase() : null,
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === "string" ? payload.name : null,
      provider: fb.sign_in_provider ?? "firebase",
    };
  } catch {
    return null;
  }
}

/**
 * Map a verified Firebase identity to our user. A verified email that already has an email + password
 * account signs in to that same account (same history and name). Otherwise the user is fb|<uid>,
 * created on first sign-in with their provider name as the greeting name.
 */
export async function userForFirebase(id: FirebaseIdentity, username: string | null = null): Promise<SessionUser> {
  // Greeting name: the provider's display name (first word), else the GitHub username.
  const first = id.name?.trim().split(/\s+/)[0]?.slice(0, 40) || username?.trim().slice(0, 40) || null;
  if (id.email && id.emailVerified) {
    const linked = (await sys<{ user_id: string }>("SELECT user_id FROM password_accounts WHERE email = $1", [id.email]))[0];
    if (linked) {
      // Fill in a greeting name only if the account doesn't have one yet.
      if (first) await asUser(linked.user_id, () => tx((q) => q("UPDATE users SET preferred_name = COALESCE(preferred_name, $1)", [first])));
      return { id: linked.user_id, name: id.name ?? first ?? id.email.split("@")[0]! };
    }
  }
  const userId = `fb|${id.uid}`;
  await asUser(userId, () =>
    tx((q) =>
      q(
        `INSERT INTO users (id, issuer, subject, display_name, email, preferred_name) VALUES ($1, 'firebase', $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET email = COALESCE(EXCLUDED.email, users.email),
           preferred_name = COALESCE(users.preferred_name, EXCLUDED.preferred_name), last_seen_at = now()`,
        [userId, id.uid, id.name, id.email, first],
      ),
    ),
  );
  return { id: userId, name: id.name ?? first };
}

/** Clean a provider username sent by the browser (display only, never used for identity). */
export function cleanUsername(u: unknown): string | null {
  const s = typeof u === "string" ? u.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(s) ? s : null;
}
