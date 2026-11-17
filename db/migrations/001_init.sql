-- Memo Chat, multi-user schema.
--
-- Every user-owned table leads with user_id, in its primary key and in its indexes, so one user's
-- history is one contiguous index range (and, later, one shard). Row-level security is the tenant
-- boundary: the app sets app.user_id per transaction from the verified token, and every policy is
-- user_id = current_setting('app.user_id'). With the setting unset, nothing is visible.
-- user_id defaults to the setting, so inserts cannot name another user by accident.
--
-- Timestamps are timestamptz (returned to the app as ISO strings); local_date is the date in the
-- user's timezone when the message was sent, which is what "last Tuesday" is resolved against.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gin;

CREATE TABLE users (
  id            text PRIMARY KEY,               -- "dev|alice", "oidc|<sub>"
  issuer        text NOT NULL,
  subject       text NOT NULL,
  display_name  text,
  email         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);

CREATE TABLE conversations (
  user_id     text NOT NULL DEFAULT current_setting('app.user_id', true) REFERENCES users(id) ON DELETE CASCADE,
  id          text NOT NULL,
  title       text,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX conversations_user_updated ON conversations (user_id, updated_at DESC);

CREATE TABLE messages (
  user_id          text NOT NULL DEFAULT current_setting('app.user_id', true),
  id               text NOT NULL,
  conversation_id  text NOT NULL,
  seq              bigint GENERATED ALWAYS AS IDENTITY,   -- insertion order, tie-breaker
  role             text NOT NULL CHECK (role IN ('user', 'assistant')),
  text             text NOT NULL,          -- plain text for display and search
  content_json     text NOT NULL,          -- exact API messages for this turn, replayed unchanged
  created_at       timestamptz NOT NULL,
  tz               text NOT NULL,
  local_date       date NOT NULL,
  reply_to         text,                   -- assistant -> user message id
  meta_json        text,                   -- timings, plan, recalled refs, sources
  tsv              tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, conversation_id) REFERENCES conversations (user_id, id) ON DELETE CASCADE
);
CREATE INDEX messages_user_date ON messages (user_id, local_date);
CREATE INDEX messages_user_conv ON messages (user_id, conversation_id, created_at);
CREATE INDEX messages_user_reply ON messages (user_id, reply_to);
CREATE INDEX messages_tsv ON messages USING gin (user_id, tsv);

CREATE TABLE search_calls (
  user_id               text NOT NULL DEFAULT current_setting('app.user_id', true) REFERENCES users(id) ON DELETE CASCADE,
  id                    text NOT NULL,
  assistant_message_id  text NOT NULL,   -- reserved before the assistant message row is written
  query                 text NOT NULL,
  since_date            text,
  domains               text,
  provider              text NOT NULL,
  created_at            timestamptz NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX search_calls_msg ON search_calls (user_id, assistant_message_id);

CREATE TABLE web_evidence (
  user_id               text NOT NULL DEFAULT current_setting('app.user_id', true),
  id                    text NOT NULL,
  search_call_id        text NOT NULL,
  assistant_message_id  text NOT NULL,
  seq                   bigint GENERATED ALWAYS AS IDENTITY,
  ref                   text NOT NULL,      -- S1..Sn, unique within the turn
  url                   text NOT NULL,
  title                 text,
  published_at          text,
  retrieved_at          text NOT NULL,
  excerpt               text NOT NULL,      -- exactly what the model was shown
  content_hash          text NOT NULL,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, search_call_id) REFERENCES search_calls (user_id, id) ON DELETE CASCADE
);
CREATE INDEX web_evidence_msg ON web_evidence (user_id, assistant_message_id);
CREATE INDEX web_evidence_url ON web_evidence (user_id, url, retrieved_at);

CREATE TABLE turn_digests (
  user_id               text NOT NULL DEFAULT current_setting('app.user_id', true) REFERENCES users(id) ON DELETE CASCADE,
  assistant_message_id  text NOT NULL,
  conversation_id       text NOT NULL,
  local_date            date NOT NULL,
  created_at            timestamptz NOT NULL,
  question              text NOT NULL,
  answer_summary        text NOT NULL,
  entities              text NOT NULL,     -- json array
  keywords              text NOT NULL,
  embedding             vector(768),       -- optional (EMBEDDING_MODEL); null until embedded
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', keywords), 'A') ||
    setweight(to_tsvector('english', question), 'B') ||
    setweight(to_tsvector('english', answer_summary), 'C')
  ) STORED,
  PRIMARY KEY (user_id, assistant_message_id)
);
CREATE INDEX turn_digests_user_date ON turn_digests (user_id, local_date);
CREATE INDEX turn_digests_tsv ON turn_digests USING gin (user_id, tsv);
CREATE INDEX turn_digests_embedding ON turn_digests USING hnsw (embedding vector_cosine_ops);

CREATE TABLE claims (
  user_id               text NOT NULL DEFAULT current_setting('app.user_id', true) REFERENCES users(id) ON DELETE CASCADE,
  id                    text NOT NULL,
  assistant_message_id  text NOT NULL,
  seq                   bigint GENERATED ALWAYS AS IDENTITY,
  local_date            date NOT NULL,
  speaker               text NOT NULL,     -- 'assistant' | 'user'
  subject               text NOT NULL,
  attribute             text NOT NULL,
  value                 text NOT NULL,
  observed_at           text NOT NULL,     -- when we saw it
  published_at          text,              -- when the source says
  source_url            text,
  evidence_id           text,
  created_at            timestamptz NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', subject || ' ' || attribute || ' ' || value)) STORED,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX claims_msg ON claims (user_id, assistant_message_id);
CREATE INDEX claims_tsv ON claims USING gin (user_id, tsv);

-- Outbox. Written in the same transaction as the message it belongs to; the worker claims rows
-- with SKIP LOCKED. Not under RLS (the worker serves every user), but it holds only ids, and the
-- worker does the actual work as that user, under RLS.
CREATE TABLE jobs (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending',   -- pending | running | done | failed | skipped
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  run_after     timestamptz NOT NULL DEFAULT now(),
  locked_until  timestamptz
);
CREATE INDEX jobs_due ON jobs (status, run_after);

-- Row-level security on every user-owned table. FORCE makes it apply to the table owner too.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversations', 'messages', 'search_calls', 'web_evidence', 'turn_digests', 'claims'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (user_id = current_setting(''app.user_id'', true)) WITH CHECK (user_id = current_setting(''app.user_id'', true))',
      t || '_owner', t);
  END LOOP;
END $$;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_self ON users
  USING (id = current_setting('app.user_id', true))
  WITH CHECK (id = current_setting('app.user_id', true));
