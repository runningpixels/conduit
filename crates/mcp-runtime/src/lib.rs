// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! mcp-runtime — transport-agnostic MCP connector runtime core.
//!
//! This crate owns the JSON-RPC protocol framing, the `McpTransport`
//! abstraction and its first implementation (stdio; HTTP/SSE is scaffolded),
//! consent *policy*, and secret redaction. It deliberately does not depend on
//! the app's `AppState`, SQLite, or Tauri — the conduit-desktop
//! `connector_runtime` supervisor composes this core with persistence,
//! credentials, and lifecycle.
//!
//! Re-exports the canonical `PermissionLevel` from `provider-core` so consent
//! classification shares one source of truth with the provider tool schema.

pub mod consent;
pub mod httpsse;
pub mod protocol;
pub mod redact;
pub mod reinject;
pub mod stdio;
pub mod transport;

pub use consent::{classify, expected_effect, ConsentDecision, ConsentKind};
pub use httpsse::{HttpSseConfig, HttpSseTransport};
pub use protocol::{
    ClientInfo, McpPrompt, McpResource, McpTool, PermissionLevel, ServerInfo, ToolContent,
    ToolOutput,
};
pub use reinject::{validate_reinjection, ReinjectionRisk};
pub use stdio::{StdioConfig, StdioTransport};
pub use transport::{ErrorCategory, McpError, McpTransport};
