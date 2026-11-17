/**
 * Email + password accounts and guests: sign-up, sign-in, duplicates, and that each new user only
 * sees their own history. Needs Postgres: `docker compose up -d postgres redis`.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, postgresAvailable } from "./setup";

const available = await postgresAvailable();

describe.skipIf(!available)("password accounts and guests", () => {
  let env: Awaited<ReturnType<typeof freshDatabase>>;
  let db: typeof import("../../src/db/index");
  let repo: typeof import("../../src/db/repo");
  let pw: typeof import("../../src/auth/password");
  let imp: typeof import("../../src/memory/import");

  beforeAll(async () => {
    env = await freshDatabase("password");
    process.env.DATABASE_URL = env.appUrl;
    db = await import("../../src/db/index");
    repo = await import("../../src/db/repo");
    pw = await import("../../src/auth/password");
    imp = await import("../../src/memory/import");
  });

  afterAll(async () => {
    await db?.closePool();
    await env?.drop();
  });

  it("signs up, then signs in with the same email in any case", async () => {
    const up = await pw.signUp("Asha@Example.com", "a strong password");
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    expect(up.user.id).toMatch(/^pw\|[0-9a-f]{24}$/);
    const back = await pw.signIn("asha@example.com", "a strong password");
    expect(back.ok && back.user.id).toBe(up.user.id);
  });

  it("refuses a duplicate email without creating a second user", async () => {
    const again = await pw.signUp("ASHA@example.com", "another password");
    expect(again).toMatchObject({ ok: false, status: 409 });
    const admin = new pg.Client({ connectionString: env.adminUrl });
    await admin.connect();
    const users = await admin.query("SELECT count(*)::int AS n FROM users WHERE id LIKE 'pw|%'");
    const hash = await admin.query("SELECT password_hash FROM password_accounts");
    await admin.end();
    expect(users.rows[0].n).toBe(1);
    expect(hash.rows[0].password_hash).not.toContain("a strong password");
  });

  it("gives the same error for a wrong password and an unknown email", async () => {
    const wrong = await pw.signIn("asha@example.com", "not the password");
    const unknown = await pw.signIn("nobody@example.com", "whatever123");
    expect(wrong).toEqual({ ok: false, status: 401, error: "Wrong email or password." });
    expect(unknown).toEqual(wrong);
  });

  it("rejects weak input at sign-up", async () => {
    expect(await pw.signUp("bad-email", "long enough pw")).toMatchObject({ ok: false, status: 400 });
    expect(await pw.signUp("ok@example.com", "short")).toMatchObject({ ok: false, status: 400 });
  });

  it("creates distinct guests that cannot see each other's or an account's history", async () => {
    const g1 = await pw.createGuest();
    const g2 = await pw.createGuest();
    expect(g1.id).toMatch(/^guest\|/);
    expect(g1.id).not.toBe(g2.id);
    const asha = await pw.signIn("asha@example.com", "a strong password");
    if (!asha.ok) throw new Error("sign-in failed");

    await db.asUser(asha.user.id, () =>
      imp.importConversations({ tz: "UTC", conversations: [{ title: "Private", messages: [{ role: "user", text: "secret plans", created_at: "2026-11-01T10:00:00Z" }] }] }),
    );
    const count = async (id: string) => (await db.asUser(id, () => repo.listConversations())).length;
    expect(await count(asha.user.id)).toBe(1);
    expect(await count(g1.id)).toBe(0);
    expect(await count(g2.id)).toBe(0);
  });

  it("stores the name given at sign-up and lets the user change it", async () => {
    const up = await pw.signUp("named@example.com", "a strong password", repo.cleanName("  Rishi   D V "));
    if (!up.ok) throw new Error("sign-up failed");
    expect(await db.asUser(up.user.id, () => repo.getPreferredName())).toBe("Rishi D V");
    await db.asUser(up.user.id, () => repo.setPreferredName(repo.cleanName("Rishi")));
    expect(await db.asUser(up.user.id, () => repo.getPreferredName())).toBe("Rishi");
    expect(repo.cleanName("   ")).toBeNull();
  });

  it("the app role cannot read another user's row through users", async () => {
    const g = await pw.createGuest();
    const rows = await db.asUser(g.id, () => db.q<{ id: string }>("SELECT id FROM users"));
    expect(rows.map((r) => r.id)).toEqual([g.id]);
  });
});
