-- t1-4: per-conversation enabled Agent Skills (SKILL.md packages).
-- Presence of a row means the skill is on for that chat. Absence is off.
-- Skill packages themselves live on disk (not in SQLite).

CREATE TABLE IF NOT EXISTS conversation_skills (
  conversation_id TEXT NOT NULL,
  skill_id        TEXT NOT NULL,
  PRIMARY KEY (conversation_id, skill_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversation_skills_conversation
  ON conversation_skills(conversation_id);
