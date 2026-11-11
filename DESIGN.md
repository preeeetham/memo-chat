# Mini Chat: design

A chat agent with one tool, `web_search`, that also remembers what was said in past conversations, including what *it* answered and what the web said that day. The sample questions ("On Monday we shortlisted 5 CRMs… has pricing changed since?") are really four problems: resolve a date, recall the right exchange, re-check the web for what changed, and compare honestly. The design is built around those.

## How it works

```
POST /api/chat ──► 1 persist user msg ──► 2 planner (helper LLM, JSON, ≤2.5s, regex fallback)
                                          3 resolve dates in code ("last Tuesday" → 10 Nov | 3 Nov)
                                          4 recall in SQL (date filter + FTS5/BM25) → evidence bundle [M1..]
                   ◄── SSE: status, memory ◄─┘
                                          5 main LLM loop, streaming; web_search ≤4 rounds, queries in parallel
                   ◄── SSE: text, sources ◄─┘   every result stored with its excerpt + hash  [S1..]
                                          6 persist answer + extraction job in one transaction (outbox)
                                          7 after the reply: extract digest + claims ledger (helper LLM)
```

**Recall** runs before the model, deterministically. Each relative date becomes ranked candidate ranges ("last Tuesday" asked on a Wednesday is 10 Nov, then 3 Nov). For each candidate, turns on that local date are ranked by BM25 over raw messages, turn digests and the claims ledger, using the planner's topic keywords. If both candidates match, the bundle is marked `ambiguous`; if one matches, it wins (so "last Tuesday you told me about Node.js" lands on 3 Nov, not 10 Nov); if nothing matches it widens by a day, then returns `none` with the span of history it does have. The bundle always quotes the **raw** question and answer (summaries only help find turns) plus the recorded claims and, for prices, the page text seen at the time.

**Search** is one tool with `queries[] (≤5, run in parallel)`, `since`, `domains`, `read_pages`. The prompt pushes the model to decompose per vendor, set `since` for "changed since X", and read the vendor's own pricing page (`domains` + `read_pages`, which also asks Exa for a fresh crawl). Results get turn-stable ids `[S1]..`, publish and retrieval dates, and are persisted (`search_calls`, `web_evidence`).

**Verification** compares recorded claims (`subject | attribute | value | seen on | source`) with today's evidence and labels each item *still correct [S#]*, *changed old → new [S#]*, or *couldn't verify*. "No announcement found" is never reported as "unchanged".

## Why this shape

- **Memory is not a second tool.** The rules allow one tool, and a recall tool would add a model round trip on exactly the questions that need to be fast. Pre-retrieval is SQL (~10 ms) and testable.
- **Dates are resolved in code, not by the model.** Timezone-correct local dates, 41 unit tests (weekday-is-today, year rollover, a UTC instant that is "tomorrow" in Kolkata). The resolved date is said back to the user.
- **The agent remembers its own claims and the evidence text.** "Is your answer still correct?" needs what was answered and what the page said then, not only the user's words. Claims link to the exact `web_evidence` row they cite.
- **Append-only history.** Each turn's API messages (tool calls, Gemini thought signatures, the context note) are stored and replayed unchanged: correct for multi-turn tool use and friendly to prefix caching. The static system prompt holds nothing time-dependent.
- **Never block on memory work.** Extraction runs after the reply from a durable SQLite `jobs` table (written in the same transaction as the answer), with retries and rate-limit backoff. Until it runs, recall still finds the turn through FTS on raw messages.
- **Provider-agnostic LLM.** Any OpenAI-compatible endpoint (Gemini by default). A planner failure or timeout falls back to regex rules: a turn never fails because a helper did.

## Considered and rejected

| Option | Why not |
|---|---|
| Vector DB / embeddings + RRF | Every sample question is date-anchored; a date filter + BM25 finds the turn. Embeddings add a second index and fusion step with no measured gain at this size. |
| Provider "grounded" search (Gemini Google Search, Anthropic server search) | No publish-date filter we control, and we can't store the page text we relied on, which "has it changed since?" depends on. |
| Memory as a tool | Breaks the one-tool rule and costs an extra model round trip. |
| LangChain-style frameworks | More surface than the problem; the loop is ~150 lines. |
| Postgres | Needs setup for reviewers; SQLite + FTS5 is zero-setup and transactional. |
| Entity graph, RAPTOR summaries, bitemporal model | Premature here. A claims ledger with `observed_at` + `published_at` is the useful part. |

## With another week

1. Hybrid recall (FTS + `sqlite-vec` embeddings) once evals show paraphrase misses ("sales software" vs "CRM").
2. Watchers: re-check shortlisted vendors daily and diff stored page snapshots, so "has it changed?" is answered from a timeline, not one fresh fetch.
3. A larger eval set (50+ backdated scenarios) with regression tracking per prompt change; LLM-judge calibrated against hand labels.
4. Multi-user auth with tenant isolation enforced in SQL, then Postgres + pgvector; retention and deletion policies.
5. Speed: cache planner output for near-identical messages, stream the first search status before the planner returns, and pick a larger main model for verify turns where the answer quality matters most.
