-- t1-2 M3: per-tool approval memory (conversation-scoped or always).
-- Sensitive tools are never stored here (enforced in application code).
-- tool_key is "{connector_version_id}::{tool_name}".

CREATE TABLE IF NOT EXISTS tool_approval_memory (
  id               TEXT PRIMARY KEY,
  tool_key         TEXT NOT NULL,
  scope            TEXT NOT NULL CHECK (scope IN ('conversation', 'always')),
  conversation_id  TEXT,
  created_at       TEXT NOT NULL
);

-- SQLite UNIQUE treats NULLs as distinct; use partial indexes instead.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_approval_memory_always
  ON tool_approval_memory(tool_key) WHERE scope = 'always';
CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_approval_memory_conversation
  ON tool_approval_memory(tool_key, conversation_id)
  WHERE scope = 'conversation' AND conversation_id IS NOT NULL;
