-- Migration 0008: Usage analytics
-- Adds per-message token columns and a usage_summary table for aggregation.
-- ADR-003 tier 1: usage data is low-sensitivity, stored as plaintext integers.

ALTER TABLE messages ADD COLUMN input_tokens INTEGER;
ALTER TABLE messages ADD COLUMN output_tokens INTEGER;
ALTER TABLE messages ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE messages ADD COLUMN cache_write_tokens INTEGER;
ALTER TABLE messages ADD COLUMN cost_estimate TEXT;

CREATE TABLE IF NOT EXISTS usage_summary (
  id                  TEXT PRIMARY KEY,
  message_id          TEXT NOT NULL,
  conversation_id     TEXT NOT NULL,
  provider_id         TEXT NOT NULL,
  model_id            TEXT NOT NULL,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_estimate       TEXT,
  created_at          TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_usage_summary_created ON usage_summary(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_summary_provider ON usage_summary(provider_id, created_at);