-- What each workflow run produced, and whether the user has looked at it.
--
-- `result_json` (encrypted, like step outputs) is the list of things the run
-- saved: documents, decks, drafts, files, each with a short preview. It is
-- written when the run ends, so lists of results don't have to decrypt every
-- step. NULL for runs from before this column; it is filled in the first time
-- such a run is listed (see `workflows::results`).
--
-- `output_count` is how many entries `result_json` holds, kept in the clear so
-- "how many unread results" is one query.
--
-- `seen_at` is set when the user opens the result (or sees it in place). Runs
-- from before this migration count as seen, so the Results list doesn't start
-- with a pile of unread history.
ALTER TABLE workflow_runs ADD COLUMN result_json TEXT;
ALTER TABLE workflow_runs ADD COLUMN output_count INTEGER;
ALTER TABLE workflow_runs ADD COLUMN seen_at TEXT;

UPDATE workflow_runs SET seen_at = COALESCE(finished_at, started_at);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_started
  ON workflow_runs(started_at);
