//! Continue a reply that stopped at the output-token limit
//! (`ProviderRequest::continue_message_id`).
//!
//! The continuation is the same reply, written further: no user message is
//! added, and its events are saved under the reply's own request id, so they
//! fold into the same `messages` row and extend the same event log. A
//! [`ProviderEvent::ReplyContinued`] marker opens the reply again in the view
//! and in `fold` until the continuation's own ending replaces `length`.
//!
//! The model is shown the conversation, its cut-off reply as its own message,
//! and one request from the app ([`CONTINUE_NUDGE`]) that is never saved. This
//! works on every provider; native assistant prefill does not.
//!
//! The reply can stop mid-sentence, so the new text must join the old with
//! nothing between them. [`BlockJoin`] maps the continuation's first text block
//! onto the block the cut-off text was in, and drops that block's start event:
//! a start on an existing part is what puts a paragraph break between rounds
//! (`messages::ROUND_BREAK`), in the view and in `fold` alike, so with no start
//! logged both join the text with nothing between. The continuation's other
//! blocks get ids of their own, so they never land in one of the reply's parts,
//! and indexes after the reply's parts, so the view (ordered by index) lists
//! them in the order `fold` adds them.

use std::collections::HashMap;

use provider_core::schema::{
    Message, MessagePart, MessagePartKind, MessageRole, ProviderEvent, ProviderRequest,
};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db::repository::{event_log, messages};

/// What the app asks the model for. Not a chat message: it is never saved.
pub const CONTINUE_NUDGE: &str =
    "Continue exactly where you stopped. Do not repeat anything or add a preamble.";

/// The finish reason of a reply that stopped at the output-token limit.
const LENGTH: &str = provider_core::output_limits::FINISH_REASON_LENGTH;

pub const NOT_FOUND: &str = "That reply is no longer in this chat, so it can't be continued.";
pub const NOT_LAST: &str = "Only the last reply in a chat can be continued.";
pub const NOT_CUT_OFF: &str =
    "This reply wasn't cut off at the output limit, so there is nothing to continue.";
pub const TURN_RUNNING: &str =
    "A reply is still being written in this chat. Wait for it to finish, then continue.";

/// A continuation the request was rewritten for.
#[derive(Debug, Clone)]
pub struct Continuation {
    /// The block the cut-off text was written in; the new text joins it.
    /// `None` when the reply had no text yet.
    pub join_block_id: Option<String>,
}

/// Check that `request` may continue its `continue_message_id`, and rewrite
/// it to: the reply's request id, the history up to the last user message, and
/// the stored reply as the assistant's message. `Ok(None)` for an ordinary
/// request. The nudge is added by [`push_nudge`], after the request's messages
/// are saved.
pub async fn prepare(
    pool: &SqlitePool,
    request: &mut ProviderRequest,
) -> Result<Option<Continuation>, String> {
    let Some(message_id) = request
        .continue_message_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
    else {
        return Ok(None);
    };
    let reply = messages::reply_to_continue(pool, &request.conversation_id, &message_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| NOT_FOUND.to_string())?;
    if !reply.is_last {
        return Err(NOT_LAST.to_string());
    }
    if reply.finish_reason.as_deref() != Some(LENGTH) {
        return Err(NOT_CUT_OFF.to_string());
    }
    let join_block_id =
        event_log::last_text_block_id(pool, &request.conversation_id, &reply.request_id)
            .await
            .map_err(|e| e.to_string())?;

    request.request_id = reply.request_id;
    // The renderer's history ends with its copy of the reply; the stored one
    // is what the model wrote.
    while request
        .messages
        .last()
        .is_some_and(|m| m.role != MessageRole::User)
    {
        request.messages.pop();
    }
    if !reply.text.is_empty() {
        let message = text_message(
            &request.conversation_id,
            MessageRole::Assistant,
            &reply.text,
        );
        request.messages.push(message);
    }
    Ok(Some(Continuation { join_block_id }))
}

/// Add the app's request to continue. Call after the request's messages are
/// saved: this message must never be.
pub fn push_nudge(request: &mut ProviderRequest) {
    let message = text_message(&request.conversation_id, MessageRole::User, CONTINUE_NUDGE);
    request.messages.push(message);
}

/// The event that reopens the reply, for the log and the renderer.
pub fn marker(request_id: &str) -> ProviderEvent {
    ProviderEvent::ReplyContinued {
        request_id: request_id.to_string(),
    }
}

fn text_message(conversation_id: &str, role: MessageRole, content: &str) -> Message {
    let now = crate::time::now_iso8601();
    let id = Uuid::new_v4().to_string();
    Message {
        id: id.clone(),
        conversation_id: conversation_id.to_string(),
        role,
        author_label: None,
        provider_message_id: None,
        request_id: None,
        interrupted_at: None,
        metadata: None,
        parts: vec![MessagePart {
            id: format!("{id}/text"),
            message_id: id,
            index: 0,
            kind: MessagePartKind::Text,
            content: Some(content.to_string()),
            mime_type: None,
            tool_call_id: None,
            artifact_id: None,
            attachment_id: None,
            blob_ref: None,
            metadata: None,
            created_at: now.clone(),
        }],
        created_at: now,
    }
}

/// Rewrites the blocks of a continuation's first round (see the module docs).
/// Every round of a provider numbers its blocks from the start again, so
/// without this the continuation's blocks would land in whichever of the
/// reply's parts shares their id, and sort among the reply's first parts.
pub struct BlockJoin {
    /// The reply's cut-off block; `None` when it wrote no text.
    target: Option<String>,
    /// Added to the indexes of the continuation's own parts.
    next_index: usize,
    tag: String,
    /// The provider's id for the text block that continues `target`.
    joined: Option<String>,
    renamed: HashMap<String, String>,
}

impl BlockJoin {
    /// `next_index` is one past the reply's highest part index.
    pub fn new(target: Option<String>, next_index: usize) -> Self {
        let tag = Uuid::new_v4().simple().to_string();
        Self {
            target,
            next_index,
            tag: tag[..8].to_string(),
            joined: None,
            renamed: HashMap::new(),
        }
    }

    /// Rewrite `event` in place, as it is saved and shown. `false` drops it.
    pub fn rewrite(&mut self, event: &mut ProviderEvent) -> bool {
        match event {
            ProviderEvent::ContentBlockStart {
                block_id,
                index,
                block_kind,
                ..
            } => {
                let reasoning = block_kind == "thinking" || block_kind == "reasoning";
                if !reasoning && self.joins(block_id) {
                    // The cut-off block is open already; starting it again
                    // would begin a new paragraph.
                    self.joined = Some(std::mem::take(block_id));
                    return false;
                }
                self.map(block_id, index);
            }
            ProviderEvent::ContentDelta {
                block_id, index, ..
            } => {
                // Some adapters send text without starting a block.
                if self.joins(block_id) {
                    self.joined = Some(block_id.clone());
                }
                self.map(block_id, index);
            }
            ProviderEvent::ReasoningDelta {
                block_id, index, ..
            }
            | ProviderEvent::ContentBlockStop {
                block_id, index, ..
            }
            | ProviderEvent::Citation {
                block_id, index, ..
            } => self.map(block_id, index),
            ProviderEvent::ToolCallStart { index, .. } => *index += self.next_index,
            _ => {}
        }
        true
    }

    /// Whether a text block `block_id` is the one that continues the reply.
    fn joins(&self, block_id: &str) -> bool {
        self.target.is_some() && self.joined.is_none() && !self.renamed.contains_key(block_id)
    }

    /// Point a block event at the part it belongs to: the cut-off block for
    /// the joined text, a part of its own (after the reply's) for the rest.
    fn map(&mut self, block_id: &mut String, index: &mut usize) {
        if let (Some(joined), Some(target)) = (self.joined.as_deref(), self.target.as_deref()) {
            if joined == block_id.as_str() {
                *block_id = target.to_string();
                return;
            }
        }
        let tag = &self.tag;
        let renamed = self
            .renamed
            .entry(block_id.clone())
            .or_insert_with(|| format!("{block_id}@{tag}"))
            .clone();
        *block_id = renamed;
        *index += self.next_index;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pass(join: &mut BlockJoin, mut event: ProviderEvent) -> Option<ProviderEvent> {
        join.rewrite(&mut event).then_some(event)
    }

    fn start(id: &str, kind: &str) -> ProviderEvent {
        ProviderEvent::ContentBlockStart {
            request_id: "r".into(),
            block_id: id.into(),
            index: 0,
            block_kind: kind.into(),
        }
    }

    fn text(id: &str) -> ProviderEvent {
        ProviderEvent::ContentDelta {
            request_id: "r".into(),
            block_id: id.into(),
            index: 0,
            content: "x".into(),
        }
    }

    fn thought(id: &str) -> ProviderEvent {
        ProviderEvent::ReasoningDelta {
            request_id: "r".into(),
            block_id: id.into(),
            index: 0,
            content: "x".into(),
        }
    }

    fn block_of(event: &ProviderEvent) -> (&str, usize) {
        match event {
            ProviderEvent::ContentBlockStart {
                block_id, index, ..
            }
            | ProviderEvent::ContentDelta {
                block_id, index, ..
            }
            | ProviderEvent::ReasoningDelta {
                block_id, index, ..
            }
            | ProviderEvent::ContentBlockStop {
                block_id, index, ..
            } => (block_id, *index),
            other => panic!("not a block event: {other:?}"),
        }
    }

    #[test]
    fn the_first_text_block_continues_the_cut_off_one_without_starting_again() {
        let mut join = BlockJoin::new(Some("block-1".into()), 3);
        assert!(pass(&mut join, start("block-0", "text")).is_none());
        let delta = pass(&mut join, text("block-0")).unwrap();
        assert_eq!(block_of(&delta).0, "block-1");
    }

    #[test]
    fn reasoning_and_later_blocks_get_ids_and_indexes_of_their_own() {
        let mut join = BlockJoin::new(Some("block-0".into()), 3);
        let thinking = pass(&mut join, start("block-0", "thinking")).unwrap();
        assert_ne!(block_of(&thinking).0, "block-0");
        assert_eq!(block_of(&thinking).1, 3);
        let reasoning = pass(&mut join, thought("block-0")).unwrap();
        assert_eq!(block_of(&reasoning).0, block_of(&thinking).0);

        assert!(pass(&mut join, start("block-1", "text")).is_none());
        assert_eq!(
            block_of(&pass(&mut join, text("block-1")).unwrap()).0,
            "block-0"
        );

        let second = pass(&mut join, start("block-2", "text")).unwrap();
        assert!(block_of(&second).0.starts_with("block-2@"));
    }

    #[test]
    fn text_without_a_block_start_still_joins() {
        let mut join = BlockJoin::new(Some("block-0".into()), 1);
        assert_eq!(
            block_of(&pass(&mut join, text("gemini-text-0")).unwrap()).0,
            "block-0"
        );
    }

    #[test]
    fn a_reply_with_no_text_yet_gets_a_new_text_block() {
        let mut join = BlockJoin::new(None, 2);
        let started = pass(&mut join, start("block-0", "text")).unwrap();
        assert!(block_of(&started).0.starts_with("block-0@"));
        assert_eq!(block_of(&started).1, 2);
    }

    #[test]
    fn other_events_pass_through() {
        let mut join = BlockJoin::new(Some("block-0".into()), 1);
        let event = ProviderEvent::MessageStart {
            request_id: "r".into(),
            index: 0,
        };
        assert_eq!(pass(&mut join, event.clone()), Some(event));
    }
}
