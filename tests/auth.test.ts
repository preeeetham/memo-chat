/** Sessions, dev usernames, and OIDC token verification against a local fake identity provider. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devUserId } from "../src/auth";
import { oidcUserId, verifyProviderToken } from "../src/auth/oidc";
import { readCookie, sessionCookie, signSession, verifySession } from "../src/auth/session";

describe("sessions", () => {
  it("round-trips a signed session", async () => {
    const t = await signSession({ id: "dev|alice", name: "alice" });
    expect(await verifySession(t)).toEqual({ id: "dev|alice", name: "alice" });
  });

  it("rejects a tampered or foreign token", async () => {
    const t = await signSession({ id: "dev|alice", name: "alice" });
    const [h, p, s] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), sub: "dev|bob" })).toString("base64url");
    expect(await verifySession(`${h}.${forged}.${s}`)).toBeNull();
    const other = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("mini-chat").setSubject("dev|bob").sign(new TextEncoder().encode("another-secret"));
    expect(await verifySession(other)).toBeNull();
    expect(await verifySession("not-a-jwt")).toBeNull();
  });

  it("rejects an expired token", async () => {
    const t = await signSession({ id: "dev|alice", name: null }, -10);
    expect(await verifySession(t)).toBeNull();
  });

  it("sets an HttpOnly cookie and reads it back", () => {
    const c = sessionCookie("abc");
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(readCookie(new Request("http://x", { headers: { cookie: "a=1; mc_session=abc; b=2" } }), "mc_session")).toBe("abc");
  });
});

describe("dev usernames", () => {
  it("accepts simple names and rejects everything else", () => {
    expect(devUserId("Alice")).toBe("dev|alice");
    expect(devUserId("bob.smith-2")).toBe("dev|bob.smith-2");
    for (const bad of ["", " ", "a|b", "x".repeat(40), "../etc", "al ice", "-x"]) expect(devUserId(bad)).toBeNull();
  });
});

describe("OIDC bearer tokens", () => {
  let server: Server;
  let issuer = "";
  let sign: (claims: Record<string, unknown>, opts?: { aud?: string; iss?: string }) => Promise<string>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/.well-known/openid-configuration")
        return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }));
      if (req.url === "/jwks") return res.end(JSON.stringify({ keys: [jwk] }));
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.AUTH_MODE = "oidc";
    process.env.OIDC_ISSUER = issuer;
    process.env.OIDC_CLIENT_ID = "mini-chat";
    sign = (claims, opts = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(opts.iss ?? issuer)
        .setAudience(opts.aud ?? "mini-chat")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
  });

  afterAll(() => {
    server.close();
    delete process.env.AUTH_MODE;
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
  });

  it("accepts a token signed by the provider for this client", async () => {
    const who = await verifyProviderToken(await sign({ sub: "user-123", email: "a@example.com", name: "A" }));
    expect(who).toMatchObject({ subject: "user-123", email: "a@example.com", name: "A" });
    expect(oidcUserId(who!.subject)).toBe("oidc|user-123");
  });

  it("rejects the wrong audience or issuer", async () => {
    expect(await verifyProviderToken(await sign({ sub: "u" }, { aud: "another-app" }))).toBeNull();
    expect(await verifyProviderToken(await sign({ sub: "u" }, { iss: "https://evil.example" }))).toBeNull();
  });

  it("rejects a token signed by another key", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const t = await new SignJWT({ sub: "u" }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(issuer).setAudience("mini-chat").setExpirationTime("5m").sign(privateKey);
    expect(await verifyProviderToken(t)).toBeNull();
  });
});
