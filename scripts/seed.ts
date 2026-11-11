/** npm run seed — load backdated demo conversations into ./data/minichat.db and index them. */
import "dotenv/config";
import { seedDemo } from "../src/demo/seed";
import { drainAll } from "../src/memory/jobs";

const tz = process.env.TZ_DEMO || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const r = seedDemo(tz);
console.log(`Seeded ${r.conversations} demo conversations (${r.messages} messages) in ${tz}. Indexing…`);
await drainAll();
console.log("Done. Run `npm run dev` and ask: \"On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing since?\"");
