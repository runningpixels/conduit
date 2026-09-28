-- Workflows v1: saved multi-step routines, run by hand (scheduling comes later).
--
-- A workflow is a definition (JSON: a list of steps, see `workflows::definition`)
-- plus one conversation of its own. That conversation holds the model calls the
-- steps make and the artifacts they save, so the existing artifact machinery
-- (and "continue in chat") works unchanged. It is hidden from the chat list by
-- `conversations.kind = 'automation'`; every normal chat keeps the default.
--
-- One conversation per workflow, not per run: an artifact the workflow keeps
-- updating ("today's briefing") lives in that conversation, and artifacts
-- cascade-delete with their conversation. `ON DELETE SET NULL` on the workflow
-- means deleting the conversation by hand doesn't take the workflow with it; the
-- next run makes a new one.
--
-- Each run records every step's inputs and outputs so a run can be inspected
-- afterwards. `input_json` / `output_json` / `definition_json` are encrypted at
-- rest like other content columns.
ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';

CREATE TABLE IF NOT EXISTS workflows (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  definition_json TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  conversation_id TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  version     INTEGER NOT NULL,
  trigger     TEXT NOT NULL,             -- 'manual' for now
  status      TEXT NOT NULL,             -- running | completed | failed
  error       TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow
  ON workflow_runs(workflow_id, started_at);

CREATE TABLE IF NOT EXISTS workflow_run_steps (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  step_id     TEXT NOT NULL,
  iteration   INTEGER,                   -- index inside a for_each, else NULL
  status      TEXT NOT NULL,             -- running | completed | failed | skipped
  input_json  TEXT,
  output_json TEXT,
  error       TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run
  ON workflow_run_steps(run_id, started_at);
