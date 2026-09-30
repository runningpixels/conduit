-- Page storage (ADR-012): a small key/value store `window.conduit.storage`
-- gives a page across launches. Keyed by principal, the same as
-- `principal_grants` (0024): 'artifact:<id>' or 'app:<id>'. `value_json` is
-- encrypted like other content columns; `size_bytes` is the byte length of
-- the plaintext JSON, kept alongside the encrypted value so quota checks
-- never need to decrypt.
--
-- Lifetime follows the principal, not a foreign key (a principal column
-- can't have one): deleting an artifact deletes its storage via the trigger
-- below, same shape as 0024's `artifacts_delete_principal_grants`. An app's
-- storage is deleted by the app's own delete in Rust.

CREATE TABLE IF NOT EXISTS page_storage (
  principal     TEXT NOT NULL,
  key           TEXT NOT NULL,
  value_json    TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (principal, key)
);

CREATE TRIGGER IF NOT EXISTS artifacts_delete_page_storage
AFTER DELETE ON artifacts
BEGIN
  DELETE FROM page_storage WHERE principal = 'artifact:' || OLD.id;
END;
