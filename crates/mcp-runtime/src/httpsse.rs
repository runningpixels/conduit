//! HTTP/SSE MCP transport — **skeleton only** (deferred to 04b).
//!
//! The trait is implemented so the supervisor is transport-agnostic from day
//! one and the `McpTransport` abstraction is exercised by two impls. The live
//! connection management (SSE session, request/response correlation over the
//! event stream) lands in `docs/plans/04b-mcp-runtime-deferred.md`.

use async_trait::async_trait;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::protocol::{McpPrompt, McpResource, McpTool, ServerInfo, ToolOutput};
use crate::transport::{McpError, McpTransport};

#[derive(Debug, Clone)]
pub struct HttpSseConfig {
    pub url: String,
    /// Optional `keychain://` credential ref for the Authorization header.
    pub credential_ref: Option<String>,
}

impl HttpSseConfig {
    pub fn from_value(raw: &Value) -> Result<Self, McpError> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire {
            url: String,
            #[serde(default)]
            credential_ref: Option<String>,
        }
        let w: Wire = serde_json::from_value(raw.clone())
            .map_err(|e| McpError::protocol(format!("invalid http-sse transport_config: {e}")))?;
        if w.url.trim().is_empty() {
            return Err(McpError::protocol("http-sse transport_config.url is empty"));
        }
        Ok(Self {
            url: w.url,
            credential_ref: w.credential_ref,
        })
    }
}

pub struct HttpSseTransport {
    #[allow(dead_code)]
    config: HttpSseConfig,
}

impl HttpSseTransport {
    pub fn new(config: HttpSseConfig) -> Self {
        Self { config }
    }
}

#[async_trait]
impl McpTransport for HttpSseTransport {
    async fn initialize(&mut self, _cancel: &CancellationToken) -> Result<ServerInfo, McpError> {
        Err(McpError::not_implemented("http/sse transport lands in 04b"))
    }
    async fn list_tools(&mut self, _c: &CancellationToken) -> Result<Vec<McpTool>, McpError> {
        Err(McpError::not_implemented("http/sse transport lands in 04b"))
    }
    async fn list_resources(
        &mut self,
        _c: &CancellationToken,
    ) -> Result<Vec<McpResource>, McpError> {
        Err(McpError::not_implemented("http/sse transport lands in 04b"))
    }
    async fn list_prompts(&mut self, _c: &CancellationToken) -> Result<Vec<McpPrompt>, McpError> {
        Err(McpError::not_implemented("http/sse transport lands in 04b"))
    }
    async fn call_tool(
        &mut self,
        _name: &str,
        _args: &Value,
        _c: &CancellationToken,
    ) -> Result<ToolOutput, McpError> {
        Err(McpError::not_implemented("http/sse transport lands in 04b"))
    }
    async fn shutdown(&mut self) -> Result<(), McpError> {
        Ok(())
    }
}
