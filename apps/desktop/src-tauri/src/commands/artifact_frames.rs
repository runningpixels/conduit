//! IPC for serving HTML artifacts from their own origin (see
//! `crate::artifact_frames`).

use tauri::State;

use crate::artifact_frames::ArtifactFrames;

/// Store an assembled artifact document; returns the token its iframe loads.
/// `full_access` marks a document rendered with full web access (ADR-007): the
/// guard proxy lets loads through only while one is stored.
#[tauri::command]
pub fn put_artifact_frame(
    frames: State<'_, ArtifactFrames>,
    html: String,
    full_access: Option<bool>,
) -> Result<String, String> {
    frames.put_with(html, full_access == Some(true))
}

/// Release a document once its iframe no longer shows it.
#[tauri::command]
pub fn drop_artifact_frame(frames: State<'_, ArtifactFrames>, token: String) {
    frames.drop_token(&token);
}
