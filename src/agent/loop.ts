/**
 * The main model loop: stream the answer, run web_search when the model asks, repeat (bounded).
 * Works with any OpenAI-compatible endpoint; handles Gemini's quirks (tool-call chunks without an
 * index, thought signatures in `extra_content` that must be sent back unchanged).
 */
import type { ChatCompletionMessageParam, ChatCompletionMessageToolCall, ReasoningEffort } from "openai/resources";
import { config } from "../config";
import { llm } from "../llm/client";
import { WebSearchInput, webSearchTool, type SearchSession } from "../search/tool";
import type { ChatEvent } from "../sse";
import { ANSWER_NOW } from "./prompt";

type ToolCallAcc = { id: string; name: string; args: string; extra?: unknown };

export type LoopResult = {
  text: string;
  /** Assistant + tool messages produced in this turn, in API shape, for append-only replay. */
  messages: ChatCompletionMessageParam[];
  rounds: number;
  searches: number;
  ttftMs: number | null;
  finishReason: string | null;
};

export async function runLoop(opts: {
  messages: ChatCompletionMessageParam[];
  effort: ReasoningEffort;
  search: SearchSession;
  emit: (e: ChatEvent) => void;
  signal?: AbortSignal;
  allowTools?: boolean;
}): Promise<LoopResult> {
  const { maxToolRounds } = config().limits;
  const started = Date.now();
  const convo = [...opts.messages];
  const produced: ChatCompletionMessageParam[] = [];
  let text = "";
  let ttft: number | null = null;
  let searches = 0;
  let finishReason: string | null = null;
  let round = 0;

  for (; ; round++) {
    const toolsAllowed = opts.allowTools !== false && round < maxToolRounds;
    const finalRound = opts.allowTools !== false && round === maxToolRounds;
    if (finalRound) {
      // Budget spent: ask for the answer and offer no tools. (A user-role note works more reliably on
      // Gemini than tool_choice "none", which sometimes returns an empty message.)
      const nudge: ChatCompletionMessageParam = { role: "user", content: `[system note] ${ANSWER_NOW}` };
      convo.push(nudge);
      produced.push(nudge);
    }

    const stream = await llm().chat.completions.create(
      {
        model: config().llm.model,
        messages: convo,
        stream: true,
        reasoning_effort: opts.effort,
        max_completion_tokens: 8000,
        ...(toolsAllowed ? { tools: [webSearchTool], tool_choice: "auto" as const } : {}),
      },
      { signal: opts.signal },
    );

    let roundText = "";
    let messageExtra: unknown;
    const calls: ToolCallAcc[] = [];
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta as typeof choice.delta & { extra_content?: unknown };
      if (delta.extra_content) messageExtra = delta.extra_content;
      if (delta.content) {
        if (ttft === null) ttft = Date.now() - started;
        roundText += delta.content;
        opts.emit({ type: "text", delta: delta.content });
      }
      for (const tc of delta.tool_calls ?? []) accumulateToolCall(calls, tc as ToolCallDelta);
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    text += roundText;

    if (!calls.length || !toolsAllowed) {
      const final: ChatCompletionMessageParam & { extra_content?: unknown } = { role: "assistant", content: roundText };
      if (messageExtra) final.extra_content = messageExtra;
      produced.push(final);
      break;
    }

    // Assistant message with the tool calls, replayed exactly (thought signatures included).
    const assistantMsg = {
      role: "assistant" as const,
      content: roundText || null,
      tool_calls: calls.map((c) => {
        const call: ChatCompletionMessageToolCall & { extra_content?: unknown } = {
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.args || "{}" },
        };
        if (c.extra) call.extra_content = c.extra;
        return call;
      }),
    };
    convo.push(assistantMsg);
    produced.push(assistantMsg);

    // Run every call of this round in parallel; return all results before the next model call.
    const results = await Promise.all(
      calls.map(async (c) => {
        if (c.name !== "web_search") return { id: c.id, content: `Error: unknown tool "${c.name}". The only tool is web_search.` };
        let input: WebSearchInput;
        try {
          input = WebSearchInput.parse(normalizeArgs(JSON.parse(c.args || "{}")));
        } catch (err) {
          return { id: c.id, content: `Error: invalid web_search input (${(err as Error).message.slice(0, 300)}). Fix the arguments and retry.` };
        }
        searches += input.queries.length;
        opts.emit({ type: "status", text: statusFor(input) });
        try {
          const r = await opts.search.run(input);
          if (r.newSources.length) opts.emit({ type: "sources", sources: r.newSources });
          return { id: c.id, content: r.text };
        } catch (err) {
          return { id: c.id, content: `Error: web search failed: ${(err as Error).message.slice(0, 300)}. Tell the user what you could not check.` };
        }
      }),
    );
    for (const r of results) {
      const msg: ChatCompletionMessageParam = { role: "tool", tool_call_id: r.id, content: r.content };
      convo.push(msg);
      produced.push(msg);
    }
    opts.emit({ type: "status", text: "Reading results…" });
  }

  return { text, messages: produced, rounds: round, searches, ttftMs: ttft, finishReason };
}

type ToolCallDelta = { index?: number; id?: string; function?: { name?: string; arguments?: string }; extra_content?: unknown };

/** Merge streamed tool-call fragments. OpenAI sends `index`; Gemini sends whole calls with an id and no index. */
function accumulateToolCall(calls: ToolCallAcc[], tc: ToolCallDelta): void {
  let target: ToolCallAcc | undefined;
  if (typeof tc.index === "number") target = calls[tc.index];
  else if (tc.id) target = calls.find((c) => c.id === tc.id);
  else target = calls[calls.length - 1];
  if (!target) {
    target = { id: tc.id || `call_${calls.length + 1}`, name: "", args: "" };
    if (typeof tc.index === "number") calls[tc.index] = target;
    else calls.push(target);
  }
  if (tc.id) target.id = tc.id;
  if (tc.function?.name) target.name += tc.function.name;
  if (tc.function?.arguments) target.args += tc.function.arguments;
  if (tc.extra_content) target.extra = tc.extra_content;
}

/** Models sometimes omit nullable fields or send a bare string; normalise before strict validation. */
function normalizeArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const queries = typeof raw.queries === "string" ? [raw.queries] : raw.queries ?? (typeof raw.query === "string" ? [raw.query] : raw.queries);
  return {
    queries: Array.isArray(queries) ? queries.slice(0, 5) : queries,
    since: raw.since || null,
    domains: Array.isArray(raw.domains) && raw.domains.length ? raw.domains : null,
    read_pages: Boolean(raw.read_pages),
  };
}

function statusFor(i: WebSearchInput): string {
  const what = i.queries.length === 1 ? `"${i.queries[0]}"` : `${i.queries.length} queries`;
  const where = i.domains?.length ? ` on ${i.domains.join(", ")}` : "";
  const since = i.since && !i.read_pages ? ` since ${i.since}` : "";
  return `${i.read_pages ? "Reading pages for" : "Searching"} ${what}${where}${since}…`;
}
