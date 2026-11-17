/**
 * npm run eval — run the sample questions (plus edge cases) against seeded, backdated history with a frozen clock.
 * Uses a temporary database. Code checks first (dates, recall, search use, citations), then an LLM-judge pass.
 * Writes eval-results.md.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { dropDatabase, ensureDatabase, migrate, withDatabase } from "../src/db/migrate";

process.env.MEMOCHAT_FAKE_NOW ||= "2026-11-11T14:05:00+05:30"; // a Wednesday
const TZ = process.env.EVAL_TZ || "Asia/Kolkata";

// A throwaway database (same server) and Redis key prefix, so the eval never touches real data or caches.
const evalDb = `memochat_eval_${Date.now()}`;
const adminUrl = withDatabase(process.env.MIGRATE_DATABASE_URL || "postgres://postgres:postgres@localhost:5433/memochat", evalDb);
process.env.DATABASE_URL = withDatabase(process.env.DATABASE_URL || "postgres://memochat_app:memochat_app@localhost:5433/memochat", evalDb);
process.env.REDIS_PREFIX = `eval:${Date.now()}:`;
process.env.DAILY_TOKEN_BUDGET = "0";
await ensureDatabase(adminUrl);
await migrate({ adminUrl, appUrl: process.env.DATABASE_URL });
const EVAL_USER = "dev|eval";

const { missingConfig } = await import("../src/config");
const { seedDemo } = await import("../src/demo/seed");
const { drainAll } = await import("../src/memory/jobs");
const { runTurn } = await import("../src/agent/turn");
const { asUser, closePool } = await import("../src/db/index");
const { searchCallsFor } = await import("../src/db/repo");
const { ensureUser } = await import("../src/auth");
const { closeRedis } = await import("../src/redis");
const { structured } = await import("../src/llm/client");

async function cleanup(): Promise<void> {
  await closeRedis();
  await closePool();
  if (!process.env.EVAL_KEEP_DB) await dropDatabase(adminUrl).catch(() => {});
}
type ChatEvent = import("../src/sse").ChatEvent;

const problems = missingConfig();
if (problems.length) {
  console.error(`Cannot run eval: ${problems.join(" ")}`);
  await cleanup();
  process.exit(1);
}

type Run = { text: string; events: ChatEvent[]; assistantId: string; ttft: number; total: number; searches: Array<{ query: string; since_date: string | null; domains: string | null }> };
type Check = { name: string; pass: boolean; detail?: string };
type Scenario = { id: string; question: string; checks: (r: Run) => Check[] };

const memory = (r: Run) => r.events.find((e) => e.type === "memory") as Extract<ChatEvent, { type: "memory" }> | undefined;
const searchCalls = (r: Run) => r.searches;
const cites = (r: Run, prefix: "S" | "M") => new RegExp(`\\[${prefix}\\d+`).test(r.text);
const recalledDates = (r: Run) => memory(r)?.recalled.map((x) => x.local_date) ?? [];
const check = (name: string, pass: boolean, detail?: string): Check => ({ name, pass, detail });

const scenarios: Scenario[] = [
  {
    id: "crm-monday",
    question: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    checks: (r) => [
      check("Monday resolved to 2026-11-09", memory(r)?.resolved.some((x) => x.date === "2026-11-09") ?? false, JSON.stringify(memory(r)?.resolved)),
      check("recalled the 9 Nov CRM conversation", recalledDates(r).includes("2026-11-09")),
      check("searched the web", searchCalls(r).length > 0, `${searchCalls(r).length} queries`),
      check("cites web sources [S#]", cites(r, "S")),
    ],
  },
  {
    id: "nov-3",
    question: "What did I ask you on 3 November? Is your answer still correct today?",
    checks: (r) => [
      check("recalled the 3 Nov conversation", recalledDates(r).includes("2026-11-03")),
      check("answer mentions what was asked (Node.js)", /node/i.test(r.text)),
      check("re-checked on the web", searchCalls(r).length > 0),
      check("cites the past record [M#]", cites(r, "M")),
    ],
  },
  {
    id: "postgres-last-tuesday",
    question: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    checks: (r) => [
      check("recalled the 10 Nov Postgres conversation", recalledDates(r).includes("2026-11-10")),
      check("searched the web", searchCalls(r).length > 0),
      check("mentions Neon, Supabase and RDS", /neon/i.test(r.text) && /supabase/i.test(r.text) && /rds/i.test(r.text)),
      check("cites web sources [S#]", cites(r, "S")),
    ],
  },
  {
    id: "no-record",
    question: "What did I ask you on 20 October?",
    checks: (r) => [
      check("memory status none", memory(r)?.status === "none", memory(r)?.status),
      check("says there is no record", /(no|don't have|do not have|couldn't find|could not find|nothing|didn't ask|did not ask).{0,60}(record|conversation|history|anything)/i.test(r.text)),
      check("did not search the web", searchCalls(r).length === 0),
    ],
  },
  {
    id: "ambiguous-tuesday",
    question: "Last Tuesday you told me when Node.js 22 reaches end of life. Is that still right?",
    checks: (r) => [
      // "Last Tuesday" could be 10 Nov or 3 Nov; only 3 Nov is about Node.js.
      check("picked 3 Nov by topic", recalledDates(r).includes("2026-11-03") && !recalledDates(r).includes("2026-11-10"), JSON.stringify(recalledDates(r))),
      check("re-checked on the web", searchCalls(r).length > 0),
    ],
  },
  {
    id: "current-no-memory",
    question: "What's the latest LTS version of Node.js right now?",
    checks: (r) => [
      check("no memory lookup", memory(r)?.status === "not_needed", memory(r)?.status),
      check("searched the web", searchCalls(r).length > 0),
      check("cites web sources [S#]", cites(r, "S")),
    ],
  },
];

const Judge = z.object({ answers_question: z.boolean(), honest_about_uncertainty: z.boolean(), comment: z.string() });

async function ask(question: string): Promise<Run> {
  const events: ChatEvent[] = [];
  let text = "";
  const t0 = Date.now();
  let ttft = -1;
  await asUser(EVAL_USER, () =>
    runTurn({ text: question, tz: TZ }, (e) => {
      events.push(e);
      if (e.type === "text") {
        if (ttft < 0) ttft = Date.now() - t0;
        text += e.delta;
      }
    }),
  );
  const total = Date.now() - t0;
  const start = events.find((e) => e.type === "start") as Extract<ChatEvent, { type: "start" }>;
  const searches = await asUser(EVAL_USER, () => searchCallsFor(start.assistantMessageId));
  return { text, events, assistantId: start.assistantMessageId, ttft, total, searches };
}

console.log(`Seeding demo history (now = ${process.env.MEMOCHAT_FAKE_NOW}, tz = ${TZ})…`);
await ensureUser({ id: EVAL_USER, name: "eval" }, "dev", "eval");
await asUser(EVAL_USER, () => seedDemo(TZ));
await drainAll(300_000);

const rows: string[] = [];
const details: string[] = [];
let passed = 0;
let total = 0;
// Free-tier LLM keys allow few requests per minute; pause between scenarios (EVAL_PAUSE_MS=0 to disable).
const pause = Number(process.env.EVAL_PAUSE_MS ?? 20_000);
for (const [i, s] of scenarios.entries()) {
  if (i > 0 && pause > 0) await new Promise((r) => setTimeout(r, pause));
  process.stdout.write(`- ${s.id}… `);
  const r = await ask(s.question);
  const checks = s.checks(r);
  let judge: z.infer<typeof Judge> | null = null;
  try {
    judge = await structured(Judge, "judge", [
      {
        role: "system",
        content:
          "You grade a research assistant that remembers the user's past conversations and searches the web. You are shown the past conversations it really has on record; referring to those is correct, not invented. answers_question: it directly addresses what was asked. honest_about_uncertainty: it does not claim facts it could not support, says when it could not verify something, and does not invent past conversations. Be strict.",
      },
      {
        role: "user",
        content: `Question: ${s.question}\n\nPast conversations the assistant really has on record and was shown for this question (anything else would be invented):\n${
          memory(r)?.recalled.map((x) => `- ${x.local_date}: "${x.question}"`).join("\n") || "(none)"
        }\n\nAnswer:\n${r.text}`,
      },
    ]);
  } catch (err) {
    judge = { answers_question: false, honest_about_uncertainty: false, comment: `judge failed: ${(err as Error).message}` };
  }
  checks.push(check("judge: answers the question", judge.answers_question), check("judge: honest about uncertainty", judge.honest_about_uncertainty, judge.comment));
  const ok = checks.filter((c) => c.pass).length;
  passed += ok;
  total += checks.length;
  console.log(`${ok}/${checks.length}  ttft ${r.ttft}ms  total ${r.total}ms`);
  rows.push(`| ${s.id} | ${ok}/${checks.length} | ${r.ttft} | ${r.total} | ${searchCalls(r).length} |`);
  details.push(
    `### ${s.id}\n\n> ${s.question}\n\n${checks.map((c) => `- ${c.pass ? "✅" : "❌"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`).join("\n")}\n\n<details><summary>Answer</summary>\n\n${r.text}\n\n</details>\n`,
  );
}

const report = `# Eval results

Clock frozen at ${process.env.MEMOCHAT_FAKE_NOW} (${TZ}). Model: ${process.env.LLM_MODEL}. Search: ${process.env.SEARCH_PROVIDER || "exa"}. Run at ${new Date().toISOString()}.

**${passed}/${total} checks passed.**

| Scenario | Checks | TTFT ms | Total ms | Web queries |
|---|---|---|---|---|
${rows.join("\n")}

${details.join("\n")}`;
writeFileSync("eval-results.md", report);
console.log(`\n${passed}/${total} checks passed. Wrote eval-results.md`);
await cleanup();
process.exit(0);
