-- Per-app settings: model slots, a daily cloud-token limit, and an activity
-- log (what the app did, never what it said). One `app_settings` row per app
-- (absent = every default); `app_activity` holds model and fetch calls one row
-- each, and storage writes rolled up to one row per app per local day (the
-- partial unique index below), so a chatty app can't flood the table.
--
-- Hosts, provider ids, model ids, token counts and error codes are metadata,
-- like `principal_grants` (0024), so none of it is encrypted. Prompts,
-- replies, URL paths and stored values are never written here.
--
-- Lifetime follows the app through a real foreign key: deleting an app
-- cascades to both tables. `day` is the local calendar day (YYYY-MM-DD) the
-- row belongs to; Rust deletes rows older than 7 days when it inserts.

CREATE TABLE IF NOT EXISTS app_settings (
  app_id           TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  default_provider TEXT, default_model TEXT,
  quick_provider   TEXT, quick_model   TEXT,
  daily_token_cap  INTEGER,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_activity (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id        TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  at            TEXT NOT NULL,
  day           TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('model','fetch','storage')),
  ok            INTEGER NOT NULL,
  provider_id   TEXT, model TEXT, cloud INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER, output_tokens INTEGER,
  host TEXT, method TEXT, status INTEGER, error TEXT,
  count         INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS app_activity_app_day ON app_activity(app_id, day);
CREATE UNIQUE INDEX IF NOT EXISTS app_activity_storage_day
  ON app_activity(app_id, day) WHERE kind = 'storage';
