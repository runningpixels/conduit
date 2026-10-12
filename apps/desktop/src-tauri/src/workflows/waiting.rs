//! Runs waiting for the user: a permission question (`permissions::Reviews`)
//! or an "Ask me" step (`ask::Questions`).
//!
//! The waiting run holds the receiving end; the page lists what's waiting and
//! answers through the registry. A run can wait on several steps at once (steps
//! that run side by side), so a wait is keyed by the run and the step. The wait
//! is in memory: quitting while a run waits ends it, and it's marked failed at
//! the next launch.

use std::collections::HashMap;
use std::sync::Mutex;

use tokio::sync::oneshot;

/// Something a run is waiting on.
pub trait Pending: Clone {
    fn run_id(&self) -> &str;
    /// The step that is waiting.
    fn step_id(&self) -> &str;
    /// ISO-8601, so waiting items list oldest first.
    fn requested_at(&self) -> &str;
}

type Listener<T> = Box<dyn Fn(&T) + Send + Sync>;
/// What is waiting, by (run id, step id), with where its answer goes.
type Entries<T, A> = HashMap<(String, String), (T, oneshot::Sender<A>)>;

/// What runs are waiting on (`T`), by run id and step id, and where each
/// answer (`A`) goes.
pub struct Waiting<T, A> {
    waiting: Mutex<Entries<T, A>>,
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
            waiting.insert(
                (item.run_id().to_string(), item.step_id().to_string()),
                (item, tx),
            );
        }
        rx
    }

    /// The key of the wait `step_id` names in `run_id`; without a step, the
    /// run's only wait (none when it waits on several: which one is unclear).
    fn key_for(
        waiting: &Entries<T, A>,
        run_id: &str,
        step_id: Option<&str>,
    ) -> Option<(String, String)> {
        if let Some(step_id) = step_id {
            let key = (run_id.to_string(), step_id.to_string());
            return waiting.contains_key(&key).then_some(key);
        }
        let mut open = waiting.keys().filter(|(run, _)| run == run_id);
        match (open.next(), open.next()) {
            (Some(only), None) => Some(only.clone()),
            _ => None,
        }
    }

    /// Answer what `step_id` waits on in `run_id`; without a step, the run's
    /// only wait. `false` when nothing (or, without a step, more than one
    /// thing) is waiting.
    pub fn answer(&self, run_id: &str, step_id: Option<&str>, answer: A) -> bool {
        let entry = self.waiting.lock().ok().and_then(|mut w| {
            let key = Self::key_for(&w, run_id, step_id)?;
            w.remove(&key)
        });
        match entry {
            Some((_, tx)) => tx.send(answer).is_ok(),
            None => false,
        }
    }

    /// What `step_id` waits on in `run_id` (without a step, the run's only
    /// wait), if anything.
    pub fn get(&self, run_id: &str, step_id: Option<&str>) -> Option<T> {
        let waiting = self.waiting.lock().ok()?;
        let key = Self::key_for(&waiting, run_id, step_id)?;
        waiting.get(&key).map(|(item, _)| item.clone())
    }

    /// Forget what `step_id` waited on in `run_id` (answered, stopped or
    /// timed out).
    pub fn clear(&self, run_id: &str, step_id: &str) {
        if let Ok(mut waiting) = self.waiting.lock() {
            waiting.remove(&(run_id.to_string(), step_id.to_string()));
        }
    }

    /// How many things `run_id` waits on.
    pub fn open(&self, run_id: &str) -> usize {
        self.waiting
            .lock()
            .map(|w| w.keys().filter(|(run, _)| run == run_id).count())
            .unwrap_or(0)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct Item(&'static str, &'static str);

    impl Pending for Item {
        fn run_id(&self) -> &str {
            self.0
        }
        fn step_id(&self) -> &str {
            self.1
        }
        fn requested_at(&self) -> &str {
            ""
        }
    }

    #[test]
    fn a_run_can_wait_on_two_steps_and_each_is_answered_on_its_own() {
        let waiting: Waiting<Item, u8> = Waiting::default();
        let mut one = waiting.ask(Item("r", "a"));
        let mut two = waiting.ask(Item("r", "b"));
        assert_eq!(waiting.open("r"), 2);
        // Without a step the answer is ambiguous, so nothing is answered.
        assert!(!waiting.answer("r", None, 0));
        assert!(waiting.get("r", None).is_none());
        assert!(waiting.answer("r", Some("b"), 2));
        assert_eq!(two.try_recv().unwrap(), 2);
        assert!(one.try_recv().is_err());
        // One wait left: the run alone names it.
        assert_eq!(waiting.get("r", None).unwrap().1, "a");
        assert!(waiting.answer("r", None, 1));
        assert_eq!(one.try_recv().unwrap(), 1);
        assert_eq!(waiting.open("r"), 0);
        assert!(!waiting.answer("r", Some("a"), 1), "only once");
    }

    #[test]
    fn clearing_forgets_one_step_only() {
        let waiting: Waiting<Item, u8> = Waiting::default();
        let _one = waiting.ask(Item("r", "a"));
        let _two = waiting.ask(Item("r", "b"));
        waiting.clear("r", "a");
        assert_eq!(waiting.open("r"), 1);
        assert_eq!(waiting.list().len(), 1);
    }
}
