-- t1-6: local knowledge base (RAG).
--
-- A collection is a named set of imported documents, embedded with one model.
-- The `(provider_id, embedding_model, embedding_dimensions)` triple is recorded
-- per collection because changing any of them invalidates every vector in it --
-- vectors from different models are not comparable. Mixing is refused; the user
-- re-embeds explicitly.
--
-- Vectors are stored inline as BLOBs on the chunk row rather than in a sidecar
-- file. The design doc proposed a sidecar for scan speed, but at one person's
-- scale (10k chunks is ~60MB at 1536 dims) a table scan is milliseconds, and
-- inline storage removes a whole class of bugs the sidecar invites: file/row
-- desync, partial writes, orphaned vectors after a crash, and cleanup on
-- delete. Deletes now cascade for free. Revisit if a corpus ever gets large
-- enough for the scan to show up in a profile.
--
-- `content` is encrypted at the column layer when encryption-at-rest is On,
-- the same as `artifacts.content_text` and `memory_items.body`. `enc_key_version`
-- marks a row as encrypted so `encrypted_data_exists` can see it.

CREATE TABLE IF NOT EXISTS knowledge_collections (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  provider_id          TEXT NOT NULL,
  embedding_model      TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id            TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  -- Where it came from: an absolute path, or a URL for a fetched page.
  source        TEXT NOT NULL,
  title         TEXT NOT NULL,
  mime_type     TEXT,
  -- sha256 over the extracted text, for dedup and re-import detection.
  content_hash  TEXT NOT NULL,
  byte_size     INTEGER NOT NULL DEFAULT 0,
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  imported_at   TEXT NOT NULL,
  FOREIGN KEY (collection_id) REFERENCES knowledge_collections(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_collection
  ON knowledge_documents(collection_id, imported_at DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_hash
  ON knowledge_documents(collection_id, content_hash);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id              TEXT PRIMARY KEY,
  document_id     TEXT NOT NULL,
  -- Position of this chunk within its document, 0-based. Ordering and citation.
  ordinal         INTEGER NOT NULL,
  content         TEXT NOT NULL,
  -- Character range in the extracted text, so a citation can point at a place.
  char_start      INTEGER NOT NULL,
  char_end        INTEGER NOT NULL,
  -- Raw little-endian f32 vector. Length is the collection's
  -- `embedding_dimensions` * 4 bytes.
  embedding       BLOB,
  enc_key_version INTEGER,
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document
  ON knowledge_chunks(document_id, ordinal);

-- Per-conversation attachment. Presence of a row means the collection is on for
-- that chat; absence is off. Shape copied from `conversation_skills` (0015),
-- which already works and gives the user the same mental model.
CREATE TABLE IF NOT EXISTS conversation_collections (
  conversation_id TEXT NOT NULL,
  collection_id   TEXT NOT NULL,
  PRIMARY KEY (conversation_id, collection_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id) REFERENCES knowledge_collections(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversation_collections_conversation
  ON conversation_collections(conversation_id);

-- Keyword half of hybrid retrieval. Standalone FTS5 table with its own
-- triggers, structurally a copy of `message_fts` (0006) -- not external-content,
-- for the same reason: the columns we filter on live on other tables.
--
-- As with `message_fts`, this index holds plaintext even when encryption-at-rest
-- is On. That was decided deliberately for this feature: full-disk encryption
-- already covers a powered-off machine, an unlocked one exposes the OS keychain
-- where our key lives, and the source documents sit unencrypted on the same disk
-- anyway. Encrypting the FTS index under a separate key is tracked as its own
-- card and would fix `message_fts` too.
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunk_fts USING fts5(
  content,
  chunk_id UNINDEXED,
  document_id UNINDEXED,
  collection_id UNINDEXED,
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS knowledge_chunk_fts_ai AFTER INSERT ON knowledge_chunks
BEGIN
  INSERT INTO knowledge_chunk_fts(rowid, content, chunk_id, document_id, collection_id)
  SELECT new.rowid, new.content, new.id, new.document_id, d.collection_id
  FROM knowledge_documents d
  WHERE d.id = new.document_id;
END;

CREATE TRIGGER IF NOT EXISTS knowledge_chunk_fts_ad AFTER DELETE ON knowledge_chunks
BEGIN
  DELETE FROM knowledge_chunk_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS knowledge_chunk_fts_au AFTER UPDATE ON knowledge_chunks
BEGIN
  DELETE FROM knowledge_chunk_fts WHERE rowid = old.rowid;
  INSERT INTO knowledge_chunk_fts(rowid, content, chunk_id, document_id, collection_id)
  SELECT new.rowid, new.content, new.id, new.document_id, d.collection_id
  FROM knowledge_documents d
  WHERE d.id = new.document_id;
END;
