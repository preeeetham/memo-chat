# Memo Chat: design

A chat agent with one tool, `web_search`, that also remembers what was said in each user's past conversations, including what *it* answered and what the web said that day. The sample questions ("On Monday we shortlisted 5 CRMs… has pricing changed since?") are really four problems: resolve a date, recall the right exchange, re-check the web for what changed, and compare honestly. The design is built around those.

## How it works

```
POST /api/chat ──► 0 verify session/JWT → user_id; per-user rate limit, optional daily token budget (Redis)
                   1 persist user msg (as user_id: RLS)
                   2 planner (helper LLM, JSON, ≤5s, cached per user in Redis, regex fallback)
                   3 resolve dates in code ("last Tuesday" → 10 Nov | 3 Nov)
                   4 recall in SQL (date filter + full text + pgvector, fused with RRF) → evidence bundle [M1..]
  ◄── SSE: status, memory ─┘           (every event also appended to a Redis stream: resumable)
                   5 main LLM loop, streaming; web_search ≤4 rounds, queries in parallel,
                     through the search gateway (shared cache, coalescing, provider fallback);
                     model fallback when the main model is down (answer marked degraded)
  ◄── SSE: text, sources ─┘            every result stored with its excerpt + hash  [S1..]
                   6 persist answer + outbox row in one transaction → publish job id to a Redis stream
                   7 worker (separate process): extract digest + claims ledger + embedding, as that user
```

**Recall** runs before the model, deterministically. Each relative date becomes ranked candidate ranges ("last Tuesday" asked on a Wednesday is 10 Nov, then 3 Nov). For each candidate, turns on that local date are ranked by reciprocal rank fusion over Postgres full text (raw messages, turn digests, the claims ledger, using the planner's topic keywords) and, when `EMBEDDING_MODEL` is set, vector similarity over turn digests above a minimum similarity (so "sales software" can find "CRM"). If both candidates match, the bundle is marked `ambiguous`; if one matches, it wins (so "last Tuesday you told me about Node.js" lands on 3 Nov, not 10 Nov); if nothing matches it widens by a day, then returns `none` with the span of history it does have. The bundle always quotes the **raw** question and answer (summaries only help find turns) plus the recorded claims and, for prices, the page text seen at the time.

**Search** is one tool with `queries[] (≤5, run in parallel)`, `since`, `domains`, `read_pages`. The prompt pushes the model to decompose per vendor, set `since` for "changed since X", and read the vendor's own pricing page (`domains` + `read_pages`, which also asks Exa for a fresh crawl). Results get turn-stable ids `[S1]..`, publish and retrieval dates, and are persisted (`search_calls`, `web_evidence`).

**Verification** compares recorded claims (`subject | attribute | value | seen on | source`) with today's evidence and labels each item *still correct [S#]*, *changed old → new [S#]*, or *couldn't verify*. "No announcement found" is never reported as "unchanged".

## Why this shape

- **Memory is not a second tool.** The rules allow one tool, and a recall tool would add a model round trip on exactly the questions that need to be fast. Pre-retrieval is SQL (~10 ms) and testable.
- **Dates are resolved in code, not by the model.** Timezone-correct local dates, 41 unit tests (weekday-is-today, year rollover, a UTC instant that is "tomorrow" in Kolkata). The resolved date is said back to the user.
- **The agent remembers its own claims and the evidence text.** "Is your answer still correct?" needs what was answered and what the page said then, not only the user's words. Claims link to the exact `web_evidence` row they cite.
- **Append-only history.** Each turn's API messages (tool calls, Gemini thought signatures, the context note) are stored and replayed unchanged: correct for multi-turn tool use and friendly to prefix caching. The static system prompt holds nothing time-dependent.
- **Never block on memory work.** Extraction runs in a separate worker process. The job row is written in the same transaction as the answer (an outbox), its id is published to a Redis stream for low latency, and the worker claims it with an atomic `UPDATE` (so a job published twice runs once). A sweep every few seconds claims anything the stream missed (Redis down, crash, backoff, expired lease). Five attempts, then the job is kept as `failed` (dead letter). Until it runs, recall still finds the turn through full text on raw messages.
- **Tenant isolation in the database, not in every query.** Every user-owned table leads with `user_id` in its primary key and indexes and has a row-level security policy `user_id = current_setting('app.user_id')`. The app sets that per transaction from the verified token (via AsyncLocalStorage, so no repo function takes a user id) and connects as a role with no `BYPASSRLS`; with the setting unset, nothing is visible. `user_id` defaults to the setting, and composite foreign keys `(user_id, conversation_id)` stop writes into someone else's conversation. The worker runs each job as its user. Redis keys are prefixed `u:<user_id>:`; only public web search results are cached across users.
- **Stateless app.** Nothing a turn needs lives in process memory: SSE events are buffered in Redis (resume with `Last-Event-ID` on any instance), Stop goes through Redis, limits are counted in Redis. A turn keeps running if the client disconnects, so its answer is saved.
- **Redis is an accelerator.** If it is down, caches are skipped, limits fall back to per-process counters, and the worker's Postgres sweep still runs every job.
- **Provider-agnostic LLM.** Any OpenAI-compatible endpoint (Gemini by default). A planner failure or timeout falls back to regex rules: a turn never fails because a helper did.

## Considered and rejected

| Option | Why not |
|---|---|
| A separate vector DB | pgvector in the same Postgres keeps vectors under the same row-level security and in the same transaction as the digest. Vectors are optional and only add hits above a similarity floor, so date-anchored recall behaves as before. |
| Provider "grounded" search (Gemini Google Search, Anthropic server search) | No publish-date filter we control, and we can't store the page text we relied on, which "has it changed since?" depends on. |
| Memory as a tool | Breaks the one-tool rule and costs an extra model round trip. |
| LangChain-style frameworks | More surface than the problem; the loop is ~150 lines. |
| Staying on SQLite | One writer, no row-level security, no replicas. `docker compose up` makes Postgres as easy to start. |
| A full IdP in the compose file (Keycloak, Dex) | Heavy for a demo. Dev sign-in by default; any OIDC provider with three env vars. |
| Kafka / SQS for the queue | A Redis stream plus the Postgres outbox gives the same guarantees at this size, with one fewer service. |
| Entity graph, RAPTOR summaries, bitemporal model | Premature here. A claims ledger with `observed_at` + `published_at` is the useful part. |

## Scaling beyond one machine

The compose file is the single-region, single-shard version of the multi-user architecture. What is code today and what stays design:

| Piece | Here | At scale |
|---|---|---|
| Identity | OIDC code flow + bearer JWTs, `sub` → `user_id` | same; JWKS verified at the gateway, org ids for org-level quotas |
| App tier | stateless Next.js, `--scale app=N` | Kubernetes, autoscaled on concurrent streams |
| Isolation | RLS on every table, non-bypass role | same, plus per-tenant KMS keys for archives, audit log |
| Data | one Postgres, `(user_id, …)` keys and indexes | sharded by `user_id` (Citus or app routing) behind PgBouncer; recall on read replicas; messages partitioned by month |
| History tiers | all hot | hot 90 days, warm partitions to 18 months, cold raw history in S3 (digests, claims and embeddings stay hot) |
| Queue | outbox + Redis stream + sweep | outbox relayed by CDC to Kafka/SQS partitioned by `user_id`, KEDA-scaled workers, priority lanes |
| LLM | fallback model, per-user rate limit, optional per-user token budget | LLM gateway: global TPM governor, multi-region failover, prompt caching, cost metering |
| Search | shared query cache, coalescing, fallback provider | page snapshot cache, per-provider rate limits and spend budgets |
| Regions | one | users homed to a region with their shard; active-active app tier |
| Observability | structured logs, per-turn timings in `meta_json` | OpenTelemetry traces per turn, SLO alerts (p95 TTFT, queue lag, fallback rate) |

## With another week

1. Embed claims as well as digests, and tune the similarity floor against a paraphrase eval set.
2. Watchers: re-check shortlisted vendors daily and diff stored page snapshots, so "has it changed?" is answered from a timeline, not one fresh fetch.
3. A larger eval set (50+ backdated scenarios) with regression tracking per prompt change; LLM-judge calibrated against hand labels.
4. Retention and deletion policies (GDPR export/delete by `user_id`; deleting a user already cascades), and moving the demo clock to a per-user setting.
5. Speed: cache planner output for near-identical messages, stream the first search status before the planner returns, and pick a larger main model for verify turns where the answer quality matters most.
