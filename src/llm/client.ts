/**
 * LLM access through any OpenAI-compatible Chat Completions endpoint (Gemini by default).
 * Two entry points: `structured()` for the helper jobs (planner, extraction) and `llm()` for the streaming main loop.
 */
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ReasoningEffort } from "openai/resources";
import { z } from "zod";
import { config } from "../config";

const g = globalThis as unknown as { __minichatLlm?: { key: string; client: OpenAI } };

export function llm(): OpenAI {
  const c = config().llm;
  const key = `${c.baseURL}|${c.apiKey}`;
  if (g.__minichatLlm?.key !== key) {
    g.__minichatLlm = { key, client: new OpenAI({ apiKey: c.apiKey, baseURL: c.baseURL, maxRetries: 3, timeout: 60_000 }) };
  }
  return g.__minichatLlm.client;
}

/** JSON Schema for response_format, from a zod schema. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/**
 * Ask the helper model for JSON matching `schema`. Validates with zod; throws on timeout,
 * transport error or invalid output. Callers decide the fallback.
 */
export async function structured<T extends z.ZodType>(
  schema: T,
  name: string,
  messages: ChatCompletionMessageParam[],
  opts: { model?: string; effort?: ReasoningEffort; timeoutMs?: number; maxTokens?: number } = {},
): Promise<z.infer<T>> {
  const c = config().llm;
  const res = await llm().chat.completions.create(
    {
      model: opts.model ?? c.helperModel,
      messages,
      reasoning_effort: opts.effort ?? "minimal",
      max_completion_tokens: opts.maxTokens ?? 2000,
      response_format: { type: "json_schema", json_schema: { name, schema: jsonSchemaOf(schema), strict: true } },
    },
    { timeout: opts.timeoutMs ?? 20_000, maxRetries: opts.timeoutMs && opts.timeoutMs < 5000 ? 0 : 1 },
  );
  const text = res.choices[0]?.message?.content ?? "";
  const json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  return schema.parse(json);
}
