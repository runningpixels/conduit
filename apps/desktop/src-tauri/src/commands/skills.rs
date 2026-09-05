//! Agent Skills IPC (t1-4) — discovery, import/export, per-chat enablement.

use std::path::PathBuf;

use crate::{
    db::repository::skills as skill_repo,
    skills::{
        self, compose_extra_system_sections, default_roots, find_skill, SkillRoots, SkillSummary,
    },
    state::AppState,
};
use tauri::State;

fn roots_from_state(state: &AppState, workspace_root: Option<&str>) -> SkillRoots {
    default_roots(
        &state.paths.root,
        &state.paths.branding,
        workspace_root
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(std::path::Path::new),
    )
}

fn ensure_conduit_skills(state: &AppState) -> Result<PathBuf, String> {
    let dir = skills::conduit_skills_dir(&state.paths.root);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
pub fn list_skills(
    state: State<'_, AppState>,
    workspace_root: Option<String>,
) -> Result<Vec<SkillSummary>, String> {
    Ok(skills::discover_skills(&roots_from_state(
        &state,
        workspace_root.as_deref(),
    )))
}

#[tauri::command]
pub fn get_skill_prompt_block(
    state: State<'_, AppState>,
    skill_ids: Vec<String>,
    workspace_root: Option<String>,
) -> Result<String, String> {
    Ok(compose_extra_system_sections(
        &roots_from_state(&state, workspace_root.as_deref()),
        &skill_ids,
    ))
}

#[tauri::command]
pub async fn list_conversation_skills(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<String>, String> {
    skill_repo::list_enabled(&state.db, &conversation_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_conversation_skills(
    state: State<'_, AppState>,
    conversation_id: String,
    skill_ids: Vec<String>,
) -> Result<Vec<String>, String> {
    skill_repo::set_enabled(&state.db, &conversation_id, &skill_ids)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn import_skill_folder(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<SkillSummary>, String> {
    let Some(src) = pick_folder(&app, "Import skill folder").await? else {
        return Ok(None);
    };
    let dest = ensure_conduit_skills(&state)?;
    skills::import_skill_dir(&dest, &src).map(Some)
}

#[tauri::command]
pub async fn import_skill_zip(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<SkillSummary>, String> {
    let Some(src) = pick_zip(&app, "Import skill zip").await? else {
        return Ok(None);
    };
    let dest = ensure_conduit_skills(&state)?;
    skills::import_skill_zip(&dest, &src).map(Some)
}

#[tauri::command]
pub async fn export_skill_folder(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    skill_id: String,
    workspace_root: Option<String>,
) -> Result<Option<String>, String> {
    let listed = skills::discover_skills(&roots_from_state(&state, workspace_root.as_deref()));
    let summary = find_skill(&listed, &skill_id)
        .cloned()
        .ok_or_else(|| format!("unknown skill {skill_id}"))?;
    let Some(parent) = pick_folder(&app, "Export skill to folder").await? else {
        return Ok(None);
    };
    let dest = skills::export_skill_dir(&summary, &parent)?;
    Ok(Some(dest.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn export_skill_zip(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    skill_id: String,
    workspace_root: Option<String>,
) -> Result<Option<String>, String> {
    let listed = skills::discover_skills(&roots_from_state(&state, workspace_root.as_deref()));
    let summary = find_skill(&listed, &skill_id)
        .cloned()
        .ok_or_else(|| format!("unknown skill {skill_id}"))?;
    let suggested = format!("{}.zip", summary.name);
    let Some(path) = pick_save_zip(&app, "Export skill zip", &suggested).await? else {
        return Ok(None);
    };
    let dest = skills::export_skill_zip(&summary, &path)?;
    Ok(Some(dest.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn delete_managed_skill(state: State<'_, AppState>, skill_id: String) -> Result<(), String> {
    let dest = ensure_conduit_skills(&state)?;
    skills::delete_managed_skill(&dest, &skill_id)
}

#[tauri::command]
#[allow(deprecated)]
pub fn reveal_skills_dir(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    use tauri_plugin_shell::ShellExt;
    let dir = ensure_conduit_skills(&state)?;
    app.shell()
        .open(dir.to_string_lossy(), None)
        .map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

async fn pick_folder(app: &tauri::AppHandle, title: &str) -> Result<Option<PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(title)
        .pick_folder(move |folder| {
            let _ = tx.send(folder);
        });
    let picked = rx
        .await
        .map_err(|_| "the folder dialog closed without a response".to_string())?;
    picked
        .map(|file_path| {
            file_path
                .into_path()
                .map_err(|err| format!("failed to resolve the picked folder path: {err}"))
        })
        .transpose()
}

async fn pick_zip(app: &tauri::AppHandle, title: &str) -> Result<Option<PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Skill zip", &["zip"])
        .set_title(title)
        .pick_file(move |file_path| {
            let _ = tx.send(file_path);
        });
    resolve_picked_path(rx).await
}

async fn pick_save_zip(
    app: &tauri::AppHandle,
    title: &str,
    suggested: &str,
) -> Result<Option<PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Skill zip", &["zip"])
        .set_file_name(suggested)
        .set_title(title)
        .save_file(move |file_path| {
            let _ = tx.send(file_path);
        });
    resolve_picked_path(rx).await
}

async fn resolve_picked_path(
    rx: tokio::sync::oneshot::Receiver<Option<tauri_plugin_dialog::FilePath>>,
) -> Result<Option<PathBuf>, String> {
    let picked = rx
        .await
        .map_err(|_| "the file dialog closed without a response".to_string())?;
    picked
        .map(|file_path| {
            file_path
                .into_path()
                .map_err(|err| format!("failed to resolve the picked file path: {err}"))
        })
        .transpose()
}
