//! Streamable HTTP transport integration test: a loopback MCP endpoint
//! speaks spec 2026-07-28 (`server/discover` + JSON or SSE replies).

use mcp_runtime::{protocol::ClientInfo, HttpSseConfig, HttpSseTransport, McpTransport};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

async fn spawn_server(handler: fn(&str, &str, &Value) -> (u16, &'static str, String)) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut tmp = [0u8; 2048];
                let (headers, body) = loop {
                    let n = match stream.read(&mut tmp).await {
                        Ok(0) => return,
                        Ok(n) => n,
                        Err(_) => return,
                    };
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(pos) = find_headers_end(&buf) {
                        let header_text = String::from_utf8_lossy(&buf[..pos]).to_string();
                        let content_length = content_length(&header_text).unwrap_or(0);
                        let mut body = buf[pos + 4..].to_vec();
                        while body.len() < content_length {
                            let n = match stream.read(&mut tmp).await {
                                Ok(0) => break,
                                Ok(n) => n,
                                Err(_) => return,
                            };
                            body.extend_from_slice(&tmp[..n]);
                        }
                        body.truncate(content_length);
                        break (header_text, body);
                    }
                };
                let method_header = header_value(&headers, "mcp-method").unwrap_or_default();
                let json: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let (status, content_type, payload) = handler(&headers, &method_header, &json);
                let response = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });
    format!("http://{addr}/mcp")
}

fn find_headers_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn content_length(headers: &str) -> Option<usize> {
    header_value(headers, "content-length")?.parse().ok()
}

fn header_value(headers: &str, name: &str) -> Option<String> {
    for line in headers.lines() {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        if k.eq_ignore_ascii_case(name) {
            return Some(v.trim().to_string());
        }
    }
    None
}

fn modern_handler(_headers: &str, method: &str, body: &Value) -> (u16, &'static str, String) {
    let id = body.get("id").cloned().unwrap_or(json!(1));
    match method {
        "server/discover" => (
            200,
            "application/json",
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2026-07-28",
                    "serverInfo": { "name": "http-echo", "version": "1.0.0" },
                    "capabilities": { "tools": {} }
                }
            })
            .to_string(),
        ),
        "tools/list" => (
            200,
            "text/event-stream",
            format!(
                "event: message\ndata: {}\n\n",
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "tools": [{
                            "name": "echo",
                            "description": "echo",
                            "inputSchema": { "type": "object" },
                            "permissionLevel": "readOnly"
                        }],
                        "ttlMs": 60_000
                    }
                })
            ),
        ),
        "tools/call" => {
            let text = body
                .pointer("/params/arguments/text")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            (
                200,
                "application/json",
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": text }],
                        "isError": false
                    }
                })
                .to_string(),
            )
        }
        other => (
            200,
            "application/json",
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("method not found: {other}") }
            })
            .to_string(),
        ),
    }
}

fn auth_handler(_headers: &str, _method: &str, _body: &Value) -> (u16, &'static str, String) {
    (
        401,
        "application/json",
        json!({"error":"unauthorized"}).to_string(),
    )
}

fn sse_legacy_handler(_headers: &str, _method: &str, _body: &Value) -> (u16, &'static str, String) {
    (405, "text/plain", "method not allowed".into())
}

fn transport_at(url: &str) -> HttpSseTransport {
    HttpSseTransport::new(
        HttpSseConfig::from_value(&json!({ "url": url })).expect("config"),
        ClientInfo {
            name: "test".into(),
            version: "0.0.0".into(),
        },
    )
}

#[tokio::test]
async fn streamable_http_discover_list_and_call() {
    let url = spawn_server(modern_handler).await;
    let mut t = transport_at(&url);
    let cancel = CancellationToken::new();
    let info = t.initialize(&cancel).await.expect("discover");
    assert_eq!(info.name, "http-echo");
    let tools = t.list_tools(&cancel).await.expect("list");
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "echo");
    let out = t
        .call_tool("echo", &json!({ "text": "hi" }), &cancel)
        .await
        .expect("call");
    assert_eq!(out.text_summary(), "hi");
}

#[tokio::test]
async fn streamable_http_401_is_auth_expired() {
    let url = spawn_server(auth_handler).await;
    let mut t = transport_at(&url);
    let cancel = CancellationToken::new();
    let err = t.initialize(&cancel).await.expect_err("401");
    assert_eq!(err.category, mcp_runtime::ErrorCategory::AuthExpired);
}

#[tokio::test]
async fn streamable_http_405_needs_streamable_http() {
    let url = spawn_server(sse_legacy_handler).await;
    let mut t = transport_at(&url);
    let cancel = CancellationToken::new();
    let err = t.initialize(&cancel).await.expect_err("405");
    assert!(
        err.message.contains("needs streamable HTTP"),
        "got {}",
        err.message
    );
}
