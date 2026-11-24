/**
 * The chat models a user can pick: every model each configured endpoint lists at GET /models,
 * minus the ones that can't chat (embeddings, speech, image, safety classifiers…).
 * A choice is stored as "<provider id>:<model id>", e.g. "nim:minimaxai/minimax-m3.1-flash".
 */
import { config, type LlmProvider } from "../config";
import { llm } from "./client";

export type ModelOption = { id: string; provider: string; providerLabel: string; model: string };
export type ChatModel = { ref: string; provider: LlmProvider; model: string };

/** Model ids that are not chat models, on Gemini and NIM. */
const NOT_CHAT =
  /embed|tts|image|banana|lyria|transcribe|live|native-audio|aqa|genie|robotics|computer-use|deep-research|antigravity|translate|safety|guard|nemoguard|clip|retriever|detector|pii|gliner|starcoder|calibration|cosmos|decision|content-safety/i;

export function isChatModel(id: string): boolean {
  return !NOT_CHAT.test(id);
}

const TTL_MS = 10 * 60_000;
const g = globalThis as unknown as { __memochatModels?: { key: string; at: number; list: Promise<ModelOption[]> } };

/** All chat models from every endpoint, cached for 10 minutes. An endpoint that fails is left out. */
export function listModels(): Promise<ModelOption[]> {
  const providers = config().llm.providers;
  const key = providers.map((p) => `${p.baseURL}|${p.apiKey}`).join(",");
  const hit = g.__memochatModels;
  if (hit && hit.key === key && Date.now() - hit.at < TTL_MS) return hit.list;
  const list = Promise.all(providers.map(modelsOf)).then((lists) => lists.flat());
  g.__memochatModels = { key, at: Date.now(), list };
  // Don't cache a total failure: try again on the next request.
  list.then((l) => !l.length && g.__memochatModels?.list === list && (g.__memochatModels = undefined));
  return list;
}

async function modelsOf(p: LlmProvider): Promise<ModelOption[]> {
  if (!p.apiKey) return [];
  try {
    const ids: string[] = [];
    for await (const m of llm(p).models.list({ timeout: 10_000, maxRetries: 0 })) ids.push(m.id.replace(/^models\//, ""));
    return [...new Set(ids)]
      .filter(isChatModel)
      .sort((a, b) => a.localeCompare(b))
      .map((model) => ({ id: `${p.id}:${model}`, provider: p.id, providerLabel: p.label, model }));
  } catch (err) {
    console.warn(`[models] could not list ${p.label} models: ${(err as Error).message}`);
    return [];
  }
}

/** The configured default (LLM_MODEL on the primary endpoint). */
export function defaultChatModel(): ChatModel {
  const c = config().llm;
  return { ref: `${c.providers[0].id}:${c.model}`, provider: c.providers[0], model: c.model };
}

/** Turn a stored choice into an endpoint + model; null when its provider is no longer configured. */
export function parseChatModel(ref: string | null | undefined): ChatModel | null {
  if (!ref) return null;
  const i = ref.indexOf(":");
  if (i <= 0) return null;
  const provider = config().llm.providers.find((p) => p.id === ref.slice(0, i));
  const model = ref.slice(i + 1);
  return provider && model ? { ref, provider, model } : null;
}
