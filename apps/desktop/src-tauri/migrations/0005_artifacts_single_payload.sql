-- Phase 5: collapse append-only artifact_versions into a single payload on the
-- artifact row. The app no longer tracks version history (user-directed
-- decision; overrides ADR-002). Saving an artifact now overwrites its payload
-- in place. Encryption / blob / hash / file-state primitives are unchanged,
-- just keyed on artifact_id instead of version_id.
--
-- Data preservation: the current payload of any pre-existing artifact (its
-- current_version_id row) is copied onto the artifact row before the version
-- table is dropped, so dev stores keep their latest content. File blobs already
-- on disk under artifacts/<artifact_id>/<version_id>/<filename> are NOT moved —
-- the migrated content_path still points there and resolves correctly. New File
-- payloads are written to artifacts/<artifact_id>/<filename>.

ALTER TABLE artifacts ADD COLUMN mime_type TEXT;
ALTER TABLE artifacts ADD COLUMN content_text TEXT;
ALTER TABLE artifacts ADD COLUMN content_json TEXT;
ALTER TABLE artifacts ADD COLUMN content_path TEXT;
ALTER TABLE artifacts ADD COLUMN content_hash TEXT;
ALTER TABLE artifacts ADD COLUMN size_bytes INTEGER;
ALTER TABLE artifacts ADD COLUMN enc_key_version INTEGER;
ALTER TABLE artifacts ADD COLUMN updated_at TEXT;

-- Copy the current version's payload onto the artifact row for any artifact
-- that already had content. Rows with no current version stay payload-less.
UPDATE artifacts
SET mime_type       = (SELECT av.mime_type       FROM artifact_versions av WHERE av.id = artifacts.current_version_id),
    content_text    = (SELECT av.content_text    FROM artifact_versions av WHERE av.id = artifacts.current_version_id),
    content_json    = (SELECT av.content_json    FROM artifact_versions av WHERE av.id = artifacts.current_version_id),
    content_path    = (SELECT av.content_path    FROM artifact_versions av WHERE av.id = artifacts.current_version_id),
    content_hash    = (SELECT av.content_hash    FROM artifact_versions av WHERE av.id = artifacts.current_version_id),
    size_bytes      = (SELECT av.size_bytes      FROM artifact_versions av WHERE av.id = artifacts.current_version_id),
    enc_key_version = (SELECT av.enc_key_version FROM artifact_versions av WHERE av.id = artifacts.current_version_id),
    updated_at      = (SELECT av.created_at      FROM artifact_versions av WHERE av.id = artifacts.current_version_id)
WHERE current_version_id != '';

ALTER TABLE artifacts DROP COLUMN current_version_id;

DROP TABLE artifact_versions;