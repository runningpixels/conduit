-- t1-5: user-inspectable persistent memory.
-- `body` is encrypted when encryption-at-rest is On (same as prompt bodies).
-- `status` is pending until the user saves a model-proposed fact; manual
-- Settings adds are written as active. Injection only reads status=active.

CREATE TABLE IF NOT EXISTS memory_items (
  id                      TEXT PRIMARY KEY,
  kind                    TEXT NOT NULL,
  body                    TEXT NOT NULL,
  source_conversation_id  TEXT,
  pinned                  INTEGER NOT NULL DEFAULT 0,
  status                  TEXT NOT NULL DEFAULT 'active',
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  FOREIGN KEY (source_conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_items_status_updated
  ON memory_items(status, pinned DESC, updated_at DESC);
