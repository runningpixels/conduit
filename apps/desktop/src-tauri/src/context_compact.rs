//! Context compaction (t1-3): cut-point selection + one-shot summarizer.
//!
//! Auto-compact journals a summary of older turns and keeps the most recent
//! ~30% of estimated tokens verbatim. The summarizer is a no-tools provider
//! stream drained to text (not a chat bubble).

use futures::StreamExt;
use provider_core::schema::{
    Message, MessagePart, MessagePartKind, MessageRole, ProviderEvent, ProviderRequest,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::db::repository::{compactions, messages};
use crate::state::AppState;
use crate::stream_manager::StreamManager;
use crate::time::now_iso8601;

/// Rough tokens: chars ÷ 4.
fn estimate_tokens(text: &str) -> i64 {
    ((text.len() as f64) / 4.0).round() as i64
}

fn message_text(msg: &Message) -> String {
    msg.parts
        .iter()
        .filter(|p| matches!(p.kind, MessagePartKind::Text))
        .filter_map(|p| p.content.as_deref())
        .collect::<Vec<_>>()
        .join("\n")
}

fn is_chat_turn(msg: &Message) -> bool {
    matches!(msg.role, MessageRole::User | MessageRole::Assistant)
}

/// Incomplete tool turns: a toolCall part with no matching toolResult in the
/// conversation after it.
fn has_incomplete_tools(msgs: &[Message]) -> bool {
    let mut open: std::collections::HashSet<String> = std::collections::HashSet::new();
    for msg in msgs {
        for part in &msg.parts {
            match part.kind {
                MessagePartKind::ToolCall => {
                    if let Some(id) = &part.tool_call_id {
                        open.insert(id.clone());
                    }
                }
                MessagePartKind::ToolResult => {
                    if let Some(id) = &part.tool_call_id {
                        open.remove(id);
                    }
                }
                _ => {}
            }
        }
        if msg.interrupted_at.is_some() {
            return true;
        }
    }
    !open.is_empty()
}

/// Pick the first message index to keep so retained tokens ≈ 30% of total
/// (at least the last user+assistant pair when present).
pub fn select_keep_from_index(texts: &[(String, String)]) -> Option<usize> {
    // texts: (id, text) in chronological order for compactable turns
    if texts.len() < 4 {
        // Need at least 2 exchange pairs (user+assistant × 2)
        return None;
    }
    let total: i64 = texts.iter().map(|(_, t)| estimate_tokens(t)).sum();
    if total <= 0 {
        return None;
    }
    let keep_budget = std::cmp::max((total as f64 * 0.30).round() as i64, 1);

    // Always keep at least the last user+assistant pair (last 2 turns).
    let mut keep_from = texts.len().saturating_sub(2);
    let mut kept = 0i64;
    for i in (0..texts.len()).rev() {
        kept += estimate_tokens(&texts[i].1);
        if kept >= keep_budget {
            keep_from = i;
            break;
        }
        keep_from = i;
    }
    // Never compact everything — leave at least one pair.
    if keep_from == 0 {
        keep_from = 2.min(texts.len().saturating_sub(2));
    }
    if keep_from >= texts.len() {
        return None;
    }
    // Must leave something to compact.
    if keep_from < 2 {
        return None;
    }
    Some(keep_from)
}

async fn summarize_range(
    state: &AppState,
    conversation_id: &str,
    model_id: &str,
    prior_summary: Option<&str>,
    compacted: &[(String, String, String)], // role, id, text
) -> Result<String, String> {
    let mut transcript = String::new();
    if let Some(s) = prior_summary {
        if !s.trim().is_empty() {
            transcript.push_str("Previous summary of earlier messages:\n");
            transcript.push_str(s.trim());
            transcript.push_str("\n\n");
        }
    }
    transcript.push_str("Conversation to summarize:\n");
    for (role, _id, text) in compacted {
        if text.trim().is_empty() {
            continue;
        }
        transcript.push_str(role);
        transcript.push_str(": ");
        transcript.push_str(text);
        transcript.push_str("\n\n");
    }

    let request_id = Uuid::new_v4().to_string();
    let now = now_iso8601();
    let user_msg_id = Uuid::new_v4().to_string();
    let user_message = Message {
        id: user_msg_id.clone(),
        conversation_id: conversation_id.to_string(),
        role: MessageRole::User,
        author_label: None,
        provider_message_id: None,
        request_id: None,
        interrupted_at: None,
        metadata: None,
        parts: vec![MessagePart {
            id: format!("{user_msg_id}-part-0"),
            message_id: user_msg_id,
            index: 0,
            kind: MessagePartKind::Text,
            content: Some(format!(
                "Summarize the following conversation for context continuity. \
                 Preserve decisions, facts, open questions, and user preferences. \
                 Write 1–3 concise paragraphs. Do not greet or ask questions.\n\n{transcript}"
            )),
            mime_type: None,
            tool_call_id: None,
            artifact_id: None,
            attachment_id: None,
            blob_ref: None,
            metadata: None,
            created_at: now.clone(),
        }],
        created_at: now,
    };

    let request = ProviderRequest {
        request_id: request_id.clone(),
        conversation_id: conversation_id.to_string(),
        model_id: model_id.to_string(),
        messages: vec![user_message],
        system_prompt: Some(
            "You summarize chat history for an assistant. Output only the summary.".into(),
        ),
        developer_prompt: None,
        attachments: None,
        tool_definitions: vec![],
        generation_controls: None,
        response_format: None,
        web_search: None,
    };

    let settings = state.settings()?;
    let provider_id = settings.active_provider.clone();
    let adapter = provider_core::get_adapter(&provider_id)
        .ok_or_else(|| format!("Unknown provider: {provider_id}"))?;
    let ctx = StreamManager::build_adapter_context(state, &provider_id)?;
    let cancel = CancellationToken::new();
    let stream = adapter
        .stream_chat(request, ctx, cancel)
        .await
        .map_err(|e| e.message)?;

    let mut summary = String::new();
    futures::pin_mut!(stream);
    while let Some(event) = stream.next().await {
        match event {
            ProviderEvent::ContentDelta { content, .. } => summary.push_str(&content),
            ProviderEvent::Error { error, .. } => {
                return Err(error.message);
            }
            ProviderEvent::MessageComplete { .. } => break,
            _ => {}
        }
    }

    let trimmed = summary.trim().to_string();
    if trimmed.is_empty() {
        return Err("Compaction summarizer returned empty text".into());
    }
    Ok(trimmed)
}

/// Run compaction for a conversation. Returns `None` when guards skip.
pub async fn compact_conversation(
    state: &AppState,
    conversation_id: &str,
) -> Result<Option<compactions::ConversationCompaction>, String> {
    let settings = state.settings()?;
    if !settings.context_compact_enabled {
        return Ok(None);
    }

    let model_id = settings.active_model.clone();
    let msgs = messages::load_conversation_messages(&state.db, conversation_id)
        .await
        .map_err(|e| e.to_string())?;

    if has_incomplete_tools(&msgs) {
        return Ok(None);
    }

    let prior = compactions::latest_for_conversation(&state.db, conversation_id)
        .await
        .map_err(|e| e.to_string())?;

    // Build compactable turn list (user/assistant text), optionally skipping
    // messages already covered by a prior compaction.
    let start_idx = if let Some(ref p) = prior {
        msgs.iter()
            .position(|m| m.id == p.kept_from_message_id)
            .unwrap_or(0)
    } else {
        0
    };

    let mut turns: Vec<(String, String, String)> = Vec::new(); // role, id, text
    for msg in msgs.iter().skip(start_idx) {
        if !is_chat_turn(msg) {
            continue;
        }
        let text = message_text(msg);
        if text.trim().is_empty() {
            continue;
        }
        let role = match msg.role {
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            _ => continue,
        };
        turns.push((role.to_string(), msg.id.clone(), text));
    }

    let texts: Vec<(String, String)> = turns
        .iter()
        .map(|(_, id, text)| (id.clone(), text.clone()))
        .collect();
    let Some(keep_from) = select_keep_from_index(&texts) else {
        return Ok(None);
    };

    let compacted = &turns[..keep_from];
    let kept = &turns[keep_from..];
    if compacted.is_empty() || kept.is_empty() {
        return Ok(None);
    }

    let before: i64 = if let Some(ref p) = prior {
        estimate_tokens(&p.summary_text)
            + texts.iter().map(|(_, t)| estimate_tokens(t)).sum::<i64>()
    } else {
        texts.iter().map(|(_, t)| estimate_tokens(t)).sum()
    };

    let summary = summarize_range(
        state,
        conversation_id,
        &model_id,
        prior.as_ref().map(|p| p.summary_text.as_str()),
        compacted,
    )
    .await?;

    let after =
        estimate_tokens(&summary) + kept.iter().map(|(_, _, t)| estimate_tokens(t)).sum::<i64>();
    let kept_from_message_id = kept[0].1.clone();
    // Exclusive upper bound of compacted range == first kept message.
    let through_message_id = kept_from_message_id.clone();

    let row = compactions::insert(
        &state.db,
        conversation_id,
        &summary,
        &through_message_id,
        &kept_from_message_id,
        &model_id,
        before,
        after,
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(Some(row))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keep_index_preserves_tail_and_needs_pairs() {
        assert!(select_keep_from_index(&[]).is_none());
        assert!(select_keep_from_index(&[
            ("1".into(), "a".repeat(40)),
            ("2".into(), "b".repeat(40)),
        ])
        .is_none());

        let long = "x".repeat(400); // ~100 tokens each
        let texts: Vec<(String, String)> = (0..10).map(|i| (i.to_string(), long.clone())).collect();
        let keep = select_keep_from_index(&texts).expect("cut");
        assert!(keep >= 2);
        assert!(keep <= texts.len() - 2);
        let kept: i64 = texts[keep..].iter().map(|(_, t)| estimate_tokens(t)).sum();
        let total: i64 = texts.iter().map(|(_, t)| estimate_tokens(t)).sum();
        assert!(kept as f64 >= total as f64 * 0.25);
    }
}
