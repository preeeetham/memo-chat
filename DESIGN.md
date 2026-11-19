# Memo Chat: design

A chat agent with one tool, `web_search`, that remembers each user's past conversations: what they asked, what it answered, what the web said that day, and when. The sample questions ("Last Tuesday I asked about Postgres hosting. Has pricing changed since?") are four problems in one: read the date, find the right past exchange, check the web for what changed, and compare honestly. The design is built around those four.

## How it works

```
POST /api/chat
  1 verify the session -> user_id; per-user rate limit (Redis)
  2 planner (small model, JSON, 5 s budget, regex fallback): task, time phrases, topic keywords
  3 dates resolved in code, in the user's timezone: "last to last Tuesday" -> 10 Nov, then 3 Nov
  4 recall in SQL, no model call: date filter, then full text + pgvector fused with RRF -> [M1]..
       date and topic disagree -> topic first, judged by confidence: answer / ask "did you mean..." / no record
  5 streaming agent loop; web_search (<= 5 parallel queries, publish-date and domain filters) -> [S1]..
  6 answer + indexing job saved in one transaction (outbox) -> Redis stream
  7 worker: digest, embedding and a claims ledger (subject | attribute | value | seen on | source)
```

Every streamed event is buffered in Redis, so a dropped connection resumes where it left off. The worker runs after the reply, so memory work never slows an answer.

**Verification.** Recalled claims are checked against today's search results and labelled *still correct [S#]*, *changed old -> new [S#]* or *couldn't verify*. "No announcement found" is never reported as "unchanged". A claim a later chat changed ("we went with Supabase instead") is marked superseded and shown as history, not as current.

**Isolation.** Every table leads with `user_id` and has a row-level security policy. The app connects as a role that cannot bypass it and sets the user per transaction from the verified token, so no query can see another user's rows.

## Why this shape

- **Memory is not a tool.** The rules allow one tool, and a recall tool costs an extra model round trip on exactly the questions that must be fast. Recall is SQL (about 10 ms), deterministic and unit-tested.
- **Dates in code, not in the model.** Models are unreliable at calendar arithmetic, and a wrong date breaks everything after it. A tested resolver covers weekdays further back, weeks, months, quarters, years, ranges, day-first numeric dates and fixed holidays. The planner only guesses for movable holidays and seasons, and its guess is validated. The date used is shown back to the user.
- **Topic first when the date is off.** People misremember dates. When nothing on the named day matches, the indexed full-text and vector lookups find the topic, and their dates are read off the matches. Confident: answer and say the real date. Unsure: ask. Nothing: say so.
- **The agent remembers its own side.** "Is your answer still correct?" needs what was answered and what the page said then, so answers, search results, page excerpts and a claims ledger are stored, linked to each other.
- **Our own search tool, not built-in grounding.** We need publish-date filters and page text we can store and compare later.
- **Stateless app, Redis as an accelerator.** Streams, Stop and limits go through Redis, so any instance can serve any request. If Redis is down, caches are skipped and the worker's Postgres sweep still runs every job.
- **Append-only history.** Each turn's API messages are replayed unchanged, which is correct for multi-turn tool use and friendly to prompt caching. Long chats get a digest of the turns older than the replay window.

## Considered and rejected

| Option | Why not |
|---|---|
| Memory as a second tool | Breaks the one-tool rule and adds a model round trip. |
| A separate vector database | pgvector keeps vectors under the same row-level security and in the same transaction as the digest. |
| Provider "grounded" search | No publish-date filter we control, and the page text can't be stored for later comparison. |
| Letting the model resolve dates | Wrong on weekday arithmetic and timezones often enough to break recall. |
| Branching on message edits | Answers the user removed would still be recallable. Edits truncate and regenerate, and remove everything derived from the dropped turns. |
| Agent frameworks | More surface than the problem needs; the loop is about 150 lines. |
| SQLite | One writer and no row-level security. Docker makes Postgres just as easy to start. |
| Kafka or SQS | An outbox plus a Redis stream gives the same guarantees at this size, with one fewer service. |

## With another week

1. **Speed on verify questions.** 16–30 s to first text on the free Gemini tier, against a 12 s target. Stream the first search status before the planner returns, cache planner output for near-identical messages, and use a larger model only for verify turns.
2. **Watchers.** Re-check shortlisted vendors daily and diff stored page snapshots, so "has it changed?" is answered from a timeline, not a single fresh fetch.
3. **A larger eval set.** 50+ backdated scenarios covering every date phrase and the confidence tiers, with regression tracking per prompt change and an LLM judge calibrated against hand labels.
4. **Tune recall confidence.** Calibrate the similarity thresholds on a paraphrase set, and embed claims as well as digests.
5. **Accounts and data.** Password reset and email verification, full export and delete of a user's data, and the sharded, multi-region layout in `docs/architecture-scaled.png` once the user count calls for it.
