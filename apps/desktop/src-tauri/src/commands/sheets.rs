//! Spreadsheet commands: the computed view the panel draws, and Save as Excel.

use provider_core::schema::LanguageSetting;
use serde::Serialize;
use tauri::State;

use crate::{
    db::repository::artifacts::{self, Artifact},
    sheets::{self, compute, spec::Workbook, xlsx, SpreadsheetView},
    slides_export,
    state::AppState,
};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetExportResult {
    pub saved: bool,
    pub path: Option<String>,
}

/// The stored spec of a spreadsheet artifact.
async fn load_spreadsheet(
    state: &AppState,
    artifact_id: &str,
) -> Result<(Artifact, Workbook), String> {
    let artifact = artifacts::get(&state.db, &state.encryption, artifact_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That spreadsheet no longer exists.".to_string())?;
    let workbook = sheets::workbook_of(&artifact)?;
    Ok((artifact, workbook))
}

/// Load, calculate and describe a spreadsheet for the panel: sheets, cells
/// formatted as Excel shows them, and the first formulas that errored.
#[tauri::command]
pub async fn get_spreadsheet_view(
    state: State<'_, AppState>,
    artifact_id: String,
) -> Result<SpreadsheetView, String> {
    let (artifact, workbook) = load_spreadsheet(&state, &artifact_id).await?;
    // Numbers read as the user writes them: 6.000,00 € in German.
    let language = match state.settings()?.language {
        LanguageSetting::De => "de",
        LanguageSetting::Es => "es",
        LanguageSetting::Fr => "fr",
        LanguageSetting::PtBr => "pt-BR",
        _ => "en",
    };
    let computed = compute::compute_in(&workbook, compute::number_locale(language))?;
    Ok(sheets::build_view(artifact.title, &computed))
}

/// Save a spreadsheet as an .xlsx file through the native save dialog.
/// `saved: false` means the user cancelled. The renderer never supplies a path
/// (ADR-008); the dialog strings are optional so the panel can pass translated
/// ones (D15).
#[tauri::command]
pub async fn export_spreadsheet_xlsx(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    artifact_id: String,
    dialog_title: Option<String>,
    filter_name: Option<String>,
) -> Result<SpreadsheetExportResult, String> {
    let (artifact, workbook) = load_spreadsheet(&state, &artifact_id).await?;
    let bytes = xlsx::write_xlsx(&workbook)?;
    let suggested = slides_export::suggested_file_name(
        artifact.title.as_deref().unwrap_or("spreadsheet"),
        "xlsx",
    );
    let picked = super::slides::pick_deck_save_path(
        &app,
        "xlsx",
        dialog_title.as_deref().unwrap_or("Save spreadsheet"),
        filter_name.as_deref().unwrap_or("Excel workbook"),
        &suggested,
    )
    .await?;
    save_xlsx_impl(picked, &bytes).await
}

/// Post-picker half of [`export_spreadsheet_xlsx`], split out so cancel vs
/// write can be tested without the OS dialog.
pub async fn save_xlsx_impl(
    picked: Option<std::path::PathBuf>,
    bytes: &[u8],
) -> Result<SpreadsheetExportResult, String> {
    let Some(path) = picked else {
        return Ok(SpreadsheetExportResult {
            saved: false,
            path: None,
        });
    };
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| format!("could not save {}: {e}", path.display()))?;
    Ok(SpreadsheetExportResult {
        saved: true,
        path: Some(path.to_string_lossy().into_owned()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelling_the_dialog_saves_nothing() {
        let r = save_xlsx_impl(None, b"x").await.unwrap();
        assert_eq!(
            r,
            SpreadsheetExportResult {
                saved: false,
                path: None
            }
        );
    }

    #[tokio::test]
    async fn a_picked_path_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.xlsx");
        let r = save_xlsx_impl(Some(path.clone()), b"PKdata").await.unwrap();
        assert!(r.saved);
        assert_eq!(r.path.as_deref(), path.to_str());
        assert_eq!(std::fs::read(&path).unwrap(), b"PKdata");
    }
}
