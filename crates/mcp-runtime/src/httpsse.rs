//! Streamable HTTP MCP transport (spec 2026-07-28).
//!
//! Each JSON-RPC message is its own HTTP POST to a single MCP endpoint. The
//! server answers with either `application/json` or a request-scoped SSE
//! stream. There is no `Mcp-Session-Id` on the modern path; `server/discover`
//! replaces the old `initialize` handshake.
//!
//! Legacy Streamable HTTP (2025-03-26 through 2025-11-25) is a fallback when
//! a modern request comes back as a non-modern 400. Spec-deprecated HTTP+SSE
//! (GET `/sse` + POST messages) is rejected with a clear "needs streamable
//! HTTP" error — we do not revive that stub.
//!
//! Tokens are injected by the supervisor from the keychain; this crate never
//! talks to a credential store. Bearer values are redacted before they reach
//! logs.

use std::collections::HashMap;

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::protocol::{
    decode_tool_output, params_with_meta, resp_to_result, ClientInfo, InitializeResult,
    JsonRpcMessage, JsonRpcRequest, McpPrompt, McpResource, McpTool, RequestId, ServerInfo,
    ToolOutput, HTTP_LEGACY_PROTOCOL_VERSION, HTTP_PROTOCOL_VERSION,
};
use crate::redact;
use crate::transport::{McpError, McpTransport};

/// Parsed, validated streamable-HTTP transport config. Deserialized from the
/// opaque `ConnectorVersion.transport_config` JSON blob.
#[derive(Debug, Clone)]
pub struct HttpSseConfig {
    pub url: String,
    /// Optional `keychain://` credential ref (also stored on the grant).
    pub credential_ref: Option<String>,
    /// Extra headers from a registry `remotes[].headers` entry. Values are
    /// treated as untrusted and never logged.
    pub headers: HashMap<String, String>,
    /// Bearer token resolved by the supervisor. Never serialized to disk.
    pub access_token: Option<String>,
}

impl HttpSseConfig {
    pub fn from_value(raw: &Value) -> Result<Self, McpError> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire {
            url: String,
            #[serde(default)]
            credential_ref: Option<String>,
            #[serde(default)]
            headers: HashMap<String, String>,
        }
        let w: Wire = serde_json::from_value(raw.clone())
            .map_err(|e| McpError::protocol(format!("invalid http-sse transport_config: {e}")))?;
        let url = validate_mcp_url(&w.url)?;
        Ok(Self {
            url,
            credential_ref: w.credential_ref,
            headers: w.headers,
            access_token: None,
        })
    }
}

/// Accept `https` anywhere, or `http` only to loopback (tests + local servers).
pub fn validate_mcp_url(raw: &str) -> Result<String, McpError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(McpError::protocol("http-sse transport_config.url is empty"));
    }
    let parsed = reqwest::Url::parse(trimmed).map_err(|e| {
        McpError::protocol(format!("http-sse transport_config.url is not a URL: {e}"))
    })?;
    if parsed.username() != "" || parsed.password().is_some() {
        return Err(McpError::protocol(
            "http-sse transport_config.url must not include credentials",
        ));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| McpError::protocol("http-sse transport_config.url has no host"))?;
    match parsed.scheme() {
        "https" => {}
        "http" if is_loopback_host(host) => {}
        "http" => {
            return Err(McpError::protocol(
                "http-sse transport_config.url must be https (http is allowed only for localhost)",
            ));
        }
        other => {
            return Err(McpError::protocol(format!(
                "http-sse transport_config.url has unsupported scheme '{other}'"
            )));
        }
    }
    Ok(parsed.to_string())
}

fn is_loopback_host(host: &str) -> bool {
    let h = host.trim_matches(['[', ']']);
    h.eq_ignore_ascii_case("localhost") || h == "127.0.0.1" || h == "::1"
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HttpEra {
    /// Spec 2026-07-28: per-request `_meta`, no session, `server/discover`.
    Modern,
    /// Spec 2025-03-26..2025-11-25: `initialize` handshake, optional session.
    Legacy,
}

pub struct HttpSseTransport {
    config: HttpSseConfig,
    client: ClientInfo,
    http: reqwest::Client,
    next_id: u64,
    era: HttpEra,
    session_id: Option<String>,
    tools_cache: Vec<McpTool>,
    dead: bool,
}

impl HttpSseTransport {
    pub fn new(config: HttpSseConfig, client: ClientInfo) -> Self {
        let http = reqwest::Client::builder()
            .user_agent("Conduit-MCP/0.1")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            config,
            client,
            http,
            next_id: 1,
            era: HttpEra::Modern,
            session_id: None,
            tools_cache: Vec::new(),
            dead: false,
        }
    }

    fn next_request_id(&mut self) -> RequestId {
        let id = self.next_id;
        self.next_id += 1;
        RequestId::Num(id)
    }

    fn protocol_version(&self) -> &'static str {
        match self.era {
            HttpEra::Modern => HTTP_PROTOCOL_VERSION,
            HttpEra::Legacy => HTTP_LEGACY_PROTOCOL_VERSION,
        }
    }

    fn mcp_name_for(method: &str, params: Option<&Value>) -> Option<String> {
        let params = params?;
        match method {
            "tools/call" | "prompts/get" => params
                .get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            "resources/read" => params
                .get("uri")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            _ => None,
        }
    }

    async fn round_trip(
        &mut self,
        id: RequestId,
        method: &str,
        params: Option<Value>,
        cancel: &CancellationToken,
    ) -> Result<Value, McpError> {
        let body_params = match self.era {
            HttpEra::Modern => Some(params_with_meta(
                params.clone(),
                &self.client,
                self.protocol_version(),
            )),
            HttpEra::Legacy => params.clone(),
        };
        let req = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: id.clone(),
            method: method.to_string(),
            params: body_params,
        };
        let encoded = serde_json::to_string(&req)
            .map_err(|e| McpError::protocol(format!("encode request failed: {e}")))?;

        let send = self.post_json(method, params.as_ref(), encoded);
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(McpError::cancelled()),
            res = send => {
                let (status, content_type, www_auth, session, body) = res?;
                if let Some(session) = session {
                    self.session_id = Some(session);
                }
                self.decode_http_body(id, method, status, &content_type, www_auth, body)
            }
        }
    }

    async fn post_json(
        &self,
        method: &str,
        params: Option<&Value>,
        encoded: String,
    ) -> Result<(u16, String, Option<String>, Option<String>, String), McpError> {
        let mut builder = self
            .http
            .post(&self.config.url)
            .header("Accept", "application/json, text/event-stream")
            .header("Content-Type", "application/json")
            .header("MCP-Protocol-Version", self.protocol_version())
            .header("Mcp-Method", method);

        if let Some(name) = Self::mcp_name_for(method, params) {
            builder = builder.header("Mcp-Name", encode_header_value(&name));
        }
        if method == "tools/call" {
            if let Some(name) = params.and_then(|p| p.get("name")).and_then(|v| v.as_str()) {
                if let Some(tool) = self.tools_cache.iter().find(|t| t.name == name) {
                    for (header, value) in
                        param_headers(tool, params.and_then(|p| p.get("arguments")))
                    {
                        builder = builder.header(header, value);
                    }
                }
            }
        }
        if let Some(token) = &self.config.access_token {
            builder = builder.header("Authorization", format!("Bearer {token}"));
        }
        if let Some(session) = &self.session_id {
            builder = builder.header("Mcp-Session-Id", session);
        }
        for (k, v) in &self.config.headers {
            if k.eq_ignore_ascii_case("authorization") {
                continue;
            }
            builder = builder.header(k, v);
        }

        let resp = builder.body(encoded).send().await.map_err(|e| {
            McpError::unavailable(redact::redact_text(&format!(
                "MCP HTTP request failed: {e}"
            )))
        })?;

        let status = resp.status().as_u16();
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let session = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let www_auth = resp
            .headers()
            .get(reqwest::header::WWW_AUTHENTICATE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let body = resp.text().await.map_err(|e| {
            McpError::unavailable(redact::redact_text(&format!(
                "MCP HTTP body read failed: {e}"
            )))
        })?;

        // Stash session id from a legacy handshake without mutating through &self
        // here; the caller applies it.
        Ok((status, content_type, www_auth, session, body))
    }

    fn decode_http_body(
        &mut self,
        id: RequestId,
        method: &str,
        status: u16,
        content_type: &str,
        www_auth: Option<String>,
        body: String,
    ) -> Result<Value, McpError> {
        if status == 401 || status == 403 {
            return Err(McpError::auth_expired_challenge(
                "MCP server requires authentication",
                www_auth,
            ));
        }
        if status == 405 {
            return Err(McpError::protocol(
                "server needs streamable HTTP (legacy HTTP+SSE is not supported)",
            ));
        }
        if status == 202 {
            return Ok(Value::Null);
        }

        let ct = content_type.to_ascii_lowercase();
        if looks_like_legacy_sse_endpoint(&ct, &body) {
            return Err(McpError::protocol(
                "server needs streamable HTTP (legacy HTTP+SSE is not supported)",
            ));
        }

        if status >= 500 {
            return Err(McpError::unavailable(format!(
                "MCP server returned HTTP {status}"
            )));
        }

        let payload = if ct.contains("text/event-stream") {
            parse_sse_jsonrpc(&body)?
        } else if body.trim().is_empty() {
            if status >= 400 {
                return Err(McpError::protocol(format!(
                    "MCP server returned HTTP {status} with an empty body"
                )));
            }
            return Ok(Value::Null);
        } else {
            body
        };

        let msg: JsonRpcMessage = serde_json::from_str(payload.trim()).map_err(|e| {
            if status >= 400 {
                McpError::protocol(format!(
                    "MCP HTTP {status} (not JSON-RPC): {}",
                    redact::redact_text(payload.trim())
                ))
            } else {
                McpError::protocol(format!("decode MCP HTTP message failed: {e}"))
            }
        })?;

        match msg {
            JsonRpcMessage::Response(resp) => {
                if resp.id != id {
                    warn!(target: "mcp_connector", id = ?resp.id, "HTTP response id mismatch");
                }
                resp_to_result(resp)
            }
            other => Err(McpError::protocol(format!(
                "unexpected MCP HTTP payload for {method}: {other:?}"
            ))),
        }
    }

    async fn modern_discover(
        &mut self,
        cancel: &CancellationToken,
    ) -> Result<ServerInfo, McpError> {
        self.era = HttpEra::Modern;
        let id = self.next_request_id();
        let result = self.round_trip(id, "server/discover", None, cancel).await?;
        parse_server_info(&result)
    }

    async fn legacy_initialize(
        &mut self,
        cancel: &CancellationToken,
    ) -> Result<ServerInfo, McpError> {
        self.era = HttpEra::Legacy;
        let id = self.next_request_id();
        let params = json!({
            "protocolVersion": HTTP_LEGACY_PROTOCOL_VERSION,
            "clientInfo": self.client,
            "capabilities": {},
        });
        let result = self
            .round_trip(id, "initialize", Some(params), cancel)
            .await?;
        let init: InitializeResult = serde_json::from_value(result.clone()).or_else(|_| {
            parse_server_info(&result).map(|server_info| InitializeResult {
                protocol_version: HTTP_LEGACY_PROTOCOL_VERSION.to_string(),
                server_info,
            })
        })?;

        let initialized = json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        });
        let encoded = serde_json::to_string(&initialized)
            .map_err(|e| McpError::protocol(format!("encode initialized failed: {e}")))?;
        let _ = self
            .post_json("notifications/initialized", None, encoded)
            .await;
        Ok(init.server_info)
    }

    fn should_fallback_to_legacy(err: &McpError) -> bool {
        if err.category == crate::transport::ErrorCategory::AuthExpired {
            return false;
        }
        let msg = err.message.to_ascii_lowercase();
        msg.contains("method not found")
            || msg.contains("unsupportedprotocolversion")
            || msg.contains("http 400")
            || msg.contains("not json-rpc")
            || msg.contains("unknown method")
            || msg.contains("server/discover")
    }
}

fn parse_server_info(result: &Value) -> Result<ServerInfo, McpError> {
    if let Some(info) = result.get("serverInfo") {
        return serde_json::from_value(info.clone())
            .map_err(|e| McpError::protocol(format!("decode serverInfo failed: {e}")));
    }
    Ok(ServerInfo {
        name: result
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("mcp-server")
            .to_string(),
        version: result
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
    })
}

fn looks_like_legacy_sse_endpoint(content_type: &str, body: &str) -> bool {
    if !content_type.contains("text/event-stream") {
        return false;
    }
    body.lines().any(|line| {
        let t = line.trim();
        t.eq_ignore_ascii_case("event: endpoint") || t.starts_with("event: endpoint")
    })
}

/// Pull JSON-RPC payloads out of a request-scoped SSE stream. Comments (`:`)
/// and keep-alives are ignored. The last JSON-RPC response wins.
fn parse_sse_jsonrpc(body: &str) -> Result<String, McpError> {
    let mut data = String::new();
    let mut last_payload: Option<String> = None;
    for line in body.lines() {
        if line.starts_with(':') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("data:") {
            let piece = rest.strip_prefix(' ').unwrap_or(rest);
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(piece);
            continue;
        }
        if line.is_empty() && !data.is_empty() {
            last_payload = Some(std::mem::take(&mut data));
        }
    }
    if !data.is_empty() {
        last_payload = Some(data);
    }
    last_payload.ok_or_else(|| McpError::protocol("SSE stream closed without a JSON-RPC payload"))
}

/// Encode a header value per spec 2026-07-28 Value Encoding.
pub fn encode_header_value(value: &str) -> String {
    let bytes = value.as_bytes();
    let sentinel = value.starts_with("=?base64?") && value.ends_with("?=");
    let leading_or_trailing_ws = value.starts_with(' ')
        || value.starts_with('\t')
        || value.ends_with(' ')
        || value.ends_with('\t');
    let unsafe_bytes = bytes
        .iter()
        .any(|b| !matches!(*b, 0x09 | 0x20 | 0x21..=0x7E));
    if sentinel || leading_or_trailing_ws || unsafe_bytes {
        format!("=?base64?{}?=", B64.encode(bytes))
    } else {
        value.to_string()
    }
}

fn is_tchar(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|b| {
            matches!(
                b,
                b'0'..=b'9'
                    | b'A'..=b'Z'
                    | b'a'..=b'z'
                    | b'!'
                    | b'#'
                    | b'$'
                    | b'%'
                    | b'&'
                    | b'\''
                    | b'*'
                    | b'+'
                    | b'-'
                    | b'.'
                    | b'^'
                    | b'_'
                    | b'`'
                    | b'|'
                    | b'~'
            )
        })
}

/// Drop tools whose `x-mcp-header` annotations are invalid (spec MUST).
pub fn filter_tools_for_http(tools: Vec<McpTool>) -> Vec<McpTool> {
    tools
        .into_iter()
        .filter(|tool| match validate_x_mcp_headers(&tool.input_schema) {
            Ok(()) => true,
            Err(reason) => {
                warn!(
                    target: "mcp_connector",
                    tool = %tool.name,
                    %reason,
                    "excluding tool with invalid x-mcp-header"
                );
                false
            }
        })
        .collect()
}

fn validate_x_mcp_headers(schema: &Value) -> Result<(), String> {
    let mut names: Vec<String> = Vec::new();
    walk_header_props(schema, &mut names)?;
    let mut seen = HashMap::new();
    for name in &names {
        let key = name.to_ascii_lowercase();
        if seen.insert(key, ()).is_some() {
            return Err(format!("duplicate x-mcp-header '{name}'"));
        }
    }
    Ok(())
}

fn walk_header_props(schema: &Value, names: &mut Vec<String>) -> Result<(), String> {
    let Some(props) = schema.get("properties").and_then(|v| v.as_object()) else {
        return Ok(());
    };
    for (prop_name, prop) in props {
        if let Some(header) = prop.get("x-mcp-header").and_then(|v| v.as_str()) {
            if !is_tchar(header) {
                return Err(format!("invalid x-mcp-header on '{prop_name}': '{header}'"));
            }
            let ty = prop.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if !matches!(ty, "string" | "integer" | "boolean") {
                return Err(format!(
                    "x-mcp-header on '{prop_name}' is not a primitive string/integer/boolean"
                ));
            }
            names.push(header.to_string());
        }
        if prop.get("properties").is_some() {
            walk_header_props(prop, names)?;
        }
    }
    Ok(())
}

fn param_headers(tool: &McpTool, arguments: Option<&Value>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    collect_param_headers(&tool.input_schema, arguments, &mut out);
    out
}

fn collect_param_headers(
    schema: &Value,
    arguments: Option<&Value>,
    out: &mut Vec<(String, String)>,
) {
    let Some(props) = schema.get("properties").and_then(|v| v.as_object()) else {
        return;
    };
    for (prop_name, prop) in props {
        if let Some(header) = prop.get("x-mcp-header").and_then(|v| v.as_str()) {
            if let Some(value) = arguments.and_then(|a| a.get(prop_name)) {
                if let Some(encoded) = encode_param_header_value(value) {
                    out.push((format!("Mcp-Param-{header}"), encoded));
                }
            }
        }
        if prop.get("properties").is_some() {
            let nested_args = arguments.and_then(|a| a.get(prop_name));
            collect_param_headers(prop, nested_args, out);
        }
    }
}

fn encode_param_header_value(value: &Value) -> Option<String> {
    let raw = match value {
        Value::String(s) => s.clone(),
        Value::Number(n) if n.is_i64() || n.is_u64() => n.to_string(),
        Value::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        Value::Null => return None,
        _ => return None,
    };
    Some(encode_header_value(&raw))
}

async fn list_named<T: serde::de::DeserializeOwned>(
    transport: &mut HttpSseTransport,
    method: &str,
    key: &str,
    cancel: &CancellationToken,
) -> Result<Vec<T>, McpError> {
    let id = transport.next_request_id();
    let result = transport.round_trip(id, method, None, cancel).await?;
    serde_json::from_value(result.get(key).cloned().unwrap_or(Value::Array(vec![])))
        .map_err(|e| McpError::protocol(format!("decode {method} failed: {e}")))
}

#[async_trait]
impl McpTransport for HttpSseTransport {
    async fn initialize(&mut self, cancel: &CancellationToken) -> Result<ServerInfo, McpError> {
        match self.modern_discover(cancel).await {
            Ok(info) => Ok(info),
            Err(e) if e.category == crate::transport::ErrorCategory::AuthExpired => Err(e),
            Err(e) if e.message.contains("needs streamable HTTP") => Err(e),
            Err(e) if Self::should_fallback_to_legacy(&e) => {
                warn!(
                    target: "mcp_connector",
                    error = %e.message,
                    "modern server/discover failed; falling back to initialize handshake"
                );
                self.legacy_initialize(cancel).await
            }
            Err(e) => Err(e),
        }
    }

    async fn list_tools(&mut self, cancel: &CancellationToken) -> Result<Vec<McpTool>, McpError> {
        let tools = list_named::<McpTool>(self, "tools/list", "tools", cancel).await?;
        let filtered = filter_tools_for_http(tools);
        self.tools_cache = filtered.clone();
        Ok(filtered)
    }

    async fn list_resources(
        &mut self,
        cancel: &CancellationToken,
    ) -> Result<Vec<McpResource>, McpError> {
        list_named(self, "resources/list", "resources", cancel).await
    }

    async fn list_prompts(
        &mut self,
        cancel: &CancellationToken,
    ) -> Result<Vec<McpPrompt>, McpError> {
        list_named(self, "prompts/list", "prompts", cancel).await
    }

    async fn call_tool(
        &mut self,
        name: &str,
        arguments: &Value,
        cancel: &CancellationToken,
    ) -> Result<ToolOutput, McpError> {
        let id = self.next_request_id();
        let params = json!({ "name": name, "arguments": arguments });
        let result = self
            .round_trip(id, "tools/call", Some(params), cancel)
            .await?;
        decode_tool_output(&result)
    }

    async fn shutdown(&mut self) -> Result<(), McpError> {
        self.dead = true;
        self.session_id = None;
        Ok(())
    }

    async fn is_alive(&mut self) -> bool {
        !self.dead
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_and_credentialed_urls() {
        assert!(HttpSseConfig::from_value(&json!({"url": ""})).is_err());
        assert!(
            HttpSseConfig::from_value(&json!({"url": "https://user:pass@x.example/mcp"})).is_err()
        );
        assert!(HttpSseConfig::from_value(&json!({"url": "http://example.com/mcp"})).is_err());
        assert!(HttpSseConfig::from_value(&json!({"url": "https://mcp.example.com/mcp"})).is_ok());
        assert!(HttpSseConfig::from_value(&json!({"url": "http://127.0.0.1:9/mcp"})).is_ok());
    }

    #[test]
    fn encodes_non_ascii_header_values() {
        let encoded = encode_header_value("Hello, 世界");
        assert!(encoded.starts_with("=?base64?"));
        assert!(encoded.ends_with("?="));
        assert_eq!(encode_header_value("get_weather"), "get_weather");
        assert!(encode_header_value(" padded ").starts_with("=?base64?"));
        assert!(encode_header_value("=?base64?literal?=").starts_with("=?base64?"));
    }

    #[test]
    fn parses_sse_payload() {
        let body =
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n\n";
        let payload = parse_sse_jsonrpc(body).unwrap();
        assert!(payload.contains("\"ok\":true"));
    }

    #[test]
    fn detects_legacy_sse_endpoint_event() {
        assert!(looks_like_legacy_sse_endpoint(
            "text/event-stream",
            "event: endpoint\ndata: /messages\n\n"
        ));
        assert!(!looks_like_legacy_sse_endpoint(
            "text/event-stream",
            "data: {\"jsonrpc\":\"2.0\"}\n\n"
        ));
    }

    #[test]
    fn drops_tools_with_bad_x_mcp_header() {
        let bad = McpTool {
            name: "bad".into(),
            description: String::new(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "q": { "type": "object", "x-mcp-header": "Q" }
                }
            }),
            permission_level: None,
        };
        let good = McpTool {
            name: "good".into(),
            description: String::new(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "region": { "type": "string", "x-mcp-header": "Region" }
                }
            }),
            permission_level: None,
        };
        let kept = filter_tools_for_http(vec![bad, good]);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].name, "good");
    }
}
