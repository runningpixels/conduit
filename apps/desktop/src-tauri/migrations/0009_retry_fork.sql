-- Migration 0009: Retry & Fork schema changes
-- Adds branch metadata to conversations and retry lineage to messages.

ALTER TABLE conversations ADD COLUMN forked_from_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN fork_point_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN fork_label TEXT;

ALTER TABLE messages ADD COLUMN retry_of_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN retry_sequence INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_conversations_forked_from ON conversations(forked_from_conversation_id) WHERE forked_from_conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_retry_of ON messages(retry_of_message_id) WHERE retry_of_message_id IS NOT NULL;