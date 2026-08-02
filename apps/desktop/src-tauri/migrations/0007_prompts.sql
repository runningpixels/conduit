-- Prompts library (Competitive Feature).
-- Allows users to save, organize, and reuse prompts with variable substitution.
-- Stores the body encrypted when EncryptionTier::On; title/folder/tags are
-- plaintext for sorting and filtering.

CREATE TABLE IF NOT EXISTS prompts (
  id         TEXT PRIMARY KEY,          -- UUID v4
  title      TEXT NOT NULL,             -- user-facing name
  body       TEXT NOT NULL,             -- prompt text with optional {{variable}} tokens; encrypted when tier=On
  variables  TEXT,                       -- JSON array of variable names parsed from body, e.g. '["var1","var2"]' or NULL
  folder     TEXT,                       -- optional grouping folder name
  tags       TEXT,                       -- JSON array of tag strings or NULL
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,             -- ISO-8601 Zulu
  updated_at TEXT                        -- ISO-8601 Zulu, NULL on creation
);

CREATE INDEX IF NOT EXISTS idx_prompts_folder ON prompts(folder, sort_order);