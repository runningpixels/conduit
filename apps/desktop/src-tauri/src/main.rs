// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// All modules live in the `conduit_desktop` library crate so Phase 3
// integration tests (`tests/`) can reach the migration runner and repositories.
use conduit_desktop::{
    artifact_frames::{self, ArtifactFrames},
    brand,
    commands::*,
    connector_runtime::ConnectorRuntimeManager,
    state::AppState,
    stream_manager::StreamManager,
    updater::*,
    webview_args,
};
use tauri::{Manager, RunEvent};

fn main() {
    let app_name = brand::app_name();

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
        // Phase 6 plugins (registered before `.manage(state)`):
        // - updater: signature-verified auto-update; commands in `updater.rs`.
        // - dialog: first-run onboarding + the one-time diagnostics disclosure.
        // - shell: "Reveal in Finder/Explorer" for diagnostics + artifact exports
        //   (renderer calls `reveal_path` IPC command; no `shell:allow-open`).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .manage(StreamManager::new())
        .manage(ConnectorRuntimeManager::new())
        // HTML artifacts load from their own origin so they don't inherit the
        // app CSP (which blocks every inline script); see `artifact_frames`.
        .manage(ArtifactFrames::default())
        .register_uri_scheme_protocol(artifact_frames::SCHEME, |ctx, request| {
            ctx.app_handle().state::<ArtifactFrames>().respond(&request)
        })
        .manage(StagedUpdate::new())
        .invoke_handler(tauri::generate_handler![
            get_app_paths,
            get_settings,
            update_settings,
            pick_workspace_folder,
            get_onboarding_state,
            // White-label Mode A: brand.md storage + IPC surface.
            get_brand_config,
            get_brand_warnings,
            set_brand_config,
            clear_brand_config,
            parse_brand_source,
            import_brand_file,
            import_brand_file_dialog,
            apply_brand_edits,
            export_brand_config,
            export_brand_config_dialog,
            save_brand_logo,
            get_brand_logo,
            clear_brand_logo,
            // Theming Phase 5: user theme files (`<id>.theme.md` under
            // AppPaths::themes) -- see docs/theming/user-themes.md.
            list_user_themes,
            reveal_themes_dir,
            create_example_user_theme,
            save_provider_credential,
            load_provider_credential_reference,
            list_provider_descriptors,
            validate_provider_credentials,
            list_provider_models,
            start_chat_stream,
            cancel_chat_stream,
            steer_chat_stream,
            submit_ask_user,
            get_conversation_messages,
            get_conversation_compaction,
            compact_conversation,
            get_request_provider_events,
            create_conversation,
            list_conversations,
            get_conversation,
            delete_conversation,
            set_conversation_title,
            set_conversation_pinned,
            set_conversation_archived,
            set_conversation_folder,
            list_conversation_folders,
            create_conversation_folder,
            rename_conversation_folder,
            delete_conversation_folder,
            set_conversation_workspace,
            delete_all_conversations,
            preview_conversation_export,
            export_conversation_dialog,
            save_attachment,
            list_attachments,
            delete_attachment,
            get_attachment_bytes,
            create_artifact,
            list_artifacts,
            get_message_id_by_request,
            get_artifact,
            set_artifact_content,
            set_artifact_title,
            get_artifact_content_bytes,
            read_artifact_file_bytes,
            check_artifact_file_state,
            export_artifact,
            list_connector_definitions,
            list_connector_versions,
            list_connector_grants,
            list_connector_capabilities,
            list_connector_prompts,
            list_connector_resources,
            get_connector_prompt,
            read_connector_resources,
            is_connector_resource_acknowledged,
            acknowledge_connector_resources,
            get_connector_runtime_states,
            start_connector,
            stop_connector,
            discover_connector,
            invoke_connector_tool,
            approve_connector_tool_call,
            deny_connector_tool_call,
            list_tool_approval_memory,
            revoke_tool_approval_memory,
            revoke_connector_grant,
            add_local_connector,
            search_mcp_registry,
            add_remote_connector,
            signin_remote_connector,
            get_tenant_config,
            get_license_state,
            export_diagnostics,
            start_mock_stream,
            cancel_mock_stream,
            // Phase 6: updater trust-promise gate.
            check_for_update,
            download_and_install_update,
            // Automatic updates: non-networked status read + stage-for-quit.
            get_update_status,
            stage_update,
            // Phase 6 M6.5: diagnostics export disclosure + reveal-in-folder.
            get_diagnostics_disclosure_acknowledged,
            acknowledge_diagnostics_disclosure,
            reveal_path,
            reveal_artifacts_dir,
            reveal_artifact,
            open_external_url,
            artifact_fetch,
            grant_artifact_network,
            get_artifact_network_state,
            list_artifact_network_grants,
            revoke_artifact_network_grant,
            clear_artifact_network_grants,
            search_messages,
            // Competitive Feature: usage analytics
            get_usage_summary,
            // Competitive Feature: built-in agent tools
            // (tool definitions built into agent_tools.rs, no new commands needed)
            // Competitive Feature: retry & fork
            remove_last_turn,
            fork_conversation,
            prepare_message_edit,
            set_conversation_chat_settings,
            // Competitive Feature: prompts library
            create_prompt,
            list_prompts,
            get_prompt,
            update_prompt,
            delete_prompt,
            list_prompt_folders,
            // t1-4: SKILL.md-compatible skills
            list_skills,
            get_skill_prompt_block,
            list_conversation_skills,
            set_conversation_skills,
            import_skill_folder,
            import_skill_zip,
            export_skill_folder,
            export_skill_zip,
            delete_managed_skill,
            reveal_skills_dir,
            // t1-5: persistent memory
            list_memory_items,
            create_memory_item,
            update_memory_item,
            delete_memory_item,
            accept_memory_item,
            get_memory_prompt_block,
            // t1-6: local knowledge base (RAG)
            list_knowledge_collections,
            create_knowledge_collection,
            rename_knowledge_collection,
            delete_knowledge_collection,
            list_knowledge_documents,
            pick_knowledge_document,
            import_knowledge_document,
            delete_knowledge_document,
            list_conversation_collections,
            set_conversation_collections,
            retrieve_knowledge_context,
            get_knowledge_passage,
            // t1-8 P2: documents control (M1-M3)
            list_conversation_excluded_documents,
            set_conversation_document_excluded,
            save_dropped_attachment,
            // Phase 7 / M-WebSearch: local database reset (Privacy & Data section).
            reset_local_database,
            // Migration-recovery escape hatches: dismiss the notice, delete the
            // backup, wipe local data, and actually restart the process.
            acknowledge_migration_recovery,
            discard_migration_backup,
            request_local_data_wipe,
            cancel_local_data_wipe,
            restart_app,
            put_artifact_frame,
            drop_artifact_frame,
            // Workflows v1: saved routines, run by hand.
            validate_workflow,
            list_workflows,
            get_workflow,
            create_workflow,
            update_workflow,
            delete_workflow,
            run_workflow,
            list_workflow_runs,
            get_workflow_run,
        ])
        .setup(|app| {
            // The main window is built here, not from tauri.conf.json, so its
            // WebView2 gets browser arguments computed from settings: WebRTC
            // egress closed, remote-allowlist origins exempt (see
            // `webview_args`). The config entry has `create: false`.
            let allowlist = app
                .state::<AppState>()
                .settings()
                .map(|s| s.artifact_remote_allowlist)
                .unwrap_or_default();
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .ok_or("tauri.conf.json has no \"main\" window")?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .additional_browser_args(&webview_args::main_webview_browser_args(&allowlist))
                .build()?;
            Ok(())
        })
        // t1-8 P2 M1 (D13): record every path a native window drop carries, so
        // `save_dropped_attachment` can later verify a path it's asked to read
        // actually came from a real, recent drop rather than trusting whatever
        // the renderer names. The native drop handler (Tauri's default; see
        // `dragDropEnabled` in tauri.conf.json) is what fires on Windows even
        // for a drop that lands on the composer, where WebView2 delivers no
        // HTML5 `drop` event at all — this is the one place Rust ever sees
        // those paths.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                if let Some(state) = window.try_state::<AppState>() {
                    state.record_dropped_paths(paths.clone(), std::time::Instant::now());
                }
            }
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
            // Strictly last: on Windows this spawns the installer and calls
            // `std::process::exit(0)`, so nothing sequenced after it runs. It
            // must not pre-empt the connector shutdown above, or child
            // processes outlive the app.
            install_staged_update(handle);
        }
    });
}
