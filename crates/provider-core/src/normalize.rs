use crate::error::fatal;
use crate::schema::{
    GenerationControls, Message, MessagePartKind, MessageRole, ProviderError, ProviderRequest,
    ToolChoice, ToolDefinition,
};

#[derive(Debug, Clone)]
pub struct NormalizedRequest {
    pub request: ProviderRequest,
}

pub fn validate(request: ProviderRequest) -> Result<NormalizedRequest, ProviderError> {
    if request.request_id.trim().is_empty() {
        return Err(fatal("request_id is required"));
    }
    if request.conversation_id.trim().is_empty() {
        return Err(fatal("conversation_id is required"));
    }
    if request.model_id.trim().is_empty() {
        return Err(fatal("model_id is required"));
    }
    if request.messages.is_empty() {
        return Err(fatal("at least one message is required"));
    }

    for message in &request.messages {
        validate_message(message)?;
    }

    for tool in &request.tool_definitions {
        validate_tool(tool)?;
    }

    if let Some(controls) = &request.generation_controls {
        validate_controls(controls)?;
    }

    if let Some(attachments) = &request.attachments {
        for attachment_id in attachments {
            if attachment_id.trim().is_empty() {
                return Err(fatal("attachment references cannot be empty"));
            }
        }
    }

    Ok(NormalizedRequest { request })
}

fn validate_message(message: &Message) -> Result<(), ProviderError> {
    if message.id.trim().is_empty() {
        return Err(fatal("message id is required"));
    }

    match message.role {
        MessageRole::System
        | MessageRole::Developer
        | MessageRole::User
        | MessageRole::Assistant
        | MessageRole::Tool => {}
    }

    let mut last_index: Option<u32> = None;
    for part in &message.parts {
        if part.message_id != message.id {
            return Err(fatal("message part message_id must match parent message"));
        }
        if let Some(prev) = last_index {
            if part.index <= prev {
                return Err(fatal("message parts must be ordered by increasing index"));
            }
        }
        last_index = Some(part.index);

        match part.kind {
            MessagePartKind::Text | MessagePartKind::Reasoning => {
                if part.content.as_ref().is_none_or(|c| c.is_empty()) {
                    return Err(fatal("text and reasoning parts require content"));
                }
            }
            MessagePartKind::ToolResult => {
                if part.tool_call_id.as_ref().is_none_or(|id| id.is_empty()) {
                    return Err(fatal("tool result parts require tool_call_id"));
                }
            }
            MessagePartKind::AttachmentReference => {
                if part.attachment_id.as_ref().is_none_or(|id| id.is_empty()) {
                    return Err(fatal("attachment reference parts require attachment_id"));
                }
            }
            MessagePartKind::ArtifactReference => {
                if part.artifact_id.as_ref().is_none_or(|id| id.is_empty()) {
                    return Err(fatal("artifact reference parts require artifact_id"));
                }
            }
            MessagePartKind::Image | MessagePartKind::File => {
                if part.blob_ref.as_ref().is_none_or(|r| r.is_empty())
                    && part.attachment_id.is_none()
                {
                    return Err(fatal(
                        "image and file parts require blob_ref or attachment_id",
                    ));
                }
            }
        }
    }

    Ok(())
}

fn validate_tool(tool: &ToolDefinition) -> Result<(), ProviderError> {
    if tool.tool_id.trim().is_empty() {
        return Err(fatal("tool_id is required"));
    }
    if tool.name.trim().is_empty() {
        return Err(fatal("tool name is required"));
    }
    if tool.description.trim().is_empty() {
        return Err(fatal("tool description is required"));
    }
    if tool.input_schema.is_null() {
        return Err(fatal("tool input_schema is required"));
    }
    Ok(())
}

fn validate_controls(controls: &GenerationControls) -> Result<(), ProviderError> {
    if let Some(temp) = controls.temperature {
        if !(0.0..=2.0).contains(&temp) {
            return Err(fatal("temperature must be between 0 and 2"));
        }
    }
    if let Some(top_p) = controls.top_p {
        if !(0.0..=1.0).contains(&top_p) {
            return Err(fatal("top_p must be between 0 and 1"));
        }
    }
    if let Some(max_tokens) = controls.max_tokens {
        if max_tokens == 0 {
            return Err(fatal("max_tokens must be greater than 0"));
        }
    }
    if let Some(ToolChoice::Specific { tool_id }) = &controls.tool_choice {
        if tool_id.trim().is_empty() {
            return Err(fatal("specific tool_choice requires tool_id"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{MessagePart, ToolChoice};

    fn sample_message(role: MessageRole) -> Message {
        Message {
            id: "msg-1".to_string(),
            conversation_id: "conv-1".to_string(),
            role,
            author_label: None,
            provider_message_id: None,
            interrupted_at: None,
            metadata: None,
            parts: vec![MessagePart {
                id: "part-1".to_string(),
                message_id: "msg-1".to_string(),
                index: 0,
                kind: MessagePartKind::Text,
                content: Some("hello".to_string()),
                mime_type: None,
                tool_call_id: None,
                artifact_id: None,
                attachment_id: None,
                blob_ref: None,
                metadata: None,
                created_at: "2026-01-01T00:00:00Z".to_string(),
            }],
            created_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn validates_basic_request() {
        let request = ProviderRequest {
            request_id: "req-1".to_string(),
            conversation_id: "conv-1".to_string(),
            model_id: "claude-sonnet-4".to_string(),
            messages: vec![sample_message(MessageRole::User)],
            system_prompt: None,
            developer_prompt: None,
            attachments: None,
            tool_definitions: vec![],
            generation_controls: Some(GenerationControls {
                temperature: Some(0.7),
                top_p: Some(0.9),
                max_tokens: Some(1024),
                stop_sequences: None,
                tool_choice: Some(ToolChoice::Auto),
            }),
            response_format: None,
        };

        assert!(validate(request).is_ok());
    }

    #[test]
    fn rejects_empty_model() {
        let request = ProviderRequest {
            request_id: "req-1".to_string(),
            conversation_id: "conv-1".to_string(),
            model_id: "".to_string(),
            messages: vec![sample_message(MessageRole::User)],
            system_prompt: None,
            developer_prompt: None,
            attachments: None,
            tool_definitions: vec![],
            generation_controls: None,
            response_format: None,
        };

        assert!(validate(request).is_err());
    }
}
