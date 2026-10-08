//! Workflows: saved multi-step routines ("fetch these pages, summarize each,
//! save a briefing") that run with no window required.
//!
//! - `definition`: the stored format and its validation
//! - `template`: `{{steps.x.y}}` / `{{#each}}` filling
//! - `author`: drafting a workflow from a description or a chat
//! - `data`: reading files from the workflow's folder and parsing CSV/JSON
//! - `exports`: where `export_file` steps write
//! - `extract`: readable text from fetched pages
//! - `models`: which model each summarize/agent step calls
//! - `runner`: runs a workflow and records every step
//! - `ask`: "Ask me" steps, which wait for the user's answer
//! - `documents`: telling the page a workflow changed a saved deck or draft
//! - `waiting`: what runs wait on, and answering it
//! - `permissions`: what a scheduled run may do, and asking when it wants more
//! - `schedule` / `scheduler`: running workflows automatically
//! - `triggers`: starting a workflow on a new feed post or a new file

pub mod ask;
pub mod author;
pub mod data;
pub mod definition;
pub mod documents;
pub mod edit;
pub mod exports;
pub mod extract;
pub mod models;
pub mod permissions;
pub mod runner;
pub mod schedule;
pub mod scheduler;
pub mod template;
pub mod triggers;
pub mod waiting;
