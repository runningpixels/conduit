-- Agents the user defines once and uses anywhere (`agents::library`, the
-- Agents page).
--
-- `id` is the agent's id (lowercase letters, digits, `_`), the same id a
-- workflow helper refers to it by (`{ "id": .., "library": .. }`).
-- `definition_json` is the agent as a workflow helper's JSON (`AgentDef`:
-- name, instructions, model, tools, agents, maxTokens), encrypted.
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  definition_json TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
