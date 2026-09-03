-- t1-3: conversation context compaction journal.
-- Raw messages stay forever; latest row per conversation is applied at read/send.

CREATE TABLE IF NOT EXISTS conversation_compactions (
  id                      TEXT PRIMARY KEY,
  conversation_id         TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  summary_text            TEXT NOT NULL,
  through_message_id      TEXT NOT NULL,
  kept_from_message_id    TEXT NOT NULL,
  model_id                TEXT NOT NULL,
  token_estimate_before   INTEGER NOT NULL,
  token_estimate_after    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_compactions_conversation
  ON conversation_compactions(conversation_id, created_at DESC);
