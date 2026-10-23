-- Agents at work, watched and stopped one by one (`agents::handoff`,
-- `workflows::runner`, the run's agent tree).
--
-- `request_id` is the request of the agent's own turn, which Redirect steers.
-- The token columns split `tokens` by kind (input, output, cache reads and
-- cache writes), so a node's cost can be priced; rows from before this have
-- zeros. They are updated after each of the agent's rounds while it runs.
-- `status` may now also be `stopped`: the user stopped it, or the work it
-- was part of was stopped.
ALTER TABLE agent_calls ADD COLUMN request_id TEXT;
ALTER TABLE agent_calls ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_calls ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_calls ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_calls ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
