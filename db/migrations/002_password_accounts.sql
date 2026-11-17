-- Email + password sign-in. One row per account, keyed by normalised (lowercase) email.
-- Looked up before anyone is signed in, so it has no row-level security; it holds only the
-- email, the owning user id and a salted scrypt hash. Guests have a users row and no account row.
CREATE TABLE password_accounts (
  email          text PRIMARY KEY,
  user_id        text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
