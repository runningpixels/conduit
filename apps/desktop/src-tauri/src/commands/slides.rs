//! Slides: list, create, open, edit and restore decks. A deck is bound to the
//! chat that builds it; the deck tools run against that chat (see
//! `agent_tools`).

use provider_core::schema::{
    DeckDetail, DeckSnapshotCause, DeckSnapshotSummary, DeckStage, DeckSummary, SlideTheme,
    StorylineItem,
};
use tauri::State;

use crate::{
    db::repository::{
        conversations,
        slides::{self, user_message as message},
    },
    state::AppState,
};

#[tauri::command]
pub async fn list_decks(state: State<'_, AppState>) -> Result<Vec<DeckSummary>, String> {
    slides::list(&state.db).await.map_err(message)
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
