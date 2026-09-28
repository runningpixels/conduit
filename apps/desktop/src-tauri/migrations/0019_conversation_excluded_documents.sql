-- t1-8 P2 (documents control), M2: per-conversation document exclusions.
--
-- D1: exclusions, not inclusions. A row here means "this chat leaves this
-- document out"; absence means it is searched (the default for every
-- document in an attached collection, including one imported after the chat
-- attached the collection). An inclusion list would need updating every time
-- a new document showed up; this needs updating only when the user opts a
-- document out.
--
-- D3: only the document needs to exist, not its collection needs to be
-- attached to this conversation. Detaching a collection (`conversation_
-- collections`) leaves its exclusion rows here untouched, so re-attaching
-- restores them -- that only works if this table's foreign key is to
-- `knowledge_documents`, not to `conversation_collections`.
--
-- Both foreign keys cascade: deleting the document (or its collection, which
-- cascades to the document per 0017) or deleting the conversation removes the
-- exclusion row with it. Nothing here ever needs a manual cleanup pass, same
-- reasoning as `conversation_collections`.
CREATE TABLE IF NOT EXISTS conversation_excluded_documents (
  conversation_id TEXT NOT NULL,
  document_id     TEXT NOT NULL,
  PRIMARY KEY (conversation_id, document_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversation_excluded_documents_conversation
  ON conversation_excluded_documents(conversation_id);
