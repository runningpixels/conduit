//! Research: a planned, budgeted web research run that ends in a cited report.
//!
//! The user asks a question in a chat; a planner call turns it into a brief
//! (sub-questions, scope, domains, depth) the user edits and approves; the run
//! then searches, reads whole pages, extracts claims with exact quotes, checks
//! for gaps, and writes a Markdown report whose every `[n]` citation points at a page
//! that really contains the quoted words.
//!
//! - `brief`: the planner call and checking a brief the user sends back
//! - `run`: the loop (search → read → extract → gap check), its budget and stop
//! - `claims`: the extractor call, the only one that sees page text
//! - `verify`: the quote check, by code
//! - `report`: the writer call, citation mapping and the report's Markdown
//! - `urls`: which search results get read
//! - `repo`: the run, source and claim tables
//! - `service`: what the commands do (start, approve, stop, cancel, read)
//! - `app`: the real network and model behind [`ResearchIo`]
//!
//! Safety rules the code keeps, whatever a model or a page says:
//! - Page text reaches only the extractor, which has no tools. The planner,
//!   gap checker and writer see claims, quotes, titles and hosts.
//! - Only addresses from search results are fetched, never one a page or a
//!   model names, and only public web addresses (the network layer checks
//!   again after DNS).
//! - A claim is kept only if its quote is in the stored page text; the writer
//!   cites claim ids, and code turns them into footnotes.

pub mod app;
pub mod brief;
pub mod claims;
pub mod repo;
pub mod report;
pub mod run;
pub mod service;
pub mod urls;
pub mod verify;

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::workflows::runner::{parse_json_reply, JSON_REPAIR};

/// App-wide event sent after every status or progress change of a run.
pub const RUN_UPDATED_EVENT: &str = "research-run-updated";

/// One search result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// A fetched page, reduced to readable text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedPage {
    /// The address that finally answered, after redirects.
    pub url: String,
    pub title: Option<String>,
    pub text: String,
}

/// Everything a run does outside itself: search, fetch, and tool-less model
/// calls. The app implements it with the real network and model
/// ([`app::AppIo`]); tests script it.
#[async_trait]
pub trait ResearchIo: Send + Sync {
    async fn search(&self, query: &str) -> Result<Vec<SearchHit>, String>;
    async fn fetch(&self, url: &str) -> Result<FetchedPage, String>;
    /// One model call with no tools; the reply's text.
    async fn complete(&self, system: &str, user: &str) -> Result<String, String>;
    /// Model tokens the calls so far really used, when the backend reports
    /// them; the run estimates from text length otherwise.
    fn tokens_used(&self) -> Option<u64> {
        None
    }
}

/// Ask for a JSON reply matching `schema`; one more ask if the reply isn't
/// JSON. `Ok(None)` when it still isn't; `Err` when the call itself failed.
pub(crate) async fn ask_json(
    io: &dyn ResearchIo,
    system: &str,
    user: &str,
    schema: &Value,
) -> Result<Option<Value>, String> {
    let prompt = format!(
        "{user}\n\nReply with only a JSON value matching this JSON Schema, and no other text:\n{schema}"
    );
    let reply = io.complete(system, &prompt).await?;
    if let Some(value) = parse_json_reply(&reply) {
        return Ok(Some(value));
    }
    // Small models often wrap JSON in prose; asking once more usually fixes it.
    let clipped: String = reply.chars().take(4_000).collect();
    let repair = format!(
        "{prompt}\n\nYour previous reply was:\n<reply>\n{clipped}\n</reply>\n\n{JSON_REPAIR}"
    );
    let again = io.complete(system, &repair).await?;
    Ok(parse_json_reply(&again))
}

/// `text` cut to at most `max` characters.
pub(crate) fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        text.chars().take(max).collect()
    }
}

/// `text` on one line: runs of whitespace (newlines included) become a space.
pub(crate) fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Runs in progress (planning or running), each with the token that stops it.
#[derive(Default)]
pub struct ResearchRuns {
    runs: Mutex<HashMap<String, CancellationToken>>,
}

impl ResearchRuns {
    /// Register `run_id` and return its stop token; `None` if it is already
    /// registered.
    pub fn begin(&self, run_id: &str) -> Option<CancellationToken> {
        let mut runs = self.runs.lock().ok()?;
        if runs.contains_key(run_id) {
            return None;
        }
        let token = CancellationToken::new();
        runs.insert(run_id.to_string(), token.clone());
        Some(token)
    }

    /// Forget `run_id` (its work has ended).
    pub fn end(&self, run_id: &str) {
        if let Ok(mut runs) = self.runs.lock() {
            runs.remove(run_id);
        }
    }

    /// Ask `run_id` to stop; `false` when it isn't registered.
    pub fn stop(&self, run_id: &str) -> bool {
        match self.runs.lock() {
            Ok(runs) => match runs.get(run_id) {
                Some(token) => {
                    token.cancel();
                    true
                }
                None => false,
            },
            Err(_) => false,
        }
    }

    pub fn is_active(&self, run_id: &str) -> bool {
        self.runs
            .lock()
            .map(|r| r.contains_key(run_id))
            .unwrap_or(false)
    }

    /// Ask every run to stop (quitting).
    pub fn stop_all(&self) -> usize {
        let Ok(runs) = self.runs.lock() else { return 0 };
        for token in runs.values() {
            token.cancel();
        }
        runs.len()
    }
}
