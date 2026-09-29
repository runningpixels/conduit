//! Runs waiting for the user: a permission question (`permissions::Reviews`)
//! or an "Ask me" step (`ask::Questions`).
//!
//! The waiting run holds the receiving end; the page lists what's waiting and
//! answers through the registry. The wait is in memory: quitting while a run
//! waits ends it, and it's marked failed at the next launch.

use std::collections::HashMap;
use std::sync::Mutex;

use tokio::sync::oneshot;

/// Something a run is waiting on.
pub trait Pending: Clone {
    fn run_id(&self) -> &str;
    /// ISO-8601, so waiting items list oldest first.
    fn requested_at(&self) -> &str;
}

type Listener<T> = Box<dyn Fn(&T) + Send + Sync>;

/// What runs are waiting on (`T`), by run id, and where each answer (`A`) goes.
pub struct Waiting<T, A> {
    waiting: Mutex<HashMap<String, (T, oneshot::Sender<A>)>>,
    on_wait: Mutex<Option<Listener<T>>>,
}

impl<T, A> Default for Waiting<T, A> {
    fn default() -> Self {
        Self {
            waiting: Mutex::new(HashMap::new()),
            on_wait: Mutex::new(None),
        }
    }
}

impl<T: Pending, A> Waiting<T, A> {
    /// Register `item` and return where its answer arrives.
    pub fn ask(&self, item: T) -> oneshot::Receiver<A> {
        let (tx, rx) = oneshot::channel();
        if let Ok(slot) = self.on_wait.lock() {
            if let Some(listener) = slot.as_ref() {
                listener(&item);
            }
        }
        if let Ok(mut waiting) = self.waiting.lock() {
            waiting.insert(item.run_id().to_string(), (item, tx));
        }
        rx
    }

    /// Answer what `run_id` waits on. `false` when nothing is waiting.
    pub fn answer(&self, run_id: &str, answer: A) -> bool {
        let entry = self.waiting.lock().ok().and_then(|mut w| w.remove(run_id));
        match entry {
            Some((_, tx)) => tx.send(answer).is_ok(),
            None => false,
        }
    }

    /// What `run_id` waits on, if anything.
    pub fn get(&self, run_id: &str) -> Option<T> {
        self.waiting
            .lock()
            .ok()
            .and_then(|w| w.get(run_id).map(|(item, _)| item.clone()))
    }

    /// Forget what `run_id` waited on (answered, stopped or timed out).
    pub fn clear(&self, run_id: &str) {
        if let Ok(mut waiting) = self.waiting.lock() {
            waiting.remove(run_id);
        }
    }

    /// Everything waiting, oldest first.
    pub fn list(&self) -> Vec<T> {
        let mut list: Vec<T> = self
            .waiting
            .lock()
            .map(|w| w.values().map(|(item, _)| item.clone()).collect())
            .unwrap_or_default();
        list.sort_by(|a, b| a.requested_at().cmp(b.requested_at()));
        list
    }

    /// Called whenever a run starts waiting (the notification).
    pub fn set_listener(&self, listener: impl Fn(&T) + Send + Sync + 'static) {
        if let Ok(mut slot) = self.on_wait.lock() {
            *slot = Some(Box::new(listener));
        }
    }
}
