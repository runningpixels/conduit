-- Command rules for agents that use the computer (`workflows::computer`):
-- which commands a workflow's agents may run without asking, and which
-- always ask (encrypted JSON `{"allow": [...], "deny": [...]}`). NULL is
-- none. Kept with the outside-action rules: both change only from the UI.
ALTER TABLE workflow_action_rules ADD COLUMN commands TEXT;
