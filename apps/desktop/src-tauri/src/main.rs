#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// All modules live in the `conduit_desktop` library crate so Phase 3
// integration tests (`tests/`) can reach the migration runner and repositories.
use conduit_desktop::{
    commands::*, connector_runtime::ConnectorRuntimeManager, state::AppState,
    stream_manager::StreamManager,
};
use tauri::{Manager, RunEvent};

fn main() {
    let app_name = "Conduit";

    // Phase 4: route redacted connector stderr + connector-runtime lifecycle
    // events to the process log. `RUST_LOG` overrides; default to `info` so
    // connector events surface without env config. Per-connector file appender
    // routing (into AppPaths::connectors) is a 04b refinement.
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();

    // Pool init + migrations are async; run them on the Tauri async runtime
    // before building the app so `AppState` (with `db: DbPool`) is ready to
    // `.manage()`. A migration failure returns a user-safe `MigrationRecovery`
    // rather than panicking — the renderer surfaces it.
    let state = tauri::async_runtime::block_on(AppState::load(app_name))
        .expect("failed to initialize desktop state");

    let app = tauri::Builder::default()
        .manage(state)
        .manage(StreamManager::new())
        .manage(ConnectorRuntimeManager::new())
        .invoke_handler(tauri::generate_handler![
            get_app_paths,
            get_settings,
            update_settings,
            save_provider_credential,
            load_provider_credential_reference,
            validate_provider_credentials,
            list_provider_models,
            start_chat_stream,
            cancel_chat_stream,
            get_conversation_messages,
            create_conversation,
            list_conversations,
            get_conversation,
            delete_conversation,
            save_attachment,
            list_attachments,
            delete_attachment,
            get_attachment_bytes,
            create_artifact,
            list_artifacts,
            get_artifact,
            set_artifact_content,
            get_artifact_content_bytes,
            check_artifact_file_state,
            export_artifact,
            list_connector_definitions,
            list_connector_versions,
            list_connector_grants,
            list_connector_capabilities,
            get_connector_runtime_states,
            start_connector,
            stop_connector,
            discover_connector,
            invoke_connector_tool,
            approve_connector_tool_call,
            deny_connector_tool_call,
            revoke_connector_grant,
            add_local_connector,
            get_tenant_config,
            get_license_state,
            export_diagnostics,
            start_mock_stream,
            cancel_mock_stream,
        ])
        .setup(|app| {
            let _ = app.handle();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Conduit desktop shell");

    // Phase 4: on quit, tear down every active connector so no child process
    // outlives the app (disable / sign-out / revocation paths call
    // `stop_connector` directly; this is the app-exit backstop).
    app.run(|handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            if let Some(mgr) = handle.try_state::<ConnectorRuntimeManager>() {
                tauri::async_runtime::block_on(mgr.shutdown_all());
            }
        }
    });
}