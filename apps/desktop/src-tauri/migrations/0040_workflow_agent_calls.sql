-- Agents at work (`workflows::runner`, the Agents page).
--
-- One row each time an agent works on something in a run: an `agent` step
-- (`kind` 'step', `agent_id` the step's id) or a helper it handed a task to
-- (`kind` 'helper', `agent_id` the helper's id, `parent_id` the row of the
-- agent that handed it the task). `task` is what it was asked (encrypted);
-- `tokens` the model tokens it used. `status` is running | done | failed.
-- Rows go with their run.
CREATE TABLE IF NOT EXISTS workflow_agent_calls (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  step_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  parent_id   TEXT,
  task        TEXT,
  status      TEXT NOT NULL,
  error       TEXT,
  tokens      INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_agent_calls_agent
  ON workflow_agent_calls(workflow_id, agent_id, started_at);
CREATE INDEX IF NOT EXISTS idx_workflow_agent_calls_run
  ON workflow_agent_calls(run_id);
