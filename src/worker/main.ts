/** npm run worker — the extraction worker: turn digests, claims ledger and embeddings, off the request path. */
import "dotenv/config";
import { closePool } from "../db/index";
import { runWorker } from "../memory/jobs";
import { closeRedis } from "../redis";

const ctrl = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[worker] ${sig}: finishing the current job, then exiting`);
    ctrl.abort();
  });
}

await runWorker({ signal: ctrl.signal });
await closeRedis();
await closePool();
process.exit(0);
