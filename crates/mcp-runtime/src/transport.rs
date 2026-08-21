//! The transport abstraction every MCP connector sits behind.
//!
//! A transport owns the connection to one connector server (a stdio child
//! process, an HTTP/SSE session, ...). It speaks the JSON-RPC protocol from
//! `protocol.rs` and exposes a typed, cancellation-aware surface the runtime
//! supervisor calls. The supervisor maps `McpError::category` onto the
//! persisted `SupportState`/health taxonomy.

use async_trait::async_trait;
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::protocol::{McpPrompt, McpResource, McpTool, ServerInfo, ToolOutput};

/// Coarse failure category. The supervisor translates this into the
/// `connector_runtime_state.health` + `SupportState` shown to the user, so the
/// taxonomy here is the runtime failure taxonomy (plan §7).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCategory {
    /// A stdio child exited unexpectedly, or a remote session dropped.
    Crash,
    /// The call exceeded its timeout.
    Timeout,
    /// The endpoint was unreachable / connection refused.
    Unavailable,
    /// The server violated the JSON-RPC/MCP protocol.
    Protocol,
    /// Authentication expired or is required for this call.
    AuthExpired,
    /// The operation was cancelled via the `CancellationToken`.
    Cancelled,
    /// Output exceeded the per-call size limit.
    OutputTooLarge,
    /// Transport not implemented (e.g. HTTP/SSE before 04b).
    NotImplemented,
    /// A typed error not covered above.
    Other,
}

impl std::fmt::Display for ErrorCategory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ErrorCategory::Crash => write!(f, "crash"),
            ErrorCategory::Timeout => write!(f, "timeout"),
            ErrorCategory::Unavailable => write!(f, "unavailable"),
            ErrorCategory::Protocol => write!(f, "protocol"),
            ErrorCategory::AuthExpired => write!(f, "authExpired"),
            ErrorCategory::Cancelled => write!(f, "cancelled"),
            ErrorCategory::OutputTooLarge => write!(f, "outputTooLarge"),
            ErrorCategory::NotImplemented => write!(f, "notImplemented"),
            ErrorCategory::Other => write!(f, "other"),
        }
    }
}

#[derive(Debug, Clone, Error)]
#[error("{category}: {message}")]
pub struct McpError {
    pub category: ErrorCategory,
    pub message: String,
}

impl McpError {
    pub fn new(category: ErrorCategory, message: impl Into<String>) -> Self {
        Self {
            category,
            message: message.into(),
        }
    }
    pub fn crash(msg: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Crash, msg)
    }
    pub fn timeout(msg: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Timeout, msg)
    }
    pub fn unavailable(msg: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Unavailable, msg)
    }
    pub fn protocol(msg: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Protocol, msg)
    }
    pub fn auth_expired(msg: impl Into<String>) -> Self {
        Self::new(ErrorCategory::AuthExpired, msg)
    }
    pub fn cancelled() -> Self {
        Self::new(ErrorCategory::Cancelled, "cancelled")
    }
    pub fn too_large(msg: impl Into<String>) -> Self {
        Self::new(ErrorCategory::OutputTooLarge, msg)
    }
    pub fn not_implemented(msg: impl Into<String>) -> Self {
        Self::new(ErrorCategory::NotImplemented, msg)
    }
}

/// One MCP connector transport. Implementations are expected to be used by a
/// single supervisor task at a time (calls are sequential per connector); the
/// supervisor enforces per-call timeouts and concurrency across connectors.
#[async_trait]
pub trait McpTransport: Send {
    /// Complete the MCP handshake and return server identity.
    async fn initialize(&mut self, cancel: &CancellationToken) -> Result<ServerInfo, McpError>;

    async fn list_tools(&mut self, cancel: &CancellationToken) -> Result<Vec<McpTool>, McpError>;
    async fn list_resources(
        &mut self,
        cancel: &CancellationToken,
    ) -> Result<Vec<McpResource>, McpError>;
    async fn list_prompts(
        &mut self,
        cancel: &CancellationToken,
    ) -> Result<Vec<McpPrompt>, McpError>;

    /// Invoke a tool. The transport computes `size_bytes`/`mime_hints` from
    /// the raw content; the supervisor enforces the size limit and redaction.
    async fn call_tool(
        &mut self,
        name: &str,
        arguments: &serde_json::Value,
        cancel: &CancellationToken,
    ) -> Result<ToolOutput, McpError>;

    /// Best-effort graceful shutdown. `Drop` must also kill/tear down the
    /// underlying process/connection so a connector never outlives the runtime.
    async fn shutdown(&mut self) -> Result<(), McpError>;

    /// Cheap, non-blocking liveness probe used by the supervisor's watch loop.
    /// For stdio this is a `try_wait` on the child; for stream transports it
    /// defaults to `true` (a real ping-based probe is a 04b target). Returning
    /// `false` triggers a supervised restart.
    async fn is_alive(&mut self) -> bool {
        true
    }
}
