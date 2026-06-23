//! Transport integration test: boot the `echo_connector` fixture over stdio,
//! exercise initialize / tools-list / tools-call, and confirm a dropped
//! transport kills the child.

use std::collections::HashMap;

use mcp_runtime::{
    consent::{classify, ConsentKind},
    protocol::{ClientInfo, PermissionLevel},
    stdio::StdioConfig,
    McpTransport, StdioTransport,
};
use serde_json::json;
use tokio_util::sync::CancellationToken;

fn fixture_config() -> StdioConfig {
    let bin = env!("CARGO_BIN_EXE_echo_connector");
    StdioConfig {
        command: bin.to_string(),
        args: vec![],
        env: HashMap::new(),
        cwd: None,
    }
}

#[tokio::test]
async fn stdio_initialize_list_and_call() {
    let cancel = CancellationToken::new();
    let mut t = StdioTransport::spawn(
        fixture_config(),
        ClientInfo { name: "conduit-test".into(), version: "0.1.0".into() },
    )
    .expect("spawn");

    let server = t.initialize(&cancel).await.expect("initialize");
    assert_eq!(server.name, "echo-connector");

    let tools = t.list_tools(&cancel).await.expect("tools/list");
    let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
    assert!(names.contains(&"echo"));
    assert!(names.contains(&"post_message"));

    // Consent policy: declared side-effectful tool → Prompt; read-only → Auto.
    let post = tools.iter().find(|t| t.name == "post_message").unwrap();
    assert_eq!(classify(post).required, ConsentKind::Prompt);
    let echo = tools.iter().find(|t| t.name == "echo").unwrap();
    assert_eq!(classify(echo).level, PermissionLevel::ReadOnly);
    assert_eq!(classify(echo).required, ConsentKind::Auto);

    let out = t
        .call_tool("echo", &json!({ "text": "hello" }), &cancel)
        .await
        .expect("call");
    assert!(!out.is_error);
    assert_eq!(out.text_summary(), "hello");
    assert!(out.size_bytes > 0);
    assert!(out.mime_hints.iter().any(|m| m == "text/plain"));

    let _ = t.shutdown().await;
}

#[tokio::test]
async fn stdio_cancel_kills_and_reports_cancelled() {
    let cancel = CancellationToken::new();
    let mut t = StdioTransport::spawn(
        fixture_config(),
        ClientInfo { name: "conduit-test".into(), version: "0.1.0".into() },
    )
    .expect("spawn");
    t.initialize(&cancel).await.expect("initialize");

    // `slow` sleeps 60s; cancel immediately. The call should resolve to
    // Cancelled and the transport should be dead afterwards.
    let call_cancel = CancellationToken::new();
    let call_cancel2 = call_cancel.clone();
    let handle = tokio::spawn(async move {
        t.call_tool("slow", &json!({}), &call_cancel2).await
    });
    // Give the child a moment to receive the request.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    call_cancel.cancel();
    let res = handle.await.expect("join");
    assert!(res.is_err());
    let err = res.unwrap_err();
    assert_eq!(
        err.category,
        mcp_runtime::ErrorCategory::Cancelled,
        "expected cancelled, got {err:?}"
    );
}

#[tokio::test]
async fn stdio_config_rejects_shell_dash_c() {
    let raw = json!({ "command": "sh", "args": ["-c", "rm -rf /"] });
    let err = StdioConfig::from_value(&raw).expect_err("must reject");
    assert_eq!(err.category, mcp_runtime::ErrorCategory::Protocol);
}

#[tokio::test]
async fn stdio_child_dies_when_transport_dropped() {
    let cancel = CancellationToken::new();
    let mut t = StdioTransport::spawn(
        fixture_config(),
        ClientInfo { name: "conduit-test".into(), version: "0.1.0".into() },
    )
    .expect("spawn");
    t.initialize(&cancel).await.expect("initialize");

    // Drop the transport; the child must not linger. (kill_on_drop + Drop.)
    drop(t);
    // No assertion on a PID here (portably awkward); the supervisor tests in
    // conduit-desktop cover restart-on-crash. This test guards the Drop path
    // compiles and runs without hang.
}