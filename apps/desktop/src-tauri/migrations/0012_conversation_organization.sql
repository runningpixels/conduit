-- Conversation organization (t0-5): pin, archive, and one-level folders.
-- Folders are first-class so empty ones exist as drop targets; chats store
-- a nullable folder_id. pinned_at / archived_at are ISO-8601 or NULL.
-- SQLite does not enforce REFERENCES added via ALTER TABLE; delete_folder
-- clears folder_id in application code.

CREATE TABLE IF NOT EXISTS conversation_folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_folders_name
  ON conversation_folders(name COLLATE NOCASE);

ALTER TABLE conversations ADD COLUMN pinned_at TEXT;
ALTER TABLE conversations ADD COLUMN archived_at TEXT;
ALTER TABLE conversations ADD COLUMN folder_id TEXT;

CREATE INDEX IF NOT EXISTS idx_conversations_pinned_at
  ON conversations(pinned_at) WHERE pinned_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_archived_at
  ON conversations(archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_folder_id
  ON conversations(folder_id);
