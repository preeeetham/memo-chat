/** Environment parsing. Read lazily so scripts can load .env before first use. */

export type SearchProviderName = "exa" | "tavily" | "mock";

/** An OpenAI-compatible endpoint whose models the user can pick from. The first one is the primary (LLM_*). */
export type LlmProvider = { id: string; label: string; baseURL: string; apiKey: string };

export type Config = {
  llm: {
    provider: string;
    model: string;
    helperModel: string;
    fallbackModel: string;
    baseURL: string;
    apiKey: string;
    /** Endpoints offered in the model picker: the primary, then NVIDIA NIM when NIM_API_KEY is set. */
    providers: [LlmProvider, ...LlmProvider[]];
  };
  embeddings: { model: string; dim: number; minSimilarity: number };
  search: { provider: SearchProviderName; fallback: SearchProviderName | null; exaKey: string; tavilyKey: string };
  databaseUrl: string;
  redisUrl: string;
  redisPrefix: string;
  auth: {
    mode: "dev" | "password" | "oidc";
    secret: string;
    oidcIssuer: string;
    oidcClientId: string;
    oidcClientSecret: string;
    oidcAudience: string;
    publicUrl: string;
  };
  budgets: { dailyTokens: number; requestsPerMinute: number };
  demoTools: boolean;
  fakeNow: string | null;
  limits: {
    maxToolRounds: number;
    resultsPerQuery: number;
    searchTimeoutMs: number;
    plannerTimeoutMs: number;
    historyTurns: number;
  };
};

/** An env value; a value that is only a comment ("KEY=   # note" read literally by docker compose) counts as empty. */
const env = (k: string) => {
  const v = (process.env[k] ?? "").trim();
  return v.startsWith("#") ? "" : v;
};
const num = (k: string, d: number) => {
  const v = Number(env(k));
  return env(k) !== "" && Number.isFinite(v) ? v : d;
};
const providerName = (v: string): SearchProviderName | null => (["exa", "tavily", "mock"].includes(v) ? (v as SearchProviderName) : null);

export const DEV_SECRET = "dev-only-insecure-secret-change-me";

export function config(): Config {
  const model = env("LLM_MODEL") || "gemini-3.5-flash-lite";
  const baseURL = env("LLM_BASE_URL") || "https://generativelanguage.googleapis.com/v1beta/openai";
  const apiKey = env("LLM_API_KEY");
  const providers: [LlmProvider, ...LlmProvider[]] = [primaryProvider(baseURL, apiKey)];
  if (env("NIM_API_KEY") && providers[0].id !== "nim")
    providers.push({ id: "nim", label: "NVIDIA NIM", baseURL: env("NIM_BASE_URL") || "https://integrate.api.nvidia.com/v1", apiKey: env("NIM_API_KEY") });
  return {
    llm: {
      provider: env("LLM_PROVIDER") || "openai",
      model,
      helperModel: env("HELPER_MODEL") || model,
      fallbackModel: env("LLM_FALLBACK_MODEL"),
      baseURL,
      apiKey,
      providers,
    },
    embeddings: { model: env("EMBEDDING_MODEL"), dim: 768, minSimilarity: num("EMBEDDING_MIN_SIMILARITY", 0.6) },
    search: {
      provider: providerName((env("SEARCH_PROVIDER") || "exa").toLowerCase()) ?? "exa",
      fallback: providerName(env("SEARCH_FALLBACK_PROVIDER").toLowerCase()),
      exaKey: env("EXA_API_KEY"),
      tavilyKey: env("TAVILY_API_KEY"),
    },
    databaseUrl: env("DATABASE_URL") || "postgres://memochat_app:memochat_app@localhost:5433/memochat",
    redisUrl: env("REDIS_URL") || "redis://localhost:6380",
    redisPrefix: env("REDIS_PREFIX") || "mc:",
    auth: {
      mode: env("AUTH_MODE") === "oidc" ? "oidc" : env("AUTH_MODE") === "dev" ? "dev" : "password",
      secret: env("AUTH_SECRET") || DEV_SECRET,
      oidcIssuer: env("OIDC_ISSUER").replace(/\/$/, ""),
      oidcClientId: env("OIDC_CLIENT_ID"),
      oidcClientSecret: env("OIDC_CLIENT_SECRET"),
      oidcAudience: env("OIDC_AUDIENCE") || env("OIDC_CLIENT_ID"),
      publicUrl: (env("PUBLIC_URL") || "http://localhost:3000").replace(/\/$/, ""),
    },
    budgets: { dailyTokens: num("DAILY_TOKEN_BUDGET", 0), requestsPerMinute: num("RATE_LIMIT_PER_MINUTE", 20) },
    demoTools: env("DEMO_TOOLS") !== "false",
    fakeNow: env("MEMOCHAT_FAKE_NOW") || null,
    limits: {
      maxToolRounds: 4,
      resultsPerQuery: 5,
      searchTimeoutMs: 8000,
      plannerTimeoutMs: 5000,
      historyTurns: 10,
    },
  };
}

/** Name the primary endpoint after its host, so the picker can say "Gemini" or "NVIDIA NIM". */
function primaryProvider(baseURL: string, apiKey: string): LlmProvider {
  const known: Array<[RegExp, string, string]> = [
    [/generativelanguage\.googleapis\.com/, "gemini", "Gemini"],
    [/integrate\.api\.nvidia\.com/, "nim", "NVIDIA NIM"],
    [/api\.openai\.com/, "openai", "OpenAI"],
  ];
  const hit = known.find(([re]) => re.test(baseURL));
  return { id: hit?.[1] ?? "primary", label: hit?.[2] ?? "Default", baseURL, apiKey };
}

/** Human-readable problems that stop the app from working. Shown in the UI instead of crashing. */
export function missingConfig(c: Config = config()): string[] {
  const problems: string[] = [];
  if (c.llm.provider !== "openai")
    problems.push(`LLM_PROVIDER=${c.llm.provider} is not supported; use "openai" (any OpenAI-compatible endpoint).`);
  if (!c.llm.apiKey) problems.push("LLM_API_KEY is not set.");
  if (c.search.provider === "exa" && !c.search.exaKey) problems.push("EXA_API_KEY is not set (web search).");
  if (c.search.provider === "tavily" && !c.search.tavilyKey) problems.push("TAVILY_API_KEY is not set (web search).");
  if (c.auth.mode === "password" && c.auth.secret === DEV_SECRET && c.auth.publicUrl.startsWith("https://"))
    problems.push("AUTH_MODE=password needs a real AUTH_SECRET (e.g. `openssl rand -hex 32`).");
  if (c.auth.mode === "oidc") {
    if (!c.auth.oidcIssuer || !c.auth.oidcClientId) problems.push("AUTH_MODE=oidc needs OIDC_ISSUER and OIDC_CLIENT_ID.");
    if (c.auth.secret === DEV_SECRET) problems.push("AUTH_MODE=oidc needs a real AUTH_SECRET (e.g. `openssl rand -hex 32`).");
  }
  return problems;
}
