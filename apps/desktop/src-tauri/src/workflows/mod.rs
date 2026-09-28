//! Workflows: saved multi-step routines ("fetch these pages, summarize each,
//! save a briefing") that run with no window required.
//!
//! - `definition`: the stored format and its validation
//! - `template`: `{{steps.x.y}}` / `{{#each}}` filling
//! - `extract`: readable text from fetched pages
//! - `runner`: runs a workflow and records every step
//!
//! Runs are manual for now; scheduling builds on the same runner.

pub mod definition;
pub mod extract;
pub mod runner;
pub mod template;
