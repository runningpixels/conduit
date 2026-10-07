//! Workflows: saved multi-step routines ("fetch these pages, summarize each,
//! save a briefing") that run with no window required.
//!
//! - `definition`: the stored format and its validation
//! - `template`: `{{steps.x.y}}` / `{{#each}}` filling
//! - `data`: reading files from the workflow's folder and parsing CSV/JSON
//! - `extract`: readable text from fetched pages
//! - `models`: which model each summarize/agent step calls
//! - `runner`: runs a workflow and records every step
//! - `ask`: "Ask me" steps, which wait for the user's answer
//! - `waiting`: what runs wait on, and answering it
//! - `permissions`: what a scheduled run may do, and asking when it wants more
//! - `schedule` / `scheduler`: running workflows automatically

pub mod ask;
pub mod data;
pub mod definition;
pub mod extract;
pub mod models;
pub mod permissions;
pub mod runner;
pub mod schedule;
pub mod scheduler;
pub mod template;
pub mod waiting;
