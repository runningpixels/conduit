-- Writing: a draft is long-form Markdown written with the model in its own chat
-- (conversations.kind = 'draft', never listed in Chats), plus an outline and a
-- sidecar of block metadata (ids, owner, pinned). brief, outline_json, markdown,
-- blocks_json and draft_snapshots.payload are encrypted like artifact content.
-- Deleting the chat deletes the draft.
CREATE TABLE IF NOT EXISTS drafts (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  stage           TEXT NOT NULL DEFAULT 'outline' CHECK (stage IN ('outline', 'draft')),
  brief           TEXT NOT NULL,
  outline_json    TEXT NOT NULL,   -- [{"heading","intent","targetWords"}]
  markdown        TEXT NOT NULL,
  blocks_json     TEXT NOT NULL,   -- {"next": n, "blocks": [DraftBlock]}
  words           INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS draft_snapshots (
  id           TEXT PRIMARY KEY,
  draft_id     TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  cause        TEXT NOT NULL CHECK (cause IN ('created', 'ai-turn', 'manual', 'restore')),
  label        TEXT,
  payload      TEXT NOT NULL,   -- JSON {markdown, blocks, outline, stage}
  payload_hash TEXT NOT NULL,   -- sha256 of plaintext payload
  words        INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_draft_snapshots_draft ON draft_snapshots(draft_id, created_at);
