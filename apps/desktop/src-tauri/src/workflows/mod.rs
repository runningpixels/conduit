//! Workflows: saved multi-step routines ("fetch these pages, summarize each,
//! save a briefing") that run with no window required.
//!
//! - `definition`: the stored format and its validation
//! - `template`: `{{steps.x.y}}` / `{{#each}}` filling
//! - `extract`: readable text from fetched pages
//! - `runner`: runs a workflow and records every step
//! - `permissions`: what a scheduled run may do, and asking when it wants more
//! - `schedule` / `scheduler`: running workflows automatically

pub mod definition;
pub mod extract;
pub mod permissions;
pub mod runner;
pub mod schedule;
pub mod scheduler;
pub mod template;
