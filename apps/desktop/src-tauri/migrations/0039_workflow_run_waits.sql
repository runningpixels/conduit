-- A run waiting for the user picks up again after Conduit restarts
-- (`workflows::runner::Runner::continue_run`).
--
-- `waiting_since` / `waiting_until`: on the step row that is waiting for an
-- answer (Ask me, a permission review, an outside action), when the wait
-- began and when it runs out; NULL when the step isn't waiting. A run left
-- with such a row is continued at the next launch instead of failed.
--
-- `sent`: the outside actions a run has sent so far (encrypted JSON list),
-- so a step that runs again after a restart doesn't send the same thing
-- twice. Cleared when the run ends.
ALTER TABLE workflow_run_steps ADD COLUMN waiting_since TEXT;
ALTER TABLE workflow_run_steps ADD COLUMN waiting_until TEXT;
ALTER TABLE workflow_runs ADD COLUMN sent TEXT;
