/** The model picker: which listed models count as chat models, and how a stored choice maps to an endpoint. */
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config";
import { defaultChatModel, isChatModel, parseChatModel } from "../src/llm/models";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("isChatModel", () => {
  it("keeps chat models from Gemini and NIM", () => {
    for (const id of ["gemini-3.5-flash-lite", "gemma-4-31b-it", "minimaxai/minimax-m3.1-flash", "nvidia/nemotron-3.5-super-vl-120b-a12b"]) expect(isChatModel(id)).toBe(true);
  });
  it("drops embeddings, speech, image and safety models", () => {
    for (const id of ["gemini-embedding-001", "gemini-3.8-flash-tts", "gemini-3.1-flash-image", "lyria-3.5", "nvidia/nemotron-3.5-embed-8b", "nvidia/nemotron-3.5-content-safety", "nvidia/nvclip"])
      expect(isChatModel(id)).toBe(false);
  });
});

describe("providers and stored choices", () => {
  it("offers NIM next to the primary endpoint when NIM_API_KEY is set", () => {
    process.env.LLM_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
    process.env.NIM_API_KEY = "test-nim-key";
    expect(config().llm.providers.map((p) => p.id)).toEqual(["gemini", "nim"]);
  });

  it("doesn't list NIM twice when it is already the primary endpoint", () => {
    process.env.LLM_BASE_URL = "https://integrate.api.nvidia.com/v1";
    process.env.NIM_API_KEY = "test-nim-key";
    expect(config().llm.providers.map((p) => p.id)).toEqual(["nim"]);
  });

  it("parses '<provider>:<model>' and keeps slashes in the model id", () => {
    process.env.LLM_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
    process.env.NIM_API_KEY = "test-nim-key";
    const m = parseChatModel("nim:minimaxai/minimax-m3.1-flash");
    expect(m?.provider.id).toBe("nim");
    expect(m?.model).toBe("minimaxai/minimax-m3.1-flash");
  });

  it("ignores a choice whose endpoint is no longer configured", () => {
    process.env.LLM_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
    delete process.env.NIM_API_KEY;
    expect(parseChatModel("nim:minimaxai/minimax-m3.1-flash")).toBeNull();
    expect(parseChatModel("no-provider")).toBeNull();
    expect(defaultChatModel().ref).toMatch(/^gemini:/);
  });
});
