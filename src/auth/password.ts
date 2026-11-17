/**
 * Email + password accounts and guest users. Passwords are hashed with scrypt (Node's crypto, no
 * native dependency): scrypt$N$r$p$salt$hash, salt and hash base64. Verification is constant time,
 * and an unknown email still costs one hash so response time does not reveal which emails exist.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { asUser, sys, tx } from "../db/index";
import type { SessionUser } from "./session";

const N = 16384, R = 8, P = 1, KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, hashB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const key = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

let dummy: Promise<string> | null = null;
const dummyHash = () => (dummy ??= hashPassword(randomBytes(16).toString("hex")));

export function normaliseEmail(email: string): string | null {
  const e = email.trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/** What is wrong with a new password, or null. */
export function passwordProblem(password: string): string | null {
  if (password.length < 8) return "Password: at least 8 characters.";
  if (password.length > 128) return "Password: at most 128 characters.";
  return null;
}

const randomUserPart = () => randomBytes(12).toString("hex");

export type AuthResult = { ok: true; user: SessionUser } | { ok: false; status: number; error: string };

export async function signUp(emailRaw: string, password: string, preferredName: string | null = null): Promise<AuthResult> {
  const email = normaliseEmail(emailRaw);
  if (!email) return { ok: false, status: 400, error: "Enter a valid email address." };
  const problem = passwordProblem(password);
  if (problem) return { ok: false, status: 400, error: problem };
  const hash = await hashPassword(password);
  const id = `pw|${randomUserPart()}`;
  const name = email.split("@")[0]!;
  try {
    // One transaction: the user row (inserted as that user, for row-level security) and the account row.
    await asUser(id, () =>
      tx(async (q) => {
        await q("INSERT INTO users (id, issuer, subject, display_name, email, preferred_name) VALUES ($1, 'pw', $2, $3, $4, $5)", [
          id, id.slice(3), preferredName ?? name, email, preferredName,
        ]);
        await q("INSERT INTO password_accounts (email, user_id, password_hash) VALUES ($1, $2, $3)", [email, id, hash]);
      }),
    );
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { ok: false, status: 409, error: "An account with this email already exists. Sign in instead." };
    throw err;
  }
  return { ok: true, user: { id, name: preferredName ?? name } };
}

export async function signIn(emailRaw: string, password: string): Promise<AuthResult> {
  const email = normaliseEmail(emailRaw);
  const row = email
    ? (await sys<{ user_id: string; password_hash: string }>("SELECT user_id, password_hash FROM password_accounts WHERE email = $1", [email]))[0]
    : undefined;
  const ok = await verifyPassword(password, row?.password_hash ?? (await dummyHash()));
  if (!row || !ok) return { ok: false, status: 401, error: "Wrong email or password." };
  return { ok: true, user: { id: row.user_id, name: email!.split("@")[0]! } };
}

/** A new anonymous user. Its history lives as long as the session cookie on that browser. */
export async function createGuest(): Promise<SessionUser> {
  const id = `guest|${randomUserPart()}`;
  await asUser(id, () => tx((q) => q("INSERT INTO users (id, issuer, subject, display_name) VALUES ($1, 'guest', $2, 'Guest')", [id, id.slice(6)])));
  return { id, name: "Guest" };
}
