/**
 * npm run smoke — end-to-end check against a running stack (docker compose up):
 * health, sign-in, per-user isolation over HTTP, one real chat turn streamed and resumed,
 * and the worker indexing that turn. Needs LLM and search keys for the chat step (SMOKE_CHAT=0 skips it).
 */
import "dotenv/config";
import pg from "pg";

const BASE = process.env.SMOKE_URL || "http://localhost:3000";
const ADMIN = process.env.SMOKE_ADMIN_DATABASE_URL || "postgres://postgres:postgres@localhost:5433/memochat";
const run = `${Date.now().toString(36)}`;
let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Dev sign-in when AUTH_MODE=dev; otherwise a fresh guest (AUTH_MODE=password). */
async function login(username: string): Promise<string> {
  const post = (path: string, body: unknown) =>
    fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let r = await post("/api/auth/dev-login", { username });
  if (r.status === 404) r = await post("/api/auth/guest", {});
  const body = (await r.json()) as { token?: string; error?: string };
  if (!body.token) throw new Error(`login ${username}: ${body.error ?? r.status}`);
  return body.token;
}

const as = (token: string) => (path: string, init: RequestInit = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });

function parseSse(text: string): Array<{ id: number; e: Record<string, any> }> {
  return text
    .split("\n\n")
    .filter((b) => b.includes("data: "))
    .map((b) => {
      const lines = b.split("\n");
      return { id: Number(lines.find((l) => l.startsWith("id: "))?.slice(4) ?? 0), e: JSON.parse(lines.find((l) => l.startsWith("data: "))!.slice(6)) };
    });
}

// 1. Health
for (let i = 0; ; i++) {
  const ok = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
  if (ok) break;
  if (i > 60) throw new Error(`${BASE} not healthy after 60s`);
  await new Promise((r) => setTimeout(r, 1000));
}
const health = await (await fetch(`${BASE}/api/health`)).json();
check("health: Postgres and Redis up", health.postgres && health.redis, JSON.stringify(health));

// 2. Auth
check("no session -> 401", (await fetch(`${BASE}/api/conversations`)).status === 401);
check("forged token -> 401", (await as("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZXZ8YWxpY2UifQ.x")("/api/conversations")).status === 401);
const alice = as(await login(`alice-${run}`));
const bob = as(await login(`bob-${run}`));

// 3. Isolation over HTTP
const imported = await alice("/api/import", {
  method: "POST",
  body: JSON.stringify({
    tz: "Asia/Kolkata",
    conversations: [
      {
        title: "Vector DBs",
        messages: [
          { role: "user", text: "Compare Pinecone and Weaviate pricing", created_at: "2026-11-02T10:00:00+05:30" },
          { role: "assistant", text: "Pinecone Standard starts at $50/month; Weaviate Serverless at $25/month.", created_at: "2026-11-02T10:01:00+05:30" },
        ],
      },
    ],
  }),
});
check("alice imports a conversation", imported.ok);
const aliceConvs = ((await (await alice("/api/conversations")).json()) as { conversations: Array<{ id: string }> }).conversations;
check("alice lists her conversation", aliceConvs.length === 1, `${aliceConvs.length}`);
const convId = aliceConvs[0]?.id ?? "missing";
const bobConvs = ((await (await bob("/api/conversations")).json()) as { conversations: unknown[] }).conversations;
check("bob's list is empty", bobConvs.length === 0, `${bobConvs.length}`);
check("bob gets 404 for alice's conversation", (await bob(`/api/conversations/${convId}`)).status === 404);
check("bob cannot delete alice's conversation", (await bob(`/api/conversations/${convId}`, { method: "DELETE" })).status === 404);
check("alice still has it", (await alice(`/api/conversations/${convId}`)).ok);

// 4. A real turn as bob, writing into alice's conversation id: must land in a new conversation of bob's.
if (process.env.SMOKE_CHAT !== "0") {
  const t0 = Date.now();
  const res = await bob("/api/chat", { method: "POST", body: JSON.stringify({ conversationId: convId, text: "What did I ask you about Pinecone pricing?", tz: "Asia/Kolkata" }) });
  const events = parseSse(await res.text());
  const start = events.find((x) => x.e.type === "start")?.e;
  const done = events.find((x) => x.e.type === "done");
  const memory = events.find((x) => x.e.type === "memory")?.e;
  const error = events.find((x) => x.e.type === "error")?.e;
  check("bob's turn streams to done", Boolean(done), error ? error.message : `${Date.now() - t0} ms`);
  check("bob's turn did not use alice's conversation", start?.conversationId !== convId);
  check("bob's recall found nothing of alice's", !memory || memory.recalled.length === 0, JSON.stringify(memory?.recalled ?? []));
  check("SSE events carry increasing ids", events.every((x, i) => x.id === i + 1));

  const turnId = start?.assistantMessageId as string;
  const replay = parseSse(await (await bob(`/api/chat/${turnId}/events?after=2`)).text());
  check("resume replays from the last seen event", replay[0]?.id === 3 && replay.at(-1)?.e.type === "done", `${replay.length} events`);
  check("alice cannot resume bob's turn", (await alice(`/api/chat/${turnId}/events`)).status === 404);

  // 5. Worker indexes the turn (outbox -> Redis stream -> worker), or the job is retrying on a provider error.
  const db = new pg.Client({ connectionString: ADMIN });
  await db.connect();
  let status = "";
  for (let i = 0; i < 60; i++) {
    const r = await db.query("SELECT status, attempts, last_error FROM jobs WHERE payload->>'assistantMessageId' = $1", [turnId]);
    status = r.rows[0] ? `${r.rows[0].status} (attempts ${r.rows[0].attempts}${r.rows[0].last_error ? `, ${String(r.rows[0].last_error).slice(0, 80)}` : ""})` : "no job";
    if (r.rows[0]?.status === "done" || r.rows[0]?.status === "skipped" || !r.rows[0]) break;
    await new Promise((res) => setTimeout(res, 1000));
  }
  await db.end();
  check("worker processed the turn's extraction job", /^(done|skipped|no job)/.test(status), status);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll smoke checks passed");
process.exit(failures ? 1 : 0);
