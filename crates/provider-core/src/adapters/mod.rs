use crate::adapter::StreamParser;
use crate::error::fatal;
use crate::schema::{
    Message, MessagePart, MessagePartKind, MessageRole, ProviderError, ProviderEvent,
    ProviderRequest,
};
use futures::stream::{Stream, StreamExt};
use std::pin::Pin;

pub mod anthropic;
pub mod gemini;
pub mod ollama;
pub mod openai;
pub mod openai_compat;
pub mod openai_preset;
pub mod opencode_zen;

/// The message's visible text. Reasoning parts are not part of it: a model's
/// earlier reasoning is never replayed to a provider as if it had said it.
/// Providers that take reasoning back do so in their own field (see
/// [`message_reasoning`] and DeepSeek's `reasoning_content` in `openai.rs`).
pub fn message_text(message: &Message) -> String {
    joined_parts(message, MessagePartKind::Text)
}

/// The message's reasoning, joined; empty when it has none.
pub fn message_reasoning(message: &Message) -> String {
    joined_parts(message, MessagePartKind::Reasoning)
}

fn joined_parts(message: &Message, kind: MessagePartKind) -> String {
    message
        .parts
        .iter()
        .filter(|p| p.kind == kind)
        .filter_map(|p| p.content.as_ref())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n")
}

/// True when a user message carries hydrated image parts (base64 in `content`).
pub fn message_has_images(message: &Message) -> bool {
    message.parts.iter().any(|p| {
        p.kind == MessagePartKind::Image
            && p.content.as_ref().is_some_and(|c| !c.is_empty())
            && p.mime_type.as_ref().is_some_and(|m| !m.is_empty())
    })
}

/// True when a user message carries hydrated image or document parts, i.e.
/// when it has to be sent as a content array rather than a plain string.
pub fn message_has_media(message: &Message) -> bool {
    message_has_images(message) || message.parts.iter().any(|p| hydrated_document(p).is_some())
}

/// A hydrated document part as `(mime, base64 data, filename)`.
///
/// The desktop crate only builds these (`MessagePartKind::File`, base64 in
/// `content`, the original file name in `metadata.filename`) for a PDF and a
/// model `vision::model_accepts_pdf` says reads PDFs; every other document
/// reaches the model as extracted text. A `File` part with no bytes (a
/// persisted reference that was never hydrated) is `None` and is dropped, as
/// before. OpenAI's `file` part requires a file name, so a missing one falls
/// back to a generic name rather than dropping the document.
pub fn hydrated_document(part: &MessagePart) -> Option<(&str, &str, &str)> {
    if part.kind != MessagePartKind::File {
        return None;
    }
    let mime = part.mime_type.as_deref().filter(|m| !m.is_empty())?;
    let data = part.content.as_deref().filter(|d| !d.is_empty())?;
    let filename = part
        .metadata
        .as_ref()
        .and_then(|m| m.get("filename"))
        .and_then(|f| f.as_str())
        .filter(|f| !f.trim().is_empty())
        .unwrap_or("document.pdf");
    Some((mime, data, filename))
}

/// OpenAI chat-completions multimodal `content` array (text + image_url data
/// URIs + `file` parts). OpenRouter takes the same `file` shape.
pub fn openai_user_content(message: &Message) -> serde_json::Value {
    use serde_json::json;
    if !message_has_media(message) {
        return json!(message_text(message));
    }
    let mut parts = Vec::new();
    for part in &message.parts {
        match part.kind {
            MessagePartKind::Text | MessagePartKind::Reasoning => {
                if let Some(text) = part.content.as_ref().filter(|s| !s.is_empty()) {
                    parts.push(json!({ "type": "text", "text": text }));
                }
            }
            MessagePartKind::Image => {
                if let (Some(mime), Some(data)) = (&part.mime_type, &part.content) {
                    if !mime.is_empty() && !data.is_empty() {
                        parts.push(json!({
                            "type": "image_url",
                            "image_url": {
                                "url": format!("data:{mime};base64,{data}")
                            }
                        }));
                    }
                }
            }
            MessagePartKind::File => {
                if let Some((mime, data, filename)) = hydrated_document(part) {
                    parts.push(json!({
                        "type": "file",
                        "file": {
                            "filename": filename,
                            "file_data": format!("data:{mime};base64,{data}"),
                        }
                    }));
                }
            }
            _ => {}
        }
    }
    if parts.is_empty() {
        json!("")
    } else {
        json!(parts)
    }
}

/// Anthropic user `content` blocks (text + base64 image and document sources).
pub fn anthropic_user_content(message: &Message) -> serde_json::Value {
    use serde_json::json;
    if !message_has_media(message) {
        return json!(message_text(message));
    }
    let mut blocks = Vec::new();
    for part in &message.parts {
        match part.kind {
            MessagePartKind::Text | MessagePartKind::Reasoning => {
                if let Some(text) = part.content.as_ref().filter(|s| !s.is_empty()) {
                    blocks.push(json!({ "type": "text", "text": text }));
                }
            }
            MessagePartKind::Image => {
                if let (Some(mime), Some(data)) = (&part.mime_type, &part.content) {
                    if !mime.is_empty() && !data.is_empty() {
                        blocks.push(json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": mime,
                                "data": data,
                            }
                        }));
                    }
                }
            }
            MessagePartKind::File => {
                if let Some((mime, data, _filename)) = hydrated_document(part) {
                    blocks.push(json!({
                        "type": "document",
                        "source": {
                            "type": "base64",
                            "media_type": mime,
                            "data": data,
                        }
                    }));
                }
            }
            _ => {}
        }
    }
    if blocks.is_empty() {
        json!("")
    } else {
        json!(blocks)
    }
}

/// Gemini user `parts` (text + inlineData for images and PDFs alike).
pub fn gemini_user_parts(message: &Message) -> Vec<serde_json::Value> {
    use serde_json::json;
    if !message_has_media(message) {
        return vec![json!({ "text": message_text(message) })];
    }
    let mut parts = Vec::new();
    for part in &message.parts {
        match part.kind {
            MessagePartKind::Text | MessagePartKind::Reasoning => {
                if let Some(text) = part.content.as_ref().filter(|s| !s.is_empty()) {
                    parts.push(json!({ "text": text }));
                }
            }
            MessagePartKind::Image => {
                if let (Some(mime), Some(data)) = (&part.mime_type, &part.content) {
                    if !mime.is_empty() && !data.is_empty() {
                        parts.push(json!({
                            "inlineData": {
                                "mimeType": mime,
                                "data": data,
                            }
                        }));
                    }
                }
            }
            MessagePartKind::File => {
                if let Some((mime, data, _filename)) = hydrated_document(part) {
                    parts.push(json!({
                        "inlineData": {
                            "mimeType": mime,
                            "data": data,
                        }
                    }));
                }
            }
            _ => {}
        }
    }
    if parts.is_empty() {
        vec![json!({ "text": "" })]
    } else {
        parts
    }
}

/// Ollama user message with optional top-level `images` array (raw base64).
pub fn ollama_user_message(message: &Message) -> serde_json::Value {
    use serde_json::json;
    let text = message_text(message);
    let images: Vec<String> = message
        .parts
        .iter()
        .filter(|p| p.kind == MessagePartKind::Image)
        .filter_map(|p| p.content.clone())
        .filter(|s| !s.is_empty())
        .collect();
    if images.is_empty() {
        json!({
            "role": role_to_string(&message.role),
            "content": text,
        })
    } else {
        json!({
            "role": role_to_string(&message.role),
            "content": text,
            "images": images,
        })
    }
}

pub fn role_to_string(role: &MessageRole) -> &'static str {
    match role {
        MessageRole::System => "system",
        MessageRole::Developer => "developer",
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::Tool => "tool",
    }
}

/// Accumulates raw bytes across `bytes_stream` chunks and emits complete
/// lines. H1: TCP/SSE framing does not align to `data:` lines — a single SSE
/// event is routinely split across two chunks, and a multibyte UTF-8 codepoint
/// can span a chunk boundary. Decoding each chunk independently dropped the
/// partial line (and mangled split codepoints). This buffer carries the
/// trailing partial line to the next chunk and decodes the *complete* line, so
/// neither happens.
///
/// Splitting on `b'\n'` is safe: a newline byte cannot be part of a multibyte
/// UTF-8 sequence (continuation bytes are all `>= 0x80`), so byte-boundary
/// splitting never fractures a codepoint mid-sequence.
struct LineBuffer {
    pending: Vec<u8>,
}

impl LineBuffer {
    fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    /// Feed raw bytes; returns each complete line (without its trailing newline
    /// or carriage return). Any trailing partial line is retained for the next
    /// call.
    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(nl) = self.pending.iter().position(|b| *b == b'\n') {
            let mut line: Vec<u8> = self.pending.drain(..=nl).collect();
            if line.last() == Some(&b'\n') {
                line.pop();
            }
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            out.push(String::from_utf8_lossy(&line).into_owned());
        }
        out
    }

    /// Drain any trailing partial line that never received a newline. Returns
    /// `None` when nothing (or only whitespace) remains.
    fn flush(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        let line = std::mem::take(&mut self.pending);
        let s = String::from_utf8_lossy(&line).into_owned();
        if s.trim().is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

pub(crate) fn wrap_sse_stream<P: StreamParser + 'static>(
    request_id: String,
    mut parser: P,
    sse: Pin<Box<dyn Stream<Item = Result<bytes::Bytes, crate::schema::ProviderError>> + Send>>,
) -> Pin<Box<dyn Stream<Item = ProviderEvent> + Send>> {
    let stream = async_stream::stream! {
      let mut index = 0usize;
      yield ProviderEvent::MessageStart {
        request_id: request_id.clone(),
        index: 0,
      };

      // Track whether the parser produced any substantive event (content,
      // reasoning, tool calls, or a surfaced error). A stream that yields only
      // `Ping`/`Usage`/nothing is an empty response — without this guard the
      // trailing `MessageComplete` would make it look like a successful turn
      // with zero output: a blank assistant bubble and no error. An `Error`
      // counts as substantive so a real in-stream error isn't doubled by the
      // synthetic empty-response error emitted below.
      let mut produced_substantive = false;

      // Every existing parser leaves `MessageComplete` to the unconditional
      // yield below (the chat-completions / Gemini shapes carry no reliable
      // per-round "why did it stop" signal outside the chunk this wrapper
      // already scans). Ollama's `done: true` chunk is the one place a parser
      // needs to pick between "stop" and "tool_calls" itself (see
      // `ollama.rs::OllamaParser`), so it emits its own `MessageComplete`.
      // Tracking that here — rather than hard-coding "stop" always — is what
      // lets that adapter opt in without every other adapter changing.
      let mut got_message_complete = false;

      let mut buf = LineBuffer::new();
      futures::pin_mut!(sse);
      while let Some(chunk_result) = sse.next().await {
        match chunk_result {
          Ok(bytes) => {
            for line in buf.push(&bytes) {
              for event in dispatch_sse_line(&line, &request_id, &mut parser, &mut index) {
                if is_substantive(&event) {
                  produced_substantive = true;
                }
                if matches!(event, ProviderEvent::MessageComplete { .. }) {
                  got_message_complete = true;
                }
                yield event;
              }
            }
          }
          Err(error) => {
            yield ProviderEvent::Error {
              request_id: request_id.clone(),
              error,
            };
            return;
          }
        }
      }

      if let Some(tail) = buf.flush() {
        for event in dispatch_sse_line(&tail, &request_id, &mut parser, &mut index) {
          if is_substantive(&event) {
            produced_substantive = true;
          }
          if matches!(event, ProviderEvent::MessageComplete { .. }) {
            got_message_complete = true;
          }
          yield event;
        }
      }

      if !produced_substantive {
        yield ProviderEvent::Error {
          request_id: request_id.clone(),
          error: ProviderError {
            provider_code: None,
            retryable: false,
            message: "Provider returned an empty response with no content".to_string(),
          },
        };
      }

      if !got_message_complete {
        yield ProviderEvent::MessageComplete {
          request_id: request_id.clone(),
          index,
          finish_reason: parser.finish_reason().unwrap_or("stop").to_string(),
        };
      }
    };

    Box::pin(stream)
}

/// Whether an event represents actual assistant output (or a surfaced
/// error), as opposed to framing/noise (`MessageStart`, `Ping`, `Usage`).
/// Used by `wrap_sse_stream` to detect an empty provider response.
fn is_substantive(event: &ProviderEvent) -> bool {
    !matches!(
        event,
        ProviderEvent::MessageStart { .. }
            | ProviderEvent::Ping { .. }
            | ProviderEvent::Usage { .. }
    )
}

/// Applies the SSE line dispatch (`data:` prefix strip, `[DONE]` skip, bare
/// JSON object fallback) shared by the streaming and fixture paths.
fn dispatch_sse_line<P: StreamParser>(
    line: &str,
    request_id: &str,
    parser: &mut P,
    index: &mut usize,
) -> Vec<ProviderEvent> {
    let line = line.trim();
    if let Some(data) = line.strip_prefix("data:") {
        let data = data.trim();
        if data == "[DONE]" {
            return Vec::new();
        }
        parser.parse_chunk(request_id, data, index)
    } else if !line.is_empty() && line.starts_with('{') {
        parser.parse_chunk(request_id, line, index)
    } else {
        Vec::new()
    }
}

pub(crate) fn normalized_or_err(
    request: ProviderRequest,
) -> Result<crate::normalize::NormalizedRequest, crate::schema::ProviderError> {
    crate::normalize::validate(request)
}

pub(crate) fn missing_key() -> crate::schema::ProviderError {
    fatal("API key is required for this provider")
}

/// Drives a `StreamParser` over an SSE fixture string the same way
/// `wrap_sse_stream` does at runtime: emit `MessageStart`, feed one
/// `parse_chunk` call per extracted line, then `MessageComplete`.
///
/// `extract` maps a raw (trimmed) line to the data payload to parse, or
/// `None` to skip the line — mirroring the per-provider preprocessing
/// (anthropic/openai strip a `data:` prefix; ollama parses bare JSON lines).
pub(crate) fn parse_fixture_stream<P, F>(
    parser: &mut P,
    request_id: &str,
    fixture: &str,
    extract: F,
) -> Vec<ProviderEvent>
where
    P: StreamParser,
    F: Fn(&str) -> Option<&str>,
{
    let mut index = 0usize;
    let mut events = vec![ProviderEvent::MessageStart {
        request_id: request_id.to_string(),
        index: 0,
    }];

    for line in fixture.lines() {
        let line = line.trim();
        if let Some(data) = extract(line) {
            events.extend(parser.parse_chunk(request_id, data, &mut index));
        }
    }

    // Mirror `wrap_sse_stream`: only append the generic "stop" completion when
    // the parser did not already emit its own `MessageComplete` (Ollama does,
    // to pick "tool_calls" vs "stop" — see `ollama.rs`).
    let got_message_complete = events
        .iter()
        .any(|e| matches!(e, ProviderEvent::MessageComplete { .. }));
    if !got_message_complete {
        events.push(ProviderEvent::MessageComplete {
            request_id: request_id.to_string(),
            index,
            finish_reason: parser.finish_reason().unwrap_or("stop").to_string(),
        });
    }

    events
}

#[cfg(test)]
mod knowledge_reference_drop_tests {
    //! D8: a `knowledgeReference` part must never reach a provider. These
    //! build a user message with one Text part and one KnowledgeReference
    //! part through each adapter's shared content builder and assert the
    //! rendered payload has no trace of the reference — no `"knowledge"`
    //! substring, no `documentId`/`title` from its metadata.
    use super::*;
    use crate::schema::{Message, MessagePart, MessageRole};

    fn message_with_reference() -> Message {
        Message {
            id: "msg-1".to_string(),
            conversation_id: "conv-1".to_string(),
            role: MessageRole::User,
            author_label: None,
            provider_message_id: None,
            request_id: None,
            interrupted_at: None,
            metadata: None,
            parts: vec![
                MessagePart {
                    id: "part-1".to_string(),
                    message_id: "msg-1".to_string(),
                    index: 0,
                    kind: MessagePartKind::Text,
                    content: Some("What does the doc say?".to_string()),
                    mime_type: None,
                    tool_call_id: None,
                    artifact_id: None,
                    attachment_id: None,
                    blob_ref: None,
                    metadata: None,
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                },
                MessagePart {
                    id: "part-2".to_string(),
                    message_id: "msg-1".to_string(),
                    index: 1,
                    kind: MessagePartKind::KnowledgeReference,
                    content: None,
                    mime_type: None,
                    tool_call_id: None,
                    artifact_id: None,
                    attachment_id: None,
                    blob_ref: None,
                    metadata: Some(serde_json::json!({
                        "documentId": "doc-secret-id",
                        "title": "notes.md",
                        "collectionId": "col-1",
                        "collectionName": "Research",
                    })),
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                },
                // A hydrated image part so `message_has_images` is true and
                // every builder below walks its full per-part match arm
                // (rather than short-circuiting to a plain-text payload),
                // actually exercising the `_ => {}` arm the KnowledgeReference
                // part must fall into.
                MessagePart {
                    id: "part-3".to_string(),
                    message_id: "msg-1".to_string(),
                    index: 2,
                    kind: MessagePartKind::Image,
                    content: Some("aGVsbG8=".to_string()),
                    mime_type: Some("image/png".to_string()),
                    tool_call_id: None,
                    artifact_id: None,
                    attachment_id: None,
                    blob_ref: None,
                    metadata: None,
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                },
            ],
            created_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    fn assert_no_reference_trace(rendered: &str) {
        assert!(rendered.contains("What does the doc say?"));
        assert!(!rendered.to_lowercase().contains("knowledge"));
        assert!(!rendered.contains("doc-secret-id"));
        assert!(!rendered.contains("notes.md"));
        assert!(!rendered.contains("col-1"));
        assert!(!rendered.contains("Research"));
    }

    #[test]
    fn message_text_ignores_knowledge_reference() {
        let message = message_with_reference();
        assert_eq!(message_text(&message), "What does the doc say?");
    }

    #[test]
    fn openai_user_content_drops_knowledge_reference() {
        let message = message_with_reference();
        let rendered = openai_user_content(&message).to_string();
        assert_no_reference_trace(&rendered);
    }

    #[test]
    fn anthropic_user_content_drops_knowledge_reference() {
        let message = message_with_reference();
        let rendered = anthropic_user_content(&message).to_string();
        assert_no_reference_trace(&rendered);
    }

    #[test]
    fn gemini_user_parts_drops_knowledge_reference() {
        let message = message_with_reference();
        let rendered = serde_json::to_string(&gemini_user_parts(&message)).unwrap();
        assert_no_reference_trace(&rendered);
    }

    #[test]
    fn ollama_user_message_drops_knowledge_reference() {
        let message = message_with_reference();
        let rendered = ollama_user_message(&message).to_string();
        assert_no_reference_trace(&rendered);
    }
}

#[cfg(test)]
mod document_part_tests {
    //! A hydrated PDF (`MessagePartKind::File`, base64 in `content`) is encoded
    //! in each provider's own document shape, and only a hydrated one is.
    use super::*;
    use crate::schema::{Message, MessagePart, MessageRole};
    use serde_json::json;

    fn part(index: u32, kind: MessagePartKind, content: Option<&str>) -> MessagePart {
        MessagePart {
            id: format!("p{index}"),
            message_id: "m1".into(),
            index,
            kind,
            content: content.map(str::to_string),
            mime_type: None,
            tool_call_id: None,
            artifact_id: None,
            attachment_id: None,
            blob_ref: None,
            metadata: None,
            created_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    fn message_with_pdf(hydrated: bool) -> Message {
        let mut pdf = part(1, MessagePartKind::File, hydrated.then_some("JVBERi0="));
        pdf.mime_type = Some("application/pdf".into());
        pdf.attachment_id = Some("att-1".into());
        pdf.metadata = Some(json!({ "filename": "report.pdf" }));
        Message {
            id: "m1".into(),
            conversation_id: "c1".into(),
            role: MessageRole::User,
            author_label: None,
            provider_message_id: None,
            request_id: None,
            interrupted_at: None,
            metadata: None,
            parts: vec![part(0, MessagePartKind::Text, Some("Summarise this")), pdf],
            created_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn openai_chat_gets_a_file_part() {
        let content = openai_user_content(&message_with_pdf(true));
        assert_eq!(
            content[0],
            json!({ "type": "text", "text": "Summarise this" })
        );
        assert_eq!(
            content[1],
            json!({
                "type": "file",
                "file": {
                    "filename": "report.pdf",
                    "file_data": "data:application/pdf;base64,JVBERi0=",
                }
            })
        );
    }

    #[test]
    fn anthropic_gets_a_document_block() {
        let content = anthropic_user_content(&message_with_pdf(true));
        assert_eq!(
            content[1],
            json!({
                "type": "document",
                "source": {
                    "type": "base64",
                    "media_type": "application/pdf",
                    "data": "JVBERi0=",
                }
            })
        );
    }

    #[test]
    fn gemini_gets_inline_data() {
        let parts = gemini_user_parts(&message_with_pdf(true));
        assert_eq!(
            parts[1],
            json!({ "inlineData": { "mimeType": "application/pdf", "data": "JVBERi0=" } })
        );
    }

    #[test]
    fn a_missing_filename_falls_back_rather_than_dropping_the_pdf() {
        let mut message = message_with_pdf(true);
        message.parts[1].metadata = None;
        let content = openai_user_content(&message);
        assert_eq!(content[1]["file"]["filename"], "document.pdf");
    }

    #[test]
    fn an_unhydrated_file_part_is_dropped_and_the_message_stays_plain_text() {
        let message = message_with_pdf(false);
        assert_eq!(openai_user_content(&message), json!("Summarise this"));
        assert_eq!(anthropic_user_content(&message), json!("Summarise this"));
        assert_eq!(
            gemini_user_parts(&message),
            vec![json!({ "text": "Summarise this" })]
        );
    }

    #[test]
    fn ollama_never_receives_a_document() {
        let rendered = ollama_user_message(&message_with_pdf(true)).to_string();
        assert!(!rendered.contains("JVBERi0="), "{rendered}");
    }
}

#[cfg(test)]
mod line_buffer_tests {
    use super::*;
    use crate::adapter::StreamParser;
    use bytes::Bytes;
    use futures::stream::StreamExt;

    /// Shared capture of the data payloads handed to `parse_chunk`. Tests assert
    /// exactly what the line buffer reconstructed, independent of any provider's
    /// parsing rules. `wrap_sse_stream` takes ownership of its parser, so we hand
    /// it a `Forward` that writes into this shared `Arc` and keep a second handle
    /// for assertion.
    type Capture = std::sync::Arc<std::sync::Mutex<Vec<String>>>;

    fn capture() -> Capture {
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()))
    }

    struct Forward(Capture);
    impl StreamParser for Forward {
        fn parse_chunk(
            &mut self,
            _request_id: &str,
            data: &str,
            _index: &mut usize,
        ) -> Vec<ProviderEvent> {
            self.0.lock().unwrap().push(data.to_string());
            Vec::new()
        }
    }

    fn drain(c: &Capture) -> Vec<String> {
        std::mem::take(&mut *c.lock().unwrap())
    }

    fn byte_chunks(
        chunks: Vec<Vec<u8>>,
    ) -> Pin<Box<dyn Stream<Item = Result<Bytes, crate::schema::ProviderError>> + Send>> {
        Box::pin(futures::stream::iter(
            chunks.into_iter().map(|c| Ok(Bytes::from(c))),
        ))
    }

    fn chunk(b: &[u8]) -> Vec<u8> {
        b.to_vec()
    }

    #[tokio::test]
    async fn split_json_line_is_reassembled() {
        // H1: a single `data:` line split across two byte chunks must reach the
        // parser as one complete payload, not be dropped.
        let seen = capture();
        let sse = byte_chunks(vec![chunk(b"data: {\"v\":\"hel"), chunk(b"lo\"}\n\n")]);
        let stream = wrap_sse_stream("req-1".to_string(), Forward(seen.clone()), sse);
        futures::pin_mut!(stream);
        while stream.next().await.is_some() {}
        assert_eq!(drain(&seen), vec!["{\"v\":\"hello\"}"]);
    }

    #[tokio::test]
    async fn split_done_marker_is_recognized() {
        // `data: [DONE]` split across chunks must still be treated as DONE and
        // not fed to the parser.
        let seen = capture();
        let sse = byte_chunks(vec![chunk(b"data: [DON"), chunk(b"E]\n\n")]);
        let stream = wrap_sse_stream("req-1".to_string(), Forward(seen.clone()), sse);
        futures::pin_mut!(stream);
        while stream.next().await.is_some() {}
        assert!(drain(&seen).is_empty(), "[DONE] must be skipped");
    }

    #[tokio::test]
    async fn split_multibyte_codepoint_is_reassembled() {
        // A multibyte UTF-8 codepoint (✓ = E2 9C 93) split across chunks must be
        // rejoined into the complete line, not replaced with U+FFFD.
        let seen = capture();
        let sse = byte_chunks(vec![
            chunk(b"data: {\"v\":\"\xe2"),
            chunk(b"\x9c\x93\"}\n\n"),
        ]);
        let stream = wrap_sse_stream("req-1".to_string(), Forward(seen.clone()), sse);
        futures::pin_mut!(stream);
        while stream.next().await.is_some() {}
        assert_eq!(drain(&seen), vec!["{\"v\":\"✓\"}"]);
    }

    #[tokio::test]
    async fn multiple_events_in_one_chunk_all_parse() {
        let seen = capture();
        let sse = byte_chunks(vec![chunk(b"data: a\ndata: b\n\n")]);
        let stream = wrap_sse_stream("req-1".to_string(), Forward(seen.clone()), sse);
        futures::pin_mut!(stream);
        while stream.next().await.is_some() {}
        assert_eq!(drain(&seen), vec!["a", "b"]);
    }

    #[tokio::test]
    async fn empty_response_emits_error_not_silent_complete() {
        // A parser that yields no substantive events (an empty provider
        // response) must produce a `ProviderEvent::Error`, not a bare
        // `MessageComplete` — otherwise the UI shows a blank bubble with no
        // error. `Forward` returns no events for any chunk.
        let seen = capture();
        let sse = byte_chunks(vec![chunk(b"data: {\"choices\":[]}\n\n")]);
        let stream = wrap_sse_stream("req-1".to_string(), Forward(seen.clone()), sse);
        futures::pin_mut!(stream);
        let mut collected = Vec::new();
        while let Some(event) = stream.next().await {
            collected.push(event);
        }
        assert!(
            collected
                .iter()
                .any(|e| matches!(e, ProviderEvent::Error { .. })),
            "empty provider response must surface an Error event, not a silent complete"
        );
        assert!(
            collected
                .iter()
                .any(|e| matches!(e, ProviderEvent::MessageComplete { .. })),
            "MessageComplete must still finalize the stream after the error"
        );
    }
}
