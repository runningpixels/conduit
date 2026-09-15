//! t0-9 against real MCP server software, rather than our own fixture.
//!
//! Every other test in this area drives `echo_connector`, which we wrote — so
//! it proves the runtime agrees with itself. This one points the same runtime
//! at the official `@modelcontextprotocol/server-everything`, whose prompts and
//! resources were written by someone with no knowledge of Conduit, and checks
//! that discovery, `resources/read` and `prompts/get` all survive contact with
//! it.
//!
//! **Opt-in.** It needs a server installed from npm, so CI must not depend on
//! it and it is skipped unless `CONDUIT_EVERYTHING_SERVER` points at the
//! package's `dist/index.js`:
//!
//! ```text
//! npm install @modelcontextprotocol/server-everything
//! CONDUIT_EVERYTHING_SERVER=<abs path>/dist/index.js \
//!   cargo test --test connector_everything_live -- --nocapture
//! ```
//!
//! Spawned as `node <script>` deliberately: the stdio transport refuses shell
//! interpreters, and on Windows `npx` is `npx.cmd`, which needs one.

mod common;

use std::path::Path;
use std::time::Duration;

use conduit_desktop::connector_runtime::{prompts, resources, ConnectorRuntimeManager};
use conduit_desktop::db::repository::connectors::{
    self, ConnectorDefinition, ConnectorGrant, ConnectorVersion,
};
use conduit_desktop::paths::AppPaths;
use conduit_desktop::state::AppState;
use provider_core::schema::{PromptArguments, ResourceRef};
use serde_json::json;

/// `None` (and a printed note) when the server is not installed, so the suite
/// stays green on a machine that never ran the npm install.
fn server_script() -> Option<String> {
    match std::env::var("CONDUIT_EVERYTHING_SERVER") {
        Ok(p) if Path::new(&p).is_file() => Some(p),
        Ok(p) => {
            eprintln!("skipping: CONDUIT_EVERYTHING_SERVER is set but {p} is not a file");
            None
        }
        Err(_) => {
            eprintln!("skipping: set CONDUIT_EVERYTHING_SERVER to the server's dist/index.js");
            None
        }
    }
}

fn test_paths(root: &Path) -> AppPaths {
    AppPaths {
        root: root.to_path_buf(),
        settings_file: root.join("settings.json"),
        database: root.join("conduit.sqlite"),
        attachments: root.join("attachments"),
        artifacts: root.join("artifacts"),
        logs: root.join("logs"),
        diagnostics: root.join("diagnostics"),
        updates: root.join("updates"),
        streams: root.join("streams"),
        connectors: root.join("connectors"),
        exports: root.join("exports"),
        branding: root.join("branding"),
        themes: root.join("themes"),
    }
}

/// A real server takes longer to boot than our fixture; node itself costs a
/// few hundred ms before the handshake even starts.
fn test_manager() -> ConnectorRuntimeManager {
    ConnectorRuntimeManager::new_with(Duration::from_millis(200), Duration::from_secs(30))
}

async fn seed(pool: &conduit_desktop::db::DbPool, script: &str) -> String {
    let def = ConnectorDefinition {
        id: "everything".into(),
        name: "Everything".into(),
        description: "MCP reference server".into(),
        transport: "stdio".into(),
        owner: "modelcontextprotocol".into(),
        icon: None,
        support_url: None,
        consent_copy: None,
        policy_metadata: None,
        cloud_id: None,
        created_at: "2026-09-15T00:00:00Z".into(),
        updated_at: "2026-09-15T00:00:00Z".into(),
    };
    connectors::upsert_definition(pool, &def).await.unwrap();

    let version = ConnectorVersion {
        id: "everything:1.0.0".into(),
        connector_id: "everything".into(),
        version: "1.0.0".into(),
        transport_config: json!({ "command": "node", "args": [script], "env": {} }),
        scope_grants: None,
        capability_allowlist: None,
        rollout_channel: None,
        support_state: None,
        created_at: "2026-09-15T00:00:00Z".into(),
    };
    connectors::insert_version(pool, &version).await.unwrap();

    let grant = ConnectorGrant {
        id: "g-everything".into(),
        connector_version_id: "everything:1.0.0".into(),
        scope: "user".into(),
        status: "active".into(),
        credential_ref: None,
        approved_by: Some("test".into()),
        revoked_at: None,
        notes: None,
        created_at: "2026-09-15T00:00:00Z".into(),
    };
    connectors::upsert_grant(pool, &grant).await.unwrap();

    "everything:1.0.0".to_string()
}

#[tokio::test]
async fn the_reference_server_survives_discovery_read_and_get() {
    let Some(script) = server_script() else {
        return;
    };
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed(&pool, &script).await;

    mgr.start_connector(&state, &vid)
        .await
        .expect("the reference server starts");

    // --- discovery ---------------------------------------------------------
    let caps = mgr.discover_capabilities(&state, &vid).await.unwrap();
    let resources_found: Vec<_> = caps.iter().filter(|c| c.kind == "resource").collect();
    let prompts_found: Vec<_> = caps.iter().filter(|c| c.kind == "prompt").collect();
    let tools_found = caps.iter().filter(|c| c.kind == "tool").count();
    eprintln!(
        "discovered {} tool(s), {} resource(s), {} prompt(s)",
        tools_found,
        resources_found.len(),
        prompts_found.len()
    );
    assert!(!resources_found.is_empty(), "server advertises resources");
    assert!(!prompts_found.is_empty(), "server advertises prompts");

    // The payloads discovery now keeps are what make the pickers usable: a
    // resource without its URI cannot be read, a prompt without its arguments
    // would be called without required values.
    let spec = resources_found
        .iter()
        .find(|c| c.name.ends_with(".md"))
        .expect("a markdown resource");
    let uri = spec
        .schema_json
        .as_ref()
        .and_then(|v| v.get("uri"))
        .and_then(|v| v.as_str())
        .expect("the resource URI survived discovery")
        .to_string();
    assert!(uri.starts_with("demo://"), "got {uri}");

    let args_prompt = prompts_found
        .iter()
        .find(|c| c.name == "args-prompt")
        .expect("args-prompt was discovered");
    let declared = args_prompt
        .schema_json
        .as_ref()
        .and_then(|v| v.get("arguments"))
        .and_then(|v| v.as_array())
        .expect("prompt arguments survived discovery");
    assert!(
        declared
            .iter()
            .any(|a| a.get("name").and_then(|n| n.as_str()) == Some("city")
                && a.get("required").and_then(|r| r.as_bool()) == Some(true)),
        "the required `city` argument survived: {declared:?}"
    );

    // --- resources/read, through the full gate -----------------------------
    let refs = vec![ResourceRef {
        connector_version_id: vid.clone(),
        name: spec.name.clone(),
        uri: uri.clone(),
    }];

    // Unacknowledged first: a real server is refused exactly like a fixture.
    let blocked = resources::read_resources(&state, &mgr, &refs)
        .await
        .unwrap();
    assert!(
        blocked.included.is_empty(),
        "refused before acknowledgement"
    );

    resources::acknowledge(&state, &vid).await.unwrap();
    let block = resources::read_resources(&state, &mgr, &refs)
        .await
        .unwrap();
    assert_eq!(
        block.included.len(),
        1,
        "the reference server's own prose passes redaction, the reinjection gate \
         and the size cap; skipped: {:?}",
        block.skipped
    );
    assert!(block.text.contains(&uri), "the block names its origin");
    assert!(block.text.contains("not instructions"));

    // --- prompts/get -------------------------------------------------------
    // No arguments: goes straight to the composer, no dialog.
    let simple = prompts::get_prompt(
        &state,
        &mgr,
        &PromptArguments {
            connector_version_id: vid.clone(),
            name: "simple-prompt".into(),
            arguments: json!({}),
        },
    )
    .await
    .expect("simple-prompt resolves");
    assert!(!simple.trim().is_empty());

    // With arguments: the value we supply reaches the resolved text.
    let filled = prompts::get_prompt(
        &state,
        &mgr,
        &PromptArguments {
            connector_version_id: vid.clone(),
            name: "args-prompt".into(),
            arguments: json!({ "city": "Reykjavik" }),
        },
    )
    .await
    .expect("args-prompt resolves");
    eprintln!("args-prompt -> {filled}");
    assert!(
        filled.contains("Reykjavik"),
        "the argument reached the server: {filled}"
    );

    mgr.stop_connector(&state, &vid).await.unwrap();
}
