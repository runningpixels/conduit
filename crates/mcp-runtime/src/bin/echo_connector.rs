//! Minimal MCP server used by the transport integration test
//! (`tests/stdio_fixture.rs`) and the conduit-desktop supervisor tests.
//!
//! Speaks newline-delimited JSON-RPC 2.0 over stdin/stdout. Exposes:
//! - `echo`        (readOnly)    — returns the arguments as text
//! - `read_time`   (readOnly)    — returns a fixed timestamp string
//! - `post_message`(sideEffectful) — "posts" the supplied text
//! - `slow`        (readOnly)    — sleeps ~60s before responding (timeout/cancel)
//! - `secret_leak` (readOnly)    — returns a `Bearer …` token (redaction test)
//! - `big`         (readOnly)    — returns ~2 MiB of text (output size-cap test)
//!
//! Deliberately minimal and dependency-light: it only needs serde_json, which
//! the crate already provides to its bins.

use std::io::{BufRead, Write};
use std::time::Duration;

use serde_json::{json, Value};

fn tools_list() -> Value {
    maybe_sleep_env("ECHO_CONNECTOR_LIST_TOOLS_DELAY_MS");
    json!([
        {
            "name": "echo",
            "description": "Echo the arguments back as text.",
            "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } } },
            "permissionLevel": "readOnly"
        },
        {
            "name": "read_time",
            "description": "Return the current time (fixed fixture value).",
            "inputSchema": { "type": "object", "properties": {} },
            "permissionLevel": "readOnly"
        },
        {
            "name": "post_message",
            "description": "Post a message to a channel (side-effectful).",
            "inputSchema": {
                "type": "object",
                "properties": { "channel": { "type": "string" }, "text": { "type": "string" } },
                "required": ["channel", "text"]
            },
            "permissionLevel": "sideEffectful"
        },
        {
            "name": "slow",
            "description": "Sleep for a long time before responding.",
            "inputSchema": { "type": "object", "properties": {} },
            "permissionLevel": "readOnly"
        },
        {
            "name": "secret_leak",
            "description": "Return a value containing a bearer token (redaction fixture).",
            "inputSchema": { "type": "object", "properties": {} },
            "permissionLevel": "readOnly"
        },
        {
            "name": "big",
            "description": "Return a payload larger than the 1 MiB output cap (size-cap fixture).",
            "inputSchema": { "type": "object", "properties": {} },
            "permissionLevel": "readOnly"
        }
    ])
}

fn maybe_sleep_env(name: &str) {
    let Ok(raw) = std::env::var(name) else {
        return;
    };
    let Ok(ms) = raw.parse::<u64>() else {
        return;
    };
    if ms > 0 {
        std::thread::sleep(Duration::from_millis(ms));
    }
}

fn call_tool(name: &str, args: &Value) -> (Value, bool) {
    match name {
        "echo" => {
            let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("");
            (json!([{ "type": "text", "text": text }]), false)
        }
        "read_time" => (
            json!([{ "type": "text", "text": "2026-06-22T12:00:00Z" }]),
            false,
        ),
        "post_message" => {
            let channel = args
                .get("channel")
                .and_then(|v| v.as_str())
                .unwrap_or("general");
            let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("");
            (
                json!([{ "type": "text", "text": format!("posted to {channel}: {text}") }]),
                false,
            )
        }
        "slow" => {
            std::thread::sleep(Duration::from_secs(60));
            (json!([{ "type": "text", "text": "finally done" }]), false)
        }
        "secret_leak" => (
            json!([{ "type": "text", "text": "token=Bearer abc123supersecret" }]),
            false,
        ),
        // ~2 MiB of text — exceeds the runtime's 1 MiB per-call output cap.
        "big" => {
            let payload = "x".repeat(2_000_000);
            (json!([{ "type": "text", "text": payload }]), false)
        }
        // Makes the connector process exit after responding, so the supervisor
        // test can simulate a crash/exit without needing the child PID.
        "exit" => (json!([{ "type": "text", "text": "bye" }]), false),
        other => (
            json!([{ "type": "text", "text": format!("unknown tool: {other}") }]),
            true,
        ),
    }
}

fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Notifications carry no id.
        let id = msg.get("id").cloned();
        let method = match msg.get("method").and_then(|m| m.as_str()) {
            Some(m) => m.to_string(),
            None => continue,
        };

        // notifications/initialized — no response.
        if id.is_none() {
            continue;
        }
        let id = id.unwrap();

        let result: Option<Value> = match method.as_str() {
            "initialize" => {
                maybe_sleep_env("ECHO_CONNECTOR_INITIALIZE_DELAY_MS");
                Some(json!({
                    "protocolVersion": "2024-11-05",
                    "serverInfo": { "name": "echo-connector", "version": "0.1.0" },
                    "capabilities": { "tools": {} }
                }))
            }
            "tools/list" => Some(json!({ "tools": tools_list() })),
            "resources/list" => Some(json!({ "resources": [] })),
            "prompts/list" => Some(json!({ "prompts": [] })),
            "tools/call" => {
                let name = msg
                    .get("params")
                    .and_then(|p| p.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("");
                let args = msg
                    .get("params")
                    .and_then(|p| p.get("arguments"))
                    .cloned()
                    .unwrap_or(json!({}));
                let (content, is_error) = call_tool(name, &args);
                let resp = json!({ "jsonrpc": "2.0", "id": id, "result": { "content": content, "isError": is_error } });
                let _ = writeln!(out, "{resp}");
                let _ = out.flush();
                if name == "exit" {
                    // Simulate a connector exit after responding.
                    break;
                }
                None
            }
            "shutdown" => {
                let _ = writeln!(
                    out,
                    "{}",
                    json!({ "jsonrpc": "2.0", "id": id, "result": Value::Null })
                );
                let _ = out.flush();
                break;
            }
            _ => {
                let _ = writeln!(
                    out,
                    "{}",
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32601, "message": "method not found" }
                    })
                );
                let _ = out.flush();
                continue;
            }
        };

        if let Some(result) = result {
            let _ = writeln!(
                out,
                "{}",
                json!({ "jsonrpc": "2.0", "id": id, "result": result })
            );
            let _ = out.flush();
        }
    }
}
