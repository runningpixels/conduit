//! stdio MCP transport: spawn a child process and speak newline-delimited
//! JSON-RPC 2.0 over its stdin/stdout.
//!
//! `transport_config` is **untrusted** tenant/local config — it is validated
//! here before any process is spawned. The command must not run through a
//! shell (no `cmd /c` / `sh -c`), and env values are redacted before they
//! reach logs. The child is killed on `Drop` so a connector never outlives
//! the runtime, and a cancelled call kills the child because a half-read
//! response misaligns the stream (the supervisor restarts the connector).

use std::collections::HashMap;
use std::process::Stdio as ProcessStdio;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command, ChildStdin, ChildStdout};
use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::protocol::{
    ClientInfo, InitializeResult, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse,
    McpPrompt, McpResource, McpTool, PROTOCOL_VERSION, RequestId, ServerInfo, ToolContent,
    ToolOutput,
};
use crate::redact;
use crate::transport::{McpError, McpTransport};

/// Parsed, validated stdio transport config. Deserialized from the opaque
/// `ConnectorVersion.transport_config` JSON blob.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StdioConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

impl StdioConfig {
    /// Parse + validate the raw `transport_config` blob. Refuses shell
    /// metacharacters in `command` and empty commands.
    pub fn from_value(raw: &Value) -> Result<Self, McpError> {
        let cfg: StdioConfig = serde_json::from_value(raw.clone()).map_err(|e| {
            McpError::protocol(format!("invalid stdio transport_config: {e}"))
        })?;
        if cfg.command.trim().is_empty() {
            return Err(McpError::protocol("stdio transport_config.command is empty"));
        }
        // No shell invocation: the command must be a real program path/name,
        // not `sh -c ...` / `cmd /c ...`. Args are passed verbatim.
        let lower = cfg.command.to_ascii_lowercase();
        if lower.ends_with("sh") || lower.ends_with("sh.exe")
            || lower == "cmd" || lower == "cmd.exe"
            || lower.contains("/sh") || lower.contains("\\cmd")
            || lower.ends_with("powershell") || lower.ends_with("powershell.exe")
            || lower.ends_with("pwsh") || lower.ends_with("pwsh.exe")
        {
            // Reject common shell interpreters outright for MVP to prevent
            // arbitrary command execution via transport_config.
            return Err(McpError::protocol(
                "refusing to spawn connector through a shell interpreter",
            ));
        }
        Ok(cfg)
    }
}

pub struct StdioTransport {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    client: ClientInfo,
    dead: bool,
}

impl StdioTransport {
    /// Spawn the connector child. Does not complete the MCP handshake — call
    /// `initialize()` next.
    pub fn spawn(config: StdioConfig, client: ClientInfo) -> Result<Self, McpError> {
        let mut cmd = Command::new(&config.command);
        cmd.args(&config.args);
        for (k, v) in &config.env {
            cmd.env(k, v);
        }
        if let Some(cwd) = &config.cwd {
            cmd.current_dir(cwd);
        }
        cmd.stdin(ProcessStdio::piped())
            .stdout(ProcessStdio::piped())
            .stderr(ProcessStdio::piped())
            .kill_on_drop(true);

        // Redact env values for the spawn trace.
        let env_summary: Vec<String> = config
            .env
            .keys()
            .map(|k| format!("{k}=[redacted]"))
            .collect();
        tracing::info!(
            command = %config.command,
            args = ?config.args,
            env = ?env_summary,
            "spawning stdio connector",
        );

        let mut child = cmd
            .spawn()
            .map_err(|e| McpError::unavailable(format!("spawn '{}' failed: {e}", config.command)))?;
        let stdin = child.stdin.take().ok_or_else(|| {
            McpError::unavailable("connector child opened without a stdin pipe")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            McpError::unavailable("connector child opened without a stdout pipe")
        })?;

        // Capture stderr: redact + emit as tracing events. The app's tracing
        // subscriber routes `mcp_connector` target lines to the connectors log
        // dir; the transport itself knows no filesystem paths.
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) => break, // EOF
                        Ok(_) => {
                            let redacted = redact::redact_text(line.trim_end());
                            warn!(target: "mcp_connector", "{}", redacted);
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
            client,
            dead: false,
        })
    }

    fn next_request_id(&mut self) -> RequestId {
        let id = self.next_id;
        self.next_id += 1;
        RequestId::Num(id)
    }

    async fn write_line(&mut self, line: &str) -> Result<(), McpError> {
        self.stdin.write_all(line.as_bytes()).await.map_err(|e| {
            self.dead = true;
            McpError::crash(format!("write to connector stdin failed: {e}"))
        })?;
        self.stdin.write_all(b"\n").await.map_err(|e| {
            self.dead = true;
            McpError::crash(format!("write newline failed: {e}"))
        })?;
        self.stdin.flush().await.map_err(|e| {
            self.dead = true;
            McpError::crash(format!("flush connector stdin failed: {e}"))
        })?;
        Ok(())
    }

    /// Send a request and read until the matching response arrives. Server
    /// notifications/requests are logged and skipped.
    async fn round_trip(
        &mut self,
        id: RequestId,
        method: &str,
        params: Option<Value>,
        cancel: &CancellationToken,
    ) -> Result<Value, McpError> {
        let req = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: id.clone(),
            method: method.to_string(),
            params,
        };
        let encoded = serde_json::to_string(&req)
            .map_err(|e| McpError::protocol(format!("encode request failed: {e}")))?;
        self.write_line(&encoded).await?;

        let read = async {
            loop {
                let mut line = String::new();
                let n = self.stdout.read_line(&mut line).await.map_err(|e| {
                    self.dead = true;
                    McpError::crash(format!("read from connector stdout failed: {e}"))
                })?;
                if n == 0 {
                    self.dead = true;
                    return Err(McpError::crash("connector stdout closed (child exited)"));
                }
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let msg: JsonRpcMessage = serde_json::from_str(trimmed).map_err(|e| {
                    McpError::protocol(format!("decode connector message failed: {e}"))
                })?;
                match msg {
                    JsonRpcMessage::Response(resp) if resp.id == id => {
                        return resp_to_result(resp);
                    }
                    JsonRpcMessage::Response(resp) => {
                        warn!(target: "mcp_connector", id = ?resp.id, "stray response, ignoring");
                        continue;
                    }
                    JsonRpcMessage::Notification(n) => {
                        warn!(target: "mcp_connector", method = %n.method, "server notification, ignoring");
                        continue;
                    }
                    JsonRpcMessage::Request(r) => {
                        warn!(target: "mcp_connector", method = %r.method, "server-originated request, ignoring");
                        continue;
                    }
                }
            }
        };

        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                // A half-read response misaligns the stream: kill the child so
                // the supervisor restarts a fresh connector.
                self.kill_now().await;
                Err(McpError::cancelled())
            }
            res = read => res,
        }
    }

    /// Synchronously signal the child to terminate. Safe to call repeatedly.
    async fn kill_now(&mut self) {
        let _ = self.child.start_kill();
        self.dead = true;
    }
}

fn resp_to_result(resp: JsonRpcResponse) -> Result<Value, McpError> {
    if let Some(err) = resp.error {
        return Err(McpError::new(crate::transport::ErrorCategory::Protocol, err.message));
    }
    resp.result.ok_or_else(|| McpError::protocol("response had no result and no error"))
}

#[async_trait]
impl McpTransport for StdioTransport {
    async fn initialize(&mut self, cancel: &CancellationToken) -> Result<ServerInfo, McpError> {
        let id = self.next_request_id();
        let params = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "clientInfo": self.client,
            "capabilities": {},
        });
        let result = self.round_trip(id, "initialize", Some(params), cancel).await?;
        let init: InitializeResult = serde_json::from_value(result)
            .map_err(|e| McpError::protocol(format!("decode initialize result failed: {e}")))?;

        // Notify the server the handshake is complete. No response expected.
        let initialized = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        });
        let encoded = serde_json::to_string(&initialized)
            .map_err(|e| McpError::protocol(format!("encode initialized failed: {e}")))?;
        self.write_line(&encoded).await?;

        Ok(init.server_info)
    }

    async fn list_tools(&mut self, cancel: &CancellationToken) -> Result<Vec<McpTool>, McpError> {
        let id = self.next_request_id();
        let result = self.round_trip(id, "tools/list", None, cancel).await?;
        let tools: Vec<McpTool> = serde_json::from_value(result.get("tools").cloned().unwrap_or(Value::Array(vec![])))
            .map_err(|e| McpError::protocol(format!("decode tools/list failed: {e}")))?;
        Ok(tools)
    }

    async fn list_resources(
        &mut self,
        cancel: &CancellationToken,
    ) -> Result<Vec<McpResource>, McpError> {
        let id = self.next_request_id();
        let result = self.round_trip(id, "resources/list", None, cancel).await?;
        let resources: Vec<McpResource> = serde_json::from_value(
            result.get("resources").cloned().unwrap_or(Value::Array(vec![])),
        )
        .map_err(|e| McpError::protocol(format!("decode resources/list failed: {e}")))?;
        Ok(resources)
    }

    async fn list_prompts(
        &mut self,
        cancel: &CancellationToken,
    ) -> Result<Vec<McpPrompt>, McpError> {
        let id = self.next_request_id();
        let result = self.round_trip(id, "prompts/list", None, cancel).await?;
        let prompts: Vec<McpPrompt> = serde_json::from_value(
            result.get("prompts").cloned().unwrap_or(Value::Array(vec![])),
        )
        .map_err(|e| McpError::protocol(format!("decode prompts/list failed: {e}")))?;
        Ok(prompts)
    }

    async fn call_tool(
        &mut self,
        name: &str,
        arguments: &Value,
        cancel: &CancellationToken,
    ) -> Result<ToolOutput, McpError> {
        let id = self.next_request_id();
        let params = json!({ "name": name, "arguments": arguments });
        let result = self.round_trip(id, "tools/call", Some(params), cancel).await?;
        decode_tool_output(&result)
    }

    async fn shutdown(&mut self) -> Result<(), McpError> {
        if self.dead {
            return Ok(());
        }
        // Fire-and-forget the MCP `shutdown` request: a responsive server cleans
        // up; an unresponsive one (e.g. mid-sleep in a long tool call) must not
        // block us. Kill the child immediately afterwards regardless — `Drop`
        // would also kill, but doing it here makes "no connector outlives the
        // runtime" deterministic without waiting on a reply.
        let id = self.next_request_id();
        let req = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id,
            method: "shutdown".to_string(),
            params: None,
        };
        if let Ok(encoded) = serde_json::to_string(&req) {
            let _ = self.write_line(&encoded).await;
        }
        self.kill_now().await;
        Ok(())
    }

    async fn is_alive(&mut self) -> bool {
        if self.dead {
            return false;
        }
        match self.child.try_wait() {
            Ok(None) => true,
            _ => {
                self.dead = true;
                false
            }
        }
    }
}

impl Drop for StdioTransport {
    fn drop(&mut self) {
        // Belt-and-suspenders with `kill_on_drop`: never let a connector
        // child outlive the transport.
        let _ = self.child.start_kill();
    }
}

/// Decode a `tools/call` result into a typed `ToolOutput`, computing the
/// size + MIME hints the supervisor / Phase 5 need.
fn decode_tool_output(result: &Value) -> Result<ToolOutput, McpError> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Wire {
        #[serde(default)]
        content: Vec<ToolContent>,
        #[serde(default)]
        is_error: bool,
    }
    let wire: Wire = serde_json::from_value(result.clone())
        .map_err(|e| McpError::protocol(format!("decode tools/call result failed: {e}")))?;

    let size_bytes = serde_json::to_vec(&wire.content).map(|v| v.len() as u64).unwrap_or(0);
    let mime_hints: Vec<String> = wire
        .content
        .iter()
        .map(|c| match c {
            ToolContent::Text { .. } => "text/plain".to_string(),
            ToolContent::Other { .. } => "application/octet-stream".to_string(),
        })
        .collect();

    Ok(ToolOutput {
        content: wire.content,
        is_error: wire.is_error,
        size_bytes,
        mime_hints,
    })
}