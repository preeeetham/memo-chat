# Mini Chat

A chat agent with one tool, web search, that remembers your past conversations. Ask it "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" and it works out which Tuesday you mean, finds what it told you then, re-checks the vendors' own pricing pages, and reports per item what changed, with sources and dates.

See [DESIGN.md](DESIGN.md) for how it works and why.

## Run it

Requires Node 22+.

```bash
cp .env.example .env     # add LLM_API_KEY and EXA_API_KEY
npm install
npm run dev              # http://localhost:3000
```

Keys:

| Key | Where to get it |
|---|---|
| `LLM_API_KEY` | Any OpenAI-compatible endpoint. Defaults are for Gemini: a key from [Google AI Studio](https://aistudio.google.com/apikey). |
| `EXA_API_KEY` | [exa.ai](https://exa.ai) (free tier works). Or set `SEARCH_PROVIDER=tavily` and `TAVILY_API_KEY`. |

If a key is missing the app still starts and tells you what to fill in.

## Try the memory without waiting a week

Open **demo tools** (bottom left) and click **Load demo history**, or run `npm run seed`. That writes three backdated conversations, dated relative to today in your timezone: a CRM shortlist last Monday, a Node.js question on 3 November, and Postgres hosting prices last Tuesday. They are marked `[demo]` and their contents are illustrative. Then ask the suggested questions on the start screen.

You can also freeze the clock (demo tools, or `MINICHAT_FAKE_NOW` in `.env`) and load your own transcripts:

```bash
curl -X POST localhost:3000/api/import -H 'content-type: application/json' -d '{
  "tz": "Asia/Kolkata",
  "conversations": [{ "title": "Vector DBs", "messages": [
    { "role": "user", "text": "Compare Pinecone and Weaviate pricing", "created_at": "2026-11-02T10:00:00+05:30" },
    { "role": "assistant", "text": "Pinecone Standard starts at ...", "created_at": "2026-11-02T10:01:00+05:30" }
  ]}]
}'
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | App + API on one port |
| `npm test` | Unit tests (date resolution, timezone edges) |
| `npm run seed` | Load demo history into `./data/minichat.db` |
| `npm run eval` | Run the sample questions and edge cases against seeded history with a frozen clock in a temp DB; writes `eval-results.md` |
| `npm run typecheck` | `tsc --noEmit` |

On a free-tier Gemini key (15 requests/minute) the eval pauses between scenarios; set `EVAL_PAUSE_MS=0` on a paid key.

## Layout

```
app/                      Next.js UI (page.tsx) and API routes (chat SSE, conversations, import, seed, settings)
src/agent/turn.ts         one turn end to end
src/agent/planner.ts      helper-model classification, regex fallback
src/time/resolve.ts       "last Tuesday" -> dates (pure, tested)
src/agent/recall.ts       SQL-only memory retrieval -> evidence bundle
src/agent/loop.ts         streaming tool loop (OpenAI-compatible, Gemini-aware)
src/search/               web_search tool, Exa / Tavily providers, evidence persistence
src/memory/               post-turn extraction (digest + claims ledger), durable job queue, import
src/db/                   schema (SQLite + FTS5) and all SQL
scripts/                  seed, eval
```
