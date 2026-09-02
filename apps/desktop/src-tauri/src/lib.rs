// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! Conduit desktop library crate.
//!
//! The app is split into a library (this crate, `conduit_desktop`) and a thin
//! binary (`main.rs`) so Phase 3's `tests/` integration tests can reach the
//! migration runner and repositories directly. All modules that were previously
//! declared in `main.rs` live here; `crate::` references inside them resolve to
//! this library root.

pub mod agent_tools;
pub mod brand;
pub mod branding;
pub mod commands;
pub mod connector_runtime;
pub mod conversation_export;
pub mod credentials;
pub mod db;
pub mod diagnostics;
pub mod encryption;
pub mod local_data;
pub mod logo;
pub mod message_preview;
pub mod paths;
pub mod state;
pub mod stream_manager;
pub mod stream_persistence;
pub mod time;
pub mod updater;
pub mod validation;
pub mod vision;
pub mod workspace_tools;
