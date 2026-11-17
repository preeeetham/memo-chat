-- Show the first-visit welcome on the home page once per user (any device), then never again.
ALTER TABLE users ADD COLUMN welcomed_at timestamptz;
