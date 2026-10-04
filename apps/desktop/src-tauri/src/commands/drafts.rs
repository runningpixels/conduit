//! Writing: list, create, edit, restore and export drafts. A draft is written
//! in a chat of its own; the draft tools run against that chat (see
//! `agent_tools`).

use provider_core::schema::{
    DraftDetail, DraftExportFormat, DraftSnapshotCause, DraftSnapshotSummary, DraftStage,
    DraftSummary, OutlineSection,
};
use tauri::State;

use crate::{
    db::repository::{
        conversations,
        drafts::{self, user_message as message},
    },
    draft_export, slides_export,
    state::AppState,
};

async fn detail(state: &AppState, draft_id: &str) -> Result<DraftDetail, String> {
    drafts::get(&state.db, &state.encryption, draft_id)
        .await
        .map_err(message)?
        .ok_or_else(|| "That draft no longer exists.".to_string())
}

/// Every draft, most recently changed first.
#[tauri::command]
pub async fn list_drafts(state: State<'_, AppState>) -> Result<Vec<DraftSummary>, String> {
    drafts::list(&state.db).await.map_err(message)
}

/// Start a draft from a brief: creates the draft (outline stage, empty
/// Markdown, titled from the brief) and its chat, which stays out of Chats.
#[tauri::command]
pub async fn create_draft(
    state: State<'_, AppState>,
    brief: String,
) -> Result<DraftDetail, String> {
    drafts::create(&state.db, &state.encryption, &brief)
        .await
        .map_err(message)
}

#[tauri::command]
pub async fn get_draft(
    state: State<'_, AppState>,
    draft_id: String,
) -> Result<DraftDetail, String> {
    detail(&state, &draft_id).await
}

/// The draft written in a chat, if any (the renderer routes a draft's chat to
/// Writing with it).
#[tauri::command]
pub async fn draft_for_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Option<DraftDetail>, String> {
    drafts::get_by_conversation(&state.db, &state.encryption, &conversation_id)
        .await
        .map_err(message)
}

/// Rename a draft and its chat.
#[tauri::command]
pub async fn rename_draft(
    state: State<'_, AppState>,
    draft_id: String,
    title: String,
) -> Result<DraftDetail, String> {
    drafts::rename(&state.db, &state.encryption, &draft_id, &title)
        .await
        .map_err(message)
}

/// Delete a draft, its history and its chat.
#[tauri::command]
pub async fn delete_draft(state: State<'_, AppState>, draft_id: String) -> Result<(), String> {
    let conversation_id = drafts::delete(&state.db, &draft_id)
        .await
        .map_err(message)?;
    if let Some(conversation_id) = conversation_id {
        conversations::delete_with_files(
            &state.db,
            &state.paths.artifacts,
            &state.paths.attachments,
            &conversation_id,
        )
        .await
        .map_err(message)?;
    }
    Ok(())
}

/// The user's edit in the editor: the Markdown is re-split, blocks keep their
/// ids, and every block the user changed or typed is pinned.
#[tauri::command]
pub async fn save_draft_markdown(
    state: State<'_, AppState>,
    draft_id: String,
    markdown: String,
) -> Result<DraftDetail, String> {
    drafts::save_markdown(&state.db, &state.encryption, &draft_id, &markdown)
        .await
        .map_err(message)
}

/// The user's edit of the outline.
#[tauri::command]
pub async fn set_draft_outline(
    state: State<'_, AppState>,
    draft_id: String,
    outline: Vec<OutlineSection>,
) -> Result<DraftDetail, String> {
    drafts::set_outline(&state.db, &state.encryption, &draft_id, outline, false)
        .await
        .map_err(message)
}

#[tauri::command]
pub async fn set_draft_stage(
    state: State<'_, AppState>,
    draft_id: String,
    stage: DraftStage,
) -> Result<DraftDetail, String> {
    drafts::set_stage(&state.db, &state.encryption, &draft_id, stage)
        .await
        .map_err(message)
}

/// Pin ("You wrote this") or unpin ("Let AI edit") one block.
#[tauri::command]
pub async fn set_block_pinned(
    state: State<'_, AppState>,
    draft_id: String,
    block_id: String,
    pinned: bool,
) -> Result<DraftDetail, String> {
    drafts::set_block_pinned(&state.db, &state.encryption, &draft_id, &block_id, pinned)
        .await
        .map_err(message)
}

#[tauri::command]
pub async fn list_draft_snapshots(
    state: State<'_, AppState>,
    draft_id: String,
) -> Result<Vec<DraftSnapshotSummary>, String> {
    drafts::list_snapshots(&state.db, &draft_id)
        .await
        .map_err(message)
}

/// Record the draft's current state in its history; `null` when nothing
/// changed since the newest entry.
#[tauri::command]
pub async fn snapshot_draft(
    state: State<'_, AppState>,
    draft_id: String,
    cause: DraftSnapshotCause,
    label: Option<String>,
) -> Result<Option<DraftSnapshotSummary>, String> {
    drafts::snapshot(
        &state.db,
        &state.encryption,
        &draft_id,
        cause,
        label.as_deref(),
    )
    .await
    .map_err(message)
}

/// Put the draft back to a history entry; records a `restore` entry.
#[tauri::command]
pub async fn restore_draft_snapshot(
    state: State<'_, AppState>,
    draft_id: String,
    snapshot_id: String,
) -> Result<DraftDetail, String> {
    drafts::restore_snapshot(&state.db, &state.encryption, &draft_id, &snapshot_id)
        .await
        .map_err(message)
}

/// Save the draft as Markdown or as an HTML page through the native save
/// dialog. `Ok(None)` means the user cancelled. The renderer never supplies a
/// path (ADR-008). The dialog's title and filter name arrive translated (D15);
/// when the renderer leaves them out, plain English ones are used.
#[tauri::command]
pub async fn export_draft(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    draft_id: String,
    format: DraftExportFormat,
    dialog_title: Option<String>,
    filter_name: Option<String>,
) -> Result<Option<String>, String> {
    let draft = detail(&state, &draft_id).await?;
    let contents = draft_export::render(&draft.title, &draft.markdown, format);
    let extension = draft_export::extension(format);
    let (default_title, default_filter) = match format {
        DraftExportFormat::Markdown => ("Export as Markdown", "Markdown"),
        DraftExportFormat::Html => ("Export as HTML", "HTML"),
    };
    let picked = pick_save_path(
        &app,
        extension,
        dialog_title.as_deref().unwrap_or(default_title),
        filter_name.as_deref().unwrap_or(default_filter),
        &slides_export::suggested_file_name(&draft.title, extension),
    )
    .await?;
    export_draft_impl(picked, &contents)
}

/// Post-picker half of [`export_draft`], split out so cancel vs write can be
/// tested without the OS dialog.
#[doc(hidden)]
pub fn export_draft_impl(
    picked: Option<std::path::PathBuf>,
    contents: &str,
) -> Result<Option<String>, String> {
    let Some(path) = picked else {
        return Ok(None);
    };
    draft_export::write(&path, contents)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// The native save dialog; `Ok(None)` when the user cancels.
async fn pick_save_path(
    app: &tauri::AppHandle,
    extension: &str,
    dialog_title: &str,
    filter_name: &str,
    suggested_filename: &str,
) -> Result<Option<std::path::PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter(filter_name, &[extension])
        .set_file_name(suggested_filename)
        .set_title(dialog_title)
        .save_file(move |file_path| {
            let _ = tx.send(file_path);
        });
    let picked = rx
        .await
        .map_err(|_| "the file dialog closed without a response".to_string())?;
    picked
        .map(|file_path| {
            file_path
                .into_path()
                .map_err(|err| format!("failed to resolve the picked file path: {err}"))
        })
        .transpose()
}
