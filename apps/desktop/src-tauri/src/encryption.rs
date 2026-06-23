//! Encryption-at-rest (Phase 3, M6) — application-level AES-256-GCM, tier-gated.
//!
//! The master key is a 256-bit `OsRng` random value wrapped in the OS keychain
//! (reusing the `credentials.rs` keyring pattern, ADR-004 opaque-ref). Per-row
//! values are encrypted with AES-256-GCM and stored as
//! `enc:v1:<b64 nonce>:<b64 ciphertext+tag>`. Blob files carry a 6-byte magic
//! `CDENC1` + 12-byte nonce + ciphertext.
//!
//! When `tier == Off`, `encrypt`/`decrypt` are **identity** (no prefix, no
//! magic), so the Off path is byte-identical to plaintext storage and existing
//! data/tests are unaffected. The prefix lets a future downgrade or key loss be
//! *detected* rather than silently misread.
//!
//! Tier policy (ADR-003) is unresolved: this module ships a runtime config knob
//! (`AppSettings.encryption_at_rest`) defaulting to Off for the consumer
//! edition. The non-silent-downgrade fallback (spec §7.2): if `tier == On` but
//! the key is unavailable AND there is no existing encrypted data → fall back to
//! Off with a diagnostic; if there IS encrypted data → refuse to start.
//! Encryption-at-rest never silently downgrades.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::rngs::OsRng;
use rand::RngCore;
use sqlx::SqlitePool;
use std::{fs, path::Path};
use zeroize::Zeroize;

use crate::db::DbError;

/// 6-byte magic prefixing every encrypted blob file, so a reader can tell an
/// encrypted blob from a plaintext one. The stored `content_hash` is always the
/// hash of the *plaintext*, so `check_file_state` decrypts before hashing.
const BLOB_MAGIC: &[u8; 6] = b"CDENC1";
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
/// Keychain account holding the base64-encoded 32-byte master key.
const KEYCHAIN_ACCOUNT: &str = "local-encryption-master-key";

/// Column-prefix for encrypted SQLite text values.
const COL_PREFIX: &str = "enc:v1:";

/// Whether encryption-at-rest is active. `Off` is identity (plaintext passthrough);
/// `On` is real AES-256-GCM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncryptionTier {
    Off,
    On,
}

/// A 256-bit AES key. Zeroized on drop.
#[derive(Clone)]
pub struct EncryptionKey(pub [u8; KEY_LEN]);

impl std::fmt::Debug for EncryptionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("EncryptionKey(<redacted>)")
    }
}

impl Drop for EncryptionKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Why `Encryption::init` could not produce an `On` instance. The caller applies
/// the non-silent-downgrade policy (fallback vs refuse) based on whether
/// encrypted data already exists.
#[derive(Debug)]
pub enum EncryptionInitError {
    /// The OS keychain backend is unavailable (no secret store, locked, denied).
    KeyUnavailable(String),
    /// The stored keychain entry exists but is not valid 256-bit key material.
    CorruptKeyMaterial(String),
}

/// The encryption capability held by `AppState`. Cheap to clone (the key is
/// 32 bytes); repos take `&Encryption` and encrypt on write / decrypt on read.
#[derive(Clone)]
pub struct Encryption {
    tier: EncryptionTier,
    key: Option<EncryptionKey>,
    /// Monotonic version stamped onto encrypted rows (`enc_key_version` column)
    /// so rotation is resumable. `0` when `tier == Off`.
    key_version: u32,
}

impl std::fmt::Debug for Encryption {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Encryption")
            .field("tier", &self.tier)
            .field("has_key", &self.key.is_some())
            .field("key_version", &self.key_version)
            .finish()
    }
}

impl Encryption {
    /// Identity encryption (tier Off). No key, no keychain access. The path used
    /// by tests and the consumer-edition default.
    pub fn off() -> Self {
        Self {
            tier: EncryptionTier::Off,
            key: None,
            key_version: 0,
        }
    }

    /// Construct an `On` instance from an explicit key + version. Used by tests
    /// and by `rotate` (the new key is generated then handed in).
    pub fn on_with_key(key: EncryptionKey, key_version: u32) -> Self {
        Self {
            tier: EncryptionTier::On,
            key: Some(key),
            key_version,
        }
    }

    /// Initialize encryption for the configured tier. `On` loads (or generates
    /// and stores) the master key from the OS keychain under `service` /
    /// `local-encryption-master-key`. A missing entry is generated on first run;
    /// a keychain backend failure surfaces as `KeyUnavailable` so the caller can
    /// apply the non-silent-downgrade policy.
    pub fn init(service: &str, tier: EncryptionTier) -> Result<Self, EncryptionInitError> {
        if tier == EncryptionTier::Off {
            return Ok(Self::off());
        }
        let key = load_or_create_key(service)?;
        Ok(Self::on_with_key(key, 1))
    }

    pub fn tier(&self) -> EncryptionTier {
        self.tier
    }

    pub fn key_version(&self) -> u32 {
        self.key_version
    }

    pub fn is_on(&self) -> bool {
        self.tier == EncryptionTier::On && self.key.is_some()
    }

    // --- column values --------------------------------------------------------

    /// Encrypt a text column value. `Off` → plaintext passthrough. `On` →
    /// `enc:v1:<nonce>:<ciphertext+tag>`. `None` (SQL NULL) stays `None` (never
    /// encrypted — NULL is not data).
    pub fn encrypt_opt(&self, plaintext: Option<&str>) -> Result<Option<String>, DbError> {
        match plaintext {
            None => Ok(None),
            Some(s) => self.encrypt(s).map(Some),
        }
    }

    pub fn encrypt(&self, plaintext: &str) -> Result<String, DbError> {
        if self.tier == EncryptionTier::Off {
            return Ok(plaintext.to_string());
        }
        let key = self.key.as_ref().ok_or_else(|| {
            DbError::Query("encryption tier is On but no key is loaded".to_string())
        })?;
        let cipher = Aes256Gcm::new(&key.0.into());
        let mut nonce_bytes = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = cipher
            .encrypt(nonce, plaintext.as_bytes())
            .map_err(|e| DbError::Query(format!("aes-gcm encrypt: {e}")))?;
        Ok(format!(
            "{COL_PREFIX}{}:{}",
            B64.encode(nonce_bytes),
            B64.encode(&ciphertext)
        ))
    }

    /// Decrypt a stored column value. Values without the `enc:v1:` prefix are
    /// returned as-is (handles `Off`, legacy plaintext, and NULL-as-empty). This
    /// is what makes the tier flip non-destructive: turning On does not require
    /// rewriting every row immediately, and `decrypt` tolerates a mixed store.
    pub fn decrypt(&self, stored: &str) -> Result<String, DbError> {
        if !stored.starts_with(COL_PREFIX) {
            return Ok(stored.to_string());
        }
        let key = self.key.as_ref().ok_or_else(|| {
            DbError::Query("encrypted value present but no key is loaded".to_string())
        })?;
        let rest = &stored[COL_PREFIX.len()..];
        let (nonce_b64, ct_b64) = rest
            .split_once(':')
            .ok_or_else(|| DbError::Query("malformed encrypted value".to_string()))?;
        let nonce_bytes = B64
            .decode(nonce_b64)
            .map_err(|e| DbError::Query(format!("decode nonce: {e}")))?;
        let ciphertext = B64
            .decode(ct_b64)
            .map_err(|e| DbError::Query(format!("decode ciphertext: {e}")))?;
        let cipher = Aes256Gcm::new(&key.0.into());
        let plaintext = cipher
            .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
            .map_err(|e| DbError::Query(format!("aes-gcm decrypt: {e}")))?;
        String::from_utf8(plaintext).map_err(|e| DbError::Query(format!("utf8: {e}")))
    }

    /// Decrypt an `Option<String>` column; `None` stays `None`.
    pub fn decrypt_opt(&self, stored: Option<&str>) -> Result<Option<String>, DbError> {
        match stored {
            None => Ok(None),
            Some(s) => self.decrypt(s).map(Some),
        }
    }

    // --- blob files -----------------------------------------------------------

    /// Encode `plaintext` bytes as an on-disk encrypted blob (`On`), or return
    /// them unchanged (`Off`). Format: `<CDENC1><12-byte nonce><ciphertext>`.
    pub fn encode_blob(&self, plaintext: &[u8]) -> Result<Vec<u8>, DbError> {
        if self.tier == EncryptionTier::Off {
            return Ok(plaintext.to_vec());
        }
        let key = self.key.as_ref().ok_or_else(|| {
            DbError::Query("encryption tier is On but no key is loaded".to_string())
        })?;
        let cipher = Aes256Gcm::new(&key.0.into());
        let mut nonce_bytes = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce_bytes);
        let ct = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), plaintext)
            .map_err(|e| DbError::Query(format!("aes-gcm encrypt blob: {e}")))?;
        let mut out = Vec::with_capacity(BLOB_MAGIC.len() + NONCE_LEN + ct.len());
        out.extend_from_slice(BLOB_MAGIC);
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ct);
        Ok(out)
    }

    /// Decode a blob read from disk. Files without the `CDENC1` magic are
    /// treated as plaintext (handles `Off` and legacy blobs under `On`).
    pub fn decode_blob(&self, bytes: &[u8]) -> Result<Vec<u8>, DbError> {
        if bytes.len() < BLOB_MAGIC.len() + NONCE_LEN || &bytes[..BLOB_MAGIC.len()] != BLOB_MAGIC {
            // Plaintext (Off, or a legacy blob written before encryption was On).
            return Ok(bytes.to_vec());
        }
        let key = self.key.as_ref().ok_or_else(|| {
            DbError::Query("encrypted blob present but no key is loaded".to_string())
        })?;
        let nonce_bytes = &bytes[BLOB_MAGIC.len()..BLOB_MAGIC.len() + NONCE_LEN];
        let ciphertext = &bytes[BLOB_MAGIC.len() + NONCE_LEN..];
        let cipher = Aes256Gcm::new(&key.0.into());
        cipher
            .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
            .map_err(|e| DbError::Query(format!("aes-gcm decrypt blob: {e}")))
    }
}

// --- keychain wrap -----------------------------------------------------------

fn load_or_create_key(service: &str) -> Result<EncryptionKey, EncryptionInitError> {
    let entry = keyring::Entry::new(service, KEYCHAIN_ACCOUNT)
        .map_err(|e| EncryptionInitError::KeyUnavailable(e.to_string()))?;
    match entry.get_password() {
        Ok(stored) => return decode_stored_key(&stored),
        Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(EncryptionInitError::KeyUnavailable(e.to_string())),
    }
    // First run: generate a fresh key and store it.
    let mut key_bytes = [0u8; KEY_LEN];
    OsRng.fill_bytes(&mut key_bytes);
    entry
        .set_password(&B64.encode(key_bytes))
        .map_err(|e| EncryptionInitError::KeyUnavailable(e.to_string()))?;
    Ok(EncryptionKey(key_bytes))
}

fn decode_stored_key(stored: &str) -> Result<EncryptionKey, EncryptionInitError> {
    let key_bytes = B64.decode(stored).map_err(|e| {
        EncryptionInitError::CorruptKeyMaterial(format!("stored key is not valid base64: {e}"))
    })?;
    if key_bytes.len() != KEY_LEN {
        return Err(EncryptionInitError::CorruptKeyMaterial(format!(
            "stored key has {} bytes, expected {KEY_LEN}",
            key_bytes.len()
        )));
    }
    let mut arr = [0u8; KEY_LEN];
    arr.copy_from_slice(&key_bytes);
    Ok(EncryptionKey(arr))
}

/// Generate a fresh random key without touching the keychain. Used by `rotate`.
pub fn generate_key() -> EncryptionKey {
    let mut key_bytes = [0u8; KEY_LEN];
    OsRng.fill_bytes(&mut key_bytes);
    EncryptionKey(key_bytes)
}

/// Overwrite the keychain entry with a new wrapped key (rotation).
pub fn store_key(service: &str, key: &EncryptionKey) -> Result<(), EncryptionInitError> {
    let entry = keyring::Entry::new(service, KEYCHAIN_ACCOUNT)
        .map_err(|e| EncryptionInitError::KeyUnavailable(e.to_string()))?;
    entry
        .set_password(&B64.encode(key.0))
        .map_err(|e| EncryptionInitError::KeyUnavailable(e.to_string()))
}

/// The non-silent-downgrade policy (spec §7.2). Given an attempted `init` that
/// failed with `KeyUnavailable`, and whether any encrypted data already exists
/// on disk/in the DB, decide: fall back to `Off` (safe — nothing to lose) or
/// refuse (encrypted data would become unreadable). Never silently downgrade.
///
/// Returns the `Encryption` to use (always `Off` on fallback) and a diagnostic
/// string the caller can surface. `Err` means *refuse to start*.
pub fn resolve_key_unavailable(
    err: EncryptionInitError,
    encrypted_data_exists: bool,
) -> Result<(Encryption, String), EncryptionInitError> {
    if !matches!(err, EncryptionInitError::KeyUnavailable(_)) {
        return Err(err);
    }
    match encrypted_data_exists {
        false => Ok((
            Encryption::off(),
            format!(
                "Encryption-at-rest is configured On but the OS keychain is unavailable \
                 ({:?}). Starting unencrypted — no existing encrypted data was found. \
                 Re-enroll your key to enable encryption.",
                err
            ),
        )),
        true => Err(err),
    }
}

// --- existing-data migration + rotation --------------------------------------
//
// These walk the inline encrypted columns (artifact inline content, tenant
// config, license token) and re-key rows whose `enc_key_version` is NULL or
// stale. Because `decrypt` is prefix-aware (plaintext passes through), the same
// re-key loop handles both the initial Off→On migration and vN→vN+1 rotation.
// Blob-file re-keying is handled by the same `decode_blob`/`encode_blob` pair;
// for v1 these helpers cover the inline columns, which is what the rotation /
// tier-upgrade tests assert on.

/// Whether any encrypted data already exists in the local store. This covers
/// both inline encrypted columns (`enc_key_version IS NOT NULL`) and encrypted
/// blob files (attachments + file-backed artifact versions with the `CDENC1`
/// magic). Drives the non-silent-downgrade decision at startup.
pub async fn encrypted_data_exists(
    pool: &SqlitePool,
    attachments_dir: &Path,
    artifacts_dir: &Path,
) -> Result<bool, DbError> {
    let row: (i64,) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM artifact_versions WHERE enc_key_version IS NOT NULL) \
         + (SELECT COUNT(*) FROM tenant_config_cache WHERE enc_key_version IS NOT NULL) \
         + (SELECT COUNT(*) FROM licenses WHERE enc_key_version IS NOT NULL)",
    )
    .fetch_one(pool)
    .await?;
    if row.0 > 0 {
        return Ok(true);
    }

    let attachment_paths: Vec<(String,)> = sqlx::query_as("SELECT path FROM attachments")
        .fetch_all(pool)
        .await?;
    if attachment_paths
        .iter()
        .any(|(path,)| blob_uses_encryption_magic(&attachments_dir.join(path)))
    {
        return Ok(true);
    }

    let artifact_paths: Vec<(String,)> =
        sqlx::query_as("SELECT content_path FROM artifact_versions WHERE content_path IS NOT NULL")
            .fetch_all(pool)
            .await?;
    Ok(artifact_paths
        .iter()
        .any(|(path,)| blob_uses_encryption_magic(&artifacts_dir.join(path))))
}

fn blob_uses_encryption_magic(path: &Path) -> bool {
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    bytes.starts_with(BLOB_MAGIC)
}

/// Re-encrypt every targeted inline row whose `enc_key_version` is NULL (i.e.
/// plaintext written while tier was Off) up to `enc.key_version()`. Idempotent:
/// rows already keyed are skipped. Returns the number of rows re-keyed. A no-op
/// when `enc.tier() == Off` (nothing to encrypt to).
pub async fn encrypt_existing_plaintext(
    pool: &SqlitePool,
    enc: &Encryption,
) -> Result<u64, DbError> {
    if !enc.is_on() {
        return Ok(0);
    }
    let version = enc.key_version() as i64;
    let mut count = 0u64;

    // artifact_versions: two inline columns (content_text, content_json).
    let rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT id, content_text, content_json FROM artifact_versions \
         WHERE enc_key_version IS NULL",
    )
    .fetch_all(pool)
    .await?;
    for (id, text, json) in rows {
        let etext = enc.encrypt_opt(text.as_deref())?;
        let ejson = match json {
            Some(_) => enc.encrypt_opt(json.as_deref())?,
            None => None,
        };
        sqlx::query(
            "UPDATE artifact_versions SET content_text = ?, content_json = ?, \
             enc_key_version = ? WHERE id = ?",
        )
        .bind(&etext)
        .bind(&ejson)
        .bind(version)
        .bind(&id)
        .execute(pool)
        .await?;
        count += 1;
    }

    // tenant_config_cache: one inline column (config_json).
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT id, config_json FROM tenant_config_cache WHERE enc_key_version IS NULL",
    )
    .fetch_all(pool)
    .await?;
    for (id, json) in rows {
        let ejson = enc.encrypt_opt(json.as_deref())?;
        sqlx::query("UPDATE tenant_config_cache SET config_json = ?, enc_key_version = ? WHERE id = ?")
            .bind(&ejson)
            .bind(version)
            .bind(&id)
            .execute(pool)
            .await?;
        count += 1;
    }

    // licenses: one inline column (token).
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT id, token FROM licenses WHERE enc_key_version IS NULL",
    )
    .fetch_all(pool)
    .await?;
    for (id, token) in rows {
        let etoken = enc.encrypt_opt(token.as_deref())?;
        sqlx::query("UPDATE licenses SET token = ?, enc_key_version = ? WHERE id = ?")
            .bind(&etoken)
            .bind(version)
            .bind(&id)
            .execute(pool)
            .await?;
        count += 1;
    }

    Ok(count)
}

/// Rotate every targeted inline row from `old.key_version()` to
/// `new.key_version()`: decrypt with `old`, re-encrypt with `new`, stamp the new
/// version. Rows at other versions (including NULL/plaintext) are left alone —
/// call `encrypt_existing_plaintext` first to bring plaintext up to `old`.
pub async fn rotate(
    pool: &SqlitePool,
    old: &Encryption,
    new: &Encryption,
) -> Result<u64, DbError> {
    if !old.is_on() || !new.is_on() {
        return Ok(0);
    }
    let from_version = old.key_version() as i64;
    let to_version = new.key_version() as i64;
    let mut count = 0u64;

    let rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT id, content_text, content_json FROM artifact_versions WHERE enc_key_version = ?",
    )
    .bind(from_version)
    .fetch_all(pool)
    .await?;
    for (id, text, json) in rows {
        let pt = old.decrypt_opt(text.as_deref())?;
        let pj = old.decrypt_opt(json.as_deref())?;
        let et = new.encrypt_opt(pt.as_deref())?;
        let ej = new.encrypt_opt(pj.as_deref())?;
        sqlx::query(
            "UPDATE artifact_versions SET content_text = ?, content_json = ?, \
             enc_key_version = ? WHERE id = ?",
        )
        .bind(&et)
        .bind(&ej)
        .bind(to_version)
        .bind(&id)
        .execute(pool)
        .await?;
        count += 1;
    }

    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT id, config_json FROM tenant_config_cache WHERE enc_key_version = ?",
    )
    .bind(from_version)
    .fetch_all(pool)
    .await?;
    for (id, json) in rows {
        let plain = old.decrypt_opt(json.as_deref())?;
        let ejson = new.encrypt_opt(plain.as_deref())?;
        sqlx::query("UPDATE tenant_config_cache SET config_json = ?, enc_key_version = ? WHERE id = ?")
            .bind(&ejson)
            .bind(to_version)
            .bind(&id)
            .execute(pool)
            .await?;
        count += 1;
    }

    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT id, token FROM licenses WHERE enc_key_version = ?",
    )
    .bind(from_version)
    .fetch_all(pool)
    .await?;
    for (id, token) in rows {
        let plain = old.decrypt_opt(token.as_deref())?;
        let etoken = new.encrypt_opt(plain.as_deref())?;
        sqlx::query("UPDATE licenses SET token = ?, enc_key_version = ? WHERE id = ?")
            .bind(&etoken)
            .bind(to_version)
            .bind(&id)
            .execute(pool)
            .await?;
        count += 1;
    }

    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_stored_key_rejects_malformed_material() {
        let err = decode_stored_key("not-base64").unwrap_err();
        assert!(matches!(err, EncryptionInitError::CorruptKeyMaterial(_)));

        let err = decode_stored_key(&B64.encode([7_u8; 8])).unwrap_err();
        assert!(matches!(err, EncryptionInitError::CorruptKeyMaterial(_)));
    }

    #[test]
    fn corrupt_key_material_never_falls_back_to_off() {
        let err = EncryptionInitError::CorruptKeyMaterial("bad key".into());
        assert!(resolve_key_unavailable(err, false).is_err());
    }
}