-- "Forget what I told you about X": the chat stays visible, but the turn is dropped from memory.
ALTER TABLE messages ADD COLUMN forgotten_at text;
