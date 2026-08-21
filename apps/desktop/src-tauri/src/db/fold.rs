//! The canonical event fold + view rebuild (M2).
//!
//! [`fold`] is the pure function that is the single source of truth for the
//! persistence invariant `view == fold(events)`. It replicates the event→part
//! logic of `stream_persistence::apply_to_message` as a function over a slice
//! of events — no `StreamRecord`, no I/O.
//!
//! [`rebuild_view_from_log`] is the repair path: load a turn's events, fold
//! them, and replace the materialized `message_parts` rows (preserving
//! turn-level metadata on the `messages` row). Used by reconciliation (M3) and
//! interrupted-stream recovery.

use provider_core::schema::{MessagePart, MessagePartKind, ProviderEvent};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    db::{
        repository::{event_log, messages},
        DbError,
    },
    time::now_iso8601,
};

/// The event-derived projection of a turn: its parts and finalization state.
/// Turn-level metadata (`created_at`, `interrupted_at`) lives on the `messages`
/// row and is intentionally not part of the fold — it is set by the stream
/// lifecycle, not the event sequence.
pub struct FoldedView {
    pub parts: Vec<MessagePart>,
    pub finalized: bool,
    pub finish_reason: Option<String>,
}

/// Pure fold over a turn's events. `message_id` is supplied (it is generated at
/// turn start, not derivable from events); `now` stamps each part's `created_at`
/// so the function is deterministic and testable.
pub fn fold(
    events: &[ProviderEvent],
    _conversation_id: &str,
    message_id: &str,
    now: &str,
) -> FoldedView {
    let mut parts: Vec<MessagePart> = Vec::new();
    let mut finalized = false;
    let mut finish_reason: Option<String> = None;

    for event in events {
        match event {
            ProviderEvent::MessageStart { .. } => {
                // The message row's id is `message_id`; nothing to append.
            }
            ProviderEvent::ContentBlockStart {
                block_id,
                index,
                block_kind,
                ..
            } => {
                parts.push(MessagePart {
                    id: format!("{message_id}/{block_id}"),
                    message_id: message_id.to_string(),
                    index: *index as u32,
                    kind: if block_kind == "thinking" {
                        MessagePartKind::Reasoning
                    } else {
                        MessagePartKind::Text
                    },
                    content: Some(String::new()),
                    mime_type: None,
                    tool_call_id: None,
                    artifact_id: None,
                    attachment_id: None,
                    blob_ref: None,
                    metadata: None,
                    created_at: now.to_string(),
                });
            }
            ProviderEvent::ContentDelta {
                block_id, content, ..
            }
            | ProviderEvent::ReasoningDelta {
                block_id, content, ..
            } => {
                // Part ids are `{message_id}/{block_id}` (see ContentBlockStart),
                // so match the delta to its part by the prefixed id.
                let part_id = format!("{message_id}/{block_id}");
                if let Some(part) = parts.iter_mut().find(|p| p.id == part_id) {
                    let current = part.content.take().unwrap_or_default();
                    part.content = Some(format!("{current}{content}"));
                }
            }
            ProviderEvent::ToolCallStart {
                tool_call_id,
                index,
                name,
                ..
            } => {
                parts.push(MessagePart {
                    id: format!("{message_id}/{tool_call_id}"),
                    message_id: message_id.to_string(),
                    index: *index as u32,
                    kind: MessagePartKind::ToolCall,
                    content: Some(format!("Tool call: {name}")),
                    mime_type: None,
                    tool_call_id: Some(tool_call_id.clone()),
                    artifact_id: None,
                    attachment_id: None,
                    blob_ref: None,
                    metadata: None,
                    created_at: now.to_string(),
                });
            }
            ProviderEvent::MessageComplete {
                finish_reason: fr, ..
            } => {
                finalized = true;
                finish_reason = Some(fr.clone());
            }
            ProviderEvent::Error { .. } => {
                finalized = true;
                finish_reason = Some("error".to_string());
            }
            // ContentBlockStop, ToolCallDelta, ToolCallComplete, Usage, Ping
            _ => {}
        }
    }

    FoldedView {
        parts,
        finalized,
        finish_reason,
    }
}

/// Rebuild the materialized view for a turn from its event log: load events,
/// fold, and replace the `message_parts` rows + finalization state. If no
/// `messages` row exists yet (recovery after a crash before any view write),
/// one is created. Turn-level metadata on an existing row (`created_at`,
/// `interrupted_at`) is preserved.
pub async fn rebuild_view_from_log(
    pool: &SqlitePool,
    conversation_id: &str,
    request_id: &str,
) -> Result<(), DbError> {
    let events = event_log::load_events(pool, conversation_id, request_id).await?;
    let now = now_iso8601();

    let message_id = match messages::get_message_id_by_request(pool, request_id).await? {
        Some(id) => id,
        None => {
            // No row yet — create one so the folded view has somewhere to land.
            let id = Uuid::new_v4().to_string();
            let mut tx = pool.begin().await?;
            sqlx::query(
                "INSERT INTO messages (id, conversation_id, role, request_id, created_at, finalized) \
                 VALUES (?, ?, ?, ?, ?, 0)",
            )
            .bind(&id)
            .bind(conversation_id)
            .bind("assistant")
            .bind(request_id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            id
        }
    };

    let folded = fold(&events, conversation_id, &message_id, &now);

    let mut tx = pool.begin().await?;
    messages::replace_view_in_txn(
        &mut tx,
        &message_id,
        &folded.parts,
        folded.finalized,
        folded.finish_reason.as_deref(),
    )
    .await?;
    tx.commit().await?;

    Ok(())
}
