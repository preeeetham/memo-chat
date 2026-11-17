-- The name a user asked to be called (sign-up or the welcome screen), used in the home greeting.
ALTER TABLE users ADD COLUMN preferred_name text;
