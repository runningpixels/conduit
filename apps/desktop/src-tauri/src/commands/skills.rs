//! Agent Skills IPC (t1-4) — discovery, import/export, per-chat enablement.

use std::path::PathBuf;

use crate::{
    db::repository::skills as skill_repo,
    skill_draft::{self, SkillDraft},
    skills::{
        self, compose_extra_system_sections, default_roots, find_skill, SkillRoots, SkillSummary,
    },
    state::AppState,
    stream_manager::StreamManager,
};
use provider_core::schema::AppError;
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

/// The renderer's code for "a skill of that name exists": it asks the user
/// whether to replace it and tries again with `replace`.
pub const SKILL_EXISTS_CODE: &str = "error.skills.exists";

/// An import's error, with the name-conflict case given its own code.
fn import_error(error: String) -> AppError {
    match skills::exists_error_name(&error) {
        Some(name) => AppError::new(
            SKILL_EXISTS_CODE,
            format!("A skill named \"{name}\" already exists."),
        )
        .with("name", name),
        None => AppError::from(error),
    }
}

#[tauri::command]
pub async fn import_skill_folder(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    dialog_title: String,
) -> Result<Option<SkillSummary>, AppError> {
    let Some(src) = pick_folder(&app, &dialog_title).await? else {
        return Ok(None);
    };
    let dest = ensure_conduit_skills(&state)?;
    skills::import_skill_dir(&dest, &src)
        .map(Some)
        .map_err(import_error)
}

#[tauri::command]
pub async fn import_skill_zip(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    dialog_title: String,
    filter_name: String,
) -> Result<Option<SkillSummary>, AppError> {
    let Some(src) = pick_zip(&app, &dialog_title, &filter_name).await? else {
        return Ok(None);
    };
    let dest = ensure_conduit_skills(&state)?;
    skills::import_skill_zip(&dest, &src)
        .map(Some)
        .map_err(import_error)
}

/// Import a skill from a GitHub link (a repository, or a folder in one). The
/// repository's archive is downloaded from codeload.github.com through the
/// same guarded client artifacts use (https only, public addresses only,
/// redirects re-checked, 20 MB cap), and only the linked folder is extracted.
/// Scripts in the skill are never run.
#[tauri::command]
pub async fn import_skill_git(
    state: State<'_, AppState>,
    url: String,
    replace: bool,
) -> Result<SkillSummary, AppError> {
    let source = skills::parse_github_skill_url(&url)?;
    let zip = download_github_zip(&source).await?;
    let dest = ensure_conduit_skills(&state)?;
    skills::import_skill_github_zip(&dest, &zip, &source, replace).map_err(import_error)
}

async fn download_github_zip(source: &skills::GitHubSkillSource) -> Result<Vec<u8>, String> {
    use crate::artifact_network::{
        perform_capped, AddressPolicy, ArtifactFetchRequest, MAX_DOCUMENT_RESPONSE_BYTES,
        REDIRECT_ERROR_PREFIX,
    };
    use base64::{engine::general_purpose::STANDARD, Engine};
    let request = ArtifactFetchRequest {
        principal: "skills:github".to_string(),
        url: source.zip_url(),
        method: "GET".to_string(),
        headers: Vec::new(),
        body: None,
    };
    let allowed =
        |origin: &str| origin == "https://github.com" || origin == "https://codeload.github.com";
    let response = perform_capped(
        &request,
        AddressPolicy::APP,
        &allowed,
        MAX_DOCUMENT_RESPONSE_BYTES,
    )
    .await
    .map_err(|e| {
        if e.starts_with(REDIRECT_ERROR_PREFIX) {
            "GitHub sent the download somewhere else, so it was stopped.".to_string()
        } else {
            e
        }
    })?;
    match response.status {
        200 => STANDARD
            .decode(response.body)
            .map_err(|_| "The download from GitHub could not be read.".to_string()),
        404 => Err(format!(
            "GitHub has no public repository or branch at {}/{} ({}). Private repositories can't be imported.",
            source.owner, source.repo, source.git_ref
        )),
        status => Err(format!("GitHub answered {status}; try again later.")),
    }
}

/// Draft a skill from what happened in a chat with the active model. Nothing
/// is saved; the dialog shows the draft for the user to edit. Waits for the
/// model (up to 90 seconds); `cancel_skill_draft` stops it.
#[tauri::command]
pub async fn draft_skill_from_chat(
    state: State<'_, AppState>,
    streams: State<'_, StreamManager>,
    conversation_id: String,
) -> Result<SkillDraft, String> {
    skill_draft::draft_from_chat(&state, &streams, &conversation_id).await
}

/// Stop the skill draft in progress; `false` when none was running.
#[tauri::command]
pub fn cancel_skill_draft() -> bool {
    skill_draft::cancel_current()
}

/// Save a (possibly edited) draft as a skill in the managed folder and turn
/// it on for `conversation_id`. A name that exists is an
/// `error.skills.exists` error unless `replace` is set.
#[tauri::command]
pub async fn save_skill_draft(
    state: State<'_, AppState>,
    name: String,
    description: String,
    body: String,
    replace: bool,
    conversation_id: Option<String>,
) -> Result<SkillSummary, AppError> {
    let dest = ensure_conduit_skills(&state)?;
    let draft = SkillDraft {
        name,
        description,
        body,
    };
    skill_draft::save(
        &state.db,
        &dest,
        &draft,
        replace,
        conversation_id.as_deref(),
    )
    .await
    .map_err(import_error)
}

#[tauri::command]
pub async fn export_skill_folder(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    skill_id: String,
    workspace_root: Option<String>,
    dialog_title: String,
) -> Result<Option<String>, String> {
    let listed = skills::discover_skills(&roots_from_state(&state, workspace_root.as_deref()));
    let summary = find_skill(&listed, &skill_id)
        .cloned()
        .ok_or_else(|| format!("unknown skill {skill_id}"))?;
    let Some(parent) = pick_folder(&app, &dialog_title).await? else {
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
    dialog_title: String,
    filter_name: String,
) -> Result<Option<String>, String> {
    let listed = skills::discover_skills(&roots_from_state(&state, workspace_root.as_deref()));
    let summary = find_skill(&listed, &skill_id)
        .cloned()
        .ok_or_else(|| format!("unknown skill {skill_id}"))?;
    let suggested = format!("{}.zip", summary.name);
    let Some(path) = pick_save_zip(&app, &dialog_title, &filter_name, &suggested).await? else {
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

async fn pick_zip(
    app: &tauri::AppHandle,
    title: &str,
    filter_name: &str,
) -> Result<Option<PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter(filter_name, &["zip"])
        .set_title(title)
        .pick_file(move |file_path| {
            let _ = tx.send(file_path);
        });
    resolve_picked_path(rx).await
}

async fn pick_save_zip(
    app: &tauri::AppHandle,
    title: &str,
    filter_name: &str,
    suggested: &str,
) -> Result<Option<PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter(filter_name, &["zip"])
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
