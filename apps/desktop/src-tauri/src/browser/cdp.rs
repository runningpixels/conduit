// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! A minimal DevTools-protocol client over a loopback websocket. Flattened
//! sessions: every message for a tab carries its `sessionId`. Requests are
//! numbered and answered through one-shot channels; events go out on a
//! broadcast channel.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

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

/// Read one websocket text frame.
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

/// The request frame for `method`.
pub fn request_frame(id: u64, method: &str, params: Value, session: Option<&str>) -> String {
    let mut frame = json!({ "id": id, "method": method, "params": params });
    if let Some(session) = session {
        frame["sessionId"] = Value::String(session.to_string());
    }
    frame.to_string()
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

pub struct Cdp {
    out: mpsc::UnboundedSender<String>,
    pending: Pending,
    next: AtomicU64,
    events: broadcast::Sender<Event>,
    closed: Arc<AtomicBool>,
}

impl Cdp {
    /// Connect to the browser's websocket (`ws://127.0.0.1:<port>/devtools/browser/<id>`).
    pub async fn connect(ws_url: &str) -> Result<Arc<Cdp>, CdpError> {
        let (socket, _) = tokio::time::timeout(
            Duration::from_secs(10),
            tokio_tungstenite::connect_async(ws_url),
        )
        .await
        .map_err(|_| CdpError::Timeout)?
        .map_err(|e| CdpError::Protocol(e.to_string()))?;
        let (mut sink, mut stream) = socket.split();
        let (out, mut outgoing) = mpsc::unbounded_channel::<String>();
        let (events, _) = broadcast::channel(1024);
        let pending: Pending = Arc::default();
        let closed = Arc::new(AtomicBool::new(false));

        tokio::spawn(async move {
            while let Some(frame) = outgoing.recv().await {
                if sink.send(Message::text(frame)).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });

        let reader = (pending.clone(), events.clone(), closed.clone());
        tokio::spawn(async move {
            let (pending, events, closed) = reader;
            while let Some(Ok(message)) = stream.next().await {
                let Message::Text(text) = message else {
                    if matches!(message, Message::Close(_)) {
                        break;
                    }
                    continue;
                };
                match parse_incoming(text.as_str()) {
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
            closed.store(true, Ordering::SeqCst);
            // Dropping the senders wakes every waiting call with `Closed`.
            let locked = pending.lock();
            if let Ok(mut waiting) = locked {
                waiting.clear();
            }
        });

        Ok(Arc::new(Cdp {
            out,
            pending,
            next: AtomicU64::new(1),
            events,
            closed,
        }))
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
        if self
            .out
            .send(request_frame(id, method, params, session))
            .is_err()
        {
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
    use tokio::net::TcpListener;

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

    /// A fake browser: answers `Echo` with its params, ignores `Silent`, and
    /// follows every answer with an event.
    async fn fake_browser() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(Message::Text(text))) = ws.next().await {
                let request: Value = serde_json::from_str(text.as_str()).unwrap();
                match request["method"].as_str() {
                    Some("Silent") => {}
                    Some("Fail") => {
                        let reply = json!({"id": request["id"], "error": {"message": "bad"}});
                        ws.send(Message::text(reply.to_string())).await.unwrap();
                    }
                    Some("Hangup") => {
                        let _ = ws.close(None).await;
                        return;
                    }
                    _ => {
                        let reply = json!({"id": request["id"], "result": request["params"]});
                        ws.send(Message::text(reply.to_string())).await.unwrap();
                        let event = json!({"method": "Test.happened", "params": {"n": 1}, "sessionId": request["sessionId"]});
                        ws.send(Message::text(event.to_string())).await.unwrap();
                    }
                }
            }
        });
        format!("ws://127.0.0.1:{port}/devtools/browser/test")
    }

    #[tokio::test]
    async fn calls_get_their_answers_and_events_arrive() {
        let cdp = Cdp::connect(&fake_browser().await).await.unwrap();
        let mut events = cdp.subscribe();
        let answer = cdp.call("Echo", json!({"x": 1}), Some("S")).await.unwrap();
        assert_eq!(answer, json!({"x": 1}));
        let event = events.recv().await.unwrap();
        assert_eq!(event.method, "Test.happened");
        assert_eq!(event.session_id.as_deref(), Some("S"));
    }

    #[tokio::test]
    async fn errors_timeouts_and_hangups_are_told_apart() {
        let cdp = Cdp::connect(&fake_browser().await).await.unwrap();
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
