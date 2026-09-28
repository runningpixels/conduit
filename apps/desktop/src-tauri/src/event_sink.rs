//! Where an agent turn's events go.
//!
//! `StreamManager` used to take `tauri::ipc::Channel`s, so a turn could only
//! run with a webview listening. An `EventSink` is the same "send, or learn the
//! listener is gone" contract without the webview. A `Channel` converts into
//! one, and a headless caller (a scheduled workflow, a test) passes a closure or
//! a [`collector`].
//!
//! A failed send means the listener has gone away. For a webview that is the
//! window closing, and the turn cancels itself. That behaviour is unchanged: the
//! `Channel` conversion reports its errors as [`SinkClosed`].

use std::sync::{Arc, Mutex};

use tauri::ipc::{Channel, IpcResponse};

/// The listener is gone; the turn should stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SinkClosed;

pub struct EventSink<T>(Arc<dyn Fn(T) -> Result<(), SinkClosed> + Send + Sync>);

impl<T> Clone for EventSink<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<T> EventSink<T> {
    pub fn from_fn(send: impl Fn(T) -> Result<(), SinkClosed> + Send + Sync + 'static) -> Self {
        Self(Arc::new(send))
    }

    /// Accepts and drops every event.
    pub fn discard() -> Self {
        Self::from_fn(|_| Ok(()))
    }

    pub fn send(&self, event: T) -> Result<(), SinkClosed> {
        (self.0)(event)
    }
}

impl<T: IpcResponse + Send + Sync + 'static> From<Channel<T>> for EventSink<T> {
    fn from(channel: Channel<T>) -> Self {
        Self::from_fn(move |event| channel.send(event).map_err(|_| SinkClosed))
    }
}

/// A sink that keeps every event, and a handle to read them.
pub fn collector<T: Send + 'static>() -> (EventSink<T>, Arc<Mutex<Vec<T>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink_events = events.clone();
    let sink = EventSink::from_fn(move |event| {
        sink_events.lock().map_err(|_| SinkClosed)?.push(event);
        Ok(())
    });
    (sink, events)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collector_keeps_events_in_order_across_clones() {
        let (sink, events) = collector::<u32>();
        let clone = sink.clone();
        sink.send(1).unwrap();
        clone.send(2).unwrap();
        assert_eq!(*events.lock().unwrap(), vec![1, 2]);
    }

    #[test]
    fn a_closed_listener_is_reported() {
        let sink = EventSink::<u32>::from_fn(|_| Err(SinkClosed));
        assert_eq!(sink.send(1), Err(SinkClosed));
        assert_eq!(EventSink::<u32>::discard().send(1), Ok(()));
    }

    #[test]
    fn a_channel_converts_and_reports_its_failures_as_closed() {
        let ok: EventSink<String> = Channel::<String>::new(|_| Ok(())).into();
        assert_eq!(ok.send("x".into()), Ok(()));
        let gone: EventSink<String> =
            Channel::<String>::new(|_| Err(tauri::Error::WebviewNotFound)).into();
        assert_eq!(gone.send("x".into()), Err(SinkClosed));
    }
}
