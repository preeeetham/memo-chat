/** Environment parsing. Read lazily so scripts can load .env before first use. */

export type SearchProviderName = "exa" | "tavily" | "mock";

export type Config = {
  llm: { provider: string; model: string; helperModel: string; baseURL: string; apiKey: string };
  search: { provider: SearchProviderName; exaKey: string; tavilyKey: string };
  dbPath: string;
  fakeNow: string | null;
  limits: {
    maxToolRounds: number;
    resultsPerQuery: number;
    searchTimeoutMs: number;
    plannerTimeoutMs: number;
    historyTurns: number;
  };
};

const env = (k: string) => (process.env[k] ?? "").trim();

export function config(): Config {
  const model = env("LLM_MODEL") || "gemini-3.5-flash-lite";
  const provider = (env("SEARCH_PROVIDER") || "exa").toLowerCase();
  return {
    llm: {
      provider: env("LLM_PROVIDER") || "openai",
      model,
      helperModel: env("HELPER_MODEL") || model,
      baseURL: env("LLM_BASE_URL") || "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: env("LLM_API_KEY"),
    },
    search: {
      provider: (["exa", "tavily", "mock"].includes(provider) ? provider : "exa") as SearchProviderName,
      exaKey: env("EXA_API_KEY"),
      tavilyKey: env("TAVILY_API_KEY"),
    },
    dbPath: env("MINICHAT_DB_PATH") || "./data/minichat.db",
    fakeNow: env("MINICHAT_FAKE_NOW") || null,
    limits: {
      maxToolRounds: 4,
      resultsPerQuery: 5,
      searchTimeoutMs: 8000,
      plannerTimeoutMs: 5000,
      historyTurns: 10,
    },
  };
}

/** Human-readable problems that stop the app from working. Shown in the UI instead of crashing. */
export function missingConfig(c: Config = config()): string[] {
  const problems: string[] = [];
  if (c.llm.provider !== "openai")
    problems.push(`LLM_PROVIDER=${c.llm.provider} is not supported; use "openai" (any OpenAI-compatible endpoint).`);
  if (!c.llm.apiKey) problems.push("LLM_API_KEY is not set.");
  if (c.search.provider === "exa" && !c.search.exaKey) problems.push("EXA_API_KEY is not set (web search).");
  if (c.search.provider === "tavily" && !c.search.tavilyKey) problems.push("TAVILY_API_KEY is not set (web search).");
  return problems;
}
