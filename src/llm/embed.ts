/** Optional embeddings for hybrid recall (EMBEDDING_MODEL, any OpenAI-compatible endpoint). */
import { createHash } from "node:crypto";
import { recordTokens } from "../budget";
import { config } from "../config";
import { cacheGet, cacheSet, key } from "../redis";
import { llm } from "./client";

export function embeddingsEnabled(): boolean {
  return Boolean(config().embeddings.model);
}

/**
 * Embed text to a unit vector of the configured size (768). Larger vectors are truncated and
 * re-normalised (valid for Matryoshka-trained models such as gemini-embedding-001 and text-embedding-3).
 * Returns null when embeddings are off.
 */
export async function embed(text: string): Promise<number[] | null> {
  const { model, dim } = config().embeddings;
  if (!model) return null;
  const k = key("emb", model, createHash("sha256").update(text).digest("hex").slice(0, 32));
  const cached = await cacheGet<number[]>(k);
  if (cached) return cached;
  const res = await llm().embeddings.create({ model, input: text.slice(0, 8000), dimensions: dim }, { timeout: 10_000, maxRetries: 1 });
  await recordTokens(res.usage?.total_tokens);
  const raw = res.data[0]?.embedding;
  if (!raw || raw.length < dim) throw new Error(`embedding has ${raw?.length ?? 0} dimensions, need at least ${dim}`);
  const v = raw.slice(0, dim);
  const norm = Math.hypot(...v) || 1;
  const out = v.map((x) => x / norm);
  await cacheSet(k, out, 86_400);
  return out;
}
