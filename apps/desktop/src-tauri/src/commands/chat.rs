//! Chat / stream commands: provider streaming, mock streams, conversation CRUD,
//! and message loading.

use crate::{
    connector_runtime::ConnectorRuntimeManager,
    db::repository::{conversations, messages},
    state::AppState,
    stream_manager::{StreamHandle, StreamManager},
};
use provider_core::schema::{
    Conversation, ConversationSummary, Message, ProviderEvent, ProviderRequest,
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
