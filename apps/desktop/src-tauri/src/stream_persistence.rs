use crate::time::now_iso8601;
use provider_core::schema::{Message, MessagePart, MessagePartKind, MessageRole, ProviderEvent};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamRecord {
    pub request_id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub events: Vec<ProviderEvent>,
    pub message: Message,
    pub finalized: bool,
    pub interrupted: bool,
    pub finish_reason: Option<String>,
}

pub struct StreamPersistence {
    root: PathBuf,
}

impl StreamPersistence {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn stream_dir(&self, conversation_id: &str) -> PathBuf {
        self.root.join(conversation_id)
    }

    fn stream_file(&self, conversation_id: &str, request_id: &str) -> PathBuf {
        self.stream_dir(conversation_id)
            .join(format!("{request_id}.json"))
    }

    pub fn apply_event(
        &self,
        conversation_id: &str,
        request_id: &str,
        event: &ProviderEvent,
    ) -> Result<(), String> {
        let path = self.stream_file(conversation_id, request_id);
        let mut record = if path.exists() {
            self.load_record(&path)?
        } else {
            let now = now_iso8601();
            StreamRecord {
                request_id: request_id.to_string(),
                conversation_id: conversation_id.to_string(),
                message_id: Uuid::new_v4().to_string(),
                events: Vec::new(),
                message: Message {
                    id: Uuid::new_v4().to_string(),
                    conversation_id: conversation_id.to_string(),
                    role: MessageRole::Assistant,
                    author_label: None,
                    provider_message_id: None,
                    request_id: None,
                    interrupted_at: None,
                    metadata: None,
                    parts: Vec::new(),
                    created_at: now.clone(),
                },
                finalized: false,
                interrupted: false,
                finish_reason: None,
            }
        };

        record.events.push(event.clone());
        self.apply_to_message(&mut record, event);
        self.save_record(&path, &record)
    }

    fn apply_to_message(&self, record: &mut StreamRecord, event: &ProviderEvent) {
        match event {
            ProviderEvent::MessageStart { .. } => {
                record.message.id = record.message_id.clone();
            }
            ProviderEvent::ContentBlockStart {
                block_id,
                index,
                block_kind,
                ..
            } => {
                let now = now_iso8601();
                record.message.parts.push(MessagePart {
                    id: block_id.clone(),
                    message_id: record.message.id.clone(),
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
                    created_at: now,
                });
            }
            ProviderEvent::ContentDelta {
                block_id, content, ..
            }
            | ProviderEvent::ReasoningDelta {
                block_id, content, ..
            } => {
                if let Some(part) = record.message.parts.iter_mut().find(|p| p.id == *block_id) {
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
                let now = now_iso8601();
                record.message.parts.push(MessagePart {
                    id: tool_call_id.clone(),
                    message_id: record.message.id.clone(),
                    index: *index as u32,
                    kind: MessagePartKind::Text,
                    content: Some(format!("Tool call: {name}")),
                    mime_type: Some("application/x-tool-call".to_string()),
                    tool_call_id: Some(tool_call_id.clone()),
                    artifact_id: None,
                    attachment_id: None,
                    blob_ref: None,
                    metadata: None,
                    created_at: now,
                });
            }
            ProviderEvent::MessageComplete { finish_reason, .. } => {
                record.finalized = true;
                record.finish_reason = Some(finish_reason.clone());
            }
            ProviderEvent::Error { .. } => {
                record.finalized = true;
                record.finish_reason = Some("error".to_string());
            }
            _ => {}
        }
    }

    pub fn mark_interrupted(&self, conversation_id: &str, request_id: &str) -> Result<(), String> {
        let path = self.stream_file(conversation_id, request_id);
        if !path.exists() {
            return Ok(());
        }
        let mut record = self.load_record(&path)?;
        let now = now_iso8601();
        record.interrupted = true;
        record.finalized = true;
        record.finish_reason = Some("cancelled".to_string());
        record.message.interrupted_at = Some(now);
        self.save_record(&path, &record)
    }

    pub fn load_conversation_messages(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<Message>, String> {
        let dir = self.stream_dir(conversation_id);
        if !dir.exists() {
            return Ok(Vec::new());
        }

        let mut messages = Vec::new();
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let record = self.load_record(&path)?;
            messages.push(record.message);
        }

        messages.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(messages)
    }

    fn load_record(&self, path: &Path) -> Result<StreamRecord, String> {
        let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    }

    fn save_record(&self, path: &Path, record: &StreamRecord) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let serialized = serde_json::to_string_pretty(record).map_err(|e| e.to_string())?;
        fs::write(path, serialized).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn persists_interrupted_stream() {
        let temp = env::temp_dir().join(format!("conduit-stream-{}", Uuid::new_v4()));
        let persistence = StreamPersistence::new(temp.clone());

        persistence
            .apply_event(
                "conv-1",
                "req-1",
                &ProviderEvent::MessageStart {
                    request_id: "req-1".to_string(),
                    index: 0,
                },
            )
            .unwrap();

        persistence
            .apply_event(
                "conv-1",
                "req-1",
                &ProviderEvent::ContentBlockStart {
                    request_id: "req-1".to_string(),
                    block_id: "block-0".to_string(),
                    index: 1,
                    block_kind: "text".to_string(),
                },
            )
            .unwrap();

        persistence
            .apply_event(
                "conv-1",
                "req-1",
                &ProviderEvent::ContentDelta {
                    request_id: "req-1".to_string(),
                    block_id: "block-0".to_string(),
                    index: 2,
                    content: "partial".to_string(),
                },
            )
            .unwrap();

        persistence.mark_interrupted("conv-1", "req-1").unwrap();

        let messages = persistence.load_conversation_messages("conv-1").unwrap();
        assert_eq!(messages.len(), 1);
        assert!(messages[0].interrupted_at.is_some());

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn created_at_is_iso8601_and_sorts_lexicographically() {
        // H2: created_at must be a single canonical format (ISO-8601 UTC) so the
        // lexicographic sort in load_conversation_messages orders records correctly.
        let temp = env::temp_dir().join(format!("conduit-stream-{}", Uuid::new_v4()));
        let persistence = StreamPersistence::new(temp.clone());

        persistence
            .apply_event(
                "conv-sort",
                "req-a",
                &ProviderEvent::MessageStart {
                    request_id: "req-a".to_string(),
                    index: 0,
                },
            )
            .unwrap();

        let raw = fs::read_to_string(temp.join("conv-sort").join("req-a.json")).unwrap();
        let record: StreamRecord = serde_json::from_str(&raw).unwrap();
        assert!(
            record.message.created_at.ends_with('Z'),
            "expected ISO-8601 Zulu, got {}",
            record.message.created_at
        );

        let _ = fs::remove_dir_all(temp);
    }
}
