//! Chat / stream commands: provider streaming, mock streams, conversation CRUD,
//! and message loading.

use crate::{
    connector_runtime::ConnectorRuntimeManager,
    conversation_export::{self, ConversationExportResult, ExportFormat},
    db::repository::{conversations, messages},
    encryption::Encryption,
    state::AppState,
    stream_manager::{StreamHandle, StreamManager},
};
use provider_core::schema::{
    Conversation, ConversationSummary, GenerationControls, Message, MessageRole, ProviderEvent,
    ProviderRequest,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{ipc::Channel, State};
use tokio::time::sleep;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

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
pub struct CancelChatStreamRequest {
    pub request_id: String,
    pub conversation_id: Option<String>,
}

fn conversation_for_ipc(enc: &Encryption, conv: Conversation) -> Result<Conversation, String> {
    conversations::reveal_user_instructions(enc, conv).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Provider streaming
// ---------------------------------------------------------------------------

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
) -> Result<Vec<provider_core::schema::ModelInfo>, String> {
    StreamManager::list_models(state.inner(), &provider_id).await
}

#[tauri::command]
pub async fn start_chat_stream(
    state: State<'_, AppState>,
    stream_manager: State<'_, StreamManager>,
    runtime: State<'_, ConnectorRuntimeManager>,
    request: ProviderRequest,
    channel: Channel<ProviderEvent>,
    runtime_channel: Channel<provider_core::schema::ConnectorRuntimeEvent>,
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

// ---------------------------------------------------------------------------
// Conversation CRUD
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn create_conversation(
    state: State<'_, AppState>,
    title: Option<String>,
) -> Result<Conversation, String> {
    let created = conversations::create(&state.db, title.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    // Inherit Settings default workspace when enabled for new chats.
    let settings = state.settings().unwrap_or_default();
    if settings.workspace_tools_enabled && settings.workspace_tools_consent_acknowledged {
        if let Some(root) = settings
            .workspace_root
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            conversations::set_workspace_root(&state.db, &created.id, Some(root))
                .await
                .map_err(|e| e.to_string())?;
            return conversations::get(&state.db, &created.id)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "conversation not found after create".to_string())
                .and_then(|c| conversation_for_ipc(&state.encryption, c));
        }
    }
    Ok(created)
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
    match conversations::get(&state.db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?
    {
        Some(conv) => Ok(Some(conversation_for_ipc(&state.encryption, conv)?)),
        None => Ok(None),
    }
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
pub async fn set_conversation_title(
    state: State<'_, AppState>,
    conversation_id: String,
    title: String,
) -> Result<(), String> {
    conversations::set_title(&state.db, &conversation_id, &title)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_conversation_pinned(
    state: State<'_, AppState>,
    conversation_id: String,
    pinned: bool,
) -> Result<(), String> {
    conversations::set_pinned(&state.db, &conversation_id, pinned)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_conversation_archived(
    state: State<'_, AppState>,
    conversation_id: String,
    archived: bool,
) -> Result<(), String> {
    conversations::set_archived(&state.db, &conversation_id, archived)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_conversation_folder(
    state: State<'_, AppState>,
    conversation_id: String,
    folder_id: Option<String>,
) -> Result<(), String> {
    conversations::set_folder(&state.db, &conversation_id, folder_id.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_conversation_folders(
    state: State<'_, AppState>,
) -> Result<Vec<conversations::ConversationFolder>, String> {
    conversations::list_folders(&state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_conversation_folder(
    state: State<'_, AppState>,
    name: String,
) -> Result<conversations::ConversationFolder, String> {
    conversations::create_folder(&state.db, &name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_conversation_folder(
    state: State<'_, AppState>,
    folder_id: String,
    name: String,
) -> Result<conversations::ConversationFolder, String> {
    conversations::rename_folder(&state.db, &folder_id, &name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_conversation_folder(
    state: State<'_, AppState>,
    folder_id: String,
) -> Result<(), String> {
    conversations::delete_folder(&state.db, &folder_id)
        .await
        .map_err(|e| e.to_string())
}

/// Bind or clear the workspace folder for a conversation. `workspace_root`
/// must be an absolute existing directory, or `null` to clear.
#[tauri::command]
pub async fn set_conversation_workspace(
    state: State<'_, AppState>,
    conversation_id: String,
    workspace_root: Option<String>,
) -> Result<Conversation, String> {
    if let Some(ref path) = workspace_root {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Err("workspace_root must not be empty".into());
        }
        let p = std::path::Path::new(trimmed);
        if !p.is_absolute() {
            return Err("workspace_root must be an absolute path".into());
        }
        if !p.is_dir() {
            return Err("workspace_root must be an existing directory".into());
        }
        conversations::set_workspace_root(&state.db, &conversation_id, Some(trimmed))
            .await
            .map_err(|e| e.to_string())?;
    } else {
        conversations::set_workspace_root(&state.db, &conversation_id, None)
            .await
            .map_err(|e| e.to_string())?;
    }
    conversations::get(&state.db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "conversation not found".to_string())
        .and_then(|c| conversation_for_ipc(&state.encryption, c))
}

/// Set or clear per-conversation generation controls and user instructions.
/// `null` on either field clears that override (inherit Settings). Does not
/// start a stream.
#[tauri::command]
pub async fn set_conversation_chat_settings(
    state: State<'_, AppState>,
    conversation_id: String,
    generation_controls: Option<GenerationControls>,
    user_instructions: Option<String>,
) -> Result<Conversation, String> {
    if let Some(ref controls) = generation_controls {
        crate::validation::validate_generation_controls(controls)?;
    }
    if let Some(ref text) = user_instructions {
        crate::validation::validate_user_instructions(text)?;
    }
    conversations::set_chat_settings(
        &state.db,
        &state.encryption,
        &conversation_id,
        generation_controls.as_ref(),
        user_instructions.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;
    conversations::get(&state.db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "conversation not found".to_string())
        .and_then(|c| conversation_for_ipc(&state.encryption, c))
}

#[tauri::command]
pub async fn delete_all_conversations(state: State<'_, AppState>) -> Result<Conversation, String> {
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

// ---------------------------------------------------------------------------
// Conversation export (t0-4)
// ---------------------------------------------------------------------------

/// Render the conversation as Markdown or JSON without writing a file. Used by
/// the clipboard "Copy as Markdown" path so it shares the canonical renderer
/// (and redaction) with the save-dialog export.
#[tauri::command]
pub async fn preview_conversation_export(
    state: State<'_, AppState>,
    conversation_id: String,
    format: ExportFormat,
) -> Result<String, String> {
    conversation_export::preview(&state.db, &conversation_id, format).await
}

/// Show a native save dialog and write the conversation there. `Ok(None)` means
/// the user cancelled — that is success, not an error. The renderer never
/// supplies a path (ADR-008).
#[tauri::command]
pub async fn export_conversation_dialog(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conversation_id: String,
    format: ExportFormat,
    include_attachments: Option<bool>,
) -> Result<Option<ConversationExportResult>, String> {
    let include = include_attachments.unwrap_or(false);
    // Fail before the picker when there is nothing to export.
    let prepared = conversation_export::prepare(&state.db, &conversation_id, format).await?;
    let picked = pick_conversation_save_path(&app, format, &prepared.suggested_filename).await?;
    export_conversation_dialog_impl(state.inner(), &conversation_id, format, include, picked).await
}

/// Post-picker half of [`export_conversation_dialog`]. Split out so cancel vs
/// write can be tested without driving the OS dialog (same shape as
/// `export_brand_config_dialog_impl`).
#[doc(hidden)]
pub async fn export_conversation_dialog_impl(
    state: &AppState,
    conversation_id: &str,
    format: ExportFormat,
    include_attachments: bool,
    picked: Option<std::path::PathBuf>,
) -> Result<Option<ConversationExportResult>, String> {
    let Some(path) = picked else {
        return Ok(None);
    };
    let result = conversation_export::export_to_path(
        &state.db,
        &state.paths.attachments,
        state.encryption.as_ref(),
        conversation_id,
        format,
        include_attachments,
        &path,
    )
    .await?;
    Ok(Some(result))
}

async fn pick_conversation_save_path(
    app: &tauri::AppHandle,
    format: ExportFormat,
    suggested_filename: &str,
) -> Result<Option<std::path::PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    let title = match format {
        ExportFormat::Markdown => "Export conversation as Markdown",
        ExportFormat::Json => "Export conversation as JSON",
    };
    app.dialog()
        .file()
        .add_filter(format.dialog_filter_name(), &[format.extension()])
        .set_file_name(suggested_filename)
        .set_title(title)
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

// ---------------------------------------------------------------------------
// Message id resolution
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Full-text search (FTS5)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMessagesRequest {
    pub query: String,
    pub limit: Option<i64>,
}

/// Search all messages (and artifact titles) using the FTS5 index. Returns up
/// to `limit` results (default 20, capped at 100) ordered by relevance.
#[tauri::command]
pub async fn search_messages(
    state: State<'_, AppState>,
    request: SearchMessagesRequest,
) -> Result<Vec<crate::db::repository::search::SearchResult>, String> {
    let limit = request.limit.unwrap_or(20).clamp(1, 100);
    crate::db::repository::search::search_messages(&state.db, &request.query, limit)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Usage analytics
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UsagePeriod {
    Today,
    ThisWeek,
    ThisMonth,
    AllTime,
}

#[tauri::command]
pub async fn get_usage_summary(
    state: State<'_, AppState>,
    period: UsagePeriod,
) -> Result<crate::db::repository::usage_summary::UsageSummaryResponse, String> {
    let period_str = match period {
        UsagePeriod::Today => "today",
        UsagePeriod::ThisWeek => "thisWeek",
        UsagePeriod::ThisMonth => "thisMonth",
        UsagePeriod::AllTime => "all",
    };
    crate::db::repository::usage_summary::get_usage_summary(&state.db, period_str)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Retry & Fork (Competitive Feature)
// ---------------------------------------------------------------------------

/// Remove the last assistant turn's messages/parts/event-log rows for a
/// conversation. Returns the number of remaining messages in the conversation.
#[tauri::command]
pub async fn remove_last_turn(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<i64, String> {
    conversations::remove_last_assistant_turn(&state.db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;
    let (count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM messages WHERE conversation_id = ?")
            .bind(&conversation_id)
            .fetch_one(&state.db)
            .await
            .map_err(|e| e.to_string())?;
    Ok(count)
}

/// Fork a conversation at a specific message. Returns the new conversation.
#[tauri::command]
pub async fn fork_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
    fork_message_id: String,
) -> Result<Conversation, String> {
    // Derive a label from the source conversation title
    let source = conversations::get(&state.db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;
    let label = match source.and_then(|c| c.title) {
        Some(title) => format!("Fork of {title}"),
        None => "Fork".to_string(),
    };
    conversations::fork_at(&state.db, &conversation_id, &fork_message_id, Some(&label))
        .await
        .map_err(|e| e.to_string())
        .and_then(|c| conversation_for_ipc(&state.encryption, c))
}

/// Result of [`prepare_message_edit`]: either the same conversation (tip truncate)
/// or a new fork (mid-thread). The frontend then sends the edited text.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareMessageEditResult {
    pub conversation: Conversation,
    /// `"in_place"` when the tip was truncated; `"forked"` when a branch was created.
    pub mode: PrepareMessageEditMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrepareMessageEditMode {
    InPlace,
    Forked,
}

/// Prepare a user-message edit-and-resend.
///
/// - Mid-thread (later user turns exist): exclusive fork before the message.
/// - Tip (no later user turns): truncate from the message in place.
///
/// Does not start a stream — the caller sends the new user text afterward.
#[tauri::command]
pub async fn prepare_message_edit(
    state: State<'_, AppState>,
    conversation_id: String,
    message_id: String,
) -> Result<PrepareMessageEditResult, String> {
    prepare_message_edit_impl(&state.db, &conversation_id, &message_id)
        .await
        .and_then(|mut result| {
            result.conversation = conversation_for_ipc(&state.encryption, result.conversation)?;
            Ok(result)
        })
}

/// Testable half of [`prepare_message_edit`] (no Tauri state).
pub async fn prepare_message_edit_impl(
    pool: &sqlx::SqlitePool,
    conversation_id: &str,
    message_id: &str,
) -> Result<PrepareMessageEditResult, String> {
    let msgs = messages::load_conversation_messages(pool, conversation_id)
        .await
        .map_err(|e| e.to_string())?;
    let idx = msgs
        .iter()
        .position(|m| m.id == message_id)
        .ok_or_else(|| "message not found".to_string())?;
    let target = &msgs[idx];
    if target.role != MessageRole::User {
        return Err("can only edit user messages".into());
    }

    let has_later_user = msgs[idx + 1..].iter().any(|m| m.role == MessageRole::User);

    if has_later_user {
        let source = conversations::get(pool, conversation_id)
            .await
            .map_err(|e| e.to_string())?;
        let label = match source.and_then(|c| c.title) {
            Some(title) => format!("Edit of {title}"),
            None => "Edited chat".to_string(),
        };
        let fork = conversations::fork_before(pool, conversation_id, message_id, Some(&label))
            .await
            .map_err(|e| e.to_string())?;
        Ok(PrepareMessageEditResult {
            conversation: fork,
            mode: PrepareMessageEditMode::Forked,
        })
    } else {
        conversations::truncate_from(pool, conversation_id, message_id)
            .await
            .map_err(|e| e.to_string())?;
        let conversation = conversations::get(pool, conversation_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "conversation not found".to_string())?;
        Ok(PrepareMessageEditResult {
            conversation,
            mode: PrepareMessageEditMode::InPlace,
        })
    }
}

// ---------------------------------------------------------------------------
// Mock streams (UI development without a live provider)
// ---------------------------------------------------------------------------

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
