/** One chat turn, end to end: persist -> plan -> resolve dates -> recall -> model loop -> persist -> extract later. */
import type { ChatCompletionMessageParam, ReasoningEffort } from "openai/resources";
import { now } from "../clock";
import { config } from "../config";
import { createConversation, getConversation, getMessages, insertMessage, setConversationTitle, type MessageRow } from "../db/repo";
import { newId } from "../ids";
import { publishJob } from "../memory/jobs";
import { SearchSession } from "../search/tool";
import type { ChatEvent } from "../sse";
import { describeNow, localDate, safeTz, shortLabel } from "../time/local";
import { guessedResolutions, resolveAll, unresolvedExpressions } from "../time/resolve";
import { renderContext } from "./bundle";
import { runLoop } from "./loop";
import { embed } from "../llm/embed";
import { isFastPath, plan as makePlan, type Plan } from "./planner";
import { SYSTEM_PROMPT } from "./prompt";
import { recall } from "./recall";

export type TurnInput = { conversationId?: string | null; text: string; tz?: string | null };

export async function runTurn(input: TurnInput, emit: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const mark = (k: string) => (timings[k] = Date.now() - t0);
  const tz = safeTz(input.tz);
  const at = now();
  const text = input.text.trim();

  // 1. Conversation + user message.
  // A conversation id that isn't this user's is invisible under row-level security: start a new one.
  let conv = input.conversationId ? await getConversation(input.conversationId) : undefined;
  const isNew = !conv;
  if (!conv) conv = await createConversation(null, at.toISOString());
  const prior = await getMessages(conv.id);
  const userMsg: ChatCompletionMessageParam = { role: "user", content: text };
  const userRow = await insertMessage({
    conversation_id: conv.id,
    role: "user",
    text,
    content_json: JSON.stringify([userMsg]),
    created_at: at.toISOString(),
    tz,
    local_date: localDate(at, tz),
    reply_to: null,
  });
  const assistantId = newId("a");
  emit({ type: "start", conversationId: conv.id, userMessageId: userRow.id, assistantMessageId: assistantId });

  // 2. Plan (helper model) while the history is assembled.
  const nowLine = describeNow(at, tz);
  const recent = prior.slice(-6).map((m) => `${m.role}: ${m.text.slice(0, 300)}`);
  const history = replayHistory(prior);
  // The query embedding (if enabled) is computed alongside the planner, so hybrid recall costs no extra wait.
  const queryEmbedding = isFastPath(text) ? undefined : embed(text);
  queryEmbedding?.catch(() => {});
  const p: Plan = await makePlan(text, recent, nowLine);
  mark("plan");

  // 3. Dates, in code.  4. Recall, in SQL.
  // Phrases the code can't read (Diwali, "this summer") fall back to the planner's own date guess.
  const resolutions = resolveAll(p.time_expressions, at, tz);
  const unresolved = unresolvedExpressions(p.time_expressions, at, tz);
  const guessed = guessedResolutions(p.date_guesses ?? [], unresolved, at, tz).filter((g) => !resolutions.some((r) => r.expr === g.expr));
  resolutions.push(...guessed);
  const bundle = await recall(p, resolutions, conv.id, queryEmbedding);
  mark("recall");
  emit({
    type: "memory",
    status: bundle.status,
    resolved: bundle.resolved,
    recalled: bundle.turns.map((t) => ({
      ref: t.ref,
      local_date: t.local_date,
      conversation_id: t.conversation_id,
      conversation_title: t.conversation_title,
      question: t.question.slice(0, 140),
    })),
  });
  const memStatus = memoryStatus(bundle);
  if (memStatus) emit({ type: "status", text: memStatus });
  else if (p.task !== "chat") emit({ type: "status", text: "Thinking…" });

  // 5. Main model loop.
  const contextNote: ChatCompletionMessageParam = { role: "system", content: renderContext(nowLine, bundle) };
  const effort: ReasoningEffort = p.source === "fast_path" ? "minimal" : p.task === "chat" || p.task === "recall_only" ? "low" : p.task === "recall_and_verify" ? "high" : "medium";
  const search = new SearchSession(assistantId, tz);
  const result = await runLoop({
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history, userMsg, contextNote],
    effort,
    search,
    emit,
    signal,
    allowTools: p.source !== "fast_path",
  });
  timings.ttft = result.ttftMs ?? -1;
  mark("total");

  let answer = result.text.trim();
  if (!answer) {
    answer = "Sorry, I couldn't produce an answer for that. Could you rephrase or try again?";
    emit({ type: "text", delta: answer });
  }
  if (result.finishReason === "length" || result.finishReason === "max_tokens") {
    const cut = "\n\n_(Answer cut short: it hit the length limit.)_";
    answer += cut;
    emit({ type: "text", delta: cut }); // show it live too, not only after a reload
  }
  if (result.finishReason === "content_filter") answer = "I can't help with that one.";

  // 6. Persist the answer and its extraction job in one transaction (the outbox).
  const trivial = p.task === "chat" && !p.entities.length && !search.sources.length;
  const saved = await insertMessage(
    {
      id: assistantId,
      conversation_id: conv.id,
      role: "assistant",
      text: answer,
      content_json: JSON.stringify([contextNote, ...result.messages]),
      created_at: new Date(at.getTime() + (Date.now() - t0)).toISOString(),
      tz,
      local_date: localDate(at, tz),
      reply_to: userRow.id,
      meta: {
        timings,
        plan: p,
        memory: { status: bundle.status, resolved: bundle.resolved, recalled: bundle.turns.map((t) => ({ ref: t.ref, local_date: t.local_date, conversation_id: t.conversation_id, conversation_title: t.conversation_title })) },
        sources: search.sources,
        rounds: result.rounds,
        searches: result.searches,
        tokens: result.tokens,
        fallbackModel: result.fallbackModel,
      },
    },
    trivial ? undefined : { type: "extract_turn", payload: { assistantMessageId: assistantId } },
  );
  let title: string | undefined;
  if (isNew) {
    title = text.length > 60 ? `${text.slice(0, 57)}…` : text;
    await setConversationTitle(conv.id, title);
  }
  console.log(`[turn] ${p.task}/${p.source} memory=${bundle.status} rounds=${result.rounds} searches=${result.searches} finish=${result.finishReason} chars=${answer.length} ` + Object.entries(timings).map(([k, v]) => `${k}=${v}ms`).join(" "));
  emit({ type: "done", assistantMessageId: assistantId, timings, title });

  // 7. Extraction runs after the response, in the worker. Publishing is best effort; the worker's sweep covers a miss.
  await publishJob(saved.jobId);
}

/** This conversation's stored API messages, replayed unchanged (append-only), last N turns. */
function replayHistory(rows: MessageRow[]): ChatCompletionMessageParam[] {
  const n = config().limits.historyTurns;
  const userIdx = rows.map((r, i) => (r.role === "user" ? i : -1)).filter((i) => i >= 0);
  const from = userIdx.length > n ? userIdx[userIdx.length - n]! : 0;
  return rows.slice(from).flatMap((r) => JSON.parse(r.content_json) as ChatCompletionMessageParam[]);
}

function memoryStatus(b: Awaited<ReturnType<typeof recall>>): string | null {
  if (b.status === "not_needed") return null;
  if (b.status === "none") return "No matching past conversation found";
  const days = [...new Set(b.turns.map((t) => shortLabel(t.local_date)))];
  return `Recalled ${b.turns.length} past ${b.turns.length === 1 ? "exchange" : "exchanges"} from ${days.join(", ")}`;
}
