//! Artifact and attachment commands: CRUD, file-state, export, and reveal.

use crate::{
    db::repository::{
        artifacts::{self, Artifact, ArtifactContent, ArtifactExportResult, FileState},
        attachments::{self, Attachment},
    },
    state::AppState,
};
use tauri::State;

/// 25 MiB cap for attachment bytes delivered inline over IPC. Larger files will
/// use a temp-file + path protocol in a later phase.
const ATTACHMENT_INLINE_CAP_BYTES: usize = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

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

/// Export the artifact's current payload to the app's `exports` directory.
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

/// Reveal a file-backed artifact in the OS file manager.
#[tauri::command]
#[allow(deprecated)]
pub async fn reveal_artifact(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    artifact_id: String,
) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT content_path FROM artifacts WHERE id = ?")
            .bind(&artifact_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| e.to_string())?;
    let Some((Some(rel_path),)) = row else {
        return Err("This artifact has no file on disk to reveal.".to_string());
    };
    // Reject path traversal — content_path must stay under the artifacts dir.
    let abs = state.paths.artifacts.join(&rel_path);
    let canonical_artifacts = state
        .paths
        .artifacts
        .canonicalize()
        .unwrap_or_else(|_| state.paths.artifacts.clone());
    let canonical_target = abs.canonicalize().unwrap_or(abs.clone());
    if !canonical_target.starts_with(&canonical_artifacts) {
        return Err("Artifact path is outside the workspace.".to_string());
    }
    let reveal_target = if canonical_target.is_file() {
        canonical_target
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or(canonical_target)
    } else {
        canonical_target
    };
    app.shell()
        .open(reveal_target.to_string_lossy(), None)
        .map_err(|e| e.to_string())
}
