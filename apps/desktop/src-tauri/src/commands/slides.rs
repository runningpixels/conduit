//! Slides: list, create, open, edit and restore decks. A deck is bound to the
//! chat that builds it; the deck tools run against that chat (see
//! `agent_tools`).

use provider_core::schema::{
    ConversationSummary, DeckDetail, DeckReplaceResult, DeckSnapshotCause, DeckSnapshotSummary,
    DeckStage, DeckSummary, SlideTheme, SlotEdit, StorylineItem,
};
use tauri::State;

use crate::{
    db::repository::{
        conversations,
        slides::{self, user_message as message},
    },
    slides_export,
    state::AppState,
};

#[tauri::command]
pub async fn list_decks(state: State<'_, AppState>) -> Result<Vec<DeckSummary>, String> {
    slides::list(&state.db).await.map_err(message)
}

/// The presenter view's window label (also listed in capabilities/default.json).
pub const PRESENTER_WINDOW: &str = "presenter";

/// Open the presenter view for a deck, or focus it when it is already open.
/// Built here rather than from the page so it gets the main webview's browser
/// arguments (see `webview_args::MainWebviewArgs`); a page-created window
/// fails on Windows with a mismatched WebView2 environment. `x`/`y` place it
/// (logical pixels), else it is centred.
#[tauri::command]
pub async fn open_presenter_window(
    app: tauri::AppHandle,
    args: State<'_, crate::webview_args::MainWebviewArgs>,
    deck_id: String,
    title: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    use tauri::Manager;
    if let Some(existing) = app.get_webview_window(PRESENTER_WINDOW) {
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    // The id goes into the window URL: accept only what a deck id can be.
    if deck_id.is_empty()
        || deck_id.len() > 64
        || !deck_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("That deck id isn't valid.".to_string());
    }
    let title: String = title.chars().take(200).collect();
    let url = tauri::WebviewUrl::App(format!("index.html?presenter={deck_id}").into());
    let mut builder = tauri::WebviewWindowBuilder::new(&app, PRESENTER_WINDOW, url)
        .title(title)
        .inner_size(1100.0, 700.0)
        .decorations(true)
        .focused(true)
        .additional_browser_args(&args.0);
    builder = match (x, y) {
        (Some(x), Some(y)) if x.is_finite() && y.is_finite() => builder.position(x, y),
        _ => builder.center(),
    };
    let _window = builder.build().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    crate::webview_args::disable_webrtc(&_window).map_err(|e| e.to_string())?;
    Ok(())
}

/// Save a deck as one self-contained HTML file through the native save dialog.
/// `Ok(None)` means the user cancelled. The renderer builds the document and
/// never supplies a path (ADR-008); dialog strings arrive translated (D15).
#[tauri::command]
pub async fn export_deck_html(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    deck_id: String,
    html: String,
    dialog_title: String,
    filter_name: String,
) -> Result<Option<String>, String> {
    slides_export::check_size(&html)?;
    let deck = get_deck_detail(&state, &deck_id).await?;
    let picked = pick_deck_save_path(
        &app,
        "html",
        &dialog_title,
        &filter_name,
        &slides_export::suggested_file_name(&deck.title, "html"),
    )
    .await?;
    export_deck_html_impl(picked, &html)
}

/// Post-picker half of [`export_deck_html`], split out so cancel vs write can
/// be tested without the OS dialog.
#[doc(hidden)]
pub fn export_deck_html_impl(
    picked: Option<std::path::PathBuf>,
    html: &str,
) -> Result<Option<String>, String> {
    let Some(path) = picked else {
        return Ok(None);
    };
    slides_export::write_html(&path, html)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Save a deck as a PDF, one 1920x1080 page per slide, through the native save
/// dialog. `html` is the print document. Windows prints it with a hidden
/// webview on the artifact origin; other platforms say it is not available yet.
#[tauri::command]
pub async fn export_deck_pdf(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    args: State<'_, crate::webview_args::MainWebviewArgs>,
    deck_id: String,
    html: String,
    dialog_title: String,
    filter_name: String,
) -> Result<Option<String>, String> {
    #[cfg(not(windows))]
    {
        let _ = (
            &app,
            &state,
            &args,
            &deck_id,
            &html,
            &dialog_title,
            &filter_name,
        );
        Err(slides_export::PDF_UNAVAILABLE.to_string())
    }
    #[cfg(windows)]
    {
        slides_export::check_size(&html)?;
        let deck = get_deck_detail(&state, &deck_id).await?;
        let picked = pick_deck_save_path(
            &app,
            "pdf",
            &dialog_title,
            &filter_name,
            &slides_export::suggested_file_name(&deck.title, "pdf"),
        )
        .await?;
        let Some(path) = picked else {
            return Ok(None);
        };
        slides_export::print_pdf(&app, &args.0, html, &path).await?;
        Ok(Some(path.to_string_lossy().into_owned()))
    }
}

/// The native save dialog; `Ok(None)` when the user cancels.
async fn pick_deck_save_path(
    app: &tauri::AppHandle,
    extension: &str,
    dialog_title: &str,
    filter_name: &str,
    suggested_filename: &str,
) -> Result<Option<std::path::PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter(filter_name, &[extension])
        .set_file_name(suggested_filename)
        .set_title(dialog_title)
        .save_file(move |file_path| {
            let _ = tx.send(file_path);
        });
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

/// Saved custom themes, most recently used first (built-in themes excluded).
#[tauri::command]
pub async fn list_slide_themes(state: State<'_, AppState>) -> Result<Vec<SlideTheme>, String> {
    slides::list_themes(&state.db, &state.encryption)
        .await
        .map_err(message)
}

#[tauri::command]
pub async fn delete_slide_theme(state: State<'_, AppState>, name: String) -> Result<(), String> {
    slides::delete_theme(&state.db, &name)
        .await
        .map_err(message)
}

/// Create a deck with its own chat (titled like the deck) and a `created`
/// snapshot.
#[tauri::command]
pub async fn create_deck(
    state: State<'_, AppState>,
    title: String,
    theme_name: String,
    theme_css: String,
) -> Result<DeckDetail, String> {
    let title = slides::validate_title(&title).map_err(message)?;
    let conversation = conversations::create(&state.db, Some(&title))
        .await
        .map_err(message)?;
    let deck = match slides::create(
        &state.db,
        &state.encryption,
        &title,
        &theme_name,
        &theme_css,
        Some(&conversation.id),
    )
    .await
    {
        Ok(deck) => deck,
        Err(error) => {
            let _ = conversations::delete(&state.db, &conversation.id).await;
            return Err(message(error));
        }
    };
    slides::snapshot(
        &state.db,
        &state.encryption,
        &deck.id,
        DeckSnapshotCause::Created,
        &title,
    )
    .await
    .map_err(message)?;
    Ok(deck)
}

/// Undo a deck started from a chat: deletes the deck, keeps the chat (an
/// ordinary chat again) and returns it. Only while the deck has no slides.
#[tauri::command]
pub async fn undo_start_deck(
    state: State<'_, AppState>,
    deck_id: String,
) -> Result<Option<ConversationSummary>, String> {
    let conversation_id = slides::undo_start(&state.db, &deck_id)
        .await
        .map_err(message)?;
    match conversation_id {
        Some(id) => conversations::get_summary(&state.db, &id)
            .await
            .map_err(message),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn get_deck(state: State<'_, AppState>, id: String) -> Result<DeckDetail, String> {
    slides::get(&state.db, &state.encryption, &id)
        .await
        .map_err(message)?
        .ok_or_else(|| "That deck no longer exists.".to_string())
}

#[tauri::command]
pub async fn get_deck_for_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Option<DeckDetail>, String> {
    slides::get_by_conversation(&state.db, &state.encryption, &conversation_id)
        .await
        .map_err(message)
}

/// Open a deck: stamps when it was opened and, when its chat is gone, starts a
/// new one and binds it.
#[tauri::command]
pub async fn open_deck(state: State<'_, AppState>, id: String) -> Result<DeckDetail, String> {
    let deck = slides::get(&state.db, &state.encryption, &id)
        .await
        .map_err(message)?
        .ok_or_else(|| "That deck no longer exists.".to_string())?;
    slides::mark_opened(&state.db, &id).await.map_err(message)?;
    if deck.conversation_id.is_none() {
        let conversation = conversations::create(&state.db, Some(&deck.title))
            .await
            .map_err(message)?;
        slides::bind_conversation(&state.db, &id, &conversation.id)
            .await
            .map_err(message)?;
    }
    get_deck_detail(&state, &id).await
}

async fn get_deck_detail(state: &AppState, id: &str) -> Result<DeckDetail, String> {
    slides::get(&state.db, &state.encryption, id)
        .await
        .map_err(message)?
        .ok_or_else(|| "That deck no longer exists.".to_string())
}

#[tauri::command]
pub async fn rename_deck(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> Result<(), String> {
    let deck = get_deck_detail(&state, &id).await?;
    let title = slides::rename(&state.db, &id, &title)
        .await
        .map_err(message)?;
    if let Some(conversation_id) = deck.conversation_id {
        conversations::set_title(&state.db, &conversation_id, &title)
            .await
            .map_err(message)?;
    }
    Ok(())
}

/// Delete a deck and the chat bound to it.
#[tauri::command]
pub async fn delete_deck(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conversation_id = slides::delete(&state.db, &id).await.map_err(message)?;
    if let Some(conversation_id) = conversation_id {
        conversations::delete_with_files(
            &state.db,
            &state.paths.artifacts,
            &state.paths.attachments,
            &conversation_id,
        )
        .await
        .map_err(message)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_deck_storyline(
    state: State<'_, AppState>,
    id: String,
    storyline: Vec<StorylineItem>,
) -> Result<DeckDetail, String> {
    slides::set_storyline(&state.db, &state.encryption, &id, storyline)
        .await
        .map_err(message)
}

#[tauri::command]
pub async fn set_deck_stage(
    state: State<'_, AppState>,
    id: String,
    stage: DeckStage,
) -> Result<DeckDetail, String> {
    slides::set_stage(&state.db, &state.encryption, &id, stage)
        .await
        .map_err(message)
}

#[tauri::command]
pub async fn set_deck_theme(
    state: State<'_, AppState>,
    id: String,
    theme_name: String,
    theme_css: String,
) -> Result<DeckDetail, String> {
    slides::set_theme(&state.db, &state.encryption, &id, &theme_name, &theme_css)
        .await
        .map_err(message)
}

/// The user's edits of a slide's words: each edited slot is set and pinned;
/// the speaker notes are replaced when given.
#[tauri::command]
pub async fn edit_slide_words(
    state: State<'_, AppState>,
    deck_id: String,
    slide_id: String,
    edits: Vec<SlotEdit>,
    notes: Option<String>,
) -> Result<DeckDetail, String> {
    slides::edit_slide_words(
        &state.db,
        &state.encryption,
        &deck_id,
        &slide_id,
        &edits,
        notes.as_deref(),
    )
    .await
    .map_err(message)
}

/// Pin ("Yours") or unpin ("Let AI edit") one slot.
#[tauri::command]
pub async fn set_slot_pinned(
    state: State<'_, AppState>,
    deck_id: String,
    slide_id: String,
    index: u32,
    name: String,
    pinned: bool,
) -> Result<DeckDetail, String> {
    slides::set_slot_pinned(
        &state.db,
        &state.encryption,
        &deck_id,
        &slide_id,
        index as usize,
        &name,
        pinned,
    )
    .await
    .map_err(message)
}

/// Add an empty bullet after the given bullet slot.
#[tauri::command]
pub async fn insert_bullet(
    state: State<'_, AppState>,
    deck_id: String,
    slide_id: String,
    index: u32,
    name: String,
) -> Result<DeckDetail, String> {
    slides::insert_bullet(
        &state.db,
        &state.encryption,
        &deck_id,
        &slide_id,
        index as usize,
        &name,
    )
    .await
    .map_err(message)
}

/// Remove the given bullet slot from its list.
#[tauri::command]
pub async fn remove_bullet(
    state: State<'_, AppState>,
    deck_id: String,
    slide_id: String,
    index: u32,
    name: String,
) -> Result<DeckDetail, String> {
    slides::remove_bullet(
        &state.db,
        &state.encryption,
        &deck_id,
        &slide_id,
        index as usize,
        &name,
    )
    .await
    .map_err(message)
}

/// Find and replace across the deck's text and speaker notes. `apply = false`
/// is a dry run that only counts.
#[tauri::command]
pub async fn replace_in_deck(
    state: State<'_, AppState>,
    deck_id: String,
    find: String,
    replace: String,
    match_case: bool,
    whole_word: bool,
    apply: bool,
) -> Result<DeckReplaceResult, String> {
    slides::replace_in_deck(
        &state.db,
        &state.encryption,
        &deck_id,
        &find,
        &replace,
        match_case,
        whole_word,
        apply,
    )
    .await
    .map(|report| report.result)
    .map_err(message)
}

#[tauri::command]
pub async fn list_deck_snapshots(
    state: State<'_, AppState>,
    deck_id: String,
) -> Result<Vec<DeckSnapshotSummary>, String> {
    slides::list_snapshots(&state.db, &deck_id)
        .await
        .map_err(message)
}

/// Record the deck's current state in its history; `null` when nothing changed
/// since the newest entry.
#[tauri::command]
pub async fn snapshot_deck(
    state: State<'_, AppState>,
    deck_id: String,
    cause: DeckSnapshotCause,
    label: String,
) -> Result<Option<DeckSnapshotSummary>, String> {
    slides::snapshot(&state.db, &state.encryption, &deck_id, cause, &label)
        .await
        .map_err(message)
}

#[tauri::command]
pub async fn restore_deck_snapshot(
    state: State<'_, AppState>,
    deck_id: String,
    snapshot_id: String,
) -> Result<DeckDetail, String> {
    let restored = slides::restore_snapshot(&state.db, &state.encryption, &deck_id, &snapshot_id)
        .await
        .map_err(message)?;
    // The chat carries the deck's title; keep it in step with the restored one.
    if let Some(conversation_id) = &restored.conversation_id {
        conversations::set_title(&state.db, conversation_id, &restored.title)
            .await
            .map_err(message)?;
    }
    Ok(restored)
}
