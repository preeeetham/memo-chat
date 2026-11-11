/** All SQL lives here. Small, explicit functions; no ORM. */
import { createHash } from "node:crypto";
import { newId } from "../ids";
import { db } from "./index";

export const USER_ID = "local";

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

// ---------- conversations ----------

export function createConversation(title: string | null, at: string): ConversationRow {
  const row = { id: newId("c"), title, created_at: at, updated_at: at };
  db().prepare("INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (@id, 'local', @title, @created_at, @updated_at)").run(row);
  return row;
}

export function getConversation(id: string): ConversationRow | undefined {
  return db().prepare("SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?").get(id) as ConversationRow | undefined;
}

export function listConversations(): Array<ConversationRow & { last_local_date: string | null }> {
  return db()
    .prepare(
      `SELECT c.id, c.title, c.created_at, c.updated_at,
              (SELECT local_date FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_local_date
       FROM conversations c WHERE c.user_id = ? ORDER BY c.updated_at DESC`,
    )
    .all(USER_ID) as Array<ConversationRow & { last_local_date: string | null }>;
}

export function setConversationTitle(id: string, title: string): void {
  db().prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, id);
}

export function deleteConversation(id: string): void {
  const conn = db();
  conn.transaction(() => {
    const ids = (conn.prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant'").all(id) as Array<{ id: string }>).map((r) => r.id);
    for (const mid of ids) {
      conn.prepare("DELETE FROM claims WHERE assistant_message_id = ?").run(mid);
      conn.prepare("DELETE FROM claims_fts WHERE assistant_message_id = ?").run(mid);
      conn.prepare("DELETE FROM turn_digests WHERE assistant_message_id = ?").run(mid);
      conn.prepare("DELETE FROM digests_fts WHERE assistant_message_id = ?").run(mid);
      conn.prepare("DELETE FROM web_evidence WHERE assistant_message_id = ?").run(mid);
      conn.prepare("DELETE FROM search_calls WHERE assistant_message_id = ?").run(mid);
    }
    conn.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
    conn.prepare("DELETE FROM conversations WHERE id = ?").run(id);
  })();
}

// ---------- messages ----------

export type NewMessage = Omit<MessageRow, "id" | "meta_json"> & { id?: string; meta?: unknown };

/** Insert a message. For assistant messages, the extraction job is written in the same transaction (the outbox). */
export function insertMessage(m: NewMessage, job?: { type: string; payload: unknown }): MessageRow {
  const conn = db();
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
  conn.transaction(() => {
    conn
      .prepare(
        `INSERT INTO messages (id, conversation_id, user_id, role, text, content_json, created_at, tz, local_date, reply_to, meta_json)
         VALUES (@id, @conversation_id, 'local', @role, @text, @content_json, @created_at, @tz, @local_date, @reply_to, @meta_json)`,
      )
      .run(row);
    conn.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(row.created_at, row.conversation_id);
    if (job) enqueueJob(job.type, job.payload, row.created_at);
  })();
  return row;
}

export function getMessages(conversationId: string): MessageRow[] {
  return db().prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid").all(conversationId) as MessageRow[];
}

export function getMessage(id: string): MessageRow | undefined {
  return db().prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
}

// ---------- turns (user question + assistant answer) ----------

const TURN_SELECT = `
  SELECT a.id AS assistant_id, u.id AS user_id_msg, a.conversation_id, c.title AS conversation_title,
         u.local_date, u.created_at, u.text AS question, a.text AS answer
  FROM messages a
  JOIN messages u ON u.id = a.reply_to
  JOIN conversations c ON c.id = a.conversation_id
  WHERE a.role = 'assistant' AND a.user_id = 'local'`;

export function turnsInRange(start: string, end: string, excludeAssistantIds: string[]): TurnRow[] {
  const rows = db().prepare(`${TURN_SELECT} AND u.local_date BETWEEN ? AND ? ORDER BY u.created_at`).all(start, end) as TurnRow[];
  return rows.filter((r) => !excludeAssistantIds.includes(r.assistant_id));
}

export function turnsByIds(ids: string[]): TurnRow[] {
  if (!ids.length) return [];
  const rows = db().prepare(`${TURN_SELECT} AND a.id IN (${ids.map(() => "?").join(",")})`).all(...ids) as TurnRow[];
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows.sort((x, y) => order.get(x.assistant_id)! - order.get(y.assistant_id)!);
}

export function historySpan(): { first: string; last: string; count: number } | null {
  const r = db().prepare("SELECT MIN(local_date) AS first, MAX(local_date) AS last, COUNT(*) AS count FROM messages WHERE role = 'user' AND user_id = 'local'").get() as {
    first: string | null;
    last: string | null;
    count: number;
  };
  return r.first && r.last ? { first: r.first, last: r.last, count: r.count } : null;
}

/** Turns on the dates closest to `date` (for "nothing on that day, but here is what I do have"). */
export function nearestTurns(date: string, limit: number, excludeAssistantIds: string[]): TurnRow[] {
  const rows = db()
    .prepare(`${TURN_SELECT} ORDER BY ABS(julianday(u.local_date) - julianday(?)), u.created_at LIMIT ?`)
    .all(date, limit + excludeAssistantIds.length) as TurnRow[];
  return rows.filter((r) => !excludeAssistantIds.includes(r.assistant_id)).slice(0, limit);
}

/** Turns of one conversation, newest first. */
export function lastAssistantIds(conversationId: string, n: number): string[] {
  return (
    db().prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT ?").all(conversationId, n) as Array<{ id: string }>
  ).map((r) => r.id);
}

// ---------- full-text search ----------

/** Build a safe FTS5 query from free keywords: each token quoted and prefix-matched, OR'd together. */
export function ftsQuery(keywords: string[]): string | null {
  const tokens = [...new Set(keywords.flatMap((k) => k.toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter((t) => t.length >= 2 && !STOP.has(t)))];
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}
const STOP = new Set(["the", "and", "for", "you", "what", "did", "was", "are", "with", "that", "this", "about", "from", "have", "has", "can", "our", "any", "how", "who", "which", "when", "since", "still", "your", "they", "them", "then"]);

/**
 * Score turns (assistant message ids) by BM25 across raw messages, digests and claims.
 * Returns a map assistant_id -> score (higher is better). Optional restriction to a set of turns.
 */
export function scoreTurns(keywords: string[], restrictTo?: string[]): Map<string, number> {
  const q = ftsQuery(keywords);
  const scores = new Map<string, number>();
  if (!q) return scores;
  const add = (id: string | null, s: number) => {
    if (!id || (restrictTo && !restrictTo.includes(id))) return;
    scores.set(id, (scores.get(id) ?? 0) + s);
  };
  const conn = db();
  const msgHits = conn
    .prepare(
      `SELECT m.id, m.role, m.reply_to, bm25(messages_fts) AS r FROM messages_fts
       JOIN messages m ON m.rowid = messages_fts.rowid
       WHERE messages_fts MATCH ? AND m.user_id = 'local' ORDER BY r LIMIT 200`,
    )
    .all(q) as Array<{ id: string; role: string; reply_to: string | null; r: number }>;
  // Map user messages to the assistant reply that answers them.
  const replyOf = conn.prepare("SELECT id FROM messages WHERE reply_to = ? LIMIT 1");
  for (const h of msgHits) {
    const aid = h.role === "assistant" ? h.id : (replyOf.get(h.id) as { id: string } | undefined)?.id ?? null;
    add(aid, -h.r);
  }
  for (const h of conn.prepare("SELECT assistant_message_id AS id, bm25(digests_fts) AS r FROM digests_fts WHERE digests_fts MATCH ? ORDER BY r LIMIT 100").all(q) as Array<{ id: string; r: number }>)
    add(h.id, -h.r * 1.5);
  for (const h of conn.prepare("SELECT assistant_message_id AS id, bm25(claims_fts) AS r FROM claims_fts WHERE claims_fts MATCH ? ORDER BY r LIMIT 200").all(q) as Array<{ id: string; r: number }>)
    add(h.id, -h.r);
  return scores;
}

// ---------- digests and claims ----------

export function getDigest(assistantId: string): { question: string; answer_summary: string } | undefined {
  return db().prepare("SELECT question, answer_summary FROM turn_digests WHERE assistant_message_id = ?").get(assistantId) as
    | { question: string; answer_summary: string }
    | undefined;
}

export function claimsFor(assistantIds: string[]): ClaimRow[] {
  if (!assistantIds.length) return [];
  return db()
    .prepare(`SELECT * FROM claims WHERE assistant_message_id IN (${assistantIds.map(() => "?").join(",")}) ORDER BY created_at, rowid`)
    .all(...assistantIds) as ClaimRow[];
}

export type NewClaim = Omit<ClaimRow, "id">;

export function saveExtraction(
  turn: { assistantId: string; conversationId: string; localDate: string; createdAt: string },
  digest: { question: string; answer_summary: string; entities: string[]; keywords: string[] },
  claims: NewClaim[],
): void {
  const conn = db();
  conn.transaction(() => {
    // Idempotent: a retried job replaces its own rows.
    conn.prepare("DELETE FROM turn_digests WHERE assistant_message_id = ?").run(turn.assistantId);
    conn.prepare("DELETE FROM digests_fts WHERE assistant_message_id = ?").run(turn.assistantId);
    conn.prepare("DELETE FROM claims WHERE assistant_message_id = ?").run(turn.assistantId);
    conn.prepare("DELETE FROM claims_fts WHERE assistant_message_id = ?").run(turn.assistantId);
    conn
      .prepare(
        `INSERT INTO turn_digests (assistant_message_id, user_id, conversation_id, local_date, created_at, question, answer_summary, entities, keywords)
         VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(turn.assistantId, turn.conversationId, turn.localDate, turn.createdAt, digest.question, digest.answer_summary, JSON.stringify(digest.entities), digest.keywords.join(" "));
    conn
      .prepare("INSERT INTO digests_fts (assistant_message_id, question, answer_summary, keywords) VALUES (?, ?, ?, ?)")
      .run(turn.assistantId, digest.question, digest.answer_summary, [...digest.keywords, ...digest.entities].join(" "));
    const ins = conn.prepare(
      `INSERT INTO claims (id, user_id, assistant_message_id, local_date, speaker, subject, attribute, value, observed_at, published_at, source_url, evidence_id, created_at)
       VALUES (@id, 'local', @assistant_message_id, @local_date, @speaker, @subject, @attribute, @value, @observed_at, @published_at, @source_url, @evidence_id, @created_at)`,
    );
    const insFts = conn.prepare("INSERT INTO claims_fts (assistant_message_id, subject, attribute, value) VALUES (?, ?, ?, ?)");
    for (const c of claims) {
      ins.run({ id: newId("cl"), ...c, local_date: turn.localDate, created_at: turn.createdAt });
      insFts.run(c.assistant_message_id, c.subject, c.attribute, c.value);
    }
  })();
}

// ---------- web evidence ----------

export function insertSearchCall(c: { assistantId: string; query: string; since: string | null; domains: string[] | null; provider: string; at: string }): string {
  const id = newId("sc");
  db()
    .prepare("INSERT INTO search_calls (id, assistant_message_id, query, since_date, domains, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, c.assistantId, c.query, c.since, c.domains ? JSON.stringify(c.domains) : null, c.provider, c.at);
  return id;
}

export function insertEvidence(e: Omit<EvidenceRow, "id">): string {
  const id = newId("ev");
  const hash = createHash("sha256").update(e.excerpt).digest("hex");
  db()
    .prepare(
      `INSERT INTO web_evidence (id, search_call_id, assistant_message_id, ref, url, title, published_at, retrieved_at, excerpt, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, e.search_call_id, e.assistant_message_id, e.ref, e.url, e.title, e.published_at, e.retrieved_at, e.excerpt, hash);
  return id;
}

export function evidenceFor(assistantId: string): EvidenceRow[] {
  return db().prepare("SELECT * FROM web_evidence WHERE assistant_message_id = ? ORDER BY rowid").all(assistantId) as EvidenceRow[];
}

export function evidenceByIds(ids: string[]): EvidenceRow[] {
  if (!ids.length) return [];
  return db().prepare(`SELECT * FROM web_evidence WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as EvidenceRow[];
}

// ---------- jobs (durable outbox, drained in-process) ----------

export type JobRow = { id: string; type: string; payload: string; status: string; attempts: number; last_error: string | null; run_after: string };

export function enqueueJob(type: string, payload: unknown, at: string): string {
  const id = newId("job");
  // run_after uses the wall clock (not the fake clock) so the worker's schedule is real time.
  db().prepare("INSERT INTO jobs (id, type, payload, created_at, run_after) VALUES (?, ?, ?, ?, ?)").run(id, type, JSON.stringify(payload), at, new Date().toISOString());
  return id;
}

/** Atomically claim the next due job. */
export function claimNextJob(): JobRow | undefined {
  const conn = db();
  return conn.transaction(() => {
    const job = conn
      .prepare("SELECT * FROM jobs WHERE status = 'pending' AND run_after <= ? ORDER BY run_after LIMIT 1")
      .get(new Date().toISOString()) as JobRow | undefined;
    if (!job) return undefined;
    conn.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE id = ?").run(job.id);
    return { ...job, attempts: job.attempts + 1 };
  })();
}

export function finishJob(id: string, status: "done" | "skipped"): void {
  db().prepare("UPDATE jobs SET status = ?, last_error = NULL WHERE id = ?").run(status, id);
}

export function failJob(id: string, error: string, attempts: number, maxAttempts: number, backoffMs: number): void {
  const retryAt = new Date(Date.now() + backoffMs).toISOString();
  db()
    .prepare("UPDATE jobs SET status = ?, last_error = ?, run_after = ? WHERE id = ?")
    .run(attempts >= maxAttempts ? "failed" : "pending", error.slice(0, 1000), retryAt, id);
}

/** Jobs left 'running' by a crashed process go back to the queue on boot. */
export function resetRunningJobs(): void {
  db().prepare("UPDATE jobs SET status = 'pending' WHERE status = 'running'").run();
}

export function pendingJobCount(): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','running')").get() as { n: number }).n;
}
