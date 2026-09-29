-- Grants belong to a principal, not only to an artifact: 'artifact:<id>' or
-- 'app:<id>' (a saved mini-app, 0025). Only the 'net' capability exists so far
-- (ADR-010's "Always allow"), and `target` is the https origin it covers.
--
-- Replaces artifact_network_grants. Artifact grants used to go with their
-- artifact through a foreign key; a principal column can't have one, so a
-- trigger does it now. SQLite fires triggers for foreign-key cascade deletes
-- too, so deleting a conversation still clears its artifacts' grants. App
-- grants are removed by the app's own delete.

CREATE TABLE IF NOT EXISTS principal_grants (
  principal     TEXT NOT NULL,
  capability    TEXT NOT NULL,
  target        TEXT NOT NULL DEFAULT '',
  granted_at    TEXT NOT NULL,
  last_used_at  TEXT,
  PRIMARY KEY (principal, capability, target)
);

INSERT OR IGNORE INTO principal_grants (principal, capability, target, granted_at, last_used_at)
  SELECT 'artifact:' || artifact_id, 'net', host, created_at, last_used_at
  FROM artifact_network_grants;

DROP TABLE artifact_network_grants;

CREATE TRIGGER IF NOT EXISTS artifacts_delete_principal_grants
AFTER DELETE ON artifacts
BEGIN
  DELETE FROM principal_grants WHERE principal = 'artifact:' || OLD.id;
END;
