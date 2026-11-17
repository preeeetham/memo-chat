# Memo Chat: project journey

How Memo Chat went from a challenge brief to a multi-user, Docker-packaged chat agent: the research we started from, each decision and the reason for it, where the build stands today, and what comes next.

`DESIGN.md` is the one-page design the challenge asks for. This file is the longer story behind it.

---

## 0. The brief

Project Minimi (projectminimi.com) asked for **a chat agent with exactly one tool, web search, "as good as the best ones on the internet today."** The rules: JavaScript or TypeScript on Node, runs with `npm install` then `npm run dev`, every key listed in `.env.example`, a public GitHub repo, and a one-page `DESIGN.md`. Judging is on architecture: answers fast, gets things right, good to talk to. "Not the most features."

The three sample questions set the real problem:

- "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
- "What did I ask you on 3 November? Is your answer still correct today?"
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"

Each one has the same shape:

1. Resolve a relative date ("Monday", "last Tuesday") in the user's timezone.
2. Recall what was said that day, **including what the agent answered and what the web said then**.
3. Search the web for what changed since that date, from primary sources.
4. Compare old with new, item by item, honestly: changed, still correct, or couldn't verify.
5. Say so plainly when there is no record, instead of making one up.

So this is less a "chatbot with search" and more a **memory-plus-verification agent**. That reading drove almost every decision below.

---

## 1. Initial research (before writing code)

### 1.1 What we started with

The starting research was an enterprise memory architecture with four tiers:

| Tier | Contents |
|---|---|
| Episodic | Raw messages, stored once, append-only: the source of truth |
| Semantic | Extracted facts, decisions, entities, deduplicated and linked to source messages |
| Retrieval | Selective embeddings, full-text index, RAPTOR-style hierarchical summaries |
| Working | Only the evidence needed for this question, compressed into a bundle |

Around it: tenants, partitioning, hot/warm/cold storage, entity resolution, vector search fused with RRF, a bitemporal fact model, an outbox and async queue, and a progressive scaling table from 10K to 1M+ users. It also pointed to the Mem0 paper as a reference.

### 1.2 What we checked it against

We reviewed it against the brief, the sample questions and the current tooling:

- **Search APIs:** Exa, Tavily, Brave and Perplexity, plus the built-in web search in model APIs.
- **Memory benchmarks:** LongMemEval (temporal reasoning and knowledge updates are where chat memory usually fails).
- **Model API docs** for streaming, tool use and structured output.

### 1.3 Verdict

**The memory principles were right, the scope was wrong, and the half of the problem the sample questions actually test was missing.**

Kept from the research:

- Raw messages stored once as the source of truth.
- Summaries and extracted facts only help *find* things. Before making any claim about the past, go back to the original message.
- Facts linked to the message (and web page) they came from.
- A compact evidence bundle for the model instead of dumping 40 messages.
- Memory processing runs after the reply, so the user never waits for it.
- "Never sacrifice historical accuracy for compression."

Cut for the first version (and written up under "at scale" instead):

| Researched item | Why we cut it |
|---|---|
| Tenants, sharding, storage tiers, legal hold | One local user at first. A `user_id` column shows it's tenant-ready. |
| Vector index + RRF | Every sample question is pinned to a date. A date filter plus full-text search finds the right turn. (Vectors came back later, see 3.6.) |
| Entity graph, deduplication | A per-turn "claims ledger" (subject, attribute, value, date seen, source) covers it. |
| RAPTOR summaries | Histories are tiny. One digest per turn is the whole hierarchy. |
| Full bitemporal model | Two timestamps per fact are enough: when we saw it, and when the source says it was published. |
| Distributed queue | A jobs table drained in-process gives the same durability guarantee at this size. |

Missing, and where the points are:

1. **A strong search agent:** split questions into parallel queries, filter by publish date, read the vendor's own pricing page, cite sources, cap the number of search rounds.
2. **Date resolution in code**, timezone-aware, unit-tested, and said back to the user ("last Tuesday (10 Nov)").
3. **Remembering the agent's side**: what it answered and what the web said that day.
4. **Respecting the one-tool rule**: memory must not become a second tool.
5. **Honest answers**: "no record from 3 Nov", and never "unchanged" just because no announcement turned up.
6. **Speed and feel**: streaming, visible status, a fast path for small talk.
7. **Evals and a way to test**: backdated seed data, a fixed clock, a scripted run of the sample questions.

The full assessment and build spec are in `PLAN.md`; the first diagram is `architecture.excalidraw`.

---

## 2. Key decisions and why

### 2.1 Memory recall runs before the model, not as a tool

**Decision:** recall is plain SQL that runs before the model is called. Its result is passed in as a context note with records tagged `[M1]`, `[M2]`.

**Why:** the rules allow one tool. A recall tool would also add a full model round trip on exactly the questions that need to be fast. SQL recall takes about 10 ms and can be unit-tested.

### 2.2 Dates are resolved in code, not by the model

**Decision:** a pure function turns "Monday", "last Tuesday", "3 November", "two weeks ago" into ranked candidate date ranges in the user's timezone, using `chrono-node` and `date-fns`.

**Why:** models are unreliable at calendar arithmetic, and a wrong date makes every later step wrong. In code it is deterministic and testable: 41 tests cover cases like today being the named weekday, year rollover, and a UTC instant that is already "tomorrow" in Kolkata. Ambiguity is handled explicitly: "last Tuesday" yields two candidates, and the topic decides which one matches.

### 2.3 The agent remembers its own answers and the evidence it saw

**Decision:** store every search call, every result excerpt the model read (with a hash), and a **claims ledger** extracted after each turn, for example "Neon Launch plan: $5/month minimum, seen 10 Nov, source neon.com/pricing".

**Why:** "Is your answer still correct?" and "has pricing changed?" can't be answered from the user's words alone. You need the old value and the page it came from.

### 2.4 Our own `web_search` tool on Exa, not built-in "grounded" search

**Decision:** one `web_search` tool with `queries[]` (up to 5, run in parallel), `since`, `domains` and `read_pages`, backed by Exa, with Tavily as a fallback behind the same interface.

**Why:** the built-in search in model APIs has no publish-date filter we control, and it doesn't hand back page text we can store. "Has it changed since Monday?" depends on both. Exa gives a published-date filter, full text and a freshness control.

### 2.5 Honesty rules in the prompt

**Decision:** report each item as *still correct*, *changed (old → new)*, or *couldn't verify*, with citations `[S#]` and past records `[M#]`. Say "no record" with the span of history we do have.

**Why:** the judges will ask about dates with no history. A confident made-up answer is the worst outcome. "No announcement found since 9 Nov" is not the same as "unchanged".

### 2.6 Gemini through an OpenAI-compatible endpoint

**Decision:** the first plan named Anthropic models. At build time we switched to **Gemini (`gemini-3.5-flash-lite`)** through Google's OpenAI-compatible endpoint, with the provider, model and base URL all set in `.env`.

**Why:** it was the API available to us. Keeping the client provider-agnostic means any OpenAI-compatible model works with no code change.

**Trade-off:** the free tier allows about 15 requests a minute, and a verify question uses around 5. So the planner falls back to regex rules when it times out or fails, 429s are retried with backoff and shown to the user as a clear "rate-limited, try again" message, and the load test uses a mocked model.

### 2.7 SQLite first, then Postgres

**Decision:** version 1 used SQLite with FTS5 in a single file. Version 2 moved to Postgres with pgvector.

**Why:** SQLite meant zero setup for `npm run dev`, which the rules require. When we designed for many users, SQLite's single writer, lack of row-level security and lack of replicas became the limit. Docker Compose made Postgres just as easy to start, so the original reason for SQLite went away.

### 2.8 Planner on a small helper call, with a fallback

**Decision:** a quick structured-output call classifies the turn (chat, lookup, recall, recall-and-verify, research) and pulls out time expressions, topic keywords and entities. Greetings skip it entirely.

**Why:** it lets recall and search be targeted, and small talk stays fast. If it fails or times out, regex rules take over, so a turn never fails because a helper did.

### 2.9 Background extraction with an outbox

**Decision:** the answer and its extraction job are written in one transaction. A worker processes the job afterwards: a turn digest, claims and an embedding.

**Why:** the user never waits for memory work, and a saved answer can't lose its indexing job. Until the job runs, recall still finds the turn through full-text search on the raw messages.

### 2.10 Testing built in from the start

**Decision:** backdated demo history (Node.js on 3 Nov, CRMs on Mon 9 Nov, Postgres on Tue 10 Nov), an import endpoint, a fake clock, and an eval script that runs the sample questions plus no-record, ambiguous and no-memory cases.

**Why:** judges can't wait a week to see recall work, and "how you think" shows best in how you test.

---

## 3. How the build evolved

### 3.1 Version 1: single-user agent (11–12 Nov)

- Next.js + TypeScript, SQLite with FTS5, Gemini, Exa.
- Date resolver with 41 passing tests.
- Streaming chat UI: conversations grouped by date, status line, recalled-conversation chips, source list.
- Eval: 28/32 checks with offline search on the first run. It caught an empty-answer bug, which we fixed.
- Live check on the Mac: "Last Tuesday I asked you about Postgres hosting…" found the Tue 10 Nov conversation, read the real pricing pages on neon.tech, supabase.com and aws.amazon.com, and correctly reported that Neon's Launch plan had changed while Supabase and RDS had not. It took about 28 seconds.

### 3.2 Stress tests (12 Nov)

About 40 adversarial conversations in `STRESS_TESTS.md`, written from the code. The ones most likely to break it:

- "Two weeks ago…" covers a range that the one-day widening can miss.
- Paraphrases with no date ("which database host did we decide on?") miss keyword-only search.
- Changed decisions ("Supabase instead of Neon"): the ledger never retires old facts.
- "Forget everything about Neon": nothing can be deleted yet.
- Long chats: only the last 10 turns are replayed.
- Instructions planted in stored web page text.
- More vendors than the 5-queries × 4-rounds search budget allows.

These directly shaped later work: the paraphrase gap is why vector search came back in version 2.

### 3.3 Published (16 Nov)

Pushed to the public repo **github.com/preeeetham/memo-chat** after a full history scan: `.env`, the database and build output were never committed, and no keys were found.

### 3.4 Designing for many users (16 Nov)

`architecture-scaled.excalidraw` lays out the many-user version:

- OIDC login, JWT carrying `user_id`.
- Postgres row-level security on every table, with `(user_id, local_date)` indexes, so "what did I ask on Monday" is a small indexed lookup on that user's rows only.
- A stateless API tier, with streams buffered in Redis so a dropped connection can resume on any instance.
- An outbox, queue and workers for extraction.
- An LLM gateway with per-user token budgets, priority for live answers, and model fallback. A shared search cache and Exa → Tavily fallback.
- Hot / warm / cold history, with summaries kept hot so old history is still found.

### 3.5 Version 2: multi-user build with Docker (16 Nov)

The goal was that anyone cloning the repo needs only two API keys:

```
cp .env.example .env    # add LLM_API_KEY and EXA_API_KEY
docker compose up --build
```

That brings up Postgres, Redis, migrations, demo history, the app and the worker. Sign in as `demo` at localhost:3000.

Key choices in this version:

| Choice | Why |
|---|---|
| Isolation enforced by Postgres row-level security, app role without `BYPASSRLS` | Isolation lives in the database, not in every query. With no user set, nothing is visible. |
| User id set per transaction from the verified token | No repository function takes a user id, so none can pass the wrong one. |
| Composite foreign keys `(user_id, conversation_id)` | Stops writes into someone else's conversation. |
| Redis for caches, rate limits, budgets and resumable streams, keys prefixed per user | Keeps the app stateless. Only public search results are shared across users. |
| Redis treated as an accelerator | If Redis is down, caches are skipped and the Postgres sweep still runs every job. |
| Outbox + Redis stream + periodic sweep instead of Kafka/SQS | Same guarantees at this size, one fewer service. |
| pgvector in the same Postgres, not a separate vector DB | Vectors sit under the same row-level security and in the same transaction. |
| Dev username sign-in by default, any OIDC provider with three env vars | A full identity provider in the compose file is heavy for a demo. |

**Recall in version 2:** date filter first, then reciprocal rank fusion over full text (raw messages, digests, claims) and vector similarity on digests above a minimum score. So "sales software" can find "CRM" without vectors overriding the date.

### 3.6 Test results for version 2

| Test | Result |
|---|---|
| Unit + cross-user isolation tests | 63 / 63 pass |
| End-to-end smoke on the running stack | 16 / 16 pass |
| Fresh clone with only two keys | Comes up clean. Found and fixed a `.env.example` bug where inline comments were read as values. |
| Redis outage | App keeps working |
| Eval with real Gemini | 30 / 32. Every date and recall check passed. The two misses were the automated grader's own judgments (one CRM answer cut off mid-reply, and a "Node.js 26" version it wrongly flagged as made up). |
| Locust load test, mocked LLM and search | 300 users across 3 app instances behind a load balancer, about 95 requests/s, 14,806 memory questions: 0 failures, every recall picked the right date and the user's own turn, **0 cross-user leaks**. p95: 0.66 s for "no record", 1.2–2.0 s for recall plus a web check. |

The load test also found that one worker couldn't keep up with 50+ turns a second. It now runs several jobs at once, and the backlog cleared 31 seconds after the run.

### 3.7 UI redesign (16 Nov)

Restyled in the spirit of projectminimi.com (white canvas, Roboto, black buttons, soft grey cards, one orange accent) without copying their logo or assets. The UI now makes the differentiators visible:

- A sign-in page with a headline, short pitch and an example recalled answer.
- Each answer opens with a small panel: how the date was read ("Last Tuesday" → Tue 10 Nov), which past conversation was recalled (click to open), and a "since Tue 10 Nov → today" count such as "1 changed, 2 still correct".
- Coloured badges for *Changed*, *Still correct* and *Couldn't verify*.
- Source cards, cited ones first.
- Works on phones and in dark mode.

Before and after screenshots are in the project files.

---

## 4. Where we are now

| Item | Status |
|---|---|
| `main` on GitHub | Version 1, the single-user SQLite build |
| `multi-user` branch | Version 2 (Postgres, auth, Redis, worker, Docker, load test) plus the UI redesign, 5 commits. Pushed to GitHub on 16 Nov, **not yet merged into `main`**. |
| `STRESS_TESTS.md` | On the Mac, deliberately kept out of git |
| `DESIGN.md` | Written for version 2, including "considered and rejected" and "with another week" |
| Submission | Not yet submitted through the application form |

Before submitting:

1. Merge `multi-user` into `main` (or open a PR and merge it), so the public default branch shows the best version.
2. Check that the README quick start (`docker compose up --build`) is the first thing a reviewer sees, and that `npm install && npm run dev` still works as the rules require.
3. Submit the repo link through the form.

Known limits today:

- **Verify questions are slow:** about 16–30 s to first text in the eval on Gemini's free tier, against a target of under 12 s. Most of that is rate limits and model latency, not our code.
- The stress-test gaps that are still open: changed decisions aren't retired from the claims ledger, nothing can be deleted on request, only the last 10 turns are replayed, and broad ranges like "two weeks ago" can miss by more than a day.

---

## 5. Future scope

**Answer quality**

- Retire or supersede claims when the user changes a decision ("we went with Supabase instead"), so recall returns the latest decision with its history.
- Embed claims as well as digests, and tune the similarity floor on a paraphrase eval set.
- Summarise older turns of long conversations instead of dropping everything before the last 10.
- Wider date windows for fuzzy phrases ("a couple of weeks ago").
- Treat stored web text strictly as data, with tests for planted instructions.

**Speed**

- A paid or higher-tier model key, and a larger main model only for verify turns.
- Send the first search status before the planner returns; cache planner output for near-identical messages.
- Prompt caching on the static system prompt.

**Change tracking**

- Watchers that re-check shortlisted vendors daily and diff stored page snapshots, so "has it changed?" is answered from a timeline, not a single fresh fetch.

**Trust and data control**

- "Forget X" and full delete/export per user (GDPR-style). Deleting a user already cascades.
- Retention policies, and moving the demo clock to a per-user setting.

**Evaluation**

- 50+ backdated scenarios, tracked per prompt change, with the LLM judge calibrated against hand labels.

**Scale** (designed, not built; see `DESIGN.md`)

- Postgres sharded by `user_id` behind PgBouncer, recall on read replicas, monthly partitions.
- Hot / warm / cold history with raw chats over 18 months in object storage.
- Kafka or SQS partitioned by user, autoscaled workers, priority lanes.
- An LLM gateway with a global token governor, multi-region failover and cost metering.
- Users homed to a region, OpenTelemetry traces per turn, and SLO alerts on first-token time, queue lag and fallback rate.

---

## Source files

| File | What it is |
|---|---|
| `PLAN.md` | Research assessment and the original build spec |
| `architecture.excalidraw` | Version 1 architecture |
| `architecture-scaled.excalidraw` | Many-user architecture |
| `STRESS_TESTS.md` | ~40 adversarial test conversations |
| `DESIGN.md` | One-page design for the submission |
| `eval-results.md` | Latest eval run |
| `loadtest/` | Locust test, mock LLM and results |
