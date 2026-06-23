use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    pub root: PathBuf,
    pub settings_file: PathBuf,
    pub database: PathBuf,
    pub attachments: PathBuf,
    pub artifacts: PathBuf,
    pub logs: PathBuf,
    pub diagnostics: PathBuf,
    pub updates: PathBuf,
    pub streams: PathBuf,
    /// Phase 4: per-connector working dirs / captured logs.
    pub connectors: PathBuf,
}

pub fn resolve(app_name: &str) -> Result<AppPaths, String> {
    let project = ProjectDirs::from("com", "Conduit", app_name)
        .ok_or_else(|| "unable to resolve application data directory".to_string())?;

    let root = project.data_local_dir().to_path_buf();
    let settings_file = root.join("settings.json");
    let database = root.join("conduit.sqlite");
    let attachments = root.join("attachments");
    let artifacts = root.join("artifacts");
    let logs = root.join("logs");
    let diagnostics = root.join("diagnostics");
    let updates = root.join("updates");
    let streams = root.join("streams");
    let connectors = root.join("connectors");

    for path in [
        &root,
        &attachments,
        &artifacts,
        &logs,
        &diagnostics,
        &updates,
        &streams,
        &connectors,
    ] {
        fs::create_dir_all(path).map_err(|error| error.to_string())?;
    }

    Ok(AppPaths {
        root,
        settings_file,
        database,
        attachments,
        artifacts,
        logs,
        diagnostics,
        updates,
        streams,
        connectors,
    })
}
