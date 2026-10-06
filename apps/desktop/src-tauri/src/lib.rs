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
pub mod artifact_frames;
pub mod artifact_network;
pub mod attachment_documents;
pub mod brand;
pub mod branding;
pub mod commands;
pub mod connector_runtime;
pub mod context_compact;
pub mod conversation_export;
pub mod credentials;
pub mod db;
pub mod diagnostics;
pub mod draft_blocks;
pub mod draft_export;
pub mod drop_grant;
pub mod encryption;
pub mod event_sink;
pub mod knowledge;
pub mod local_data;
pub mod logo;
pub mod mcp_oauth;
pub mod mcp_registry;
pub mod message_preview;
pub mod page_llm;
pub mod paths;
pub mod research;
pub mod search;
pub mod skills;
pub mod slide_html;
pub mod slides_export;
pub mod starter_apps;
pub mod state;
pub mod stream_manager;
pub mod stream_persistence;
pub mod time;
pub mod tray;
pub mod updater;
pub mod validation;
pub mod vision;
pub mod web_page;
pub mod webview_args;
pub mod workflows;
pub mod workspace_tools;
