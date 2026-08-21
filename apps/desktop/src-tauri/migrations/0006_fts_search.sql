-- FTS5 full-text search virtual table for message parts.
--
-- Standalone FTS5 table (no external content): the indexed columns include
-- `role` and `conversation_id` which live in the `messages` table, not in
-- `message_parts`, so an external-content table (`content=message_parts`) is
-- not possible — FTS5 would try to read those columns from the content table
-- and fail. The index is instead maintained entirely by the triggers below;
-- `db::repository::search::reindex_all` backfills on first startup.
--
-- Tradeoff (documented in ADR-003 follow-up): when encryption tier is On, the
-- FTS5 index stores plaintext (indexed at write time before the column
-- encryption layer runs). This is in the same SQLite file with filesystem-level
-- protection. A future improvement could encrypt the FTS5 index with a separate
-- key.

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  content,
  role UNINDEXED,
  conversation_id UNINDEXED,
  message_id UNINDEXED,
  tokenize='porter unicode61 remove_diacritics 2'
);

-- Triggers to keep FTS5 in sync with message_parts.
-- Only index 'text' kind parts with non-null, non-empty content.

CREATE TRIGGER IF NOT EXISTS message_fts_ai AFTER INSERT ON message_parts
BEGIN
  INSERT INTO message_fts(rowid, content, role, conversation_id, message_id)
  SELECT new.rowid, new.content, m.role, m.conversation_id, new.message_id
  FROM messages m
  WHERE m.id = new.message_id
    AND new.kind = 'text'
    AND new.content IS NOT NULL
    AND new.content != '';
END;

CREATE TRIGGER IF NOT EXISTS message_fts_ad AFTER DELETE ON message_parts
BEGIN
  DELETE FROM message_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS message_fts_au AFTER UPDATE ON message_parts
BEGIN
  DELETE FROM message_fts WHERE rowid = old.rowid;
  INSERT INTO message_fts(rowid, content, role, conversation_id, message_id)
  SELECT new.rowid, new.content, m.role, m.conversation_id, new.message_id
  FROM messages m
  WHERE m.id = new.message_id
    AND new.kind = 'text'
    AND new.content IS NOT NULL
    AND new.content != '';
END;