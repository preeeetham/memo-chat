/**
 * Migrations: plain SQL files in db/migrations, applied in name order, each once, each in a transaction.
 * Runs as the database owner (MIGRATE_DATABASE_URL). Also creates the app's login role from the
 * credentials in DATABASE_URL: no superuser, no BYPASSRLS, data privileges only. That role is what the
 * app and worker connect as, so row-level security always applies to them.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";

export async function migrate(opts: { adminUrl: string; appUrl: string; dir?: string; log?: (s: string) => void }): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const dir = resolve(opts.dir ?? join(process.cwd(), "db", "migrations"));
  const app = new URL(opts.appUrl);
  const appUser = decodeURIComponent(app.username);
  const appPassword = decodeURIComponent(app.password);
  if (!appUser) throw new Error("DATABASE_URL has no user name");

  const c = new pg.Client({ connectionString: opts.adminUrl });
  await c.connect();
  const applied: string[] = [];
  try {
    await c.query("SELECT pg_advisory_lock(727001)"); // one migrator at a time
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await c.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(file)) continue;
      log(`applying ${file}`);
      await c.query("BEGIN");
      try {
        await c.query(readFileSync(join(dir, file), "utf8"));
        await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK");
        throw new Error(`${file}: ${(err as Error).message}`);
      }
      applied.push(file);
    }

    // The app role: can read and write data, cannot bypass row-level security or change the schema.
    const role = c.escapeIdentifier(appUser);
    const exists = (await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [appUser])).rowCount;
    if (!exists) await c.query(`CREATE ROLE ${role} LOGIN`);
    await c.query(`ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${c.escapeLiteral(appPassword)}`);
    const db = c.escapeIdentifier((await c.query<{ d: string }>("SELECT current_database() AS d")).rows[0]!.d);
    await c.query(`GRANT CONNECT ON DATABASE ${db} TO ${role}`);
    await c.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await c.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await c.query(`REVOKE ALL ON schema_migrations FROM ${role}`);
  } finally {
    await c.query("SELECT pg_advisory_unlock(727001)").catch(() => {});
    await c.end();
  }
  return applied;
}

/** Create a database if it doesn't exist (connects to the server's maintenance DB). */
export async function ensureDatabase(adminUrl: string): Promise<void> {
  const u = new URL(adminUrl);
  const name = decodeURIComponent(u.pathname.slice(1));
  u.pathname = "/postgres";
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    const exists = (await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount;
    if (!exists) await c.query(`CREATE DATABASE ${c.escapeIdentifier(name)}`);
  } finally {
    await c.end();
  }
}

export async function dropDatabase(adminUrl: string): Promise<void> {
  const u = new URL(adminUrl);
  const name = decodeURIComponent(u.pathname.slice(1));
  u.pathname = "/postgres";
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${c.escapeIdentifier(name)} WITH (FORCE)`);
  } finally {
    await c.end();
  }
}

/** Same server and credentials, different database name. */
export function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}
