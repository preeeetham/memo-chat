/** Google / GitHub (Firebase) users: created once, and linked to an email account with the same verified email. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, postgresAvailable } from "./setup";

const available = await postgresAvailable();

describe.skipIf(!available)("Firebase sign-in accounts", () => {
  let env: Awaited<ReturnType<typeof freshDatabase>>;
  let db: typeof import("../../src/db/index");
  let repo: typeof import("../../src/db/repo");
  let fb: typeof import("../../src/auth/firebase");
  let emailUser = "";

  beforeAll(async () => {
    env = await freshDatabase("firebase");
    process.env.DATABASE_URL = env.appUrl;
    db = await import("../../src/db/index");
    repo = await import("../../src/db/repo");
    fb = await import("../../src/auth/firebase");
    const pw = await import("../../src/auth/password");
    const up = await pw.signUp("rishi@example.com", "a strong password", "Rishi");
    if (!up.ok) throw new Error("sign-up failed");
    emailUser = up.user.id;
  });

  afterAll(async () => {
    await db?.closePool();
    await env?.drop();
  });

  it("a verified Google email that has an email account signs in to that same account", async () => {
    const u = await fb.userForFirebase({ uid: "g-1", email: "rishi@example.com", emailVerified: true, name: "Rishi D V", provider: "google.com" });
    expect(u.id).toBe(emailUser);
  });

  it("an unverified email is never linked; it gets its own account", async () => {
    const u = await fb.userForFirebase({ uid: "gh-1", email: "rishi@example.com", emailVerified: false, name: "Rishi", provider: "github.com" });
    expect(u.id).toBe("fb|gh-1");
  });

  it("a new provider user is created once, with their first name as the greeting name", async () => {
    const a = await fb.userForFirebase({ uid: "g-2", email: "asha@example.com", emailVerified: true, name: "Asha Rao", provider: "google.com" });
    const b = await fb.userForFirebase({ uid: "g-2", email: "asha@example.com", emailVerified: true, name: "Asha Rao", provider: "google.com" });
    expect(a.id).toBe("fb|g-2");
    expect(b.id).toBe(a.id);
    expect(await db.asUser(a.id, () => repo.getPreferredName())).toBe("Asha");
    expect(await db.asUser(a.id, () => repo.listConversations())).toEqual([]);
  });
});
