use crate::{
    db::{self, backfill, migrations::MigrationRecovery, reconcile, recover, DbPool},
    encryption::{self, Encryption, EncryptionTier},
    paths::{resolve, AppPaths},
};
use provider_core::transport::HttpClient;
use std::{
    fs,
    sync::{Arc, Mutex},
};

// C1: `AppSettings`, `SettingsPatch`, `ProviderEndpointConfig`, and `Theme` are
// defined in `provider_core::schema` and codegen'd into `@conduit/config-schema`.
// This module owns their *behavior* (validation, persistence), not their shape.
pub use provider_core::schema::{AppSettings, SettingsPatch};

#[derive(Clone)]
pub struct AppState {
    pub paths: AppPaths,
    settings: Arc<Mutex<AppSettings>>,
    /// Shared HTTP client (connection pool + timeouts). H3/H5: one client for
    /// the whole process, reused across provider requests.
    pub http: HttpClient,
    /// Phase 3 local SQLite pool. Shared across repositories; SQLite serializes
    /// writers so the pool is a single connection.
    pub db: DbPool,
    /// Phase 3 M6: encryption-at-rest capability. Tier-gated — defaults to `Off`
    /// for the consumer edition (ADR-003 tier policy unresolved). The
    /// encrypted-column repos take `&Encryption` and encrypt on write / decrypt
    /// on read; `Off` is identity so the default path is byte-identical to
    /// plaintext storage.
    pub encryption: Arc<Encryption>,
    /// Set when a migration failed at startup and the live DB was rolled back to
    /// a fresh store (with a `.corrupt-<unix>.bak` backup). The renderer reads
    /// this once to show the user-safe failure dialog. `None` on the happy path.
    pub migration_recovery: Option<MigrationRecovery>,
}

impl AppState {
    /// Initialize paths, settings, HTTP client, and the SQLite pool (running
    /// migrations + the startup integrity check). Async because pool init and
    /// migrations are async; `main.rs` drives it via `tauri::async_runtime`.
    pub async fn load(app_name: &str) -> Result<Self, String> {
        let paths = resolve(app_name)?;
        let settings = read_settings(&paths).unwrap_or_default();

        let (db, migration_recovery) = db::migrations::open_with_migrations(&paths.database)
            .await
            .map_err(|e| format!("failed to initialize local database: {e}"))?;

        // M3 startup sweep: import legacy file journals, verify the persistence
        // invariant across every turn, and recover any interrupted streams. All
        // three are idempotent and best-effort — a failure degrades gracefully
        // (the app still starts) and the next start retries. On the happy path
        // (no legacy data, clean shutdown) each is a cheap no-op.
        let _ = backfill::backfill_legacy_streams(&db, &paths.streams).await;
        let _ = reconcile::reconcile_all(&db).await;
        let _ = recover::recover_interrupted_streams(&db).await;

        // M6: initialize encryption-at-rest. The tier is read from the raw
        // settings JSON (`encryptionAtRest: bool`, camelCase) so the knob lives
        // in the desktop settings layer without a provider-core codegen ripple;
        // it defaults to Off (ADR-003 tier policy unresolved). On tier=On the
        // master key is loaded from — or generated into — the OS keychain. If
        // the keychain is unavailable, apply the non-silent-downgrade policy:
        // fall back to Off only when no encrypted data exists, else refuse.
        let tier = read_encryption_tier(&paths);
        let encryption = match Encryption::init(app_name, tier) {
            Ok(enc) => enc,
            Err(err) => {
                let exists = encryption::encrypted_data_exists(&db, &paths.attachments, &paths.artifacts)
                    .await
                    .unwrap_or(false);
                encryption::resolve_key_unavailable(err, exists)
                    .map(|(enc, diagnostic)| {
                        eprintln!("conduit: encryption-at-rest fallback — {diagnostic}");
                        enc
                    })
                    .map_err(|e| format!(
                        "Conduit cannot unlock your local data: the OS keychain is unavailable \
                         ({e:?}). Re-enroll your key or restore from backup."
                    ))?
            }
        };
        // If tier is On and plaintext rows exist (e.g. upgraded from Off),
        // bring them up to the current key version. Idempotent + resumable.
        if encryption.is_on() {
            let _ = encryption::encrypt_existing_plaintext(&db, &encryption).await;
        }

        Ok(Self {
            paths,
            settings: Arc::new(Mutex::new(settings)),
            http: HttpClient::new(),
            db,
            encryption: Arc::new(encryption),
            migration_recovery,
        })
    }

    /// Build an `AppState` from already-initialized parts, bypassing the
    /// settings file / keychain. Intended for integration tests that only need
    /// the db pool + paths (e.g. the connector runtime supervisor tests).
    #[doc(hidden)]
    pub fn test_instance(db: DbPool, paths: AppPaths) -> Self {
        Self {
            paths,
            settings: Arc::new(Mutex::new(AppSettings::default())),
            http: HttpClient::new(),
            db,
            encryption: Arc::new(Encryption::off()),
            migration_recovery: None,
        }
    }

    pub fn settings(&self) -> Result<AppSettings, String> {
        self.settings
            .lock()
            .map(|guard| guard.clone())
            .map_err(|_| "Settings lock poisoned".to_string())
    }

    pub fn update_settings(&self, patch: SettingsPatch) -> Result<AppSettings, String> {
        let mut settings = self
            .settings
            .lock()
            .map_err(|_| "Settings lock poisoned".to_string())?;

        // Validate and update active_provider
        if let Some(value) = patch.active_provider {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Err("Provider ID cannot be empty".to_string());
            }
            settings.active_provider = trimmed.to_string();
        }

        // Validate and update active_model
        if let Some(value) = patch.active_model {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Err("Model ID cannot be empty".to_string());
            }
            settings.active_model = trimmed.to_string();
        }

        if let Some(value) = patch.local_only {
            settings.local_only = value;
        }
        if let Some(value) = patch.diagnostics_enabled {
            settings.diagnostics_enabled = value;
        }

        // `Theme` is an enum, so serde rejects invalid values at deserialization;
        // here we only need to apply it.
        if let Some(value) = patch.theme {
            settings.theme = value;
        }

        if let Some(value) = patch.provider_endpoints {
            for (provider_id, config) in value {
                if let Some(base_url) = &config.base_url {
                    let trimmed = base_url.trim();
                    if !trimmed.is_empty()
                        && !trimmed.starts_with("http://")
                        && !trimmed.starts_with("https://")
                    {
                        return Err(format!(
              "Invalid base URL for {provider_id}: must start with http:// or https://"
            ));
                    }
                }
                settings.provider_endpoints.insert(provider_id, config);
            }
        }

        write_settings(&self.paths, &settings)?;
        Ok(settings.clone())
    }
}

fn read_settings(paths: &AppPaths) -> Result<AppSettings, String> {
    if !paths.settings_file.exists() {
        return Ok(AppSettings::default());
    }

    let raw = fs::read_to_string(&paths.settings_file).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn write_settings(paths: &AppPaths, settings: &AppSettings) -> Result<(), String> {
    let mut merged = read_raw_settings_json(paths).unwrap_or_default();
    let typed = serde_json::to_value(settings).map_err(|error| error.to_string())?;
    let typed = typed
        .as_object()
        .ok_or_else(|| "settings did not serialize to an object".to_string())?;
    for (key, value) in typed {
        merged.insert(key.clone(), value.clone());
    }
    let serialized = serde_json::to_string_pretty(&serde_json::Value::Object(merged))
        .map_err(|error| error.to_string())?;
    fs::write(&paths.settings_file, serialized).map_err(|error| error.to_string())
}

fn read_raw_settings_json(
    paths: &AppPaths,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    if !paths.settings_file.exists() {
        return Ok(serde_json::Map::new());
    }
    let raw = fs::read_to_string(&paths.settings_file).map_err(|error| error.to_string())?;
    let value = serde_json::from_str::<serde_json::Value>(&raw).map_err(|error| error.to_string())?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "settings file must contain a JSON object".to_string())
}

/// Read the encryption-at-rest tier from the raw settings JSON. The knob is
/// `encryptionAtRest: bool` (camelCase, matching the rest of the settings
/// file); it is **not** part of the codegen'd `AppSettings` struct yet, so it
/// is read directly from the JSON Value to avoid a provider-core schema ripple.
/// Missing or unparseable → `Off` (the consumer-edition default; ADR-003 tier
/// policy is unresolved). Promoting this to a typed `AppSettings` field is the
/// ADR-003 follow-up.
fn read_encryption_tier(paths: &AppPaths) -> EncryptionTier {
    let Ok(value) = read_raw_settings_json(paths) else {
        return EncryptionTier::Off;
    };
    match value.get("encryptionAtRest").and_then(|v| v.as_bool()) {
        Some(true) => EncryptionTier::On,
        _ => EncryptionTier::Off,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn test_paths(root: &Path) -> AppPaths {
        AppPaths {
            root: root.to_path_buf(),
            settings_file: root.join("settings.json"),
            database: root.join("conduit.sqlite"),
            attachments: root.join("attachments"),
            artifacts: root.join("artifacts"),
            logs: root.join("logs"),
            diagnostics: root.join("diagnostics"),
            updates: root.join("updates"),
            streams: root.join("streams"),
            connectors: root.join("connectors"),
        }
    }

    #[test]
    fn write_settings_preserves_encryption_at_rest_flag() {
        let dir = tempfile::tempdir().unwrap();
        let paths = test_paths(dir.path());
        fs::write(
            &paths.settings_file,
            r#"{
  "activeProvider": "anthropic",
  "activeModel": "claude-sonnet-4",
  "localOnly": true,
  "diagnosticsEnabled": true,
  "theme": "system",
  "providerEndpoints": {},
  "encryptionAtRest": true
}"#,
        )
        .unwrap();

        let mut settings = AppSettings::default();
        settings.active_model = "claude-opus-4".into();
        write_settings(&paths, &settings).unwrap();

        let written = fs::read_to_string(&paths.settings_file).unwrap();
        let value: serde_json::Value = serde_json::from_str(&written).unwrap();
        assert_eq!(
            value.get("encryptionAtRest").and_then(|v| v.as_bool()),
            Some(true),
            "unknown settings keys survive typed settings writes"
        );
        assert_eq!(
            value.get("activeModel").and_then(|v| v.as_str()),
            Some("claude-opus-4")
        );
        assert_eq!(read_encryption_tier(&paths), EncryptionTier::On);
    }
}
