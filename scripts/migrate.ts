/** npm run migrate — apply db/migrations and set up the app's database role. Safe to run repeatedly. */
import "dotenv/config";
import { ensureDatabase, migrate } from "../src/db/migrate";

const adminUrl = process.env.MIGRATE_DATABASE_URL || "postgres://postgres:postgres@localhost:5433/memochat";
const appUrl = process.env.DATABASE_URL || "postgres://memochat_app:memochat_app@localhost:5433/memochat";

for (let attempt = 1; ; attempt++) {
  try {
    await ensureDatabase(adminUrl);
    const applied = await migrate({ adminUrl, appUrl, log: (s) => console.log(`[migrate] ${s}`) });
    console.log(`[migrate] ${applied.length ? `applied ${applied.length} migration(s)` : "schema up to date"}`);
    process.exit(0);
  } catch (err) {
    const e = err as Error & { code?: string };
    // Postgres may still be starting (compose healthchecks make this rare).
    if (attempt < 10 && (e.code === "ECONNREFUSED" || e.code === "57P03")) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    console.error(`[migrate] failed: ${e.message}`);
    process.exit(1);
  }
}
