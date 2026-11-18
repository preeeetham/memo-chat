import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { firebaseWebConfig, verifyFirebaseToken } from "../src/auth/firebase";

const PROJECT = "memo-chat-test";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const other = await generateKeyPair("RS256");

const token = (claims: Record<string, unknown> = {}, opts: { iss?: string; aud?: string; exp?: string; key?: CryptoKey } = {}) =>
  new SignJWT({ email: "Rishi@Example.com", email_verified: true, name: "Rishi D V", firebase: { sign_in_provider: "google.com" }, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? `https://securetoken.google.com/${PROJECT}`)
    .setAudience(opts.aud ?? PROJECT)
    .setSubject("firebase-uid-123")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h")
    .sign(opts.key ?? privateKey);

describe("Firebase ID token verification", () => {
  it("accepts a valid token and reads the identity", async () => {
    expect(await verifyFirebaseToken(await token(), PROJECT, publicKey)).toEqual({
      uid: "firebase-uid-123",
      email: "rishi@example.com",
      emailVerified: true,
      name: "Rishi D V",
      provider: "google.com",
    });
  });

  it("rejects a token signed by another key", async () => {
    expect(await verifyFirebaseToken(await token({}, { key: other.privateKey }), PROJECT, publicKey)).toBeNull();
  });

  it("rejects a token for another Firebase project", async () => {
    expect(await verifyFirebaseToken(await token({}, { aud: "someone-else" }), PROJECT, publicKey)).toBeNull();
    expect(await verifyFirebaseToken(await token({}, { iss: "https://securetoken.google.com/someone-else" }), PROJECT, publicKey)).toBeNull();
  });

  it("rejects an expired token and garbage", async () => {
    expect(await verifyFirebaseToken(await token({}, { exp: "-1m" }), PROJECT, publicKey)).toBeNull();
    expect(await verifyFirebaseToken("not-a-token", PROJECT, publicKey)).toBeNull();
    expect(await verifyFirebaseToken("", PROJECT, publicKey)).toBeNull();
  });

  it("treats an unverified email as unverified", async () => {
    expect((await verifyFirebaseToken(await token({ email_verified: false }), PROJECT, publicKey))?.emailVerified).toBe(false);
  });
});

describe("Firebase web config", () => {
  it("is off until the API key and project are set", () => {
    delete process.env.FIREBASE_API_KEY;
    delete process.env.FIREBASE_PROJECT_ID;
    expect(firebaseWebConfig()).toBeNull();
    process.env.FIREBASE_API_KEY = "public-key";
    process.env.FIREBASE_PROJECT_ID = PROJECT;
    expect(firebaseWebConfig()).toMatchObject({ projectId: PROJECT, authDomain: `${PROJECT}.firebaseapp.com` });
    delete process.env.FIREBASE_API_KEY;
    delete process.env.FIREBASE_PROJECT_ID;
  });
});
