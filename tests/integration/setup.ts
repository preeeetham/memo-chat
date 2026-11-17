/** Shared setup for integration tests: a throwaway database on the compose Postgres, migrated. */
import { dropDatabase, ensureDatabase, migrate, withDatabase } from "../../src/db/migrate";

export const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL || process.env.MIGRATE_DATABASE_URL || "postgres://postgres:postgres@localhost:5433/memochat";
export const APP_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgres://memochat_app:memochat_app@localhost:5433/memochat";

/** Is the Postgres from `docker compose up -d postgres redis` reachable? Integration tests skip otherwise. */
export async function postgresAvailable(): Promise<boolean> {
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 1500 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

export async function freshDatabase(label: string): Promise<{ adminUrl: string; appUrl: string; drop: () => Promise<void> }> {
  const name = `memochat_test_${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const adminUrl = withDatabase(ADMIN_URL, name);
  const appUrl = withDatabase(APP_URL, name);
  await ensureDatabase(adminUrl);
  await migrate({ adminUrl, appUrl });
  return { adminUrl, appUrl, drop: () => dropDatabase(adminUrl) };
}
