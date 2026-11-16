/**
 * A stand-in OpenAI-compatible LLM for load tests, so thousands of turns cost nothing and don't hit
 * provider rate limits. It is deliberately simple but exercises the real code paths:
 * - "plan": the app's own deterministic fallback planner (time expressions, keywords) as JSON,
 * - "extraction": a minimal digest so the worker writes digests,
 * - streaming answers: on the first round it calls web_search once (so search, evidence writes and
 *   the tool loop run), then streams an answer that quotes the [M#] records it was given.
 * Latency is simulated: MOCK_LLM_FIRST_TOKEN_MS (default 400) and MOCK_LLM_CHUNK_MS (default 30).
 */
import { createServer, type ServerResponse } from "node:http";
import { fallbackPlan } from "../src/agent/planner";

const FIRST = Number(process.env.MOCK_LLM_FIRST_TOKEN_MS ?? 400);
const CHUNK = Number(process.env.MOCK_LLM_CHUNK_MS ?? 30);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Msg = { role: string; content?: string | null; tool_calls?: unknown[] };
type Body = { model: string; messages: Msg[]; stream?: boolean; tools?: unknown[]; response_format?: { json_schema?: { name?: string } } };

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function completion(model: string, content: string) {
  return { id: `mock-${Date.now()}`, object: "chat.completion", model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 } };
}

async function stream(res: ServerResponse, model: string, body: Body): Promise<void> {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) =>
    res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`);
  await sleep(FIRST);
  const msgs = body.messages;
  const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
  const usedTool = msgs.some((m) => m.role === "tool");
  const context = msgs.filter((m) => m.role === "system").map((m) => m.content ?? "").join("\n");
  const wantsWeb = /chang|still|correct|latest|pric/i.test(lastUser);
  if (body.tools?.length && !usedTool && wantsWeb) {
    send({ role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: "web_search", arguments: JSON.stringify({ queries: [lastUser.slice(0, 80)], since: null, domains: null, read_pages: false }) } }] }, "tool_calls");
  } else {
    const records = [...context.matchAll(/\[(M\d+)\][^\n]*\nUser asked: ([^\n]{0,160})/g)].map((m) => `[${m[1]}] you asked: "${m[2]}"`);
    const none = /Memory lookup: none/.test(context);
    const text = records.length
      ? `Here is what I have on record. ${records.join(" ")} I re-checked the web [S1]. (mock answer)`
      : none
        ? "I don't have a record of a conversation on that date. (mock answer)"
        : "Here is a current answer from the web [S1]. (mock answer)";
    for (const piece of text.match(/.{1,24}/g) ?? []) {
      send({ content: piece });
      await sleep(CHUNK);
    }
    send({}, "stop");
  }
  res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 800, completion_tokens: 60, total_tokens: 860 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    try {
      if (req.method === "GET") return json(res, 200, { ok: true });
      if (!req.url?.endsWith("/chat/completions")) return json(res, 404, { error: { message: "mock: only /chat/completions" } });
      const body = JSON.parse(raw) as Body;
      const schema = body.response_format?.json_schema?.name;
      if (schema === "plan") {
        await sleep(150);
        const user = body.messages.at(-1)?.content ?? "";
        const text = user.split("New message:\n").at(-1) ?? user;
        const { source: _s, ...plan } = fallbackPlan(text);
        return json(res, 200, completion(body.model, JSON.stringify(plan)));
      }
      if (schema === "extraction") {
        await sleep(200);
        const user = body.messages.at(-1)?.content ?? "";
        const q = (user.match(/User \([^)]*\):\n([^\n]*)/)?.[1] ?? "").slice(0, 200);
        const words = [...new Set(q.match(/[A-Za-z][A-Za-z0-9.-]{3,}/g) ?? [])].slice(0, 8);
        return json(res, 200, completion(body.model, JSON.stringify({ question: q, answer_summary: "mock summary", entities: [], keywords: words, claims: [] })));
      }
      if (body.stream) return await stream(res, body.model, body);
      return json(res, 200, completion(body.model, "mock"));
    } catch (err) {
      json(res, 500, { error: { message: String(err) } });
    }
  });
}).listen(8080, () => console.log("[mock-llm] listening on :8080"));
