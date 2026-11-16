# Mini Chat

A chat agent with one tool, web search, that remembers each user's past conversations. Ask it "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" and it works out which Tuesday you mean, finds what it told you then, re-checks the vendors' own pricing pages, and reports per item what changed, with sources and dates.

It is multi-user: sign-in (OIDC, or a dev login), Postgres with row-level security per user, Redis for caches, limits and resumable streams, and a separate worker that indexes each turn after the reply. See [DESIGN.md](DESIGN.md) for how it works and why.

## Quickstart

Requires Docker.

```bash
git clone https://github.com/preeeetham/mini-chat && cd mini-chat
cp .env.example .env     # fill in LLM_API_KEY and EXA_API_KEY
docker compose up --build
```

Open http://localhost:3000 and sign in as **demo** (dev sign-in, no password) to see three preloaded, backdated conversations. Then try the suggested questions. Sign in as any other name to get an empty, separate history.

`docker compose up` starts Postgres (with pgvector), Redis, runs the migrations, seeds the demo history (`SEED_DEMO=true`), and starts the app and the worker. Nothing else needs configuring.

Keys:

| Key | Where to get it |
|---|---|
| `LLM_API_KEY` | Any OpenAI-compatible endpoint. Defaults are for Gemini: a key from [Google AI Studio](https://aistudio.google.com/apikey). |
| `EXA_API_KEY` | [exa.ai](https://exa.ai) (free tier works). Or set `SEARCH_PROVIDER=tavily` and `TAVILY_API_KEY`. |

If a key is missing the app still starts and tells you what to fill in.

## What runs

```
app      Next.js UI + API (stateless; scale with --scale app=N behind a load balancer)
worker   post-turn extraction: digests, claims ledger, embeddings (--scale worker=N)
postgres conversations, messages, digests, claims, web evidence, outbox; RLS per user
redis    plan/search/embedding caches, rate limits + token budgets, SSE buffers, job stream
migrate  one-shot: applies db/migrations, creates the app's non-superuser role
seed     one-shot: demo history for user "demo" (SEED_DEMO=false to skip)
```

## Sign-in

- **`AUTH_MODE=dev`** (default): pick any username, no password. For local use only.
- **`AUTH_MODE=oidc`**: any OpenID Connect provider (Auth0, Okta, Cognito, Keycloak, Google, Entra, Clerk). Set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (if the client is confidential), `PUBLIC_URL`, and a real `AUTH_SECRET`; register `PUBLIC_URL/api/auth/callback` as the redirect URI. API clients can also send the provider's token as `Authorization: Bearer …`.

For anything shared, also set `DEMO_TOOLS=false` (the demo clock is server-wide) and `SEED_DEMO=false`.

The verified user id becomes `app.user_id` for the database transaction, and every table's row-level security policy checks it. The app connects as a role that cannot bypass RLS.

## Limits and fallbacks

| Setting | Default | |
|---|---|---|
| `DAILY_TOKEN_BUDGET` | 300000 | per user per UTC day; 0 = unlimited |
| `RATE_LIMIT_PER_MINUTE` | 20 | chat turns per user |
| `LLM_FALLBACK_MODEL` | (none) | used when the main model is rate-limited or down; the answer is marked degraded |
| `SEARCH_FALLBACK_PROVIDER` | (none) | e.g. `tavily` when Exa fails |
| `EMBEDDING_MODEL` | `gemini-embedding-001` | hybrid recall (full text + vectors); empty = full text only |

If Redis is down the app keeps working: caches are skipped, limits are counted per process, and the worker picks up jobs from Postgres.

## Try the memory without waiting a week

Sign in as `demo`, or open **demo tools** (bottom left) and click **Load demo history** to load it into your own account. That writes three backdated conversations, dated relative to today: a CRM shortlist last Monday, a Node.js question on 3 November, and Postgres hosting prices last Tuesday. They are marked `[demo]` and their contents are illustrative.

You can also freeze the clock (demo tools, or `MINICHAT_FAKE_NOW` in `.env`) and load your own transcripts into your account:

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/auth/dev-login -H 'content-type: application/json' -d '{"username":"alice"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -X POST localhost:3000/api/import -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "tz": "Asia/Kolkata",
  "conversations": [{ "title": "Vector DBs", "messages": [
    { "role": "user", "text": "Compare Pinecone and Weaviate pricing", "created_at": "2026-11-02T10:00:00+05:30" },
    { "role": "assistant", "text": "Pinecone Standard starts at ...", "created_at": "2026-11-02T10:01:00+05:30" }
  ]}]
}'
```

## Developing without the app container

```bash
docker compose up -d postgres redis migrate    # databases + schema
npm install
npm run dev                                    # http://localhost:3000
npm run worker                                 # in another terminal
```

The defaults in `src/config.ts` point at the compose ports (Postgres 5433, Redis 6380), so `.env` only needs the API keys.

## Scripts

| Command | What it does |
|---|---|
| `npm test` | Unit tests (dates, auth, search gateway, limits) and, if the compose Postgres is up, the isolation tests |
| `npm run test:integration` | Two users in one database: neither can read, find, recall, change or delete the other's history |
| `npm run smoke` | End to end against the running stack: sign-in, isolation over HTTP, a real streamed turn, resume, the worker indexing it |
| `npm run eval` | The sample questions and edge cases against seeded history with a frozen clock, in a throwaway database; writes `eval-results.md` |
| `npm run migrate` | Apply `db/migrations` (idempotent) |
| `npm run seed -- --user alice` | Demo history for a dev user (`--drain` indexes it without a worker) |
| `npm run typecheck` | `tsc --noEmit` |

On a free-tier Gemini key (15 requests/minute) the eval pauses between scenarios; set `EVAL_PAUSE_MS=0` on a paid key.

## Load test

[Locust](https://locust.io) drives many simulated users through a load balancer in front of three app replicas. Each user signs in, imports their own backdated history (a CRM shortlist on Monday 9 Nov, Postgres hosting on Tuesday 10 Nov, a Node.js question on 3 Nov, each tagged with a secret per-user token), and then keeps asking the memory questions: "On Monday we shortlisted 5 CRM tools…", "Last Tuesday I asked you about Postgres hosting…", "What did I ask you on 3 November?", "What did I ask you on 20 October?". Every response is checked: the turn finished, recall picked the right date and this user's own turn, and no other user's token appears anywhere in the recall, the answer or the conversation list.

```bash
LT_USERS=300 LT_SPAWN_RATE=30 LT_DURATION=3m bash loadtest/run.sh
```

The LLM and web search are mocked (`loadtest/mock-llm.ts`, `SEARCH_PROVIDER=mock`) so the run costs nothing and stays clear of provider rate limits; the mock adds about 0.4 s per model round so latencies look like streaming. The clock is frozen at Wednesday 11 Nov 2026 so each date has one right answer. Results go to `loadtest/results/` (`correctness.json`, an HTML report, CSVs). The script also reports how long the worker takes to drain the extraction backlog afterwards.

Last run on a laptop (Docker Desktop, 3 app replicas, 2 workers × 16 consumers): 300 users, 14,806 chat turns at ~95 requests/s, **0 failures, 0 cross-user leaks**, every recall on the right date. p95: 0.66 s for "no record", 1.2–2.0 s for recall + web verification (mostly the mock's simulated model time). Backlog drained 31 s after the run.

## Layout

```
app/                      Next.js UI (page.tsx, login/) and API routes (chat SSE + resume + stop, conversations, import, seed, settings, auth, health)
src/agent/turn.ts         one turn end to end
src/agent/planner.ts      helper-model classification (cached), regex fallback
src/time/resolve.ts       "last Tuesday" -> dates (pure, tested)
src/agent/recall.ts       SQL-only memory retrieval (date range + full text + vectors, RRF) -> evidence bundle
src/agent/loop.ts         streaming tool loop (OpenAI-compatible, Gemini-aware), model fallback, token metering
src/search/               web_search tool, gateway (shared cache, coalescing, fallback), Exa / Tavily providers
src/memory/               post-turn extraction (digest + claims ledger + embedding), outbox + worker loop, import
src/auth/                 sessions, OIDC (code flow + PKCE, bearer tokens), dev sign-in
src/db/                   Postgres access as the current user (RLS), all SQL, migrations runner
src/redis.ts, budget.ts, stream.ts   Redis client, per-user limits, resumable SSE buffers
src/worker/main.ts        the worker process
db/migrations/            schema, indexes, row-level security policies
scripts/                  migrate, seed, eval, smoke
loadtest/                 Locust load test, mock LLM, nginx load balancer, compose overlay
```
