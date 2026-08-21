-- M6: encryption-at-rest key-version tracking.
--
-- Adds a nullable `enc_key_version INTEGER` to every table that holds
-- encryptable columns (spec §7.2/§12.2 target set). NULL means "plaintext /
-- not yet encrypted"; a value means the row was encrypted with that master-key
-- version. Rotation and the tier-upgrade migration (`encryption::migrate`) use
-- this to resume: re-encrypt only rows whose version is NULL or stale, then
-- stamp the new version. The version is stamped on the row, not the column, so
-- a partially-migrated table is recoverable.
--
-- `message_parts.content` and `tool_results.content` are part of the target set
-- but their column-level encryption is deferred to M6.1 (the incremental
-- ContentDelta append path interacts with per-row encryption — see
-- docs/plans/status.md). The columns are added now so M6.1 is a code-only
-- change with no further migration.

ALTER TABLE message_parts ADD COLUMN enc_key_version INTEGER;
ALTER TABLE artifact_versions ADD COLUMN enc_key_version INTEGER;
ALTER TABLE tool_results ADD COLUMN enc_key_version INTEGER;
ALTER TABLE tenant_config_cache ADD COLUMN enc_key_version INTEGER;
ALTER TABLE licenses ADD COLUMN enc_key_version INTEGER;