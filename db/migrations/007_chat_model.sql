-- The chat model a user picked in the web app ("<provider>:<model>"); null = the server default (LLM_MODEL).
ALTER TABLE users ADD COLUMN chat_model text;
