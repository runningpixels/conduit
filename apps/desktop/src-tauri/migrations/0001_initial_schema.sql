-- Phase 3 initial schema.
--
-- All 20 spec-mandated tables (docs/plans/03-local-data.md) plus the
-- append-only `provider_event_log` required by the persistence invariant
-- (docs/plans/phase3-persistence.md) — 21 tables total.
--
-- Conventions:
--   * Timestamps are TEXT ISO-8601 Zulu (time::now_iso8601); they sort
--     lexicographically, which is the load-bearing order invariant.
--   * JSON columns are TEXT holding serde_json::to_string output.
--   * Cloud-ID / sync columns are nullable so local-only operation never
--     depends on cloud concepts (Phase 7 fills them).
--   * Booleans are INTEGER 0/1 (SQLite has no native bool).
--   * Secrets are NEVER stored here — only `keychain://` refs (provider_accounts,
--     connector_grants). Raw provider keys live in the OS keychain.

PRAGMA foreign_keys = ON;

-- Public migration audit table. sqlx manages migration mechanics in its own
-- `_sqlx_migrations` table; `schema_migrations` is the app-readable audit table
-- Phase 7 sync consumes. db::migrations keeps the two in sync after each run.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  checksum   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,          -- UUID v4
  title      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- cloud sync (Phase 7): nullable
  cloud_id   TEXT,
  sync_state TEXT,                      -- 'pending' | 'synced' | 'conflict'
  metadata   TEXT                       -- JSON
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_cloud_id ON conversations(cloud_id) WHERE cloud_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS messages (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL,
  role                TEXT NOT NULL,    -- 'system'|'developer'|'user'|'assistant'|'tool'
  author_label        TEXT,
  provider_message_id TEXT,
  -- Persistence-internal: the request_id that produced this assistant turn, so
  -- the materialized view can be rebuilt from provider_event_log. NULL for
  -- user/system messages. Not exposed in the canonical Message struct.
  request_id          TEXT,
  interrupted_at      TEXT,
  finalized           INTEGER NOT NULL DEFAULT 0,
  finish_reason       TEXT,
  metadata            TEXT,             -- JSON
  created_at          TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_request_id ON messages(request_id) WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_parts (
  id            TEXT PRIMARY KEY,       -- block_id / tool_call_id
  message_id    TEXT NOT NULL,
  idx           INTEGER NOT NULL,       -- part index within the message
  kind          TEXT NOT NULL,          -- MessagePartKind
  content       TEXT,
  mime_type     TEXT,
  tool_call_id  TEXT,
  artifact_id   TEXT,
  attachment_id TEXT,
  blob_ref      TEXT,                   -- points into the attachments/ blob store
  metadata      TEXT,                   -- JSON
  created_at    TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_message_parts_message_index ON message_parts(message_id, idx);

-- Append-only event log: the sole source of truth for what happened in a turn.
-- One row per ProviderEvent; a streaming delta is a single atomic INSERT, never
-- a read-modify-write of an aggregate. The materialized message view (messages
-- + message_parts) is rebuildable as fold(events) and is updated in the SAME
-- transaction as the append.
CREATE TABLE IF NOT EXISTS provider_event_log (
  conversation_id TEXT NOT NULL,
  request_id      TEXT NOT NULL,
  sequence        INTEGER NOT NULL,     -- monotonic per (conversation_id, request_id)
  event_kind      TEXT NOT NULL,        -- ProviderEvent variant tag
  payload         TEXT NOT NULL,        -- full ProviderEvent JSON
  created_at      TEXT NOT NULL,
  PRIMARY KEY (conversation_id, request_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_event_log_conversation ON provider_event_log(conversation_id, request_id, sequence);

CREATE TABLE IF NOT EXISTS tool_calls (
  id          TEXT PRIMARY KEY,
  tool_id     TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  message_id  TEXT,                     -- nullable until the view folds it
  status      TEXT NOT NULL,            -- ToolCallStatus
  arguments   TEXT,                     -- JSON
  result      TEXT,                     -- JSON, redacted of secrets
  error       TEXT,
  approved_at TEXT,
  completed_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_request ON tool_calls(request_id);

CREATE TABLE IF NOT EXISTS tool_results (
  id           TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL,
  content      TEXT NOT NULL,           -- redacted of secrets
  is_error     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (tool_call_id) REFERENCES tool_calls(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS artifacts (
  id                 TEXT PRIMARY KEY,
  conversation_id    TEXT NOT NULL,
  current_version_id TEXT NOT NULL,
  kind               TEXT NOT NULL,     -- ArtifactKind
  title              TEXT,
  source_message_id  TEXT,
  cloud_share_id     TEXT,
  metadata           TEXT,              -- JSON
  created_at         TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_artifacts_conversation ON artifacts(conversation_id);

CREATE TABLE IF NOT EXISTS artifact_versions (
  id           TEXT PRIMARY KEY,
  artifact_id  TEXT NOT NULL,
  idx          INTEGER NOT NULL,        -- version ordinal (append-only)
  mime_type    TEXT,
  content_text TEXT,                    -- inline for small payloads
  content_json TEXT,                    -- inline for structured payloads
  content_path TEXT,                    -- workspace-relative path for large/file payloads
  content_hash TEXT,                    -- sha256 hex
  size_bytes   INTEGER,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact_index ON artifact_versions(artifact_id, idx);

CREATE TABLE IF NOT EXISTS attachments (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  path            TEXT NOT NULL,        -- workspace-relative under attachments/
  mime_type       TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  hash            TEXT,                 -- sha256 hex (content address)
  origin          TEXT,
  retention_state TEXT NOT NULL DEFAULT 'active', -- RetentionState
  created_at      TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_attachments_hash ON attachments(hash) WHERE hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON attachments(conversation_id);

CREATE TABLE IF NOT EXISTS connector_definitions (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  transport       TEXT NOT NULL,        -- 'stdio' | 'httpSse'
  owner           TEXT NOT NULL,
  icon            TEXT,
  support_url     TEXT,
  consent_copy    TEXT,
  policy_metadata TEXT,                 -- JSON
  cloud_id        TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_versions (
  id                   TEXT PRIMARY KEY,
  connector_id         TEXT NOT NULL,
  version              TEXT NOT NULL,
  transport_config     TEXT NOT NULL,   -- JSON
  scope_grants         TEXT,            -- JSON array
  capability_allowlist TEXT,            -- JSON array
  rollout_channel      TEXT,
  support_state        TEXT,
  created_at           TEXT NOT NULL,
  FOREIGN KEY (connector_id) REFERENCES connector_definitions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_connector_versions_connector ON connector_versions(connector_id);

CREATE TABLE IF NOT EXISTS connector_grants (
  id                   TEXT PRIMARY KEY,
  connector_version_id TEXT NOT NULL,
  scope                TEXT NOT NULL,   -- GrantScope
  status               TEXT NOT NULL,   -- GrantStatus
  credential_ref       TEXT,            -- keychain:// ref, NEVER raw secret
  approved_by          TEXT,
  revoked_at           TEXT,
  notes                TEXT,
  created_at           TEXT NOT NULL,
  FOREIGN KEY (connector_version_id) REFERENCES connector_versions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_connector_grants_status ON connector_grants(status);

CREATE TABLE IF NOT EXISTS connector_runtime_state (
  connector_version_id TEXT PRIMARY KEY,
  health               TEXT NOT NULL,   -- 'healthy' | 'degraded' | 'down'
  last_started_at      TEXT,
  last_error           TEXT,
  restart_count        INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (connector_version_id) REFERENCES connector_versions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS connector_capabilities (
  id                   TEXT PRIMARY KEY, -- stable cap id
  connector_version_id TEXT NOT NULL,
  kind                 TEXT NOT NULL,    -- 'tool' | 'resource' | 'prompt'
  name                 TEXT NOT NULL,
  schema_json          TEXT,             -- JSON
  discovered_at        TEXT NOT NULL,
  FOREIGN KEY (connector_version_id) REFERENCES connector_versions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_connector_capabilities_version ON connector_capabilities(connector_version_id);

CREATE TABLE IF NOT EXISTS provider_accounts (
  provider_id    TEXT PRIMARY KEY,      -- 'anthropic' | 'openai' | 'openai_compat' | 'ollama'
  credential_ref TEXT NOT NULL,         -- keychain:// ref, NEVER raw secret
  display_name   TEXT,
  is_local       INTEGER NOT NULL DEFAULT 0,
  metadata       TEXT,                  -- JSON
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                   -- JSON-encoded
);

CREATE TABLE IF NOT EXISTS tenant_config_cache (
  id          TEXT PRIMARY KEY,         -- tenant id
  version     TEXT NOT NULL,
  config_json TEXT NOT NULL,            -- full TenantConfig JSON
  fetched_at  TEXT NOT NULL,
  expires_at  TEXT
);

CREATE TABLE IF NOT EXISTS licenses (
  id                      TEXT PRIMARY KEY, -- license id (seat id + issued_at)
  tenant_id               TEXT NOT NULL,
  seat_id                 TEXT NOT NULL,
  tier                    TEXT NOT NULL,
  token                   TEXT NOT NULL,    -- signed JWT (opaque to Phase 3)
  exp                     INTEGER NOT NULL,
  config_version          TEXT NOT NULL,
  key_set_version         TEXT,
  feature_flags           TEXT,             -- JSON array
  offline_grace_deadline  INTEGER,
  issued_at               INTEGER,
  last_seen_server_time   INTEGER,          -- monotonic anchor (spec §11)
  created_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_licenses_seat ON licenses(seat_id);

CREATE TABLE IF NOT EXISTS license_key_sets (
  version     TEXT PRIMARY KEY,
  public_keys TEXT NOT NULL,            -- JSON array of JWKs
  fetched_at  TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_state (
  entity_type   TEXT NOT NULL,          -- 'conversation' | 'message' | 'artifact' | ...
  entity_id     TEXT NOT NULL,
  cloud_id      TEXT,
  last_synced_at TEXT,
  pending       INTEGER NOT NULL DEFAULT 0, -- bool: dirty
  conflict      INTEGER NOT NULL DEFAULT 0, -- bool
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_state_pending ON sync_state(pending) WHERE pending = 1;