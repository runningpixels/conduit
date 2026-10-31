-- Reply versions: Retry keeps the earlier reply instead of deleting it.
-- A superseded reply's rows stay, with `superseded_at` set, and every read of
-- the thread skips them. 0009's `retry_of_message_id` (the user message the
-- versions answer) and `retry_sequence` (which version) group them.
ALTER TABLE messages ADD COLUMN superseded_at TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_superseded
  ON messages(retry_of_message_id, retry_sequence)
  WHERE superseded_at IS NOT NULL;
