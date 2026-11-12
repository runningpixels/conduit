// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! A minimal DevTools-protocol client over the browser's debugging pipe
//! (`--remote-debugging-pipe`: JSON messages, each ended by a NUL byte).
//! Flattened sessions: every message for a tab carries its `sessionId`.
//! Requests are numbered and answered through one-shot channels; events go
//! out on a broadcast channel.
//!
//! The bytes travel through a [`Transport`]: the browser's two pipe ends in
//! the app, an in-process pipe in the tests. Two threads move them, because
//! the pipe handles a browser inherits are plain blocking ones.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{broadcast, oneshot};

/// Longest one call waits for its answer unless the caller says otherwise.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CdpError {
    /// The connection to the browser is gone.
    Closed,
    /// No answer in time.
    Timeout,
    /// The browser answered with an error.
    Protocol(String),
}

impl std::fmt::Display for CdpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CdpError::Closed => f.write_str("the browser closed"),
            CdpError::Timeout => f.write_str("the browser did not answer in time"),
            CdpError::Protocol(message) => write!(f, "the browser refused: {message}"),
        }
    }
}

/// An event the browser sent.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub method: String,
    pub params: Value,
    pub session_id: Option<String>,
}

/// One incoming message, sorted.
#[derive(Debug, PartialEq)]
pub enum Incoming {
    Response {
        id: u64,
        result: Result<Value, String>,
    },
    Event(Event),
}

/// Read one message.
pub fn parse_incoming(text: &str) -> Option<Incoming> {
    let value: Value = serde_json::from_str(text).ok()?;
    if let Some(id) = value.get("id").and_then(Value::as_u64) {
        let result = match value.get("error") {
            Some(error) => Err(error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
                .to_string()),
            None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
        };
        return Some(Incoming::Response { id, result });
    }
    let method = value.get("method")?.as_str()?.to_string();
    Some(Incoming::Event(Event {
        method,
        params: value.get("params").cloned().unwrap_or(Value::Null),
        session_id: value
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string),
    }))
}

/// The request message for `method`.
pub fn request_frame(id: u64, method: &str, params: Value, session: Option<&str>) -> String {
    let mut frame = json!({ "id": id, "method": method, "params": params });
    if let Some(session) = session {
        frame["sessionId"] = Value::String(session.to_string());
    }
    frame.to_string()
}

/// Splits the pipe's byte stream into messages at each NUL. Bytes arrive in
/// any chunks: a message may span reads, a read may hold several.
#[derive(Debug, Default)]
pub struct Framer {
    partial: Vec<u8>,
}

impl Framer {
    /// Feed the bytes of one read; the messages they completed come back.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut done = Vec::new();
        for piece in bytes.split_inclusive(|b| *b == 0) {
            match piece.split_last() {
                Some((0, body)) => {
                    self.partial.extend_from_slice(body);
                    let message = std::mem::take(&mut self.partial);
                    if !message.is_empty() {
                        done.push(String::from_utf8_lossy(&message).into_owned());
                    }
                }
                _ => self.partial.extend_from_slice(piece),
            }
        }
        done
    }
}

/// The bytes of one message on the pipe.
pub fn encode_frame(message: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(message.len() + 1);
    bytes.extend_from_slice(message.as_bytes());
    bytes.push(0);
    bytes
}

/// A byte stream each way between us and the browser.
pub trait Transport: Send + 'static {
    type Reader: Read + Send + 'static;
    type Writer: Write + Send + 'static;
    /// What the browser sends, and where what we send goes.
    fn into_split(self) -> (Self::Reader, Self::Writer);
}

/// Any reader and writer pair (the browser's pipe ends, or a test's).
impl<R, W> Transport for (R, W)
where
    R: Read + Send + 'static,
    W: Write + Send + 'static,
{
    type Reader = R;
    type Writer = W;
    fn into_split(self) -> (R, W) {
        self
    }
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

pub struct Cdp {
    out: Mutex<std::sync::mpsc::Sender<String>>,
    pending: Pending,
    next: AtomicU64,
    events: broadcast::Sender<Event>,
    closed: Arc<AtomicBool>,
}

/// Mark the connection gone: every waiting call wakes with `Closed`.
fn shut(closed: &AtomicBool, pending: &Pending) {
    closed.store(true, Ordering::SeqCst);
    // Dropping the senders wakes every waiting call with `Closed`.
    if let Ok(mut waiting) = pending.lock() {
        waiting.clear();
    }
}

impl Cdp {
    /// Talk to the browser over `transport`.
    pub fn start(transport: impl Transport) -> Arc<Cdp> {
        let (mut reader, mut writer) = transport.into_split();
        let (out, outgoing) = std::sync::mpsc::channel::<String>();
        let (events, _) = broadcast::channel(1024);
        let pending: Pending = Arc::default();
        let closed = Arc::new(AtomicBool::new(false));

        let (writer_pending, writer_closed) = (pending.clone(), closed.clone());
        let _ = std::thread::Builder::new()
            .name("cdp-write".into())
            .spawn(move || {
                // Ends when the `Cdp` is dropped (the channel closes) or the
                // browser's end of the pipe is gone.
                while let Ok(message) = outgoing.recv() {
                    let sent = writer
                        .write_all(&encode_frame(&message))
                        .and_then(|_| writer.flush());
                    if sent.is_err() {
                        shut(&writer_closed, &writer_pending);
                        break;
                    }
                }
            });

        let reader_state = (pending.clone(), events.clone(), closed.clone());
        let _ = std::thread::Builder::new()
            .name("cdp-read".into())
            .spawn(move || {
                let (pending, events, closed) = reader_state;
                let mut framer = Framer::default();
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    let n = match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    for message in framer.push(&buf[..n]) {
                        match parse_incoming(&message) {
                            Some(Incoming::Response { id, result }) => {
                                let waiting = pending.lock().ok().and_then(|mut p| p.remove(&id));
                                if let Some(waiting) = waiting {
                                    let _ = waiting.send(result);
                                }
                            }
                            Some(Incoming::Event(event)) => {
                                let _ = events.send(event);
                            }
                            None => {}
                        }
                    }
                }
                shut(&closed, &pending);
            });

        Arc::new(Cdp {
            out: Mutex::new(out),
            pending,
            next: AtomicU64::new(1),
            events,
            closed,
        })
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Events from now on, for every session.
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    /// Call `method`; `session` addresses a tab (`None` is the browser).
    pub async fn call(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value, CdpError> {
        self.call_within(method, params, session, DEFAULT_TIMEOUT)
            .await
    }

    pub async fn call_within(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, CdpError> {
        if self.is_closed() {
            return Err(CdpError::Closed);
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| CdpError::Closed)?
            .insert(id, tx);
        let sent = self
            .out
            .lock()
            .map_err(|_| CdpError::Closed)
            .and_then(|out| {
                out.send(request_frame(id, method, params, session))
                    .map_err(|_| CdpError::Closed)
            });
        if sent.is_err() {
            self.forget(id);
            return Err(CdpError::Closed);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(message))) => Err(CdpError::Protocol(message)),
            Ok(Err(_)) => Err(CdpError::Closed),
            Err(_) => {
                self.forget(id);
                Err(CdpError::Timeout)
            }
        }
    }

    fn forget(&self, id: u64) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_and_events_are_sorted() {
        assert_eq!(
            parse_incoming(r#"{"id":4,"result":{"a":1}}"#),
            Some(Incoming::Response {
                id: 4,
                result: Ok(json!({"a":1}))
            })
        );
        assert_eq!(
            parse_incoming(r#"{"id":5,"error":{"code":-1,"message":"nope"}}"#),
            Some(Incoming::Response {
                id: 5,
                result: Err("nope".into())
            })
        );
        match parse_incoming(
            r#"{"method":"Page.loadEventFired","params":{"timestamp":1},"sessionId":"S"}"#,
        ) {
            Some(Incoming::Event(e)) => {
                assert_eq!(e.method, "Page.loadEventFired");
                assert_eq!(e.session_id.as_deref(), Some("S"));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(parse_incoming("not json"), None);
    }

    #[test]
    fn request_frames_carry_the_session() {
        let frame: Value =
            serde_json::from_str(&request_frame(7, "Page.enable", json!({}), Some("S1"))).unwrap();
        assert_eq!(frame["id"], 7);
        assert_eq!(frame["sessionId"], "S1");
        let frame: Value =
            serde_json::from_str(&request_frame(8, "Target.getTargets", json!({}), None)).unwrap();
        assert!(frame.get("sessionId").is_none());
    }

    #[test]
    fn frames_end_with_one_nul() {
        assert_eq!(encode_frame(r#"{"id":1}"#), b"{\"id\":1}\0".to_vec());
    }

    #[test]
    fn framing_splits_at_nul_across_any_chunks() {
        let mut framer = Framer::default();
        // Two messages in one read, the second only begun.
        assert_eq!(framer.push(b"{\"a\":1}\0{\"b\""), vec![r#"{"a":1}"#]);
        // The rest of it, split again.
        assert!(framer.push(b":2").is_empty());
        assert_eq!(framer.push(b"}\0"), vec![r#"{"b":2}"#]);
        // Byte by byte.
        let mut got = Vec::new();
        for b in b"{\"c\":3}\0" {
            got.extend(framer.push(&[*b]));
        }
        assert_eq!(got, vec![r#"{"c":3}"#]);
        // Several whole messages, and empty ones between them, skipped.
        assert_eq!(
            framer.push(b"{\"d\":4}\0\0{\"e\":5}\0"),
            vec![r#"{"d":4}"#, r#"{"e":5}"#]
        );
        // Multi-byte UTF-8 split across reads stays whole.
        let text = "{\"t\":\"caf\u{e9}\"}\0".as_bytes();
        let cut = text.len() - 4;
        assert!(framer.push(&text[..cut]).is_empty());
        assert_eq!(framer.push(&text[cut..]), vec!["{\"t\":\"caf\u{e9}\"}"]);
    }

    /// A fake browser on an in-process pipe pair: answers `Echo` with its
    /// params, ignores `Silent`, fails `Fail`, hangs up on `Hangup`, and
    /// follows every answer with an event. Replies go out in odd chunks, two
    /// messages per write, to exercise the framing.
    fn fake_browser() -> Arc<Cdp> {
        let (from_us, to_browser) = std::io::pipe().unwrap();
        let (from_browser, to_us) = std::io::pipe().unwrap();
        std::thread::spawn(move || {
            let (mut input, mut output) = (from_us, to_us);
            let mut framer = Framer::default();
            let mut buf = [0u8; 7];
            loop {
                let n = match input.read(&mut buf) {
                    Ok(0) | Err(_) => return,
                    Ok(n) => n,
                };
                for text in framer.push(&buf[..n]) {
                    let request: Value = serde_json::from_str(&text).unwrap();
                    let mut bytes = Vec::new();
                    match request["method"].as_str() {
                        Some("Silent") => {}
                        Some("Fail") => {
                            let reply = json!({"id": request["id"], "error": {"message": "bad"}});
                            bytes.extend(encode_frame(&reply.to_string()));
                        }
                        Some("Hangup") => return,
                        _ => {
                            let reply = json!({"id": request["id"], "result": request["params"]});
                            let event = json!({"method": "Test.happened", "params": {"n": 1}, "sessionId": request["sessionId"]});
                            bytes.extend(encode_frame(&reply.to_string()));
                            bytes.extend(encode_frame(&event.to_string()));
                        }
                    }
                    for chunk in bytes.chunks(5) {
                        if output.write_all(chunk).is_err() {
                            return;
                        }
                    }
                }
            }
        });
        Cdp::start((from_browser, to_browser))
    }

    #[tokio::test]
    async fn calls_get_their_answers_and_events_arrive() {
        let cdp = fake_browser();
        let mut events = cdp.subscribe();
        let answer = cdp.call("Echo", json!({"x": 1}), Some("S")).await.unwrap();
        assert_eq!(answer, json!({"x": 1}));
        let event = events.recv().await.unwrap();
        assert_eq!(event.method, "Test.happened");
        assert_eq!(event.session_id.as_deref(), Some("S"));
        // Calls in flight together each get their own answer.
        let (a, b) = tokio::join!(
            cdp.call("Echo", json!({"n": "a"}), None),
            cdp.call("Echo", json!({"n": "b"}), None)
        );
        assert_eq!(
            (a.unwrap(), b.unwrap()),
            (json!({"n": "a"}), json!({"n": "b"}))
        );
    }

    #[tokio::test]
    async fn errors_timeouts_and_hangups_are_told_apart() {
        let cdp = fake_browser();
        assert_eq!(
            cdp.call("Fail", json!({}), None).await,
            Err(CdpError::Protocol("bad".into()))
        );
        assert_eq!(
            cdp.call_within("Silent", json!({}), None, Duration::from_millis(100))
                .await,
            Err(CdpError::Timeout)
        );
        assert_eq!(
            cdp.call("Hangup", json!({}), None).await,
            Err(CdpError::Closed)
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(cdp.is_closed());
        assert_eq!(
            cdp.call("Echo", json!({}), None).await,
            Err(CdpError::Closed)
        );
    }
}
