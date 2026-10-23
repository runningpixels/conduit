-- Memory scopes: the user's own memory (`global`) and each of the user's
-- agents' own notes (`agent:<id>`). Existing rows are the user's own.
-- `origin` says where an agent wrote a note (`chat`, `run`, `scheduled_run`);
-- it is empty for the user's own memory and for notes added by hand.
ALTER TABLE memory_items ADD COLUMN scope TEXT NOT NULL DEFAULT 'global';
ALTER TABLE memory_items ADD COLUMN origin TEXT;

CREATE INDEX IF NOT EXISTS idx_memory_items_scope_status
  ON memory_items(scope, status);
