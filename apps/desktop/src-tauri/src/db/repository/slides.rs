//! Slides: a deck is an ordered list of slides plus a theme and a storyline,
//! bound to the chat that builds it.
//!
//! Deleting the chat leaves the deck (the binding goes null); opening the deck
//! again binds a new chat. The theme, storyline, slide pages and snapshot
//! payloads are encrypted like artifact content. Slide positions are dense
//! `0..n-1` and renumbered inside the same transaction as any add, move or
//! delete.

use std::collections::HashSet;

use provider_core::schema::{
    DeckDetail, DeckSlide, DeckSnapshotCause, DeckSnapshotSummary, DeckStage, DeckSummary,
    StorylineItem,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::{db::DbError, encryption::Encryption, time::now_iso8601};

pub const MAX_TITLE_CHARS: usize = 120;
pub const MAX_THEME_NAME_CHARS: usize = 80;
pub const MAX_THEME_CSS_CHARS: usize = 100_000;
pub const MAX_SLIDE_HTML_CHARS: usize = 60_000;
pub const MAX_NOTES_CHARS: usize = 10_000;
pub const MAX_STORYLINE_ITEMS: usize = 60;
pub const MAX_STORYLINE_ITEM_CHARS: usize = 300;
pub const MAX_SLIDES: usize = 80;
pub const MAX_SNAPSHOTS: i64 = 200;
pub const MAX_SNAPSHOT_LABEL_CHARS: usize = 120;

const SCRIPTS_ERROR: &str = "Slides can't contain scripts. Draw charts as inline SVG.";

fn invalid(msg: impl Into<String>) -> DbError {
    DbError::Query(msg.into())
}

/// A repository error as the plain sentence to show the user or the model.
pub fn user_message(error: DbError) -> String {
    match error {
        DbError::Query(text) => text,
        other => other.to_string(),
    }
}

fn no_deck() -> DbError {
    invalid("That deck no longer exists.")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// Trim and check a deck title.
pub fn validate_title(title: &str) -> Result<String, DbError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(invalid("A deck needs a title."));
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(invalid(format!(
            "Keep the title under {MAX_TITLE_CHARS} characters."
        )));
    }
    Ok(title.to_string())
}

fn validate_theme(name: &str, css: &str) -> Result<String, DbError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(invalid("A theme needs a name."));
    }
    if name.chars().count() > MAX_THEME_NAME_CHARS {
        return Err(invalid(format!(
            "Keep the theme name under {MAX_THEME_NAME_CHARS} characters."
        )));
    }
    if css.chars().count() > MAX_THEME_CSS_CHARS {
        return Err(invalid(format!(
            "The theme CSS is too long ({MAX_THEME_CSS_CHARS} characters at most)."
        )));
    }
    Ok(name.to_string())
}

/// A layout name: a lowercase word, digits and hyphens, at most 32 characters
/// (`^[a-z][a-z0-9-]{0,31}$`).
pub fn validate_layout(layout: &str) -> Result<(), DbError> {
    let mut chars = layout.chars();
    let ok = chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && layout.len() <= 32
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(invalid(
            "A layout name is lowercase letters, digits and hyphens, starting with a letter (32 characters at most).",
        ))
    }
}

/// Reject slide HTML that is too long or contains a script tag.
pub fn validate_slide_html(html: &str) -> Result<(), DbError> {
    if html.chars().count() > MAX_SLIDE_HTML_CHARS {
        return Err(invalid(format!(
            "This slide is too long ({MAX_SLIDE_HTML_CHARS} characters of HTML at most)."
        )));
    }
    if html.to_ascii_lowercase().contains("<script") {
        return Err(invalid(SCRIPTS_ERROR));
    }
    Ok(())
}

fn validate_notes(notes: &str) -> Result<(), DbError> {
    if notes.chars().count() > MAX_NOTES_CHARS {
        return Err(invalid(format!(
            "Speaker notes are too long ({MAX_NOTES_CHARS} characters at most)."
        )));
    }
    Ok(())
}

/// Check the storyline's size and give every item a unique id: ids are kept,
/// blank or repeated ones get a fresh uuid.
fn normalize_storyline(items: Vec<StorylineItem>) -> Result<Vec<StorylineItem>, DbError> {
    if items.len() > MAX_STORYLINE_ITEMS {
        return Err(invalid(format!(
            "A storyline can have {MAX_STORYLINE_ITEMS} lines at most."
        )));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        if item.text.chars().count() > MAX_STORYLINE_ITEM_CHARS {
            return Err(invalid(format!(
                "Keep each storyline line under {MAX_STORYLINE_ITEM_CHARS} characters."
            )));
        }
        let id = if item.id.trim().is_empty() || !seen.insert(item.id.clone()) {
            let fresh = Uuid::new_v4().to_string();
            seen.insert(fresh.clone());
            fresh
        } else {
            item.id
        };
        out.push(StorylineItem {
            id,
            text: item.text,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Visible text
// ---------------------------------------------------------------------------

/// The text a viewer sees in a slide's HTML: tags stripped (their contents
/// kept, `<style>` contents dropped), the common entities decoded, whitespace
/// collapsed to single spaces.
pub fn slide_visible_text(html: &str) -> String {
    let mut text = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(lt) = rest.find('<') {
        text.push_str(&rest[..lt]);
        let after = &rest[lt + 1..];
        let starts_tag = after
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '/' || c == '!');
        if !starts_tag {
            text.push('<');
            rest = after;
            continue;
        }
        let tag_end = after.find('>').map_or(after.len(), |i| i + 1);
        let tag = &after[..tag_end];
        text.push(' ');
        rest = &after[tag_end..];
        let is_style_open = tag.len() >= 5
            && tag.is_char_boundary(5)
            && tag[..5].eq_ignore_ascii_case("style")
            && tag[5..]
                .chars()
                .next()
                .is_none_or(|c| c == '>' || c.is_whitespace() || c == '/');
        if is_style_open {
            let lower = rest.to_ascii_lowercase();
            rest = match lower.find("</style") {
                Some(i) => &rest[i..],
                None => "",
            };
        }
    }
    text.push_str(rest);
    let decoded = text
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type DeckRow = (
    String,
    String,
    Option<String>,
    String,
    String,
    String,
    String,
    String,
    String,
);

const DECK_COLUMNS: &str = "id, title, conversation_id, theme_name, theme_css, stage, \
     storyline_json, created_at, updated_at";

type SlideRow = (String, i64, String, String, String);

fn slide_from_row(enc: &Encryption, row: SlideRow) -> Result<DeckSlide, DbError> {
    let (id, position, layout, html, notes) = row;
    Ok(DeckSlide {
        id,
        position: u32::try_from(position).unwrap_or(0),
        layout,
        html: enc.decrypt(&html)?,
        notes: enc.decrypt(&notes)?,
    })
}

fn parse_stage(stage: &str) -> DeckStage {
    DeckStage::parse(stage).unwrap_or(DeckStage::Storyline)
}

fn decode_storyline(enc: &Encryption, stored: &str) -> Result<Vec<StorylineItem>, DbError> {
    serde_json::from_str(&enc.decrypt(stored)?)
        .map_err(|e| invalid(format!("decode storyline: {e}")))
}

fn encode_storyline(enc: &Encryption, items: &[StorylineItem]) -> Result<String, DbError> {
    let json =
        serde_json::to_string(items).map_err(|e| invalid(format!("encode storyline: {e}")))?;
    enc.encrypt(&json)
}

async fn list_slides(
    pool: &SqlitePool,
    enc: &Encryption,
    deck_id: &str,
) -> Result<Vec<DeckSlide>, DbError> {
    let rows: Vec<SlideRow> = sqlx::query_as(
        "SELECT id, position, layout, html, notes FROM deck_slides \
         WHERE deck_id = ? ORDER BY position",
    )
    .bind(deck_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(|r| slide_from_row(enc, r)).collect()
}

async fn detail_from_row(
    pool: &SqlitePool,
    enc: &Encryption,
    row: DeckRow,
) -> Result<DeckDetail, DbError> {
    let (
        id,
        title,
        conversation_id,
        theme_name,
        theme_css,
        stage,
        storyline_json,
        created_at,
        updated_at,
    ) = row;
    Ok(DeckDetail {
        slides: list_slides(pool, enc, &id).await?,
        storyline: decode_storyline(enc, &storyline_json)?,
        theme_css: enc.decrypt(&theme_css)?,
        stage: parse_stage(&stage),
        id,
        title,
        theme_name,
        conversation_id,
        created_at,
        updated_at,
    })
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/// Every deck, most recently changed first.
pub async fn list(pool: &SqlitePool) -> Result<Vec<DeckSummary>, DbError> {
    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        String,
        String,
        String,
        String,
        Option<String>,
        String,
        String,
        Option<String>,
        i64,
    )> = sqlx::query_as(
        "SELECT d.id, d.title, d.theme_name, d.stage, d.conversation_id, d.created_at, \
                d.updated_at, d.last_opened_at, \
                (SELECT COUNT(*) FROM deck_slides s WHERE s.deck_id = d.id) \
         FROM decks d ORDER BY d.updated_at DESC, d.created_at DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                title,
                theme_name,
                stage,
                conversation_id,
                created_at,
                updated_at,
                last_opened_at,
                count,
            )| DeckSummary {
                id,
                title,
                theme_name,
                slide_count: u32::try_from(count).unwrap_or(0),
                stage: parse_stage(&stage),
                conversation_id,
                created_at,
                updated_at,
                last_opened_at,
            },
        )
        .collect())
}

pub async fn get(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
) -> Result<Option<DeckDetail>, DbError> {
    let row: Option<DeckRow> =
        sqlx::query_as(&format!("SELECT {DECK_COLUMNS} FROM decks WHERE id = ?"))
            .bind(id)
            .fetch_optional(pool)
            .await?;
    match row {
        Some(row) => Ok(Some(detail_from_row(pool, enc, row).await?)),
        None => Ok(None),
    }
}

/// The deck bound to a chat, if any. The deck tools resolve their deck here.
pub async fn get_by_conversation(
    pool: &SqlitePool,
    enc: &Encryption,
    conversation_id: &str,
) -> Result<Option<DeckDetail>, DbError> {
    let row: Option<DeckRow> = sqlx::query_as(&format!(
        "SELECT {DECK_COLUMNS} FROM decks WHERE conversation_id = ?"
    ))
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?;
    match row {
        Some(row) => Ok(Some(detail_from_row(pool, enc, row).await?)),
        None => Ok(None),
    }
}

async fn require(pool: &SqlitePool, enc: &Encryption, id: &str) -> Result<DeckDetail, DbError> {
    get(pool, enc, id).await?.ok_or_else(no_deck)
}

/// One slide of a deck.
pub async fn get_slide(
    pool: &SqlitePool,
    enc: &Encryption,
    deck_id: &str,
    slide_id: &str,
) -> Result<Option<DeckSlide>, DbError> {
    let row: Option<SlideRow> = sqlx::query_as(
        "SELECT id, position, layout, html, notes FROM deck_slides \
         WHERE deck_id = ? AND id = ?",
    )
    .bind(deck_id)
    .bind(slide_id)
    .fetch_optional(pool)
    .await?;
    row.map(|r| slide_from_row(enc, r)).transpose()
}

// ---------------------------------------------------------------------------
// Deck writes
// ---------------------------------------------------------------------------

/// Create an empty deck in the storyline stage, bound to `conversation_id`.
pub async fn create(
    pool: &SqlitePool,
    enc: &Encryption,
    title: &str,
    theme_name: &str,
    theme_css: &str,
    conversation_id: Option<&str>,
) -> Result<DeckDetail, DbError> {
    let title = validate_title(title)?;
    let theme_name = validate_theme(theme_name, theme_css)?;
    let id = Uuid::new_v4().to_string();
    let now = now_iso8601();
    sqlx::query(
        "INSERT INTO decks (id, title, conversation_id, theme_name, theme_css, stage, \
                            storyline_json, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, 'storyline', ?, ?, ?)",
    )
    .bind(&id)
    .bind(&title)
    .bind(conversation_id)
    .bind(&theme_name)
    .bind(enc.encrypt(theme_css)?)
    .bind(encode_storyline(enc, &[])?)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    require(pool, enc, &id).await
}

async fn touch(tx: &mut Transaction<'_, Sqlite>, deck_id: &str) -> Result<(), DbError> {
    let done = sqlx::query("UPDATE decks SET updated_at = ? WHERE id = ?")
        .bind(now_iso8601())
        .bind(deck_id)
        .execute(&mut **tx)
        .await?;
    if done.rows_affected() == 0 {
        return Err(no_deck());
    }
    Ok(())
}

/// Stamp when the deck was opened.
pub async fn mark_opened(pool: &SqlitePool, id: &str) -> Result<(), DbError> {
    sqlx::query("UPDATE decks SET last_opened_at = ? WHERE id = ?")
        .bind(now_iso8601())
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Bind a chat to a deck (replacing the old binding).
pub async fn bind_conversation(
    pool: &SqlitePool,
    deck_id: &str,
    conversation_id: &str,
) -> Result<(), DbError> {
    let done = sqlx::query("UPDATE decks SET conversation_id = ? WHERE id = ?")
        .bind(conversation_id)
        .bind(deck_id)
        .execute(pool)
        .await?;
    if done.rows_affected() == 0 {
        return Err(no_deck());
    }
    Ok(())
}

/// Rename a deck; returns the trimmed title.
pub async fn rename(pool: &SqlitePool, id: &str, title: &str) -> Result<String, DbError> {
    let title = validate_title(title)?;
    let done = sqlx::query("UPDATE decks SET title = ?, updated_at = ? WHERE id = ?")
        .bind(&title)
        .bind(now_iso8601())
        .bind(id)
        .execute(pool)
        .await?;
    if done.rows_affected() == 0 {
        return Err(no_deck());
    }
    Ok(title)
}

/// Delete a deck, its slides and its history. The bound chat is the caller's
/// to delete (it is returned so the caller can).
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<Option<String>, DbError> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT conversation_id FROM decks WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    sqlx::query("DELETE FROM decks WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(row.and_then(|(c,)| c))
}

pub async fn set_storyline(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
    storyline: Vec<StorylineItem>,
) -> Result<DeckDetail, DbError> {
    let items = normalize_storyline(storyline)?;
    let done = sqlx::query("UPDATE decks SET storyline_json = ?, updated_at = ? WHERE id = ?")
        .bind(encode_storyline(enc, &items)?)
        .bind(now_iso8601())
        .bind(id)
        .execute(pool)
        .await?;
    if done.rows_affected() == 0 {
        return Err(no_deck());
    }
    require(pool, enc, id).await
}

pub async fn set_stage(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
    stage: DeckStage,
) -> Result<DeckDetail, DbError> {
    let done = sqlx::query("UPDATE decks SET stage = ?, updated_at = ? WHERE id = ?")
        .bind(stage.as_str())
        .bind(now_iso8601())
        .bind(id)
        .execute(pool)
        .await?;
    if done.rows_affected() == 0 {
        return Err(no_deck());
    }
    require(pool, enc, id).await
}

pub async fn set_theme(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
    theme_name: &str,
    theme_css: &str,
) -> Result<DeckDetail, DbError> {
    let name = validate_theme(theme_name, theme_css)?;
    let done =
        sqlx::query("UPDATE decks SET theme_name = ?, theme_css = ?, updated_at = ? WHERE id = ?")
            .bind(&name)
            .bind(enc.encrypt(theme_css)?)
            .bind(now_iso8601())
            .bind(id)
            .execute(pool)
            .await?;
    if done.rows_affected() == 0 {
        return Err(no_deck());
    }
    require(pool, enc, id).await
}

// ---------------------------------------------------------------------------
// Slide writes
// ---------------------------------------------------------------------------

async fn slide_ids(
    tx: &mut Transaction<'_, Sqlite>,
    deck_id: &str,
) -> Result<Vec<String>, DbError> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT id FROM deck_slides WHERE deck_id = ? ORDER BY position")
            .bind(deck_id)
            .fetch_all(&mut **tx)
            .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Rewrite positions as `0..n-1` in the given order.
async fn write_order(
    tx: &mut Transaction<'_, Sqlite>,
    deck_id: &str,
    ids: &[String],
) -> Result<(), DbError> {
    for (position, id) in ids.iter().enumerate() {
        sqlx::query("UPDATE deck_slides SET position = ? WHERE deck_id = ? AND id = ?")
            .bind(position as i64)
            .bind(deck_id)
            .bind(id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

/// Add a slide at the end, or right after `after_slide_id`. Returns the new
/// slide and the deck's slide count.
pub async fn add_slide(
    pool: &SqlitePool,
    enc: &Encryption,
    deck_id: &str,
    layout: &str,
    html: &str,
    notes: &str,
    after_slide_id: Option<&str>,
) -> Result<(DeckSlide, usize), DbError> {
    validate_layout(layout)?;
    validate_slide_html(html)?;
    validate_notes(notes)?;
    let mut tx = pool.begin().await?;
    touch(&mut tx, deck_id).await?;
    let mut ids = slide_ids(&mut tx, deck_id).await?;
    if ids.len() >= MAX_SLIDES {
        return Err(invalid(format!(
            "A deck can have {MAX_SLIDES} slides at most."
        )));
    }
    let at = match after_slide_id {
        Some(after) => ids
            .iter()
            .position(|id| id == after)
            .map(|i| i + 1)
            .ok_or_else(|| invalid(format!("No slide '{after}' in this deck.")))?,
        None => ids.len(),
    };
    let id = Uuid::new_v4().to_string();
    let now = now_iso8601();
    sqlx::query(
        "INSERT INTO deck_slides (id, deck_id, position, layout, html, notes, created_at, \
                                  updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(deck_id)
    .bind(at as i64)
    .bind(layout)
    .bind(enc.encrypt(html)?)
    .bind(enc.encrypt(notes)?)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    ids.insert(at, id.clone());
    write_order(&mut tx, deck_id, &ids).await?;
    tx.commit().await?;
    let slide = DeckSlide {
        id,
        position: at as u32,
        layout: layout.to_string(),
        html: html.to_string(),
        notes: notes.to_string(),
    };
    Ok((slide, ids.len()))
}

/// The parts of a slide an update may change.
#[derive(Debug, Clone, Default)]
pub struct SlideChanges {
    pub layout: Option<String>,
    pub html: Option<String>,
    pub notes: Option<String>,
}

/// Change a slide's layout, page or notes; returns the slide as stored.
pub async fn update_slide(
    pool: &SqlitePool,
    enc: &Encryption,
    deck_id: &str,
    slide_id: &str,
    changes: SlideChanges,
) -> Result<DeckSlide, DbError> {
    if let Some(layout) = &changes.layout {
        validate_layout(layout)?;
    }
    if let Some(html) = &changes.html {
        validate_slide_html(html)?;
    }
    if let Some(notes) = &changes.notes {
        validate_notes(notes)?;
    }
    let current = get_slide(pool, enc, deck_id, slide_id)
        .await?
        .ok_or_else(|| invalid(format!("No slide '{slide_id}' in this deck.")))?;
    let layout = changes.layout.unwrap_or(current.layout);
    let html = changes.html.unwrap_or(current.html);
    let notes = changes.notes.unwrap_or(current.notes);
    let mut tx = pool.begin().await?;
    touch(&mut tx, deck_id).await?;
    sqlx::query(
        "UPDATE deck_slides SET layout = ?, html = ?, notes = ?, updated_at = ? \
         WHERE deck_id = ? AND id = ?",
    )
    .bind(&layout)
    .bind(enc.encrypt(&html)?)
    .bind(enc.encrypt(&notes)?)
    .bind(now_iso8601())
    .bind(deck_id)
    .bind(slide_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(DeckSlide {
        id: current.id,
        position: current.position,
        layout,
        html,
        notes,
    })
}

/// Move a slide to a 0-based position (clamped); returns where it landed.
pub async fn move_slide(
    pool: &SqlitePool,
    deck_id: &str,
    slide_id: &str,
    position: usize,
) -> Result<usize, DbError> {
    let mut tx = pool.begin().await?;
    touch(&mut tx, deck_id).await?;
    let mut ids = slide_ids(&mut tx, deck_id).await?;
    let from = ids
        .iter()
        .position(|id| id == slide_id)
        .ok_or_else(|| invalid(format!("No slide '{slide_id}' in this deck.")))?;
    let moved = ids.remove(from);
    let to = position.min(ids.len());
    ids.insert(to, moved);
    write_order(&mut tx, deck_id, &ids).await?;
    tx.commit().await?;
    Ok(to)
}

/// Delete a slide and close the gap; returns how many slides are left.
pub async fn delete_slide(
    pool: &SqlitePool,
    deck_id: &str,
    slide_id: &str,
) -> Result<usize, DbError> {
    let mut tx = pool.begin().await?;
    touch(&mut tx, deck_id).await?;
    let done = sqlx::query("DELETE FROM deck_slides WHERE deck_id = ? AND id = ?")
        .bind(deck_id)
        .bind(slide_id)
        .execute(&mut *tx)
        .await?;
    if done.rows_affected() == 0 {
        return Err(invalid(format!("No slide '{slide_id}' in this deck.")));
    }
    let ids = slide_ids(&mut tx, deck_id).await?;
    write_order(&mut tx, deck_id, &ids).await?;
    tx.commit().await?;
    Ok(ids.len())
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/// The deck's state as stored in a snapshot payload.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeckState {
    title: String,
    theme_name: String,
    theme_css: String,
    stage: DeckStage,
    storyline: Vec<StorylineItem>,
    slides: Vec<DeckSlide>,
}

fn snapshot_summary(
    row: (String, String, String, i64, String),
) -> Result<DeckSnapshotSummary, DbError> {
    let (id, cause, label, slide_count, created_at) = row;
    Ok(DeckSnapshotSummary {
        id,
        cause: DeckSnapshotCause::parse(&cause).unwrap_or(DeckSnapshotCause::Manual),
        label,
        slide_count: u32::try_from(slide_count).unwrap_or(0),
        created_at,
    })
}

/// The deck's history, newest first.
pub async fn list_snapshots(
    pool: &SqlitePool,
    deck_id: &str,
) -> Result<Vec<DeckSnapshotSummary>, DbError> {
    let rows: Vec<(String, String, String, i64, String)> = sqlx::query_as(
        "SELECT id, cause, label, slide_count, created_at FROM deck_snapshots \
         WHERE deck_id = ? ORDER BY created_at DESC, rowid DESC",
    )
    .bind(deck_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(snapshot_summary).collect()
}

/// Record the deck's current state in its history. Returns `None` when the
/// state is identical to the newest snapshot. Keeps the newest
/// [`MAX_SNAPSHOTS`] per deck.
pub async fn snapshot(
    pool: &SqlitePool,
    enc: &Encryption,
    deck_id: &str,
    cause: DeckSnapshotCause,
    label: &str,
) -> Result<Option<DeckSnapshotSummary>, DbError> {
    let deck = require(pool, enc, deck_id).await?;
    let slide_count = deck.slides.len();
    let state = DeckState {
        title: deck.title,
        theme_name: deck.theme_name,
        theme_css: deck.theme_css,
        stage: deck.stage,
        storyline: deck.storyline,
        slides: deck.slides,
    };
    let payload =
        serde_json::to_string(&state).map_err(|e| invalid(format!("encode deck snapshot: {e}")))?;
    let hash = sha256_hex(payload.as_bytes());

    let newest: Option<(String,)> = sqlx::query_as(
        "SELECT payload_hash FROM deck_snapshots WHERE deck_id = ? \
         ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .bind(deck_id)
    .fetch_optional(pool)
    .await?;
    if newest.is_some_and(|(h,)| h == hash) {
        return Ok(None);
    }

    let label: String = label
        .trim()
        .chars()
        .take(MAX_SNAPSHOT_LABEL_CHARS)
        .collect();
    let id = Uuid::new_v4().to_string();
    let now = now_iso8601();
    sqlx::query(
        "INSERT INTO deck_snapshots (id, deck_id, cause, label, payload, payload_hash, \
                                     slide_count, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(deck_id)
    .bind(cause.as_str())
    .bind(&label)
    .bind(enc.encrypt(&payload)?)
    .bind(&hash)
    .bind(slide_count as i64)
    .bind(&now)
    .execute(pool)
    .await?;
    sqlx::query(
        "DELETE FROM deck_snapshots WHERE deck_id = ? AND id NOT IN \
         (SELECT id FROM deck_snapshots WHERE deck_id = ? \
          ORDER BY created_at DESC, rowid DESC LIMIT ?)",
    )
    .bind(deck_id)
    .bind(deck_id)
    .bind(MAX_SNAPSHOTS)
    .execute(pool)
    .await?;
    Ok(Some(DeckSnapshotSummary {
        id,
        cause,
        label,
        slide_count: slide_count as u32,
        created_at: now,
    }))
}

/// Put a deck back to a snapshot's state (title, theme, stage, storyline and
/// slides, in one transaction), then record a `restore` snapshot. The deck's
/// chat binding is kept.
pub async fn restore_snapshot(
    pool: &SqlitePool,
    enc: &Encryption,
    deck_id: &str,
    snapshot_id: &str,
) -> Result<DeckDetail, DbError> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT payload, label FROM deck_snapshots WHERE deck_id = ? AND id = ?")
            .bind(deck_id)
            .bind(snapshot_id)
            .fetch_optional(pool)
            .await?;
    let (payload, label) = row.ok_or_else(|| invalid("That history entry no longer exists."))?;
    let state: DeckState = serde_json::from_str(&enc.decrypt(&payload)?)
        .map_err(|e| invalid(format!("decode deck snapshot: {e}")))?;

    let mut tx = pool.begin().await?;
    let done = sqlx::query(
        "UPDATE decks SET title = ?, theme_name = ?, theme_css = ?, stage = ?, \
                          storyline_json = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&state.title)
    .bind(&state.theme_name)
    .bind(enc.encrypt(&state.theme_css)?)
    .bind(state.stage.as_str())
    .bind(encode_storyline(enc, &state.storyline)?)
    .bind(now_iso8601())
    .bind(deck_id)
    .execute(&mut *tx)
    .await?;
    if done.rows_affected() == 0 {
        return Err(no_deck());
    }
    sqlx::query("DELETE FROM deck_slides WHERE deck_id = ?")
        .bind(deck_id)
        .execute(&mut *tx)
        .await?;
    let now = now_iso8601();
    for (position, slide) in state.slides.iter().enumerate() {
        sqlx::query(
            "INSERT INTO deck_slides (id, deck_id, position, layout, html, notes, created_at, \
                                      updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&slide.id)
        .bind(deck_id)
        .bind(position as i64)
        .bind(&slide.layout)
        .bind(enc.encrypt(&slide.html)?)
        .bind(enc.encrypt(&slide.notes)?)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    snapshot(
        pool,
        enc,
        deck_id,
        DeckSnapshotCause::Restore,
        &format!("Restored: {label}"),
    )
    .await?;
    require(pool, enc, deck_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_text_strips_tags_and_decodes() {
        let html = "<section data-layout=\"title\"><h1 data-text=\"title\">Q3 &amp; Q4</h1>\n  \
                    <p>Plan&nbsp;for &lt;growth&gt; &quot;now&quot; it&#39;s</p></section>";
        assert_eq!(
            slide_visible_text(html),
            "Q3 & Q4 Plan for <growth> \"now\" it's"
        );
    }

    #[test]
    fn visible_text_separates_adjacent_elements_and_skips_style() {
        assert_eq!(
            slide_visible_text("<b>one</b><i>two</i><style>.x{color:red}</style>three"),
            "one two three"
        );
        assert_eq!(slide_visible_text("a < b and c"), "a < b and c");
        assert_eq!(slide_visible_text(""), "");
    }

    #[test]
    fn layout_names_are_checked() {
        assert!(validate_layout("title").is_ok());
        assert!(validate_layout("two-col-2").is_ok());
        assert!(validate_layout("").is_err());
        assert!(validate_layout("Title").is_err());
        assert!(validate_layout("2col").is_err());
        assert!(validate_layout("has space").is_err());
        assert!(validate_layout(&"a".repeat(33)).is_err());
        assert!(validate_layout(&"a".repeat(32)).is_ok());
    }

    #[test]
    fn scripts_are_rejected_case_insensitively() {
        let err = validate_slide_html("<p>hi</p><SCRIPT>alert(1)</SCRIPT>").unwrap_err();
        assert!(err.to_string().contains("Slides can't contain scripts."));
        assert!(validate_slide_html("<svg><rect/></svg>").is_ok());
    }

    #[test]
    fn titles_are_trimmed_and_bounded() {
        assert_eq!(validate_title("  Q3 review ").unwrap(), "Q3 review");
        assert!(validate_title("   ").is_err());
        assert!(validate_title(&"x".repeat(121)).is_err());
    }

    #[test]
    fn storyline_ids_are_kept_or_replaced() {
        let items = normalize_storyline(vec![
            StorylineItem {
                id: "a".into(),
                text: "one".into(),
            },
            StorylineItem {
                id: "".into(),
                text: "two".into(),
            },
            StorylineItem {
                id: "a".into(),
                text: "three".into(),
            },
        ])
        .unwrap();
        assert_eq!(items[0].id, "a");
        assert!(!items[1].id.is_empty() && items[1].id != "a");
        assert!(items[2].id != "a" && items[2].id != items[1].id);
        assert!(normalize_storyline(vec![StorylineItem {
            id: "x".into(),
            text: "y".repeat(301)
        }])
        .is_err());
    }
}
