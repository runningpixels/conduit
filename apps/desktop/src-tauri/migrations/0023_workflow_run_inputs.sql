-- The values a workflow run was started with (encrypted JSON object, input id
-- to text), so "Rerun from this step" fills the later steps the same way.
-- NULL for runs from before this column; a rerun of those uses the defaults.
ALTER TABLE workflow_runs ADD COLUMN inputs TEXT;
