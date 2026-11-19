/**
 * All SQL lives here. Small, explicit functions; no ORM.
 * Every function runs as the current user (see db/index.ts): row-level security scopes each query,
 * so none of them filters by user_id itself, and none can reach another user's rows.
 */
import { createHash } from "node:crypto";
import { newId } from "../ids";
import { currentUserId, q, tx } from "./index";

export type ConversationRow = { id: string; title: string | null; created_at: string; updated_at: string };
export type MessageRow = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  text: string;
  content_json: string;
  created_at: string;
  tz: string;
  local_date: string;
  reply_to: string | null;
  meta_json: string | null;
};
export type TurnRow = {
  assistant_id: string;
  user_id_msg: string;
  conversation_id: string;
  conversation_title: string | null;
  local_date: string;
  created_at: string;
  question: string;
  answer: string;
};
export type ClaimRow = {
  id: string;
  assistant_message_id: string;
  speaker: string;
  subject: string;
  attribute: string;
  value: string;
  observed_at: string;
  published_at: string | null;
  source_url: string | null;
  evidence_id: string | null;
};
export type EvidenceRow = {
  id: string;
  search_call_id: string;
  assistant_message_id: string;
  ref: string;
  url: string;
  title: string | null;
  published_at: string | null;
  retrieved_at: string;
  excerpt: string;
};

// ---------- users ----------

/** Create or refresh the current user's row. Called at sign-in (and lazily for bearer tokens). */
export async function upsertUser(u: { issuer: string; subject: string; displayName: string | null; email: string | null }): Promise<void> {
  await q(
    `INSERT INTO users (id, issuer, subject, display_name, email) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, users.display_name),
       email = COALESCE(EXCLUDED.email, users.email), last_seen_at = now()`,
    [currentUserId(), u.issuer, u.subject, u.displayName, u.email],
  );
}

/** Clean a name typed by the user: trimmed, single spaces, at most 40 characters; null when empty. */
export function cleanName(name: unknown): string | null {
  const n = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  return n || null;
}

export async function getPreferredName(): Promise<string | null> {
  return (await q<{ preferred_name: string | null }>("SELECT preferred_name FROM users"))[0]?.preferred_name ?? null;
}

export async function setPreferredName(name: string | null): Promise<void> {
  await q("UPDATE users SET preferred_name = $1", [name]);
}

/** Has this user already seen the first-visit welcome? */
export async function isWelcomed(): Promise<boolean> {
  return Boolean((await q<{ welcomed_at: string | null }>("SELECT welcomed_at FROM users"))[0]?.welcomed_at);
}

/** Record that the welcome was shown. Idempotent: the first time wins. */
export async function markWelcomed(): Promise<void> {
  await q("UPDATE users SET welcomed_at = COALESCE(welcomed_at, now())");
}

export async function getUser(): Promise<{ id: string; display_name: string | null; email: string | null } | undefined> {
  return (await q<{ id: string; display_name: string | null; email: string | null }>("SELECT id, display_name, email FROM users"))[0];
}

// ---------- conversations ----------

const CONV_COLS = "id, title, created_at, updated_at";

export async function createConversation(title: string | null, at: string): Promise<ConversationRow> {
  const row = { id: newId("c"), title, created_at: at, updated_at: at };
  await q("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ($1, $2, $3, $4)", [row.id, title, at, at]);
  return row;
}

export async function getConversation(id: string): Promise<ConversationRow | undefined> {
  return (await q<ConversationRow>(`SELECT ${CONV_COLS} FROM conversations WHERE id = $1`, [id]))[0];
}

/** Sidebar search: this user's chats whose title or any message contains the text (case-insensitive). */
export async function searchConversations(text: string): Promise<Array<ConversationRow & { snippet: string | null }>> {
  const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return q(
    `SELECT c.id, c.title, c.created_at, c.updated_at,
            (SELECT m.text FROM messages m WHERE m.conversation_id = c.id AND m.text ILIKE $1 ORDER BY m.created_at DESC LIMIT 1) AS snippet
       FROM conversations c
      WHERE c.title ILIKE $1 OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.text ILIKE $1)
      ORDER BY c.updated_at DESC
      LIMIT 50`,
    [like],
  );
}

export async function listConversations(): Promise<Array<ConversationRow & { last_local_date: string | null }>> {
  return q(
    `SELECT c.id, c.title, c.created_at, c.updated_at,
            (SELECT m.local_date FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_local_date
     FROM conversations c ORDER BY c.updated_at DESC LIMIT 500`,
  );
}

export async function setConversationTitle(id: string, title: string): Promise<void> {
  await q("UPDATE conversations SET title = $1 WHERE id = $2", [title, id]);
}

/** Delete a conversation and everything derived from it. Returns false if it isn't this user's. */
export async function deleteConversation(id: string): Promise<boolean> {
  return tx(async (run) => {
    const ids = (await run<{ id: string }>("SELECT id FROM messages WHERE conversation_id = $1 AND role = 'assistant'", [id])).map((r) => r.id);
    if (ids.length) {
      await run("DELETE FROM claims WHERE assistant_message_id = ANY($1)", [ids]);
      await run("DELETE FROM turn_digests WHERE assistant_message_id = ANY($1)", [ids]);
      await run("DELETE FROM search_calls WHERE assistant_message_id = ANY($1)", [ids]); // cascades to web_evidence
      await run("UPDATE jobs SET status = 'skipped' WHERE user_id = $1 AND status = 'pending' AND payload->>'assistantMessageId' = ANY($2)", [currentUserId(), ids]);
    }
    const deleted = await run("DELETE FROM conversations WHERE id = $1 RETURNING id", [id]); // cascades to messages
    return deleted.length > 0;
  });
}

/**
 * Edit support: remove a user message and everything after it in its conversation, plus all memory
 * derived from the removed answers (digests and vectors, claims, search calls and page evidence) and
 * any extraction still queued for them. Messages go first so an extraction that is saving right now
 * either commits before (and is then removed here) or finds its message gone (see saveExtraction).
 * Returns the number of messages removed, or null if the message is not this user's, in this chat.
 */
export async function truncateFrom(conversationId: string, userMessageId: string): Promise<number | null> {
  return tx(async (run) => {
    const target = (await run<{ seq: string }>("SELECT seq FROM messages WHERE id = $1 AND conversation_id = $2 AND role = 'user'", [userMessageId, conversationId]))[0];
    if (!target) return null;
    const removed = await run<{ id: string; role: string }>("DELETE FROM messages WHERE conversation_id = $1 AND seq >= $2 RETURNING id, role", [conversationId, target.seq]);
    const ids = removed.filter((m) => m.role === "assistant").map((m) => m.id);
    if (ids.length) {
      await run("DELETE FROM claims WHERE assistant_message_id = ANY($1)", [ids]);
      await run("DELETE FROM turn_digests WHERE assistant_message_id = ANY($1)", [ids]);
      await run("DELETE FROM search_calls WHERE assistant_message_id = ANY($1)", [ids]); // cascades to web_evidence
      await run("UPDATE jobs SET status = 'skipped' WHERE user_id = $1 AND status = 'pending' AND payload->>'assistantMessageId' = ANY($2)", [currentUserId(), ids]);
    }
    await run("UPDATE conversations SET updated_at = now() WHERE id = $1", [conversationId]);
    return removed.length;
  });
}

// ---------- messages ----------

export type NewMessage = Omit<MessageRow, "id" | "meta_json"> & { id?: string; meta?: unknown };
export type NewJob = { type: string; payload: Record<string, unknown> };

/**
 * Insert a message. For assistant messages, the extraction job is written in the same transaction
 * (the outbox): either both exist or neither does. Returns the row and the job id, if any.
 */
export async function insertMessage(m: NewMessage, job?: NewJob): Promise<MessageRow & { jobId: string | null }> {
  const row: MessageRow = {
    id: m.id ?? newId(m.role === "user" ? "u" : "a"),
    conversation_id: m.conversation_id,
    role: m.role,
    text: m.text,
    content_json: m.content_json,
    created_at: m.created_at,
    tz: m.tz,
    local_date: m.local_date,
    reply_to: m.reply_to,
    meta_json: m.meta === undefined ? null : JSON.stringify(m.meta),
  };
  const jobId = await tx(async (run) => {
    await run(
      `INSERT INTO messages (id, conversation_id, role, text, content_json, created_at, tz, local_date, reply_to, meta_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [row.id, row.conversation_id, row.role, row.text, row.content_json, row.created_at, row.tz, row.local_date, row.reply_to, row.meta_json],
    );
    await run("UPDATE conversations SET updated_at = GREATEST(updated_at, $1) WHERE id = $2", [row.created_at, row.conversation_id]);
    return job ? enqueueJob(job.type, job.payload) : null;
  });
  return { ...row, jobId };
}

export async function getMessages(conversationId: string): Promise<MessageRow[]> {
  return q("SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at, seq", [conversationId]);
}

export async function getMessage(id: string): Promise<MessageRow | undefined> {
  return (await q<MessageRow>("SELECT * FROM messages WHERE id = $1", [id]))[0];
}

// ---------- turns (user question + assistant answer) ----------

const TURN_SELECT = `
  SELECT a.id AS assistant_id, u.id AS user_id_msg, a.conversation_id, c.title AS conversation_title,
         u.local_date, u.created_at, u.text AS question, a.text AS answer
  FROM messages a
  JOIN messages u ON u.user_id = a.user_id AND u.id = a.reply_to
  JOIN conversations c ON c.user_id = a.user_id AND c.id = a.conversation_id
  WHERE a.role = 'assistant'`;

export async function turnsInRange(start: string, end: string, excludeAssistantIds: string[]): Promise<TurnRow[]> {
  return q(`${TURN_SELECT} AND u.local_date BETWEEN $1 AND $2 AND NOT (a.id = ANY($3)) ORDER BY u.created_at`, [start, end, excludeAssistantIds]);
}

export async function turnsByIds(ids: string[]): Promise<TurnRow[]> {
  if (!ids.length) return [];
  const rows = await q<TurnRow>(`${TURN_SELECT} AND a.id = ANY($1)`, [ids]);
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows.sort((x, y) => order.get(x.assistant_id)! - order.get(y.assistant_id)!);
}

export async function historySpan(): Promise<{ first: string; last: string; count: number } | null> {
  const r = (await q<{ first: string | null; last: string | null; count: number }>(
    "SELECT MIN(local_date) AS first, MAX(local_date) AS last, COUNT(*) AS count FROM messages WHERE role = 'user'",
  ))[0]!;
  return r.first && r.last ? { first: r.first, last: r.last, count: r.count } : null;
}

/** Turns on the dates closest to `date` (for "nothing on that day, but here is what I do have"). */
export async function nearestTurns(date: string, limit: number, excludeAssistantIds: string[]): Promise<TurnRow[]> {
  return q(`${TURN_SELECT} AND NOT (a.id = ANY($3)) ORDER BY ABS(u.local_date - $1::date), u.created_at LIMIT $2`, [date, limit, excludeAssistantIds]);
}

/** Turns of one conversation, newest first. */
export async function lastAssistantIds(conversationId: string, n: number): Promise<string[]> {
  return (
    await q<{ id: string }>("SELECT id FROM messages WHERE conversation_id = $1 AND role = 'assistant' ORDER BY created_at DESC LIMIT $2", [conversationId, n])
  ).map((r) => r.id);
}

// ---------- full-text + vector search ----------

/** Build a safe tsquery from free keywords: each token prefix-matched, OR'd together. Tokens are letters/digits only. */
export function ftsQuery(keywords: string[]): string | null {
  const tokens = [...new Set(keywords.flatMap((k) => k.toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter((t) => t.length >= 2 && !STOP.has(t)))];
  if (!tokens.length) return null;
  return tokens.map((t) => `${t}:*`).join(" | ");
}
const STOP = new Set(["the", "and", "for", "you", "what", "did", "was", "are", "with", "that", "this", "about", "from", "have", "has", "can", "our", "any", "how", "who", "which", "when", "since", "still", "your", "they", "them", "then"]);

const RRF_K = 60;

/** One scored turn: fused RRF score, best vector similarity (if vectors ran) and whether full text matched. */
export type TurnScore = { score: number; sim: number | null; fts: boolean };

/**
 * Score turns (assistant message ids) by fusing ranked lists with reciprocal rank fusion:
 * full text over raw messages, digests and claims, plus (if an embedding is given) vector
 * similarity over digests above a minimum similarity. Returns assistant_id -> score (higher is better).
 */
export async function scoreTurns(
  keywords: string[],
  restrictTo?: string[],
  vector?: { embedding: number[]; minSimilarity: number } | null,
): Promise<Map<string, number>> {
  const detail = await scoreTurnsDetailed(keywords, restrictTo, vector);
  return new Map([...detail].map(([id, d]) => [id, d.score]));
}

/**
 * Same ranking as scoreTurns, with the signals recall needs to judge confidence. Every list is an
 * index lookup with a LIMIT (GIN for full text, HNSW for vectors), so this never scans the history.
 */
export async function scoreTurnsDetailed(
  keywords: string[],
  restrictTo?: string[],
  vector?: { embedding: number[]; minSimilarity: number } | null,
): Promise<Map<string, TurnScore>> {
  const query = ftsQuery(keywords);
  const scores = new Map<string, TurnScore>();
  if (!query && !vector) return scores;
  const restrict = restrictTo ? new Set(restrictTo) : null;
  const get = (id: string) => scores.get(id) ?? (scores.set(id, { score: 0, sim: null, fts: false }), scores.get(id)!);
  const addList = (ids: Array<string | null>, weight: number, fts: boolean) => {
    let rank = 0;
    const seen = new Set<string>();
    for (const id of ids) {
      if (!id || seen.has(id) || (restrict && !restrict.has(id))) continue;
      seen.add(id);
      rank++;
      const s = get(id);
      s.score += weight / (RRF_K + rank);
      if (fts) s.fts = true;
    }
  };
  await tx(async (run) => {
    if (query) {
      // User messages map to the assistant reply that answers them.
      const msgHits = await run<{ aid: string | null }>(
        `SELECT CASE WHEN m.role = 'assistant' THEN m.id
                     ELSE (SELECT a.id FROM messages a WHERE a.user_id = m.user_id AND a.reply_to = m.id LIMIT 1) END AS aid
         FROM messages m, to_tsquery('english', $1) tq
         WHERE m.tsv @@ tq ORDER BY ts_rank_cd(m.tsv, tq) DESC LIMIT 200`,
        [query],
      );
      addList(msgHits.map((h) => h.aid), 1, true);
      const digestHits = await run<{ id: string }>(
        `SELECT d.assistant_message_id AS id FROM turn_digests d, to_tsquery('english', $1) tq
         WHERE d.tsv @@ tq ORDER BY ts_rank_cd(d.tsv, tq) DESC LIMIT 100`,
        [query],
      );
      addList(digestHits.map((h) => h.id), 1.5, true);
      const claimHits = await run<{ id: string }>(
        `SELECT c.assistant_message_id AS id FROM claims c, to_tsquery('english', $1) tq
         WHERE c.tsv @@ tq ORDER BY ts_rank_cd(c.tsv, tq) DESC LIMIT 200`,
        [query],
      );
      addList(claimHits.map((h) => h.id), 1, true);
    }
    if (vector) {
      const vecHits = await run<{ id: string; sim: number }>(
        `SELECT assistant_message_id AS id, 1 - (embedding <=> $1::vector) AS sim FROM turn_digests
         WHERE embedding IS NOT NULL ORDER BY embedding <=> $1::vector LIMIT 50`,
        [toVector(vector.embedding)],
      );
      const kept = vecHits.filter((h) => h.sim >= vector.minSimilarity && (!restrict || restrict.has(h.id)));
      addList(kept.map((h) => h.id), 1, false);
      for (const h of kept) {
        const s = get(h.id);
        s.sim = Math.max(s.sim ?? 0, Number(h.sim));
      }
    }
  });
  return scores;
}

export const toVector = (v: number[]) => `[${v.join(",")}]`;

// ---------- digests and claims ----------

export async function getDigest(assistantId: string): Promise<{ question: string; answer_summary: string } | undefined> {
  return (await q<{ question: string; answer_summary: string }>("SELECT question, answer_summary FROM turn_digests WHERE assistant_message_id = $1", [assistantId]))[0];
}

export async function claimsFor(assistantIds: string[]): Promise<ClaimRow[]> {
  if (!assistantIds.length) return [];
  return q("SELECT * FROM claims WHERE assistant_message_id = ANY($1) ORDER BY created_at, seq", [assistantIds]);
}

export type NewClaim = Omit<ClaimRow, "id">;

export async function saveExtraction(
  turn: { assistantId: string; conversationId: string; localDate: string; createdAt: string },
  digest: { question: string; answer_summary: string; entities: string[]; keywords: string[] },
  claims: NewClaim[],
  embedding: number[] | null = null,
): Promise<void> {
  await tx(async (run) => {
    // The turn may have been removed by an edit while the model was extracting: then save nothing.
    // FOR SHARE makes a concurrent edit wait for this save, so it removes these rows too.
    if (!(await run("SELECT 1 FROM messages WHERE id = $1 FOR SHARE", [turn.assistantId])).length) return;
    // Idempotent: a retried job replaces its own rows.
    await run("DELETE FROM claims WHERE assistant_message_id = $1", [turn.assistantId]);
    await run(
      `INSERT INTO turn_digests (assistant_message_id, conversation_id, local_date, created_at, question, answer_summary, entities, keywords, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)
       ON CONFLICT (user_id, assistant_message_id) DO UPDATE SET question = EXCLUDED.question, answer_summary = EXCLUDED.answer_summary,
         entities = EXCLUDED.entities, keywords = EXCLUDED.keywords, embedding = EXCLUDED.embedding`,
      [
        turn.assistantId,
        turn.conversationId,
        turn.localDate,
        turn.createdAt,
        digest.question,
        digest.answer_summary,
        JSON.stringify(digest.entities),
        [...digest.keywords, ...digest.entities].join(" "),
        embedding ? toVector(embedding) : null,
      ],
    );
    for (const c of claims) {
      await run(
        `INSERT INTO claims (id, assistant_message_id, local_date, speaker, subject, attribute, value, observed_at, published_at, source_url, evidence_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [newId("cl"), c.assistant_message_id, turn.localDate, c.speaker, c.subject, c.attribute, c.value, c.observed_at, c.published_at, c.source_url, c.evidence_id, turn.createdAt],
      );
    }
  });
}

// ---------- web evidence ----------

export async function insertSearchCall(c: { assistantId: string; query: string; since: string | null; domains: string[] | null; provider: string; at: string }): Promise<string> {
  const id = newId("sc");
  await q("INSERT INTO search_calls (id, assistant_message_id, query, since_date, domains, provider, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
    id,
    c.assistantId,
    c.query,
    c.since,
    c.domains ? JSON.stringify(c.domains) : null,
    c.provider,
    c.at,
  ]);
  return id;
}

export async function searchCallsFor(assistantId: string): Promise<Array<{ query: string; since_date: string | null; domains: string | null }>> {
  return q("SELECT query, since_date, domains FROM search_calls WHERE assistant_message_id = $1 ORDER BY created_at", [assistantId]);
}

export async function insertEvidence(e: Omit<EvidenceRow, "id">): Promise<string> {
  const id = newId("ev");
  const hash = createHash("sha256").update(e.excerpt).digest("hex");
  await q(
    `INSERT INTO web_evidence (id, search_call_id, assistant_message_id, ref, url, title, published_at, retrieved_at, excerpt, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, e.search_call_id, e.assistant_message_id, e.ref, e.url, e.title, e.published_at, e.retrieved_at, e.excerpt, hash],
  );
  return id;
}

export async function evidenceFor(assistantId: string): Promise<EvidenceRow[]> {
  return q("SELECT * FROM web_evidence WHERE assistant_message_id = $1 ORDER BY seq", [assistantId]);
}

export async function evidenceByIds(ids: string[]): Promise<EvidenceRow[]> {
  if (!ids.length) return [];
  return q("SELECT * FROM web_evidence WHERE id = ANY($1)", [ids]);
}

// ---------- outbox ----------

/** Write an outbox row for the current user (inside the caller's transaction, if any). */
export async function enqueueJob(type: string, payload: Record<string, unknown>): Promise<string> {
  const id = newId("job");
  await q("INSERT INTO jobs (id, user_id, type, payload) VALUES ($1, $2, $3, $4)", [id, currentUserId(), type, JSON.stringify(payload)]);
  return id;
}
