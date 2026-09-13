// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! User theme files IPC surface (theming Phase 5,
//! `docs/theming/user-themes.md`).
//!
//! Storage/scanning logic lives in `crate::user_themes` (filesystem) and
//! `provider_core::user_theme` (pure parse+validate); this module is the
//! thin `#[tauri::command]` layer over both, matching the
//! `local_data`/`commands::settings` and `branding`/`commands::branding`
//! splits.
//!
//! Every command here either reads a server-owned path
//! (`AppPaths::themes`) or writes one fixed, hardcoded filename inside it --
//! none accepts a renderer-supplied path or file name (ADR-008: "never
//! trust a renderer-supplied path when the OS itself, or `AppPaths`, can
//! supply one instead").

use tauri::State;

use crate::state::AppState;
use provider_core::schema::UserThemeEntry;

/// List every user theme file in `AppPaths::themes`. Invalid files are
/// included with `theme: None, error: Some(..)` rather than omitted, so the
/// picker can tell the author what to fix instead of silently dropping
/// their file -- see [`provider_core::schema::UserThemeEntry`]'s own doc
/// comment.
#[tauri::command]
pub fn list_user_themes(state: State<'_, AppState>) -> Result<Vec<UserThemeEntry>, String> {
    Ok(crate::user_themes::list(&state.paths.themes))
}

/// Reveal the themes directory in the OS file manager. Mirrors
/// `commands::settings::reveal_artifacts_dir` exactly: create the directory
/// if it is somehow missing, then open the hardcoded `AppPaths::themes`
/// path. Takes no renderer-supplied path.
#[tauri::command]
#[allow(deprecated)]
pub fn reveal_themes_dir(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    let dir = &state.paths.themes;
    if !dir.exists() {
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    app.shell()
        .open(dir.to_string_lossy(), None)
        .map_err(|error| error.to_string())
}

/// Write `crate::user_themes::USER_THEME_TEMPLATE` to
/// `<themes>/example.theme.md` -- but only if that file does not already
/// exist. An author who has started editing the example must never have
/// their edits silently clobbered by re-clicking "Add example theme";
/// returning the same id when the file is already there makes a second
/// call idempotent instead of destructive.
#[tauri::command]
pub fn create_example_user_theme(state: State<'_, AppState>) -> Result<String, String> {
    const EXAMPLE_FILE_NAME: &str = "example.theme.md";
    const EXAMPLE_ID: &str = "example";

    let path = state.paths.themes.join(EXAMPLE_FILE_NAME);
    if path.exists() {
        return Ok(EXAMPLE_ID.to_string());
    }

    std::fs::write(&path, crate::user_themes::USER_THEME_TEMPLATE)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
    Ok(EXAMPLE_ID.to_string())
}
