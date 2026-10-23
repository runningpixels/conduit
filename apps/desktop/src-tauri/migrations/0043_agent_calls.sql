-- Agents at work, in workflows and in chat (`agents::handoff`,
-- `workflows::runner`, the Agents page). Replaces `workflow_agent_calls`.
--
-- One row each time an agent works on something: an `agent` step of a run
-- (`kind` 'step', `agent_id` the step's id), a helper it handed a task to
-- (`kind` 'helper', `agent_id` the helper's id, `parent_id` the row of the
-- agent that handed it the task) or a chat turn run as a library agent
-- (`kind` 'chat'). Workflow rows carry `run_id`, `workflow_id` and `step_id`
-- and go with their run; chat rows carry the `conversation_id` the work was
-- asked in. `task` is what it was asked (encrypted); `model` the
-- "provider/model" it ran on (null for rows from before it was kept);
-- `tokens` the model tokens it used. `status` is running | done | failed.
CREATE TABLE agent_calls (
  id              TEXT PRIMARY KEY,
  run_id          TEXT,
  workflow_id     TEXT,
  step_id         TEXT,
  conversation_id TEXT,
  kind            TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  parent_id       TEXT,
  task            TEXT,
  model           TEXT,
  status          TEXT NOT NULL,
  error           TEXT,
  tokens          INTEGER NOT NULL DEFAULT 0,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

INSERT INTO agent_calls (id, run_id, workflow_id, step_id, kind, agent_id, parent_id, task,
  status, error, tokens, started_at, finished_at)
  SELECT id, run_id, workflow_id, step_id, kind, agent_id, parent_id, task, status, error,
  tokens, started_at, finished_at FROM workflow_agent_calls;

DROP TABLE workflow_agent_calls;

CREATE INDEX IF NOT EXISTS idx_agent_calls_workflow
  ON agent_calls(workflow_id, agent_id, started_at);
CREATE INDEX IF NOT EXISTS idx_agent_calls_agent
  ON agent_calls(agent_id, started_at);
CREATE INDEX IF NOT EXISTS idx_agent_calls_run
  ON agent_calls(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_calls_conversation
  ON agent_calls(conversation_id);
