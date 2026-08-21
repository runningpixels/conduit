use crate::{
    credentials,
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
    /// this to show the user-safe failure dialog. `None` on the happy path.
    ///
    /// Interior-mutable so the renderer can *dismiss* it. Reloading the webview
    /// does not rebuild `AppState`, so a plain `Option` fixed at startup left
    /// the user in a loop: the dialog's only button reloaded the page, the
    /// reload re-read the same `Some(..)`, and the dialog came straight back
    /// with no way through to the app.
    migration_recovery: Arc<Mutex<Option<MigrationRecovery>>>,
}

impl AppState {
    /// Convenience accessor for the database pool, so callers can get a
    /// handle without a partial move of the struct field.
    pub fn db(&self) -> DbPool {
        self.db.clone()
    }

    /// The pending migration-recovery notice, if the user has not dismissed it.
    pub fn migration_recovery(&self) -> Option<MigrationRecovery> {
        self.migration_recovery
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }

    /// Dismiss the migration-recovery notice for the rest of this session. The
    /// backup on disk is untouched — only the dialog goes away.
    pub fn clear_migration_recovery(&self) {
        if let Ok(mut guard) = self.migration_recovery.lock() {
            *guard = None;
        }
    }

    /// Initialize paths, settings, HTTP client, and the SQLite pool (running
    /// migrations + the startup integrity check). Async because pool init and
    /// migrations are async; `main.rs` drives it via `tauri::async_runtime`.
    pub async fn load(app_name: &str) -> Result<Self, String> {
        let paths = resolve(app_name)?;
        Self::load_with_paths(paths, app_name).await
    }

    /// Phase 6 M6.6: same as `load` but with paths injected. Production
    /// (`load`) resolves paths from the OS data dir; tests (local-data
    /// survival) point this at a tempdir so an in-place upgrade can be
    /// simulated hermetically. `#[doc(hidden)]` because it exists for tests.
    #[doc(hidden)]
    pub async fn load_with_paths(paths: AppPaths, app_name: &str) -> Result<Self, String> {
        // Deferred deletes run here, before anything opens the database or
        // reads settings: this is the only point in the process where the files
        // are guaranteed closed. No-op unless the user asked for a wipe and the
        // app restarted.
        if let Some(report) = crate::local_data::apply_pending_wipe(&paths) {
            eprintln!(
                "conduit: local data reset removed {} item(s)",
                report.removed_paths.len()
            );
        }

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
                let exists =
                    encryption::encrypted_data_exists(&db, &paths.attachments, &paths.artifacts)
                        .await
                        .unwrap_or(false);
                encryption::resolve_key_unavailable(err, exists)
                    .map(|(enc, diagnostic)| {
                        eprintln!("conduit: encryption-at-rest fallback — {diagnostic}");
                        enc
                    })
                    .map_err(|e| {
                        format!(
                        "Conduit cannot unlock your local data: the OS keychain is unavailable \
                         ({e:?}). Re-enroll your key or restore from backup."
                    )
                    })?
            }
        };
        // If tier is On and plaintext rows exist (e.g. upgraded from Off),
        // bring them up to the current key version. Idempotent + resumable.
        if encryption.is_on() {
            let _ = encryption::encrypt_existing_plaintext(&db, &encryption).await;
        }

        // FTS5 full-text search: populate the index from existing message parts
        // on first startup. Idempotent (count-check, skips if already indexed);
        // new messages are indexed automatically by the FTS5 triggers.
        let _ = crate::db::repository::search::reindex_all(&db).await;

        Ok(Self {
            paths,
            settings: Arc::new(Mutex::new(settings)),
            http: HttpClient::new(),
            db,
            encryption: Arc::new(encryption),
            migration_recovery: Arc::new(Mutex::new(migration_recovery)),
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
            migration_recovery: Arc::new(Mutex::new(None)),
        }
    }

    pub fn settings(&self) -> Result<AppSettings, String> {
        self.settings
            .lock()
            .map(|guard| guard.clone())
            .map_err(|_| "Settings lock poisoned".to_string())
    }

    /// Phase 6 M6.4: the BYOK onboarding gate. Returns `true` when the user has
    /// a usable provider configured — either the active provider is `ollama`
    /// (satisfied by config, no secret needed) or at least one BYOK provider
    /// (`anthropic`/`openai`/`openai_compat`) has a secret in the OS keychain.
    /// The keychain is the source of truth (matching the M2 credential design):
    /// a stored-but-not-active secret still satisfies the gate, because the user
    /// can switch to it without re-entering it.
    /// The credential store the user's settings select.
    ///
    /// Every caller goes through here rather than `default_service()`: a store
    /// built without the mode silently reads the OS keychain, which for a user
    /// who chose the file backend means looking in the wrong place and
    /// reporting "no key" for a key they configured.
    pub fn credential_store(&self) -> credentials::CredentialStore {
        let mode = self.settings().map(|s| s.keychain_mode).unwrap_or_default();
        credentials::CredentialStore::default_service()
            .with_mode(mode)
            .with_data_dir(self.paths.root.clone())
    }

    pub fn has_any_provider_credential(&self) -> bool {
        let settings = self.settings().unwrap_or_default();
        let store = self.credential_store();
        provider_core::has_usable_provider_credential(&settings.active_provider, |id| {
            store.has_provider_secret(id)
        })
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

        // Phase 5: artifact remote allowlist. Each entry must be an absolute
        // http(s) URL; the stored value is the origin (`scheme://host[:port]`),
        // with path/query/fragment stripped to match the frontend's
        // `validateAllowedOrigin`. A single bad entry rejects the whole update
        // so the renderer never silently drops or accepts a malformed origin.
        if let Some(allowlist) = patch.artifact_remote_allowlist {
            let mut validated: Vec<String> = Vec::with_capacity(allowlist.len());
            for raw in allowlist {
                let trimmed = raw.trim();
                let origin = crate::validation::validate_artifact_origin(trimmed)
                    .ok_or_else(|| format!("Invalid artifact allowlist entry: {trimmed}"))?;
                if !validated.contains(&origin) {
                    validated.push(origin);
                }
            }
            settings.artifact_remote_allowlist = validated;
        }

        if let Some(value) = patch.artifact_styled_preview {
            settings.artifact_styled_preview = value;
        }

        // Phase 6: update channel + update-check toggle + onboarding flag.
        // `RolloutChannel` is an enum, so serde rejects invalid values at the IPC
        // deserialization boundary; here we only apply it. The consumer UI offers
        // only Stable/Beta, but the runtime accepts Pinned/TenantSpecific so
        // Phase 7/8/9 can drive them without a schema change.
        if let Some(value) = patch.update_channel {
            settings.update_channel = value;
        }
        if let Some(value) = patch.update_check_enabled {
            settings.update_check_enabled = value;
        }
        if let Some(value) = patch.onboarding_completed {
            settings.onboarding_completed = value;
        }

        // Phase 7 / M-WebSearch: master toggle and persistent defaults. Domain
        // lists are validated for shape (bare host, no http(s) prefix, ≤253
        // chars) and length (≤100 entries per list, matching OpenAI's
        // provider-side cap). A single bad entry rejects the whole update so
        // the renderer never silently drops or accepts a malformed filter.
        if let Some(value) = patch.web_search_enabled {
            settings.web_search_enabled = value;
        }
        if let Some(defaults) = patch.web_search {
            crate::validation::validate_web_search_defaults(&defaults)?;
            settings.web_search = defaults;
        }
        if let Some(value) = patch.web_search_consent_acknowledged {
            settings.web_search_consent_acknowledged = value;
        }
        if let Some(guardrails) = patch.agent {
            crate::validation::validate_agent_guardrails(&guardrails)?;
            settings.agent = guardrails;
        }

        write_settings(&self.paths, &settings)?;
        Ok(settings.clone())
    }

    /// Phase 6 M6.5: one-time diagnostics-export disclosure. The flag
    /// `diagnosticsDisclosureAcknowledged` lives in the raw settings JSON (same
    /// pattern as `encryptionAtRest`) — **not** in the codegen'd `AppSettings`
    /// struct, to avoid a schema ripple for a UI-only acknowledgement. Returns
    /// `false` when the flag is absent or unparseable (first run, or a settings
    /// file written before M6.5). `write_settings`'s typed-merge preserves this
    /// raw key across subsequent `update_settings` calls.
    pub fn diagnostics_disclosure_acknowledged(&self) -> bool {
        read_raw_settings_json(&self.paths)
            .ok()
            .and_then(|m| {
                m.get("diagnosticsDisclosureAcknowledged")
                    .and_then(|v| v.as_bool())
            })
            .unwrap_or(false)
    }

    /// Persist the one-time diagnostics-export acknowledgement. Writes the raw
    /// JSON flag directly (merge-style) so the rest of the settings file —
    /// including other raw-only knobs like `encryptionAtRest` — is preserved.
    /// Idempotent: re-acknowledging just rewrites `true`.
    pub fn acknowledge_diagnostics_disclosure(&self) -> Result<(), String> {
        write_raw_settings_flag(&self.paths, "diagnosticsDisclosureAcknowledged", true)
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
    let value =
        serde_json::from_str::<serde_json::Value>(&raw).map_err(|error| error.to_string())?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "settings file must contain a JSON object".to_string())
}

/// Phase 6 M6.5: write a single boolean flag into the raw settings JSON
/// (merge-style), preserving every other key — including raw-only knobs like
/// `encryptionAtRest` and `diagnosticsDisclosureAcknowledged` that the codegen'd
/// `AppSettings` struct does not model. Used for the one-time diagnostics-export
/// disclosure acknowledgement. The typed `write_settings` merge likewise
/// preserves these keys, so the two writers do not clobber each other.
fn write_raw_settings_flag(paths: &AppPaths, key: &str, value: bool) -> Result<(), String> {
    let mut map = read_raw_settings_json(paths)?;
    map.insert(key.to_string(), serde_json::Value::Bool(value));
    let serialized = serde_json::to_string_pretty(&serde_json::Value::Object(map))
        .map_err(|error| error.to_string())?;
    fs::write(&paths.settings_file, serialized).map_err(|error| error.to_string())
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
            exports: root.join("exports"),
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

        let settings = AppSettings {
            active_model: "claude-opus-4".into(),
            ..AppSettings::default()
        };
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

    #[test]
    fn read_settings_defaults_missing_allowlist_to_empty() {
        // An older settings file (no `artifactRemoteAllowlist`) deserializes
        // with the serde default — empty Vec — so the renderer stays offline.
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
  "providerEndpoints": {}
}"#,
        )
        .unwrap();
        let settings = read_settings(&paths).unwrap();
        assert!(settings.artifact_remote_allowlist.is_empty());
    }
}
