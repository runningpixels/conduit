-- Which outside actions a workflow takes without asking (`workflows::actions`).
--
-- A step calling a connector tool that changes things asks first, unless the
-- user allowed that tool for this workflow ("Don't ask again") or turned
-- asking off (`allow_all`). `allowed` is the encrypted JSON list of
-- `AllowedAction`s. Deleted with the workflow.
CREATE TABLE IF NOT EXISTS workflow_action_rules (
  workflow_id TEXT PRIMARY KEY,
  allow_all   INTEGER NOT NULL DEFAULT 0,
  allowed     TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);
