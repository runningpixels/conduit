use crate::adapter::StreamParser;
use crate::error::fatal;
use crate::schema::{
    Message, MessagePartKind, MessageRole, ProviderError, ProviderEvent, ProviderRequest,
};
use futures::stream::{Stream, StreamExt};
use std::pin::Pin;

pub mod anthropic;
pub mod ollama;
pub mod openai;
pub mod openai_compat;

pub fn message_text(message: &Message) -> String {
    message
        .parts
        .iter()
        .filter(|p| matches!(p.kind, MessagePartKind::Text | MessagePartKind::Reasoning))
        .filter_map(|p| p.content.as_ref())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n")
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

      yield ProviderEvent::MessageComplete {
        request_id: request_id.clone(),
        index,
        finish_reason: "stop".to_string(),
      };
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

    events.push(ProviderEvent::MessageComplete {
        request_id: request_id.to_string(),
        index,
        finish_reason: "stop".to_string(),
    });

    events
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
