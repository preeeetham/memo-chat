/**
 * npm run seed — load backdated demo conversations for a user (default "demo"; sign in as that name).
 *   npm run seed -- --user alice      seed for dev user "alice"
 *   npm run seed -- --if-enabled      do nothing unless SEED_DEMO=true (used by docker compose)
 *   npm run seed -- --drain           index the demo turns here instead of waiting for the worker
 */
import "dotenv/config";
import { devUserId, ensureUser } from "../src/auth";
import { asUser, closePool } from "../src/db/index";
import { seedDemo } from "../src/demo/seed";
import { drainAll } from "../src/memory/jobs";
import { closeRedis } from "../src/redis";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes("--if-enabled") && process.env.SEED_DEMO !== "true") {
  console.log("[seed] SEED_DEMO is not true; skipping demo history.");
  process.exit(0);
}

const username = arg("--user") || process.env.SEED_USER || "demo";
const userId = devUserId(username);
if (!userId) {
  console.error(`[seed] bad username "${username}"`);
  process.exit(1);
}
const tz = process.env.TZ_DEMO || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
await ensureUser({ id: userId, name: username }, "dev", username);
const r = await asUser(userId, () => seedDemo(tz));
console.log(`[seed] ${r.conversations} demo conversations (${r.messages} messages) for "${username}" in ${tz}.`);
if (args.includes("--drain")) {
  console.log("[seed] indexing…");
  await drainAll();
} else {
  console.log("[seed] the worker indexes them in the background.");
}
console.log(`[seed] Sign in as "${username}" and ask: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"`);
await closeRedis();
await closePool();
process.exit(0);
