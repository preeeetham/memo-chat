import { defineConfig } from "vitest/config";

export default defineConfig({
  // Integration tests share one Postgres server: run files one at a time so they don't race on the
  // cluster-wide app role ("tuple concurrently updated") or time out the 1.5s probe and skip.
  test: { include: ["tests/**/*.test.ts"], environment: "node", fileParallelism: false },
});
