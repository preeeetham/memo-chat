/** Schema, applied idempotently on first use. All timestamps are UTC ISO strings; local_date is YYYY-MM-DD in the user's tz. */
export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'local',
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL DEFAULT 'local',
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text TEXT NOT NULL,           -- plain text for display and search
  content_json TEXT NOT NULL,   -- exact API messages for this turn, replayed unchanged
  created_at TEXT NOT NULL,
  tz TEXT NOT NULL,
  local_date TEXT NOT NULL,
  reply_to TEXT,                -- assistant -> user message id
  meta_json TEXT                -- timings, plan, recalled refs, sources
);
CREATE INDEX IF NOT EXISTS messages_user_date ON messages(user_id, local_date);
CREATE INDEX IF NOT EXISTS messages_conv_time ON messages(conversation_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TABLE IF NOT EXISTS search_calls (
  id TEXT PRIMARY KEY,
  assistant_message_id TEXT NOT NULL,   -- id reserved before the assistant message row is written
  query TEXT NOT NULL,
  since_date TEXT,
  domains TEXT,
  provider TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web_evidence (
  id TEXT PRIMARY KEY,
  search_call_id TEXT NOT NULL REFERENCES search_calls(id) ON DELETE CASCADE,
  assistant_message_id TEXT NOT NULL,
  ref TEXT NOT NULL,                    -- S1..Sn, unique within the turn
  url TEXT NOT NULL,
  title TEXT,
  published_at TEXT,
  retrieved_at TEXT NOT NULL,
  excerpt TEXT NOT NULL,                -- exactly what the model was shown
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS web_evidence_url ON web_evidence(url, retrieved_at);
CREATE INDEX IF NOT EXISTS web_evidence_msg ON web_evidence(assistant_message_id);

CREATE TABLE IF NOT EXISTS turn_digests (
  assistant_message_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  question TEXT NOT NULL,
  answer_summary TEXT NOT NULL,
  entities TEXT NOT NULL,   -- json array
  keywords TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS digests_fts USING fts5(assistant_message_id UNINDEXED, question, answer_summary, keywords);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  assistant_message_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  speaker TEXT NOT NULL,        -- 'assistant' | 'user'
  subject TEXT NOT NULL,
  attribute TEXT NOT NULL,
  value TEXT NOT NULL,
  observed_at TEXT NOT NULL,    -- when we saw it
  published_at TEXT,            -- when the source says
  source_url TEXT,
  evidence_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS claims_msg ON claims(assistant_message_id);
CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts USING fts5(assistant_message_id UNINDEXED, subject, attribute, value);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | failed | skipped
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  run_after TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status, run_after);
`;
