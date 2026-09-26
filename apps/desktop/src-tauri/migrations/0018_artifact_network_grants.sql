-- ADR-010: hosts the user allowed an HTML artifact to contact, per artifact.
-- "Allow this time" grants live in memory only (artifact_network.rs); this
-- table holds "Always allow for this page". `host` is the https origin the
-- grant covers. Deleting the artifact -- or its conversation, which cascades
-- to artifacts -- deletes its grants.

CREATE TABLE IF NOT EXISTS artifact_network_grants (
  artifact_id   TEXT NOT NULL,
  host          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  PRIMARY KEY (artifact_id, host),
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
);
