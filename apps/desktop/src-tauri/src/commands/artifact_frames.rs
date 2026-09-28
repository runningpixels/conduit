//! IPC for serving HTML artifacts from their own origin (see
//! `crate::artifact_frames`).

use tauri::State;

use crate::artifact_frames::ArtifactFrames;

/// Store an assembled artifact document; returns the token its iframe loads.
#[tauri::command]
pub fn put_artifact_frame(
    frames: State<'_, ArtifactFrames>,
    html: String,
) -> Result<String, String> {
    frames.put(html)
}

/// Release a document once its iframe no longer shows it.
#[tauri::command]
pub fn drop_artifact_frame(frames: State<'_, ArtifactFrames>, token: String) {
    frames.drop_token(&token);
}
