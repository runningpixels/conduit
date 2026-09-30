-- Launch inputs (ADR-013): stored values for an app's declared inputs, one
-- row per app. `values_json` is encrypted like other content columns, the
-- same scheme as `apps.manifest_json`/`apps.payload`. Declaration lives in
-- the app's own `manifest_json` (`AppManifest.inputs`); this table only ever
-- holds *values* the user (or an update-from-artifact) put in, keyed by input
-- id inside the JSON object -- a value survives only while its input is
-- still declared and the value still fits it, otherwise the default applies.
--
-- Lifetime follows the app, not a foreign key (apps.delete is a Rust call,
-- same as `page_storage` for an app principal): deleting an app deletes this
-- row in Rust, not via a trigger.

CREATE TABLE IF NOT EXISTS app_inputs (
  app_id        TEXT PRIMARY KEY,
  values_json   TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
