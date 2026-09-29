-- Workflow schedules: run a workflow automatically (every day / weekdays at a
-- time, or every N hours).
--
-- One schedule per workflow, deleted with it. `spec_json` is the schedule
-- (`workflows::schedule::ScheduleSpec`); `next_run_at` is the next time it is
-- due, in UTC, computed from the spec in the user's local time zone so "08:00"
-- stays 08:00 across daylight-saving changes. The scheduler runs whatever is
-- due and then moves `next_run_at` to the next future slot, so runs missed
-- while Conduit was closed turn into one run, not one per missed slot.
CREATE TABLE IF NOT EXISTS workflow_schedules (
  workflow_id TEXT PRIMARY KEY,
  spec_json   TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  last_run_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_schedules_due
  ON workflow_schedules(enabled, next_run_at);
