-- Research: a planned, budgeted web research run that ends in a cited report.
--
-- A run belongs to the chat it was started in (`conversation_id`, the card is
-- on the assistant message `message_id`) and makes its model calls in a hidden
-- conversation of its own (`hidden_conversation_id`, kind 'automation'), which
-- is deleted with the run so page text sent to the model goes with the chat.
--
-- Every page the run read is kept with its text, so a report's quotes can be
-- checked again. brief_json, summary, unanswered_json, research_sources.text and
-- research_claims.claim/quote are encrypted at rest like other content columns.
CREATE TABLE IF NOT EXISTS research_runs (
  id                     TEXT PRIMARY KEY,
  conversation_id        TEXT NOT NULL,
  message_id             TEXT NOT NULL,
  hidden_conversation_id TEXT,
  status                 TEXT NOT NULL,  -- planning | awaitingApproval | running | done | failed | stopped
  brief_json             TEXT,
  depth                  TEXT NOT NULL,  -- quick | standard | deep
  budget_json            TEXT NOT NULL,
  progress_json          TEXT NOT NULL,
  artifact_id            TEXT,
  summary                TEXT,
  unanswered_json        TEXT,
  unverified_dropped     INTEGER NOT NULL DEFAULT 0,
  error                  TEXT,
  created_at             TEXT NOT NULL,
  finished_at            TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_research_runs_conversation
  ON research_runs(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS research_sources (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  url          TEXT NOT NULL,
  final_url    TEXT,
  title        TEXT,
  host         TEXT NOT NULL,
  fetched_at   TEXT NOT NULL,
  content_hash TEXT,
  text         TEXT,
  status       TEXT NOT NULL,          -- read | empty | failed | skipped
  footnote     INTEGER,
  FOREIGN KEY (run_id) REFERENCES research_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_research_sources_run ON research_sources(run_id);

CREATE TABLE IF NOT EXISTS research_claims (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  sub_question INTEGER NOT NULL,       -- index into the brief's sub_questions
  claim        TEXT NOT NULL,
  quote        TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  verified     INTEGER NOT NULL DEFAULT 0,
  used         INTEGER NOT NULL DEFAULT 0,  -- cited in the report
  FOREIGN KEY (run_id) REFERENCES research_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES research_sources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_research_claims_run ON research_claims(run_id);

-- The run's hidden conversation holds the extractor prompts (page text); it
-- goes when the run does (including when its chat is deleted).
CREATE TRIGGER IF NOT EXISTS research_runs_delete_hidden_conversation
AFTER DELETE ON research_runs
WHEN OLD.hidden_conversation_id IS NOT NULL
BEGIN
  DELETE FROM conversations WHERE id = OLD.hidden_conversation_id;
END;
