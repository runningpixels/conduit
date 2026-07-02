use crate::{
    connector_runtime::{execution, ConnectorRuntimeManager},
    credentials::{CredentialStore, CredentialSummary},
    db::repository::{
        artifacts::{self, Artifact, ArtifactContent, ArtifactExportResult, FileState},
        attachments::{self, Attachment},
        connectors::{
            self, ConnectorCapability, ConnectorDefinition, ConnectorGrant, ConnectorRuntimeState,
            ConnectorVersion,
        },
        conversations,
        licenses::{self, License},
        messages,
        tenant_cache::{self, TenantConfigCache},
    },
    diagnostics::{self, DiagnosticsExport},
    state::{AppSettings, AppState, SettingsPatch},
    stream_manager::{StreamHandle, StreamManager},
};
use mcp_runtime::StdioConfig;
use provider_core::schema::{
    ConnectorRuntimeEvent, ConsentDecision, Conversation, ConversationSummary, CredentialRequest,
    Message, ModelInfo, ProviderEvent, ProviderRequest,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{ipc::Channel, State};
use tokio::time::sleep;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MockStreamRequest {
    pub request_id: String,
    pub conversation_id: String,
    pub prompt: String,
    pub chunks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StreamEvent {
    MessageStart {
        request_id: String,
        index: usize,
    },
    ContentDelta {
        request_id: String,
        index: usize,
        content: String,
    },
    MessageComplete {
        request_id: String,
        index: usize,
        finish_reason: String,
    },
    Error {
        request_id: String,
        index: usize,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPathsPayload {
    pub root: String,
    pub settings_file: String,
    pub database: String,
    pub attachments: String,
    pub artifacts: String,
    pub logs: String,
    pub diagnostics: String,
    pub updates: String,
    pub streams: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelChatStreamRequest {
    pub request_id: String,
    pub conversation_id: Option<String>,
}

#[tauri::command]
pub fn get_app_paths(state: State<'_, AppState>) -> Result<AppPathsPayload, String> {
    let paths = &state.paths;
    Ok(AppPathsPayload {
        root: paths.root.to_string_lossy().to_string(),
        settings_file: paths.settings_file.to_string_lossy().to_string(),
        database: paths.database.to_string_lossy().to_string(),
        attachments: paths.attachments.to_string_lossy().to_string(),
        artifacts: paths.artifacts.to_string_lossy().to_string(),
        logs: paths.logs.to_string_lossy().to_string(),
        diagnostics: paths.diagnostics.to_string_lossy().to_string(),
        updates: paths.updates.to_string_lossy().to_string(),
        streams: paths.streams.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    state.settings()
}

#[tauri::command]
pub fn update_settings(
    state: State<'_, AppState>,
    patch: SettingsPatch,
) -> Result<AppSettings, String> {
    state.update_settings(patch)
}

/// Phase 6 M6.4: serializable view of the migration-recovery info (the Rust
/// `MigrationRecovery` is `Debug`/`Clone` but not `Serialize`). The backup path
/// is the user's own local path, shown to them so they can find their data — it
/// stays on-device (not telemetry).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationRecoveryInfo {
    pub backup_path: String,
    pub error: String,
}

/// Phase 6 M6.4: first-run onboarding state. `App.tsx` reads this at boot and
/// renders `<Onboarding>` instead of the workspace while `onboardingCompleted`
/// is false or no provider credential is configured. `migrationRecovery` takes
/// priority (shown first) when a startup migration failed and the live DB was
/// rolled back to a fresh store.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingState {
    pub onboarding_completed: bool,
    pub has_provider_credential: bool,
    pub migration_recovery: Option<MigrationRecoveryInfo>,
}

#[tauri::command]
pub fn get_onboarding_state(state: State<'_, AppState>) -> Result<OnboardingState, String> {
    let settings = state.settings()?;
    Ok(OnboardingState {
        onboarding_completed: settings.onboarding_completed,
        has_provider_credential: state.has_any_provider_credential(),
        migration_recovery: state
            .migration_recovery
            .as_ref()
            .map(|r| MigrationRecoveryInfo {
                backup_path: r.backup_path.display().to_string(),
                error: r.error.clone(),
            }),
    })
}

#[tauri::command]
pub fn save_provider_credential(
    _state: State<'_, AppState>,
    request: CredentialRequest,
) -> Result<CredentialSummary, String> {
    // M2: the keychain is the sole source of truth for stored credentials,
    // keyed by provider_id. No global credential ref is mirrored into settings.
    // `build_adapter_context` looks the secret up by provider_id directly.
    let store = CredentialStore::default_service();
    let summary = store.save_provider_secret(&request.provider_id, &request.secret)?;
    Ok(summary)
}

#[tauri::command]
pub fn load_provider_credential_reference(
    provider_id: String,
) -> Result<CredentialSummary, String> {
    let store = CredentialStore::default_service();
    Ok(CredentialSummary {
        provider_id: provider_id.clone(),
        credential_ref: store.reference(&provider_id),
        stored_in_keychain: store.has_provider_secret(&provider_id),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDescriptorPayload {
    pub id: String,
    pub display_name: String,
    pub default_base_url: Option<String>,
    pub credential_mode: String,
    pub is_local: bool,
    pub show_base_url_field: bool,
    pub tier: u8,
    pub description: Option<String>,
}

fn credential_mode_label(mode: provider_core::CredentialMode) -> &'static str {
    match mode {
        provider_core::CredentialMode::None => "none",
        provider_core::CredentialMode::Optional => "optional",
        provider_core::CredentialMode::Required => "required",
    }
}

#[tauri::command]
pub fn list_provider_descriptors() -> Vec<ProviderDescriptorPayload> {
    provider_core::list_descriptors()
        .iter()
        .map(|d| ProviderDescriptorPayload {
            id: d.id.to_string(),
            display_name: d.display_name.to_string(),
            default_base_url: d.default_base_url.map(str::to_string),
            credential_mode: credential_mode_label(d.credential_mode).to_string(),
            is_local: d.is_local,
            show_base_url_field: d.show_base_url_field,
            tier: d.tier,
            description: d.description.map(str::to_string),
        })
        .collect()
}

#[tauri::command]
pub async fn validate_provider_credentials(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<(), String> {
    StreamManager::validate_credentials(state.inner(), &provider_id).await
}

#[tauri::command]
pub async fn list_provider_models(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<Vec<ModelInfo>, String> {
    StreamManager::list_models(state.inner(), &provider_id).await
}

#[tauri::command]
pub async fn start_chat_stream(
    state: State<'_, AppState>,
    stream_manager: State<'_, StreamManager>,
    runtime: State<'_, ConnectorRuntimeManager>,
    request: ProviderRequest,
    channel: Channel<ProviderEvent>,
    runtime_channel: Channel<ConnectorRuntimeEvent>,
) -> Result<StreamHandle, String> {
    if request.tool_definitions.is_empty() {
        let _ = runtime_channel;
        stream_manager
            .start_chat_stream(state.inner(), request, channel)
            .await
    } else {
        stream_manager
            .run_agent_turn(
                state.inner(),
                runtime.inner(),
                request,
                channel,
                runtime_channel,
            )
            .await
    }
}

#[tauri::command]
pub async fn cancel_chat_stream(
    state: State<'_, AppState>,
    stream_manager: State<'_, StreamManager>,
    request: CancelChatStreamRequest,
) -> Result<(), String> {
    match stream_manager
        .cancel_stream(
            state.inner(),
            &request.request_id,
            request.conversation_id.as_deref(),
        )
        .await?
    {
        true => Ok(()),
        false => Err(format!("No active stream found for {}", request.request_id)),
    }
}

#[tauri::command]
pub async fn get_conversation_messages(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<Message>, String> {
    // Phase 3: reads the materialized view from SQLite. (The legacy file-journal
    // path is retained only for the M3 backfill + one-release downgrade safety.)
    messages::load_conversation_messages(&state.db, &conversation_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_request_provider_events(
    state: State<'_, AppState>,
    conversation_id: String,
    request_id: String,
) -> Result<Vec<provider_core::schema::ProviderEvent>, String> {
    crate::db::repository::event_log::load_events(&state.db, &conversation_id, &request_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_conversation(
    state: State<'_, AppState>,
    title: Option<String>,
) -> Result<Conversation, String> {
    conversations::create(&state.db, title.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_conversations(
    state: State<'_, AppState>,
) -> Result<Vec<ConversationSummary>, String> {
    conversations::list(&state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Option<Conversation>, String> {
    conversations::get(&state.db, &conversation_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), String> {
    conversations::delete_with_files(
        &state.db,
        &state.paths.artifacts,
        &state.paths.attachments,
        &conversation_id,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_all_conversations(
    state: State<'_, AppState>,
) -> Result<Conversation, String> {
    conversations::delete_all_with_files(
        &state.db,
        &state.paths.artifacts,
        &state.paths.attachments,
    )
    .await
    .map_err(|e| e.to_string())?;
    conversations::create(&state.db, None)
        .await
        .map_err(|e| e.to_string())
}

// --- M4: attachments ---------------------------------------------------------

/// 25 MiB cap for attachment bytes delivered inline over IPC. Larger files will
/// use a temp-file + path protocol in a later phase.
const ATTACHMENT_INLINE_CAP_BYTES: usize = 25 * 1024 * 1024;

#[tauri::command]
pub async fn save_attachment(
    state: State<'_, AppState>,
    conversation_id: String,
    bytes: Vec<u8>,
    mime_type: String,
    origin: Option<String>,
) -> Result<Attachment, String> {
    if bytes.len() > ATTACHMENT_INLINE_CAP_BYTES {
        return Err(format!(
            "Attachment too large for inline IPC ({} > {} bytes); use a file-path protocol",
            bytes.len(),
            ATTACHMENT_INLINE_CAP_BYTES
        ));
    }
    attachments::save(
        &state.db,
        &state.paths.attachments,
        &state.encryption,
        &conversation_id,
        &bytes,
        &mime_type,
        origin.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_attachments(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<Attachment>, String> {
    attachments::list_for_conversation(&state.db, &conversation_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_attachment(
    state: State<'_, AppState>,
    attachment_id: String,
) -> Result<(), String> {
    // Soft delete: mark `retention_state = 'deleted'`. The blob file is
    // reclaimed later by `cleanup::gc_orphan_blobs` once no live row references
    // the hash.
    attachments::set_retention(&state.db, &attachment_id, "deleted")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_attachment_bytes(
    state: State<'_, AppState>,
    attachment_id: String,
) -> Result<Vec<u8>, String> {
    let att = attachments::get(&state.db, &attachment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Attachment not found".to_string())?;
    attachments::read_bytes(&state.paths.attachments, &state.encryption, &att.path)
        .map_err(|e| e.to_string())
}

// --- M4: artifacts -----------------------------------------------------------

#[tauri::command]
pub async fn create_artifact(
    state: State<'_, AppState>,
    conversation_id: String,
    kind: String,
    title: Option<String>,
    source_message_id: Option<String>,
) -> Result<Artifact, String> {
    artifacts::create(
        &state.db,
        &conversation_id,
        &kind,
        title.as_deref(),
        source_message_id.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_artifacts(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<Artifact>, String> {
    artifacts::list(&state.db, &conversation_id)
        .await
        .map_err(|e| e.to_string())
}

/// Resolve the persisted assistant message id for a stream `request_id`. Used
/// when promoting artifacts so `source_message_id` matches reloaded messages.
#[tauri::command]
pub async fn get_message_id_by_request(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<Option<String>, String> {
    messages::get_message_id_by_request(&state.db, &request_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_artifact(
    state: State<'_, AppState>,
    artifact_id: String,
) -> Result<Option<Artifact>, String> {
    artifacts::get(&state.db, &state.encryption, &artifact_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_artifact_content(
    state: State<'_, AppState>,
    artifact_id: String,
    mime_type: Option<String>,
    content: ArtifactContent,
) -> Result<Artifact, String> {
    if let ArtifactContent::File { bytes, .. } = &content {
        if bytes.len() > ATTACHMENT_INLINE_CAP_BYTES {
            return Err(format!(
                "Artifact payload too large for inline IPC ({} > {} bytes)",
                bytes.len(),
                ATTACHMENT_INLINE_CAP_BYTES
            ));
        }
    }
    artifacts::set_content(
        &state.db,
        &state.paths.artifacts,
        &state.encryption,
        &artifact_id,
        mime_type.as_deref(),
        &content,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_artifact_title(
    state: State<'_, AppState>,
    artifact_id: String,
    title: String,
) -> Result<Artifact, String> {
    artifacts::set_title(&state.db, &artifact_id, &title)
        .await
        .map_err(|e| e.to_string())?;
    // Return the updated row so the frontend gets the fresh title immediately.
    artifacts::get(&state.db, &state.encryption, &artifact_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "artifact not found after title update".to_string())
}

/// Read an artifact's payload bytes for in-app preview. Capped at 5 MiB; larger
/// payloads should be exported to disk instead of pulled across IPC.
#[tauri::command]
pub async fn get_artifact_content_bytes(
    state: State<'_, AppState>,
    artifact_id: String,
) -> Result<Vec<u8>, String> {
    const ARTIFACT_PREVIEW_CAP_BYTES: usize = 5 * 1024 * 1024;
    let bytes = artifacts::read_content_bytes(
        &state.db,
        &state.paths.artifacts,
        &state.encryption,
        &artifact_id,
    )
    .await
    .map_err(|e| e.to_string())?;
    if bytes.len() > ARTIFACT_PREVIEW_CAP_BYTES {
        return Err(format!(
            "Artifact payload too large for inline preview ({} > {} bytes); use Export",
            bytes.len(),
            ARTIFACT_PREVIEW_CAP_BYTES
        ));
    }
    Ok(bytes)
}

/// Read an artifact's full file payload bytes without the preview size cap.
/// Intended only for the "Use disk" recovery flow on modified File-content
/// artifacts. Callers must ensure the payload is not abused for preview.
#[tauri::command]
pub async fn read_artifact_file_bytes(
    state: State<'_, AppState>,
    artifact_id: String,
) -> Result<Vec<u8>, String> {
    artifacts::read_content_bytes(
        &state.db,
        &state.paths.artifacts,
        &state.encryption,
        &artifact_id,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_artifact_file_state(
    state: State<'_, AppState>,
    artifact_id: String,
) -> Result<FileState, String> {
    artifacts::check_file_state(
        &state.db,
        &state.paths.artifacts,
        &state.encryption,
        &artifact_id,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Export the artifact's current payload to the app's `exports` directory,
/// optionally with a `.conduit.json` metadata sidecar. Returns the absolute
/// path written + bytes written. (M5; M6.5 promotes the destination to the
/// real `AppPaths::exports` so artifact + diagnostics exports share one
/// revealable folder.) The destination is app-local; a future Tauri dialog
/// plugin can let the user pick a folder.
#[tauri::command]
pub async fn export_artifact(
    state: State<'_, AppState>,
    artifact_id: String,
    include_metadata: bool,
) -> Result<ArtifactExportResult, String> {
    let out_dir = state.paths.exports.clone();
    artifacts::export(
        &state.db,
        &state.paths.artifacts,
        &state.encryption,
        &artifact_id,
        &out_dir,
        include_metadata,
    )
    .await
    .map_err(|e| e.to_string())
}

// --- M5: connector / license / tenant-cache (shell display state) ------------

#[tauri::command]
pub async fn list_connector_definitions(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectorDefinition>, String> {
    connectors::list_definitions(&state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_connector_versions(
    state: State<'_, AppState>,
    connector_id: String,
) -> Result<Vec<ConnectorVersion>, String> {
    connectors::list_versions(&state.db, &connector_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_connector_grants(
    state: State<'_, AppState>,
    status: Option<String>,
) -> Result<Vec<ConnectorGrant>, String> {
    connectors::list_grants(&state.db, status.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_tenant_config(
    state: State<'_, AppState>,
    tenant_id: String,
) -> Result<Option<TenantConfigCache>, String> {
    tenant_cache::get_tenant_config(&state.db, &state.encryption, &tenant_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_license_state(state: State<'_, AppState>) -> Result<Option<License>, String> {
    licenses::get_active_license(&state.db, &state.encryption)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_diagnostics(state: State<'_, AppState>) -> Result<DiagnosticsExport, String> {
    let settings = state.settings()?;
    diagnostics::export(&state.paths, &settings)
}

/// Phase 6 M6.5: read the one-time diagnostics-export disclosure flag from the
/// raw settings JSON. `false` until the user has acknowledged the disclosure at
/// least once.
#[tauri::command]
pub fn get_diagnostics_disclosure_acknowledged(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.diagnostics_disclosure_acknowledged())
}

/// Phase 6 M6.5: persist the one-time diagnostics-export disclosure
/// acknowledgement. Idempotent.
#[tauri::command]
pub fn acknowledge_diagnostics_disclosure(state: State<'_, AppState>) -> Result<(), String> {
    state.acknowledge_diagnostics_disclosure()
}

/// Phase 6 M6.5: reveal the app's **exports** directory in the OS file manager
/// (Finder/Explorer). Used by the Diagnostics section (and artifact Export) to
/// surface the shared exports folder after a successful export.
///
/// Security: the directory is derived **server-side** from `AppPaths::exports`.
/// The renderer does NOT supply a path — there is no "open whatever the renderer
/// asks for" vector. This matters because `tauri-plugin-shell`'s `Shell::open`,
/// when called from Rust, passes `scope: None` and so opens **without** the
/// `shell:allow-open` scope check (see `tauri-plugin-shell` `open.rs`: "when
/// running directly from Rust code we don't need to validate the path"). That
/// is safe here only because the path is app-owned, never renderer-controlled.
///
/// `shell().open(...)` is deprecated upstream in favor of `tauri-plugin-opener`;
/// we keep the shell plugin (already wired in M6.1) to avoid introducing a new
/// plugin dependency mid-milestone. Migrating to the opener plugin is a later
/// cleanup.
#[tauri::command]
#[allow(deprecated)]
pub fn reveal_path(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    app.shell()
        .open(state.paths.exports.to_string_lossy(), None)
        .map_err(|e| e.to_string())
}

/// Phase 7 / M-WebSearch: reset the local database. The user-initiated
/// destructive operation from the Privacy & Data settings section.
///
/// Backs up the current DB to `conduit.sqlite.reset-<unix>.bak` in the same
/// directory, then deletes the live DB file (+ WAL/SHM sidecars). A fresh
/// database is created on the next app restart; the running pool is NOT
/// replaced in-place because that would require interior mutability on
/// `AppState.db` and a coordinated pool drain. The caller is expected to
/// prompt the user to restart Conduit.
///
/// Attachment and artifact files on disk are intentionally left in place —
/// they are no longer indexed, but a user who wants to recover them can
/// still find them in the `attachments/` and `artifacts/` directories.
#[tauri::command]
pub fn reset_local_database(state: State<'_, AppState>) -> Result<ResetDatabaseResult, String> {
    let db_path = &state.paths.database;
    if !db_path.exists() {
        return Err("No local database found to reset.".to_string());
    }
    let unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let backup_path = std::path::PathBuf::from(format!(
        "{}.reset-{unix}.bak",
        db_path.display()
    ));
    std::fs::copy(db_path, &backup_path)
        .map_err(|e| format!("Failed to back up database: {e}"))?
    ;
    // Delete the live DB and WAL/SHM sidecars so the next startup creates a
    // clean store. Silently ignore missing sidecars.
    let _ = std::fs::remove_file(db_path);
    let _ = std::fs::remove_file(format!("{}-wal", db_path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", db_path.display()));
    Ok(ResetDatabaseResult {
        backup_path: backup_path.to_string_lossy().to_string(),
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetDatabaseResult {
    pub backup_path: String,
}

#[tauri::command]
pub async fn start_mock_stream(
    stream_manager: State<'_, StreamManager>,
    request: MockStreamRequest,
    channel: Channel<StreamEvent>,
) -> Result<StreamHandle, String> {
    let request_id = if request.request_id.trim().is_empty() {
        Uuid::new_v4().to_string()
    } else {
        request.request_id.trim().to_string()
    };
    // M1: mock streams register with the same StreamManager cancellation
    // registry as real provider streams.
    let cancel = stream_manager.register_stream(&request_id)?;
    let active = stream_manager.active_handle();
    let channel_request_id = request_id.clone();
    let chunks = request.chunks.clone();
    let chunk_count = chunks.len();

    tauri::async_runtime::spawn(async move {
        let _ = channel.send(StreamEvent::MessageStart {
            request_id: channel_request_id.clone(),
            index: 0,
        });

        for (index, chunk) in chunks.into_iter().enumerate() {
            if cancel.is_cancelled() {
                let _ = channel.send(StreamEvent::Error {
                    request_id: channel_request_id.clone(),
                    index,
                    message: "Stream cancelled by user".to_string(),
                });
                let _ = active
                    .lock()
                    .map(|mut guard| guard.remove(&channel_request_id));
                return;
            }

            let _ = channel.send(StreamEvent::ContentDelta {
                request_id: channel_request_id.clone(),
                index,
                content: chunk,
            });
            sleep(Duration::from_millis(120)).await;
        }

        let _ = channel.send(StreamEvent::MessageComplete {
            request_id: channel_request_id.clone(),
            index: chunk_count,
            finish_reason: "stop".to_string(),
        });
        let _ = active
            .lock()
            .map(|mut guard| guard.remove(&channel_request_id));
    });

    Ok(StreamHandle { request_id })
}

#[tauri::command]
pub async fn cancel_mock_stream(
    state: State<'_, AppState>,
    stream_manager: State<'_, StreamManager>,
    request_id: String,
) -> Result<(), String> {
    // M1: unified cancellation — mock streams live in the same registry.
    match stream_manager
        .cancel_stream(state.inner(), &request_id, None)
        .await?
    {
        true => Ok(()),
        false => Err(format!("No active stream found for {}", request_id)),
    }
}

// =============================================================================
// Phase 4 — MCP connector runtime IPC
// =============================================================================

/// A request to invoke a connector tool. Streamed via `invoke_connector_tool`,
/// which emits `ConnectorRuntimeEvent`s (consent prompts, completion) over the
/// per-call `Channel` and returns a `StreamHandle` keyed by `tool_call_id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvokeConnectorToolRequest {
    pub connector_version_id: String,
    pub tool_call_id: String,
    pub request_id: String,
    pub tool_name: String,
    pub arguments: serde_json::Value,
}

/// A request to register a local stdio connector: writes a
/// `ConnectorDefinition` + `ConnectorVersion` (transport_config validated by
/// `StdioConfig` before persist) + an `active` grant. Transport config is
/// untrusted tenant/local input — validated server-side, never trusted because
/// it came from the renderer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddLocalConnectorRequest {
    pub name: String,
    pub description: Option<String>,
    pub command: String,
    pub args: Vec<String>,
    pub env: std::collections::HashMap<String, String>,
    pub consent_copy: Option<String>,
    pub capability_allowlist: Option<Vec<String>>,
}

/// The result of registering a local connector.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddLocalConnectorResult {
    pub connector_id: String,
    pub connector_version_id: String,
}

/// One row of the connectors rail snapshot: joins a version with its
/// definition (name/transport), runtime health, support state, and grant
/// status so the renderer can render health + failure state without a second
/// round-trip per row.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorRuntimeSnapshot {
    pub connector_version_id: String,
    pub connector_id: String,
    pub connector_name: String,
    pub version: String,
    pub transport: String,
    pub health: Option<String>,
    pub last_error: Option<String>,
    pub last_started_at: Option<String>,
    pub restart_count: i64,
    pub support_state: Option<String>,
    pub grant_status: Option<String>,
    pub running: bool,
}

#[tauri::command]
pub async fn start_connector(
    state: State<'_, AppState>,
    runtime: State<'_, ConnectorRuntimeManager>,
    connector_version_id: String,
) -> Result<serde_json::Value, String> {
    let server = runtime
        .start_connector(state.inner(), &connector_version_id)
        .await?;
    Ok(serde_json::json!({ "name": server.name, "version": server.version }))
}

#[tauri::command]
pub async fn stop_connector(
    state: State<'_, AppState>,
    runtime: State<'_, ConnectorRuntimeManager>,
    connector_version_id: String,
) -> Result<(), String> {
    runtime
        .stop_connector(state.inner(), &connector_version_id)
        .await
}

#[tauri::command]
pub async fn discover_connector(
    state: State<'_, AppState>,
    runtime: State<'_, ConnectorRuntimeManager>,
    connector_version_id: String,
) -> Result<Vec<ConnectorCapability>, String> {
    runtime
        .discover_capabilities(state.inner(), &connector_version_id)
        .await
}

#[tauri::command]
pub async fn list_connector_capabilities(
    state: State<'_, AppState>,
    connector_version_id: String,
) -> Result<Vec<ConnectorCapability>, String> {
    connectors::list_capabilities(&state.db, &connector_version_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_connector_runtime_states(
    state: State<'_, AppState>,
    runtime: State<'_, ConnectorRuntimeManager>,
) -> Result<Vec<ConnectorRuntimeSnapshot>, String> {
    let pool = &state.db;
    let defs = connectors::list_definitions(pool)
        .await
        .map_err(|e| e.to_string())?;
    let states = connectors::list_runtime_states(pool)
        .await
        .map_err(|e| e.to_string())?;
    let grants = connectors::list_grants(pool, None)
        .await
        .map_err(|e| e.to_string())?;

    // Index runtime states + grants by version id for O(1) join.
    use std::collections::HashMap;
    let state_by_ver: HashMap<String, ConnectorRuntimeState> = states
        .into_iter()
        .map(|s| (s.connector_version_id.clone(), s))
        .collect();
    // First grant per version (an active grant wins over revoked/pending).
    let mut grant_by_ver: HashMap<String, ConnectorGrant> = HashMap::new();
    for g in grants {
        match grant_by_ver.get(&g.connector_version_id) {
            Some(existing) if existing.status == "active" => {}
            _ => {
                grant_by_ver.insert(g.connector_version_id.clone(), g);
            }
        }
    }
    let running = runtime.active_version_ids();

    let mut rows = Vec::new();
    for def in &defs {
        let versions = connectors::list_versions(pool, &def.id)
            .await
            .map_err(|e| e.to_string())?;
        for v in versions {
            let st = state_by_ver.get(&v.id);
            let g = grant_by_ver.get(&v.id);
            rows.push(ConnectorRuntimeSnapshot {
                connector_version_id: v.id.clone(),
                connector_id: def.id.clone(),
                connector_name: def.name.clone(),
                version: v.version.clone(),
                transport: def.transport.clone(),
                health: st.map(|s| s.health.clone()),
                last_error: st.and_then(|s| s.last_error.clone()),
                last_started_at: st.and_then(|s| s.last_started_at.clone()),
                restart_count: st.map(|s| s.restart_count).unwrap_or(0),
                support_state: v.support_state.clone(),
                grant_status: g.map(|g| g.status.clone()),
                running: running.contains(&v.id) && st.is_none_or(|s| s.health != "down"),
            });
        }
    }
    Ok(rows)
}

#[tauri::command]
pub async fn invoke_connector_tool(
    state: State<'_, AppState>,
    runtime: State<'_, ConnectorRuntimeManager>,
    request: InvokeConnectorToolRequest,
    channel: Channel<ConnectorRuntimeEvent>,
) -> Result<StreamHandle, String> {
    // Validate the connector is running before we accept the call — the
    // execution path would otherwise fail at consent resolution.
    if runtime
        .active_connector(&request.connector_version_id)
        .is_none()
    {
        return Err("connector is not running; start it first".to_string());
    }

    let tool_call_id = if request.tool_call_id.trim().is_empty() {
        Uuid::new_v4().to_string()
    } else {
        request.tool_call_id.trim().to_string()
    };
    let state = state.inner().clone();
    let mgr = runtime.inner().clone();
    let connector_version_id = request.connector_version_id.clone();
    let request_id = request.request_id.clone();
    let tool_name = request.tool_name.clone();
    let arguments = request.arguments.clone();
    let tcid = tool_call_id.clone();

    // The runtime event sink forwards each event into the Tauri channel. The
    // orchestrator emits ConsentRequested + ToolCallFinished (and the consent
    // decision arrives via a separate approve/deny command calling
    // `resolve_consent`).
    let sink: execution::EventSink = std::sync::Arc::new(move |ev| {
        let _ = channel.send(ev);
    });

    tauri::async_runtime::spawn(async move {
        let req = execution::ToolCallRequest {
            connector_version_id: &connector_version_id,
            tool_call_id: &tcid,
            request_id: &request_id,
            tool_name: &tool_name,
            arguments: &arguments,
        };
        let _ = execution::execute_tool_call(&state, &mgr, &req, &sink).await;
    });

    Ok(StreamHandle {
        request_id: tool_call_id,
    })
}

#[tauri::command]
pub async fn approve_connector_tool_call(
    runtime: State<'_, ConnectorRuntimeManager>,
    tool_call_id: String,
) -> Result<(), String> {
    runtime.resolve_consent(&tool_call_id, ConsentDecision::Approved)
}

#[tauri::command]
pub async fn deny_connector_tool_call(
    runtime: State<'_, ConnectorRuntimeManager>,
    tool_call_id: String,
) -> Result<(), String> {
    runtime.resolve_consent(&tool_call_id, ConsentDecision::Denied)
}

#[tauri::command]
pub async fn revoke_connector_grant(
    state: State<'_, AppState>,
    runtime: State<'_, ConnectorRuntimeManager>,
    grant_id: String,
    _connector_version_id: Option<String>,
) -> Result<(), String> {
    revoke_connector_grant_inner(state.inner(), runtime.inner(), &grant_id).await
}

pub async fn revoke_connector_grant_inner(
    state: &AppState,
    runtime: &ConnectorRuntimeManager,
    grant_id: &str,
) -> Result<(), String> {
    // Always resolve the version from the grant so revocation guarantees stop
    // even if the renderer omits connector_version_id.
    let grants = connectors::list_grants(&state.db, None)
        .await
        .map_err(|e| e.to_string())?;
    let vid = grants
        .iter()
        .find(|g| g.id == grant_id)
        .map(|g| g.connector_version_id.clone());
    if let Some(vid) = vid.as_deref() {
        let _ = runtime.stop_connector(state, vid).await;
    }
    connectors::revoke_grant(&state.db, grant_id, None)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_local_connector(
    state: State<'_, AppState>,
    request: AddLocalConnectorRequest,
) -> Result<AddLocalConnectorResult, String> {
    // Validate the untrusted transport config server-side before persisting.
    let transport_config = serde_json::json!({
        "command": request.command,
        "args": request.args,
        "env": request.env,
    });
    StdioConfig::from_value(&transport_config).map_err(|e| e.message)?;

    let now = crate::time::now_iso8601();
    let connector_id = format!("local:{}", slugify(&request.name));
    let version_id = format!("{connector_id}:1.0.0");

    let def = ConnectorDefinition {
        id: connector_id.clone(),
        name: request.name.clone(),
        description: request.description.unwrap_or_default(),
        transport: "stdio".to_string(),
        owner: "local".to_string(),
        icon: None,
        support_url: None,
        consent_copy: request.consent_copy.clone(),
        policy_metadata: None,
        cloud_id: None,
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    connectors::upsert_definition(&state.db, &def)
        .await
        .map_err(|e| e.to_string())?;

    let capability_allowlist = request.capability_allowlist.map(|names| {
        serde_json::Value::Array(names.into_iter().map(serde_json::Value::String).collect())
    });
    let version = ConnectorVersion {
        id: version_id.clone(),
        connector_id: connector_id.clone(),
        version: "1.0.0".to_string(),
        transport_config,
        scope_grants: None,
        capability_allowlist,
        rollout_channel: None,
        support_state: Some("available".to_string()),
        created_at: now.clone(),
    };
    connectors::insert_version(&state.db, &version)
        .await
        .map_err(|e| e.to_string())?;

    let grant = ConnectorGrant {
        id: format!("grant:{version_id}"),
        connector_version_id: version_id.clone(),
        scope: "user".to_string(),
        status: "active".to_string(),
        credential_ref: None,
        approved_by: Some("local".to_string()),
        revoked_at: None,
        notes: None,
        created_at: now,
    };
    connectors::upsert_grant(&state.db, &grant)
        .await
        .map_err(|e| e.to_string())?;

    Ok(AddLocalConnectorResult {
        connector_id,
        connector_version_id: version_id,
    })
}

/// Lowercase + replace non-alphanumerics with `-` for a stable connector id.
fn slugify(s: &str) -> String {
    let slug: String = s
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "connector".to_string()
    } else {
        trimmed.to_string()
    }
}
