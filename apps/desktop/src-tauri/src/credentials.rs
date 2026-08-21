//! Provider-secret storage.
//!
//! Two backends, chosen by `AppSettings.keychain_mode` (V9 design spec §2.6):
//!
//! * **`Os`** — the platform keychain. The default, and the only mode with real
//!   OS-level protection: the secret is guarded by the user's login session and
//!   never sits on disk in a form this process can read unaided.
//!
//! * **`File`** — an AES-256-GCM blob under the app's data directory, for
//!   machines with no usable keychain: headless CI, a locked-down container, a
//!   Linux box with no Secret Service running. Strictly weaker, and the app
//!   says so rather than implying parity.
//!
//! ## Where the file mode's key comes from, and why not a file
//!
//! `encryption.rs` wraps its master key in the OS keychain. File mode cannot do
//! the same — needing no keychain is the entire reason it exists — so the key
//! comes from the environment: `CONDUIT_CREDENTIAL_KEY`, base64, 32 bytes.
//!
//! It deliberately does **not** fall back to a key file beside the ciphertext.
//! A key stored next to what it encrypts protects against nothing an attacker
//! who can read one cannot also do to the other; it would convert "encrypted at
//! rest" from a claim into a costume, and the Privacy row would be misreporting
//! the protection the user actually has. Without the variable, file mode fails
//! loudly and stores nothing.
//!
//! ## No silent downgrade, and no silent migration
//!
//! If file mode is selected and the key is absent or malformed, every operation
//! errors — it never quietly writes to the keychain instead, which would put a
//! secret somewhere the user did not choose. This mirrors the policy
//! `EncryptionInitError::KeyUnavailable` already establishes for the database.
//!
//! Switching modes does not move existing secrets. Re-encrypting them into a
//! different store is a decision about where a secret lives, and a settings
//! toggle is not consent for it; after a switch the new store simply reports no
//! secret and the key is re-entered.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use keyring::Entry;
use rand::RngCore;

// C1: `CredentialSummary` is defined in `provider_core::schema` and codegen'd
// into `@conduit/config-schema`.
pub use provider_core::schema::CredentialSummary;
pub use provider_core::schema::KeychainMode;

/// OS keychain service name. The sole source of truth for stored provider
/// secrets (keyed by provider_id). Centralized so the BYOK onboarding gate
/// (`AppState::has_any_provider_credential`) and the save/load commands agree.
pub const KEYCHAIN_SERVICE: &str = "conduit";

/// Base64-encoded 32-byte key for `KeychainMode::File`. Read from the
/// environment on every operation so a process started without it cannot
/// silently keep using a key from an earlier run.
pub const FILE_KEY_ENV: &str = "CONDUIT_CREDENTIAL_KEY";

/// Filename of the encrypted store inside the app data directory.
const FILE_STORE_NAME: &str = "credentials.enc";

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;

pub struct CredentialStore {
    service_name: String,
    mode: KeychainMode,
    /// Data directory for `File` mode. `None` in `Os` mode, where it is unused.
    data_dir: Option<PathBuf>,
}

impl CredentialStore {
    pub fn new(service_name: impl Into<String>) -> Self {
        Self {
            service_name: service_name.into(),
            mode: KeychainMode::Os,
            data_dir: None,
        }
    }

    /// Construct a store for the canonical Conduit keychain service.
    pub fn default_service() -> Self {
        Self::new(KEYCHAIN_SERVICE)
    }

    /// Select the backend. `File` also needs `with_data_dir`; without it the
    /// store reports a configuration error rather than guessing a location.
    pub fn with_mode(mut self, mode: KeychainMode) -> Self {
        self.mode = mode;
        self
    }

    pub fn with_data_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.data_dir = Some(dir.into());
        self
    }

    pub fn mode(&self) -> KeychainMode {
        self.mode
    }

    pub fn save_provider_secret(
        &self,
        provider_id: &str,
        secret: &str,
    ) -> Result<CredentialSummary, String> {
        match self.mode {
            KeychainMode::Os => {
                let entry = Entry::new(&self.service_name, provider_id)
                    .map_err(|error| error.to_string())?;
                entry
                    .set_password(secret)
                    .map_err(|error| error.to_string())?;
            }
            KeychainMode::File => {
                let mut map = self.read_file_store()?;
                map.insert(provider_id.to_string(), secret.to_string());
                self.write_file_store(&map)?;
            }
        }

        Ok(CredentialSummary {
            provider_id: provider_id.to_string(),
            credential_ref: self.reference(provider_id),
            stored_in_keychain: self.mode == KeychainMode::Os,
        })
    }

    /// Where this provider's secret lives, as shown in the UI. The scheme is
    /// the honest part: `file://` must never read as `keychain://`, because the
    /// status line and Providers page are the only places the weaker posture is
    /// visible.
    pub fn reference(&self, provider_id: &str) -> String {
        match self.mode {
            KeychainMode::Os => format!("keychain://{}/{}", self.service_name, provider_id),
            KeychainMode::File => match self.store_path() {
                Ok(path) => format!("file://{}", path.display()),
                Err(_) => "file://(data directory unavailable)".to_string(),
            },
        }
    }

    pub fn has_provider_secret(&self, provider_id: &str) -> bool {
        match self.mode {
            KeychainMode::Os => {
                let Ok(entry) = Entry::new(&self.service_name, provider_id) else {
                    return false;
                };
                entry.get_password().is_ok()
            }
            // A missing key, an unreadable file or a failed decrypt all mean the
            // same thing to a caller asking "is a secret available?" — no.
            KeychainMode::File => self
                .read_file_store()
                .map(|map| map.contains_key(provider_id))
                .unwrap_or(false),
        }
    }

    /// Retrieve a secret for provider API calls.
    /// Returns Err if the secret doesn't exist or can't be retrieved.
    pub fn get_secret(&self, provider_id: &str) -> Result<String, String> {
        match self.mode {
            KeychainMode::Os => {
                let entry = Entry::new(&self.service_name, provider_id)
                    .map_err(|error| format!("Failed to access keychain: {error}"))?;
                entry
                    .get_password()
                    .map_err(|error| format!("Failed to retrieve secret: {error}"))
            }
            KeychainMode::File => self
                .read_file_store()?
                .get(provider_id)
                .cloned()
                .ok_or_else(|| format!("No stored secret for provider {provider_id}")),
        }
    }

    // --- file backend ------------------------------------------------------

    fn store_path(&self) -> Result<PathBuf, String> {
        let dir = self.data_dir.as_ref().ok_or_else(|| {
            "File credential store selected but no data directory was configured".to_string()
        })?;
        Ok(dir.join(FILE_STORE_NAME))
    }

    /// The 32-byte key from the environment. Absent or malformed is a hard
    /// error: the alternative is writing a secret somewhere weaker than the
    /// user asked for, without telling them.
    fn file_key(&self) -> Result<[u8; KEY_LEN], String> {
        let raw = std::env::var(FILE_KEY_ENV).map_err(|_| {
            format!(
                "{FILE_KEY_ENV} is not set. The file-backed credential store takes its key from \
                 the environment — set it to a base64-encoded 32-byte value, or switch back to \
                 the OS keychain in Privacy & data."
            )
        })?;
        let bytes = B64
            .decode(raw.trim())
            .map_err(|e| format!("{FILE_KEY_ENV} is not valid base64: {e}"))?;
        if bytes.len() != KEY_LEN {
            return Err(format!(
                "{FILE_KEY_ENV} decodes to {} bytes, expected {KEY_LEN}",
                bytes.len()
            ));
        }
        let mut key = [0u8; KEY_LEN];
        key.copy_from_slice(&bytes);
        Ok(key)
    }

    fn read_file_store(&self) -> Result<BTreeMap<String, String>, String> {
        let path = self.store_path()?;
        let key = self.file_key()?;
        if !path_exists(&path) {
            return Ok(BTreeMap::new());
        }
        let blob = std::fs::read(&path)
            .map_err(|e| format!("Failed to read the credential store: {e}"))?;
        if blob.len() < NONCE_LEN {
            return Err("The credential store is truncated or corrupt".to_string());
        }
        let (nonce_bytes, ciphertext) = blob.split_at(NONCE_LEN);
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        let plaintext = cipher
            .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
            .map_err(|_| {
                format!(
                    "Could not decrypt the credential store. This usually means {FILE_KEY_ENV} \
                     differs from the key the secrets were saved with."
                )
            })?;
        serde_json::from_slice(&plaintext)
            .map_err(|e| format!("The credential store is not valid JSON: {e}"))
    }

    fn write_file_store(&self, map: &BTreeMap<String, String>) -> Result<(), String> {
        let path = self.store_path()?;
        let key = self.file_key()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create the data directory: {e}"))?;
        }
        let plaintext = serde_json::to_vec(map)
            .map_err(|e| format!("Failed to serialize the credential store: {e}"))?;
        let mut nonce_bytes = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce_bytes);
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_ref())
            .map_err(|e| format!("Failed to encrypt the credential store: {e}"))?;
        let mut blob = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        blob.extend_from_slice(&nonce_bytes);
        blob.extend_from_slice(&ciphertext);
        std::fs::write(&path, blob)
            .map_err(|e| format!("Failed to write the credential store: {e}"))?;
        Ok(())
    }
}

fn path_exists(path: &Path) -> bool {
    std::fs::metadata(path).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The env var is process-global, so these run under one lock and always
    /// restore it — a leaked key would make an unrelated test pass for the
    /// wrong reason.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_key<T>(key: Option<&str>, f: impl FnOnce() -> T) -> T {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous = std::env::var(FILE_KEY_ENV).ok();
        match key {
            Some(k) => std::env::set_var(FILE_KEY_ENV, k),
            None => std::env::remove_var(FILE_KEY_ENV),
        }
        let out = f();
        match previous {
            Some(p) => std::env::set_var(FILE_KEY_ENV, p),
            None => std::env::remove_var(FILE_KEY_ENV),
        }
        out
    }

    fn test_key() -> String {
        B64.encode([7u8; KEY_LEN])
    }

    fn file_store(dir: &Path) -> CredentialStore {
        CredentialStore::new("conduit-test")
            .with_mode(KeychainMode::File)
            .with_data_dir(dir)
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("conduit-cred-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn file_mode_round_trips_a_secret() {
        let dir = temp_dir("roundtrip");
        with_key(Some(&test_key()), || {
            let store = file_store(&dir);
            assert!(!store.has_provider_secret("anthropic"));
            store
                .save_provider_secret("anthropic", "sk-test-123")
                .unwrap();
            assert!(store.has_provider_secret("anthropic"));
            assert_eq!(store.get_secret("anthropic").unwrap(), "sk-test-123");
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_mode_writes_no_plaintext_to_disk() {
        let dir = temp_dir("ciphertext");
        with_key(Some(&test_key()), || {
            file_store(&dir)
                .save_provider_secret("openai", "sk-super-secret-value")
                .unwrap();
        });
        let blob = std::fs::read(dir.join(FILE_STORE_NAME)).unwrap();
        let haystack = String::from_utf8_lossy(&blob);
        assert!(
            !haystack.contains("sk-super-secret-value"),
            "the secret must not be readable in the stored blob"
        );
        assert!(
            !haystack.contains("openai"),
            "provider ids leak the shape of the store"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The load-bearing one. Without the key the store must fail, not fall back
    /// to the keychain: a silent downgrade puts a secret somewhere the user did
    /// not choose.
    #[test]
    fn file_mode_without_a_key_refuses_rather_than_falling_back() {
        let dir = temp_dir("nokey");
        with_key(None, || {
            let store = file_store(&dir);
            let err = store
                .save_provider_secret("anthropic", "sk-test")
                .unwrap_err();
            assert!(
                err.contains(FILE_KEY_ENV),
                "the error must name the variable: {err}"
            );
            assert!(!store.has_provider_secret("anthropic"));
            assert!(store.get_secret("anthropic").is_err());
        });
        assert!(
            std::fs::metadata(dir.join(FILE_STORE_NAME)).is_err(),
            "nothing may be written without a key"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_wrong_key_reports_the_mismatch_instead_of_an_empty_store() {
        let dir = temp_dir("wrongkey");
        with_key(Some(&test_key()), || {
            file_store(&dir)
                .save_provider_secret("anthropic", "sk-test")
                .unwrap();
        });
        with_key(Some(&B64.encode([9u8; KEY_LEN])), || {
            let err = file_store(&dir).get_secret("anthropic").unwrap_err();
            assert!(
                err.contains(FILE_KEY_ENV),
                "the error must point at the key: {err}"
            );
            // Reporting "no secret" here would invite the user to re-enter and
            // overwrite the store they still have the real key for.
            assert!(!file_store(&dir).has_provider_secret("anthropic"));
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_malformed_key_is_rejected_by_length() {
        let dir = temp_dir("shortkey");
        with_key(Some(&B64.encode([1u8; 16])), || {
            let err = file_store(&dir).save_provider_secret("x", "y").unwrap_err();
            assert!(err.contains("expected 32"), "{err}");
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_reference_names_the_backend_honestly() {
        let dir = temp_dir("reference");
        let os = CredentialStore::new("conduit-test");
        assert!(os.reference("anthropic").starts_with("keychain://"));
        let file = file_store(&dir);
        assert!(
            file.reference("anthropic").starts_with("file://"),
            "a file-backed secret must not read as keychain-backed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_mode_needs_a_data_directory() {
        with_key(Some(&test_key()), || {
            let store = CredentialStore::new("conduit-test").with_mode(KeychainMode::File);
            assert!(store
                .save_provider_secret("a", "b")
                .unwrap_err()
                .contains("data directory"));
        });
    }

    #[test]
    fn several_providers_share_one_store() {
        let dir = temp_dir("multi");
        with_key(Some(&test_key()), || {
            let store = file_store(&dir);
            store.save_provider_secret("anthropic", "sk-a").unwrap();
            store.save_provider_secret("openai", "sk-o").unwrap();
            assert_eq!(store.get_secret("anthropic").unwrap(), "sk-a");
            assert_eq!(store.get_secret("openai").unwrap(), "sk-o");
        });
        let _ = std::fs::remove_dir_all(&dir);
    }
}
