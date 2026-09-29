-- Saved mini-apps: a snapshot of an HTML artifact that outlives its chat.
--
-- The payload is copied, never referenced: `source_artifact_id` is provenance
-- only (no foreign key), so deleting the chat -- which deletes the artifact --
-- leaves the app alone. `manifest_json` and `payload` are encrypted like
-- artifact content; `content_hash` is sha256 of the plaintext payload, the
-- same scheme as artifacts.content_hash, so "the source changed" is a string
-- comparison.

CREATE TABLE IF NOT EXISTS apps (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  description         TEXT,
  icon                TEXT,
  category            TEXT NOT NULL,
  version             TEXT NOT NULL,
  source_artifact_id  TEXT,
  origin              TEXT NOT NULL,
  manifest_json       TEXT NOT NULL,
  payload             TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  last_opened_at      TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_apps_last_opened ON apps(last_opened_at);
