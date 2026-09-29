-- What a workflow may do when it runs on its own (`workflows::permissions`).
--
-- Approved once, when a schedule is turned on; a scheduled run that needs
-- something outside this set pauses and asks. `approved` is the encrypted JSON
-- list of `Permission`s (hosts it may read reveal what the user follows).
-- Deleted with the workflow.
CREATE TABLE IF NOT EXISTS workflow_permissions (
  workflow_id TEXT PRIMARY KEY,
  approved    TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);
