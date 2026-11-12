// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! The browser in chat (design "browser-chat"): one tab per chat, kept
//! between messages and closed when idle, and the approvals and questions a
//! browser call waits on, answered from the chat.
//!
//! [`crate::stream_manager::StreamManager::execute_browser_tool`] runs the
//! calls; this module holds the state they share with the commands.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::detect::Browser;
use super::tools::{Chosen, RunBrowser};
use super::BrowserError;

/// A chat's tab is closed after this long without a browser call.
pub const IDLE_CLOSE: Duration = Duration::from_secs(30 * 60);
/// How often idle tabs are looked for.
const SWEEP_EVERY: Duration = Duration::from_secs(60);

/// What the model is told when a browser action wasn't allowed (the user
/// said Don't, sent a new message, or pressed Stop).
pub const NOT_ALLOWED: &str =
    "Not done: the user didn't allow it. Don't try it again; find another way or stop.";

/// The chats' browser tabs, by conversation id.
#[derive(Default)]
pub struct ChatBrowsers {
    tabs: Arc<Mutex<HashMap<String, Tab>>>,
    sweeping: AtomicBool,
}

struct Tab {
    browser: Arc<RunBrowser>,
    last_used: Instant,
}

impl ChatBrowsers {
    /// The chat's browser (made on first use), marked used now.
    pub fn checkout(&self, conversation_id: &str) -> Arc<RunBrowser> {
        let mut tabs = self.tabs.lock().unwrap_or_else(|e| e.into_inner());
        let tab = tabs
            .entry(conversation_id.to_string())
            .or_insert_with(|| Tab {
                browser: Arc::new(RunBrowser::default()),
                last_used: Instant::now(),
            });
        tab.last_used = Instant::now();
        tab.browser.clone()
    }

    /// Mark the chat's browser used now (after a call that took a while).
    pub fn touch(&self, conversation_id: &str) {
        let mut tabs = self.tabs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tab) = tabs.get_mut(conversation_id) {
            tab.last_used = Instant::now();
        }
    }

    /// Whether the chat has a browser.
    pub fn has(&self, conversation_id: &str) -> bool {
        self.tabs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(conversation_id)
    }

    /// Close the chat's tab (it was turned off or deleted). A call still
    /// running finishes first; the close happens in the background.
    pub fn close(&self, conversation_id: &str) {
        let taken = self
            .tabs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(conversation_id);
        if let Some(tab) = taken {
            close_in_background(tab.browser);
        }
    }

    /// Close every chat's tab (all chats were deleted).
    pub fn close_all(&self) {
        let taken: Vec<Tab> = self
            .tabs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .map(|(_, tab)| tab)
            .collect();
        for tab in taken {
            close_in_background(tab.browser);
        }
    }

    /// Take out the browsers unused for `idle` as of `now`. One a call is
    /// using (someone else holds it) stays, however long the call takes.
    pub fn take_idle(&self, now: Instant, idle: Duration) -> Vec<Arc<RunBrowser>> {
        take_idle(&self.tabs, now, idle)
    }

    /// Start the sweeper that closes idle tabs, once. Needs a Tokio runtime.
    pub fn start_sweeper(&self) {
        if self.sweeping.swap(true, Ordering::SeqCst) {
            return;
        }
        let tabs = Arc::downgrade(&self.tabs);
        tokio::spawn(async move {
            let mut every = tokio::time::interval(SWEEP_EVERY);
            every.tick().await;
            loop {
                every.tick().await;
                let Some(tabs) = tabs.upgrade() else {
                    return;
                };
                for browser in take_idle(&tabs, Instant::now(), IDLE_CLOSE) {
                    browser.close().await;
                }
            }
        });
    }
}

fn take_idle(
    tabs: &Mutex<HashMap<String, Tab>>,
    now: Instant,
    idle: Duration,
) -> Vec<Arc<RunBrowser>> {
    let mut tabs = tabs.lock().unwrap_or_else(|e| e.into_inner());
    let idle_ids: Vec<String> = tabs
        .iter()
        .filter(|(_, tab)| {
            now.saturating_duration_since(tab.last_used) >= idle
                && Arc::strong_count(&tab.browser) == 1
        })
        .map(|(id, _)| id.clone())
        .collect();
    idle_ids
        .into_iter()
        .filter_map(|id| tabs.remove(&id).map(|tab| tab.browser))
        .collect()
}

fn close_in_background(browser: Arc<RunBrowser>) {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn(async move { browser.close().await });
        }
        // No runtime: dropping it closes the tab as best it can.
        Err(_) => drop(browser),
    }
}

/// The browser a chat uses: the one chosen in Settings, else the first
/// installed in order of preference. Chat doesn't ask which one when several
/// are installed and Settings says Automatic; the choice is in Settings.
pub fn chat_browser_choice(setting: Option<&str>) -> Result<Chosen, String> {
    pick_browser(setting, super::detect::installed_now())
}

fn pick_browser(
    setting: Option<&str>,
    installed: Vec<(Browser, std::path::PathBuf)>,
) -> Result<Chosen, String> {
    if installed.is_empty() {
        return Err(BrowserError::NotInstalled.for_model());
    }
    if let Some(wanted) = setting.and_then(Browser::from_id) {
        return match installed.into_iter().find(|(b, _)| *b == wanted) {
            Some((browser, exe)) => Ok(Chosen { browser, exe }),
            None => Err(format!(
                "browser error: {} is chosen in Settings, under Computer, but isn't installed.",
                wanted.name()
            )),
        };
    }
    let (browser, exe) = installed.into_iter().next().expect("not empty");
    Ok(Chosen { browser, exe })
}

/// The person's answer to a browser prompt in the chat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptAnswer {
    /// The approval card: Do it (`send`) or Don't; `remember` is `"site"`
    /// (Always on this site) or `"all"` (Allow on all sites).
    Action {
        send: bool,
        remember: Option<String>,
    },
    /// The question: Continue (`go_on`) or the declining choice.
    Question { go_on: bool },
    /// Nobody answered: a steer or Stop resolved it as declined.
    Declined,
}

/// Which kind of prompt a call waits on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptKind {
    Action,
    Question,
}

struct Pending {
    request_id: String,
    kind: PromptKind,
    tx: tokio::sync::oneshot::Sender<PromptAnswer>,
    shown: Option<ShownPrompt>,
}

/// A card or question on show, as a window that reloaded needs it to draw
/// the call's row and the prompt on it again.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShownPrompt {
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments: serde_json::Value,
    /// The `browserApprovalRequested` or `browserQuestionRequested` event.
    pub event: provider_core::schema::ProviderEvent,
}

/// The browser prompts chat turns wait on, by tool call id (a call waits on
/// one at a time).
#[derive(Default)]
pub struct BrowserPrompts {
    pending: Mutex<HashMap<String, Pending>>,
}

impl BrowserPrompts {
    /// Wait for an answer to the prompt on `tool_call_id` from the turn
    /// `request_id`. One still open on the same call is declined.
    pub fn open(
        &self,
        tool_call_id: &str,
        request_id: &str,
        kind: PromptKind,
    ) -> tokio::sync::oneshot::Receiver<PromptAnswer> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let replaced = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                tool_call_id.to_string(),
                Pending {
                    request_id: request_id.to_string(),
                    kind,
                    tx,
                    shown: None,
                },
            );
        if let Some(old) = replaced {
            let _ = old.tx.send(PromptAnswer::Declined);
        }
        rx
    }

    /// Keep what the prompt on `tool_call_id` shows, for a window that reloads.
    pub fn show(&self, tool_call_id: &str, shown: ShownPrompt) {
        if let Some(p) = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(tool_call_id)
        {
            p.shown = Some(shown);
        }
    }

    /// The prompt the turn `request_id` waits on, as shown.
    pub fn shown_for(&self, request_id: &str) -> Option<ShownPrompt> {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .find(|p| p.request_id == request_id)
            .and_then(|p| p.shown.clone())
    }

    /// Forget the prompt on `tool_call_id` (its call ended without an answer).
    pub fn forget(&self, tool_call_id: &str) {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(tool_call_id);
    }

    /// Answer the prompt on `tool_call_id`. `false` when no prompt of that
    /// kind is waiting there.
    pub fn answer(&self, tool_call_id: &str, answer: PromptAnswer) -> bool {
        let kind = match &answer {
            PromptAnswer::Action { .. } => Some(PromptKind::Action),
            PromptAnswer::Question { .. } => Some(PromptKind::Question),
            PromptAnswer::Declined => None,
        };
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if !pending
            .get(tool_call_id)
            .is_some_and(|p| kind.is_none_or(|k| p.kind == k))
        {
            return false;
        }
        let entry = pending.remove(tool_call_id).expect("checked above");
        entry.tx.send(answer).is_ok()
    }

    /// Decline every prompt the turn `request_id` waits on (the user sent a
    /// new message, or pressed Stop). How many there were.
    pub fn decline_request(&self, request_id: &str) -> usize {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let ids: Vec<String> = pending
            .iter()
            .filter(|(_, p)| p.request_id == request_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            if let Some(p) = pending.remove(id) {
                let _ = p.tx.send(PromptAnswer::Declined);
            }
        }
        ids.len()
    }

    /// Whether a prompt waits on `tool_call_id`.
    pub fn is_waiting(&self, tool_call_id: &str) -> bool {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(tool_call_id)
    }
}

/// The site list entry an approval's "remember" adds: the offered host for
/// `"site"`, every site for `"all"`, nothing otherwise (or when the card
/// offered no site: submits and risky words always ask).
pub fn remembered_site(remember: Option<&str>, offer_site: Option<&str>) -> Option<String> {
    offer_site?;
    match remember.map(str::trim) {
        Some("site") => offer_site.map(str::to_string),
        Some("all") => Some(super::rules::ANY_SITE.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_approval_is_answered_once() {
        let prompts = BrowserPrompts::default();
        let rx = prompts.open("call-1", "req-1", PromptKind::Action);
        assert!(prompts.is_waiting("call-1"));
        assert_eq!(prompts.shown_for("req-1"), None);
        let shown = ShownPrompt {
            tool_call_id: "call-1".into(),
            tool_name: "click".into(),
            arguments: serde_json::json!({ "ref": "e1" }),
            event: provider_core::schema::ProviderEvent::BrowserPromptResolved {
                request_id: "req-1".into(),
                tool_call_id: "call-1".into(),
            },
        };
        prompts.show("call-1", shown.clone());
        assert_eq!(prompts.shown_for("req-1"), Some(shown));
        assert_eq!(prompts.shown_for("req-2"), None);
        // The wrong kind, or an unknown id, isn't an answer.
        assert!(!prompts.answer("call-1", PromptAnswer::Question { go_on: true }));
        assert!(!prompts.answer(
            "call-x",
            PromptAnswer::Action {
                send: true,
                remember: None
            }
        ));
        let answer = PromptAnswer::Action {
            send: true,
            remember: Some("site".into()),
        };
        assert!(prompts.answer("call-1", answer.clone()));
        assert_eq!(rx.await.unwrap(), answer);
        // Answered: gone.
        assert!(!prompts.is_waiting("call-1"));
        assert!(!prompts.answer("call-1", answer));
    }

    #[tokio::test]
    async fn a_question_is_answered() {
        let prompts = BrowserPrompts::default();
        let rx = prompts.open("call-1", "req-1", PromptKind::Question);
        assert!(prompts.answer("call-1", PromptAnswer::Question { go_on: false }));
        assert_eq!(rx.await.unwrap(), PromptAnswer::Question { go_on: false });
    }

    #[tokio::test]
    async fn a_steer_declines_only_its_own_turns_prompts() {
        let prompts = BrowserPrompts::default();
        let mine = prompts.open("call-1", "req-1", PromptKind::Action);
        let other = prompts.open("call-2", "req-2", PromptKind::Question);
        assert_eq!(prompts.decline_request("req-1"), 1);
        assert_eq!(mine.await.unwrap(), PromptAnswer::Declined);
        assert!(prompts.is_waiting("call-2"));
        assert!(!prompts.answer(
            "call-1",
            PromptAnswer::Action {
                send: true,
                remember: None
            }
        ));
        assert!(prompts.answer("call-2", PromptAnswer::Question { go_on: true }));
        assert_eq!(other.await.unwrap(), PromptAnswer::Question { go_on: true });
    }

    #[test]
    fn forgetting_a_prompt_leaves_nothing_to_answer() {
        let prompts = BrowserPrompts::default();
        let _rx = prompts.open("call-1", "req-1", PromptKind::Question);
        prompts.forget("call-1");
        assert!(!prompts.answer("call-1", PromptAnswer::Question { go_on: true }));
    }

    #[test]
    fn remember_adds_the_offered_site_or_every_site() {
        assert_eq!(
            remembered_site(Some("site"), Some("github.com")).as_deref(),
            Some("github.com")
        );
        assert_eq!(
            remembered_site(Some("all"), Some("github.com")).as_deref(),
            Some("*")
        );
        assert_eq!(remembered_site(None, Some("github.com")), None);
        assert_eq!(remembered_site(Some("bogus"), Some("github.com")), None);
        // Nothing offered (a submit, a risky word): nothing remembered.
        assert_eq!(remembered_site(Some("all"), None), None);
    }

    #[test]
    fn idle_tabs_are_taken_unless_in_use() {
        let browsers = ChatBrowsers::default();
        let _a = browsers.checkout("a");
        let held = browsers.checkout("b");
        drop(_a);
        let later = Instant::now() + IDLE_CLOSE;
        // Not idle yet.
        assert!(browsers.take_idle(Instant::now(), IDLE_CLOSE).is_empty());
        // "a" is idle; "b" is in use by a call, so it stays.
        let taken = browsers.take_idle(later, IDLE_CLOSE);
        assert_eq!(taken.len(), 1);
        assert!(!browsers.has("a"));
        assert!(browsers.has("b"));
        drop(held);
        assert_eq!(browsers.take_idle(later, IDLE_CLOSE).len(), 1);
        assert!(!browsers.has("b"));
    }

    #[test]
    fn a_closed_chat_loses_its_tab() {
        let browsers = ChatBrowsers::default();
        let _ = browsers.checkout("a");
        let _ = browsers.checkout("b");
        browsers.close("a");
        assert!(!browsers.has("a"));
        assert!(browsers.has("b"));
        browsers.close_all();
        assert!(!browsers.has("b"));
    }

    #[test]
    fn the_browser_is_the_one_in_settings_or_the_first_installed() {
        use std::path::PathBuf;
        let installed = || {
            vec![
                (Browser::Edge, PathBuf::from("edge.exe")),
                (Browser::Chrome, PathBuf::from("chrome.exe")),
            ]
        };
        assert_eq!(
            pick_browser(None, installed()).unwrap().browser,
            Browser::Edge
        );
        assert_eq!(
            pick_browser(Some("chrome"), installed()).unwrap().browser,
            Browser::Chrome
        );
        assert!(pick_browser(Some("brave"), installed())
            .unwrap_err()
            .contains("isn't installed"));
        assert!(pick_browser(None, Vec::new())
            .unwrap_err()
            .starts_with("browser error: "));
    }
}
