//! Writing: a draft is long-form Markdown written with the model in a chat of
//! its own (`conversations.kind = 'draft'`, never listed in Chats), with an
//! outline and a sidecar of block ids, owners and pins (see `draft_blocks`).
//!
//! Deleting the chat deletes the draft (foreign key cascade). The brief,
//! outline, Markdown, sidecar and snapshot payloads are encrypted like artifact
//! content. Every write recomputes the blocks from the Markdown and stores the
//! sidecar with it, so the two never disagree.

use provider_core::schema::{
    DraftDetail, DraftSnapshotCause, DraftSnapshotSummary, DraftSources, DraftStage, DraftSummary,
    OutlineSection,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::conversations;
use crate::{
    db::DbError,
    draft_blocks::{self, Block, EditMode, Sidecar, StoredBlock},
    encryption::Encryption,
    slide_html,
    time::now_iso8601,
};

pub const MAX_TITLE_CHARS: usize = 120;
/// Longest title made from the brief.
pub const BRIEF_TITLE_CHARS: usize = 60;
pub const MAX_BRIEF_CHARS: usize = 4_000;
pub const MAX_MARKDOWN_CHARS: usize = 400_000;
pub const MAX_OUTLINE_SECTIONS: usize = 30;
/// What the model may propose in one `set_outline`.
pub const MODEL_OUTLINE_SECTIONS: std::ops::RangeInclusive<usize> = 2..=12;
pub const MAX_HEADING_CHARS: usize = 120;
pub const MAX_INTENT_CHARS: usize = 400;
pub const MAX_TARGET_WORDS: u32 = 20_000;
pub const MAX_SNAPSHOTS: i64 = 200;
pub const MAX_SNAPSHOT_LABEL_CHARS: usize = 120;
/// Largest find or replace string.
pub const MAX_FIND_CHARS: usize = 200;
/// Most Research reports one draft can draw on.
pub const MAX_RESEARCH_SOURCES: usize = 10;

/// Kind of the conversation a draft is written in.
pub const CONVERSATION_KIND: &str = "draft";

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

fn no_draft() -> DbError {
    invalid("That draft no longer exists.")
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

/// Trim and check a draft title.
pub fn validate_title(title: &str) -> Result<String, DbError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(invalid("A draft needs a title."));
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(invalid(format!(
            "Keep the title under {MAX_TITLE_CHARS} characters."
        )));
    }
    Ok(title.to_string())
}

fn validate_brief(brief: &str) -> Result<String, DbError> {
    let brief = brief.trim();
    if brief.is_empty() {
        return Err(invalid("Describe what you want to write."));
    }
    if brief.chars().count() > MAX_BRIEF_CHARS {
        return Err(invalid(format!(
            "Keep the brief under {MAX_BRIEF_CHARS} characters."
        )));
    }
    Ok(brief.to_string())
}

fn validate_markdown(markdown: &str) -> Result<(), DbError> {
    if markdown.chars().count() > MAX_MARKDOWN_CHARS {
        return Err(invalid(format!(
            "The draft is too long ({MAX_MARKDOWN_CHARS} characters at most)."
        )));
    }
    Ok(())
}

/// A title from the brief: its first non-empty line without Markdown markers,
/// cut at a word boundary to [`BRIEF_TITLE_CHARS`] characters.
pub fn title_from_brief(brief: &str) -> String {
    let line = brief
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let stripped = line.trim_start_matches(['#', '-', '*', '>', ' ']).trim();
    let line = if stripped.is_empty() { line } else { stripped };
    let flat = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= BRIEF_TITLE_CHARS {
        return flat;
    }
    let cut: String = flat.chars().take(BRIEF_TITLE_CHARS - 1).collect();
    let cut = match cut.rfind(' ') {
        Some(at) if cut[..at].chars().count() >= BRIEF_TITLE_CHARS / 2 => cut[..at].to_string(),
        _ => cut,
    };
    let mut title = cut
        .trim_end_matches(|c: char| c.is_whitespace() || ",.;:-".contains(c))
        .to_string();
    title.push('…');
    title
}

/// Check an outline's sections and trim their text. `model` applies the
/// model's tighter section count.
pub fn normalize_outline(
    sections: Vec<OutlineSection>,
    model: bool,
) -> Result<Vec<OutlineSection>, DbError> {
    if model && !MODEL_OUTLINE_SECTIONS.contains(&sections.len()) {
        return Err(invalid(format!(
            "An outline has {} to {} sections; this one has {}.",
            MODEL_OUTLINE_SECTIONS.start(),
            MODEL_OUTLINE_SECTIONS.end(),
            sections.len()
        )));
    }
    if sections.len() > MAX_OUTLINE_SECTIONS {
        return Err(invalid(format!(
            "An outline can have {MAX_OUTLINE_SECTIONS} sections at most."
        )));
    }
    sections
        .into_iter()
        .map(|s| {
            let heading = s.heading.trim().to_string();
            if heading.is_empty() {
                return Err(invalid("Every outline section needs a heading."));
            }
            if heading.chars().count() > MAX_HEADING_CHARS {
                return Err(invalid(format!(
                    "Keep each section heading under {MAX_HEADING_CHARS} characters."
                )));
            }
            let intent = s.intent.trim().to_string();
            if intent.chars().count() > MAX_INTENT_CHARS {
                return Err(invalid(format!(
                    "Keep each section's intent under {MAX_INTENT_CHARS} characters."
                )));
            }
            if s.target_words.is_some_and(|w| w > MAX_TARGET_WORDS) {
                return Err(invalid(format!(
                    "A section's target length is {MAX_TARGET_WORDS} words at most."
                )));
            }
            Ok(OutlineSection {
                heading,
                intent,
                target_words: s.target_words.filter(|w| *w > 0),
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type DraftRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
);

const DRAFT_COLUMNS: &str = "id, title, conversation_id, stage, brief, outline_json, markdown, \
     blocks_json, created_at, updated_at, sources_json";

/// A draft as loaded: everything decrypted, blocks computed.
#[derive(Debug, Clone)]
pub struct Loaded {
    pub id: String,
    pub title: String,
    pub conversation_id: String,
    pub stage: DraftStage,
    pub brief: String,
    pub outline: Vec<OutlineSection>,
    pub markdown: String,
    pub sidecar: Sidecar,
    pub blocks: Vec<Block>,
    pub created_at: String,
    pub updated_at: String,
    pub sources: DraftSources,
}

impl Loaded {
    pub fn detail(&self) -> DraftDetail {
        DraftDetail {
            id: self.id.clone(),
            title: self.title.clone(),
            conversation_id: self.conversation_id.clone(),
            stage: self.stage,
            brief: self.brief.clone(),
            outline: self.outline.clone(),
            markdown: self.markdown.clone(),
            blocks: draft_blocks::public_blocks(&self.markdown, &self.blocks),
            words: draft_blocks::words_in(&self.markdown, &self.blocks),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            sources: self.sources.clone(),
        }
    }

    pub fn words(&self) -> u32 {
        draft_blocks::words_in(&self.markdown, &self.blocks)
    }

    pub fn block_text(&self, block: &Block) -> &str {
        block.text(&self.markdown)
    }
}

fn decode_json<T: for<'de> Deserialize<'de>>(
    enc: &Encryption,
    stored: &str,
    what: &str,
) -> Result<T, DbError> {
    serde_json::from_str(&enc.decrypt(stored)?).map_err(|e| invalid(format!("decode {what}: {e}")))
}

fn encode_json<T: Serialize>(enc: &Encryption, value: &T, what: &str) -> Result<String, DbError> {
    let json = serde_json::to_string(value).map_err(|e| invalid(format!("encode {what}: {e}")))?;
    enc.encrypt(&json)
}

fn loaded_from_row(enc: &Encryption, row: DraftRow) -> Result<Loaded, DbError> {
    let (
        id,
        title,
        conversation_id,
        stage,
        brief,
        outline_json,
        markdown,
        blocks_json,
        created_at,
        updated_at,
        sources_json,
    ) = row;
    let markdown = enc.decrypt(&markdown)?;
    let sidecar: Sidecar = decode_json(enc, &blocks_json, "draft blocks")?;
    let blocks = draft_blocks::blocks(&markdown, &sidecar);
    Ok(Loaded {
        id,
        title,
        conversation_id,
        stage: DraftStage::parse(&stage).unwrap_or(DraftStage::Outline),
        brief: enc.decrypt(&brief)?,
        outline: decode_json(enc, &outline_json, "draft outline")?,
        markdown,
        sidecar,
        blocks,
        created_at,
        updated_at,
        // An unreadable value (never written by this code) reads as no sources.
        sources: serde_json::from_str(&sources_json).unwrap_or_default(),
    })
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/// Every draft, most recently changed first.
pub async fn list(pool: &SqlitePool) -> Result<Vec<DraftSummary>, DbError> {
    let rows: Vec<(String, String, String, i64, String)> = sqlx::query_as(
        "SELECT id, title, stage, words, updated_at FROM drafts \
         ORDER BY updated_at DESC, created_at DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, title, stage, words, updated_at)| DraftSummary {
            id,
            title,
            stage: DraftStage::parse(&stage).unwrap_or(DraftStage::Outline),
            words: u32::try_from(words).unwrap_or(0),
            updated_at,
        })
        .collect())
}

pub async fn load(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
) -> Result<Option<Loaded>, DbError> {
    let row: Option<DraftRow> =
        sqlx::query_as(&format!("SELECT {DRAFT_COLUMNS} FROM drafts WHERE id = ?"))
            .bind(id)
            .fetch_optional(pool)
            .await?;
    row.map(|r| loaded_from_row(enc, r)).transpose()
}

/// The draft written in a chat, if any. The draft tools resolve their draft here.
pub async fn load_by_conversation(
    pool: &SqlitePool,
    enc: &Encryption,
    conversation_id: &str,
) -> Result<Option<Loaded>, DbError> {
    let row: Option<DraftRow> = sqlx::query_as(&format!(
        "SELECT {DRAFT_COLUMNS} FROM drafts WHERE conversation_id = ?"
    ))
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?;
    row.map(|r| loaded_from_row(enc, r)).transpose()
}

pub async fn get(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
) -> Result<Option<DraftDetail>, DbError> {
    Ok(load(pool, enc, id).await?.map(|d| d.detail()))
}

pub async fn get_by_conversation(
    pool: &SqlitePool,
    enc: &Encryption,
    conversation_id: &str,
) -> Result<Option<DraftDetail>, DbError> {
    Ok(load_by_conversation(pool, enc, conversation_id)
        .await?
        .map(|d| d.detail()))
}

pub async fn require(pool: &SqlitePool, enc: &Encryption, id: &str) -> Result<Loaded, DbError> {
    load(pool, enc, id).await?.ok_or_else(no_draft)
}

// ---------------------------------------------------------------------------
// Draft writes
// ---------------------------------------------------------------------------

/// Create a draft from a brief, with its own chat (`kind = 'draft'`, titled
/// like the draft) and a `created` snapshot. The draft starts in the outline
/// stage with empty Markdown.
pub async fn create(
    pool: &SqlitePool,
    enc: &Encryption,
    brief: &str,
) -> Result<DraftDetail, DbError> {
    let brief = validate_brief(brief)?;
    let title = title_from_brief(&brief);
    let conversation = conversations::create(pool, Some(&title)).await?;
    let id = Uuid::new_v4().to_string();
    let now = now_iso8601();
    let inserted = async {
        conversations::set_kind(pool, &conversation.id, CONVERSATION_KIND).await?;
        sqlx::query(
            "INSERT INTO drafts (id, title, conversation_id, stage, brief, outline_json, markdown, \
                                 blocks_json, words, created_at, updated_at) \
             VALUES (?, ?, ?, 'outline', ?, ?, ?, ?, 0, ?, ?)",
        )
        .bind(&id)
        .bind(&title)
        .bind(&conversation.id)
        .bind(enc.encrypt(&brief)?)
        .bind(encode_json(enc, &Vec::<OutlineSection>::new(), "draft outline")?)
        .bind(enc.encrypt("")?)
        .bind(encode_json(enc, &Sidecar { next: 1, blocks: Vec::new() }, "draft blocks")?)
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await?;
        Ok::<(), DbError>(())
    }
    .await;
    if let Err(error) = inserted {
        let _ = conversations::delete(pool, &conversation.id).await;
        return Err(error);
    }
    snapshot(pool, enc, &id, DraftSnapshotCause::Created, None).await?;
    Ok(require(pool, enc, &id).await?.detail())
}

/// Rename a draft and its chat.
pub async fn rename(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
    title: &str,
) -> Result<DraftDetail, DbError> {
    let title = validate_title(title)?;
    let draft = require(pool, enc, id).await?;
    sqlx::query("UPDATE drafts SET title = ?, updated_at = ? WHERE id = ?")
        .bind(&title)
        .bind(now_iso8601())
        .bind(id)
        .execute(pool)
        .await?;
    conversations::set_title(pool, &draft.conversation_id, &title).await?;
    Ok(require(pool, enc, id).await?.detail())
}

/// Delete a draft and its history. Returns its chat's id: the caller deletes
/// the chat (with its files); deleting the chat alone also deletes the draft.
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<Option<String>, DbError> {
    let row: Option<(String,)> = sqlx::query_as("SELECT conversation_id FROM drafts WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    sqlx::query("DELETE FROM drafts WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(row.map(|(c,)| c))
}

pub async fn set_stage(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
    stage: DraftStage,
) -> Result<DraftDetail, DbError> {
    let done = sqlx::query("UPDATE drafts SET stage = ?, updated_at = ? WHERE id = ?")
        .bind(stage.as_str())
        .bind(now_iso8601())
        .bind(id)
        .execute(pool)
        .await?;
    if done.rows_affected() == 0 {
        return Err(no_draft());
    }
    Ok(require(pool, enc, id).await?.detail())
}

/// Set what the draft may draw on. Research runs must exist and be finished;
/// repeats are dropped and at most [`MAX_RESEARCH_SOURCES`] are kept.
pub async fn set_sources(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
    sources: DraftSources,
) -> Result<DraftDetail, DbError> {
    require(pool, enc, id).await?;
    let mut run_ids: Vec<String> = Vec::new();
    for run_id in sources.research_run_ids {
        let run_id = run_id.trim().to_string();
        if run_id.is_empty() || run_ids.contains(&run_id) {
            continue;
        }
        let status: Option<String> =
            sqlx::query_scalar("SELECT status FROM research_runs WHERE id = ?")
                .bind(&run_id)
                .fetch_optional(pool)
                .await?;
        match status.as_deref() {
            None => return Err(invalid("That research report no longer exists.")),
            Some("done") => {}
            Some(_) => return Err(invalid("That research report isn't finished yet.")),
        }
        run_ids.push(run_id);
    }
    if run_ids.len() > MAX_RESEARCH_SOURCES {
        return Err(invalid(format!(
            "A draft can draw on {MAX_RESEARCH_SOURCES} research reports at most."
        )));
    }
    let sources = DraftSources {
        web_search: sources.web_search,
        research_run_ids: run_ids,
    };
    let json = serde_json::to_string(&sources)
        .map_err(|e| invalid(format!("encode draft sources: {e}")))?;
    sqlx::query("UPDATE drafts SET sources_json = ?, updated_at = ? WHERE id = ?")
        .bind(json)
        .bind(now_iso8601())
        .bind(id)
        .execute(pool)
        .await?;
    Ok(require(pool, enc, id).await?.detail())
}

/// Replace the outline. `model` applies the model's 2–12 section rule.
pub async fn set_outline(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
    outline: Vec<OutlineSection>,
    model: bool,
) -> Result<DraftDetail, DbError> {
    let outline = normalize_outline(outline, model)?;
    let done = sqlx::query("UPDATE drafts SET outline_json = ?, updated_at = ? WHERE id = ?")
        .bind(encode_json(enc, &outline, "draft outline")?)
        .bind(now_iso8601())
        .bind(id)
        .execute(pool)
        .await?;
    if done.rows_affected() == 0 {
        return Err(no_draft());
    }
    Ok(require(pool, enc, id).await?.detail())
}

/// Store new Markdown with its blocks (the sidecar must describe exactly the
/// blocks of `markdown`).
async fn write_content(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
    markdown: &str,
    sidecar: &Sidecar,
    words: u32,
) -> Result<(), DbError> {
    validate_markdown(markdown)?;
    let done = sqlx::query(
        "UPDATE drafts SET markdown = ?, blocks_json = ?, words = ?, updated_at = ? WHERE id = ?",
    )
    .bind(enc.encrypt(markdown)?)
    .bind(encode_json(enc, sidecar, "draft blocks")?)
    .bind(i64::from(words))
    .bind(now_iso8601())
    .bind(id)
    .execute(pool)
    .await?;
    if done.rows_affected() == 0 {
        return Err(no_draft());
    }
    Ok(())
}

/// Carry the draft's blocks over to `new_md` and store it.
async fn store_change(
    pool: &SqlitePool,
    enc: &Encryption,
    draft: &Loaded,
    new_md: &str,
    mode: EditMode,
    released: &[String],
) -> Result<Vec<Block>, DbError> {
    validate_markdown(new_md)?;
    let mut sidecar = draft.sidecar.clone();
    let blocks = draft_blocks::reanchor(&draft.markdown, &draft.blocks, new_md, mode, &mut sidecar);
    if mode == EditMode::Ai {
        draft_blocks::check_pinned_kept(&draft.markdown, &draft.blocks, new_md, &blocks, released)
            .map_err(invalid)?;
    }
    sidecar.blocks = draft_blocks::stored(&blocks);
    let words = draft_blocks::words_in(new_md, &blocks);
    write_content(pool, enc, &draft.id, new_md, &sidecar, words).await?;
    Ok(blocks)
}

/// The user's edit in the editor: blocks they changed or typed become theirs
/// and pinned; the rest keep their state.
pub async fn save_markdown(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
    markdown: &str,
) -> Result<DraftDetail, DbError> {
    let draft = require(pool, enc, id).await?;
    if markdown != draft.markdown {
        store_change(pool, enc, &draft, markdown, EditMode::User, &[]).await?;
    }
    Ok(require(pool, enc, id).await?.detail())
}

/// Pin ("You wrote this") or unpin ("Let AI edit") one block.
pub async fn set_block_pinned(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
    block_id: &str,
    pinned: bool,
) -> Result<DraftDetail, DbError> {
    let draft = require(pool, enc, id).await?;
    let mut sidecar = draft.sidecar.clone();
    let mut blocks = draft.blocks.clone();
    let block = blocks
        .iter_mut()
        .find(|b| b.id == block_id)
        .ok_or_else(|| invalid("That block no longer exists."))?;
    if block.pinned != pinned {
        block.pinned = pinned;
        sidecar.blocks = draft_blocks::stored(&blocks);
        let words = draft_blocks::words_in(&draft.markdown, &blocks);
        write_content(pool, enc, id, &draft.markdown, &sidecar, words).await?;
    }
    Ok(require(pool, enc, id).await?.detail())
}

// ---------------------------------------------------------------------------
// Model edits
// ---------------------------------------------------------------------------

const OUTLINE_NOT_APPROVED: &str = "The outline isn't approved yet, so nothing was written. \
     Propose or revise the outline with set_outline, then wait for the user to approve it.";
const OUTLINE_APPROVED: &str = "The outline was already approved and the draft is being written. \
     Change the draft with write_section or edit_blocks; the user edits the outline in the Outline tab.";

/// What a model edit did, by block id.
#[derive(Debug, Clone, Default)]
pub struct ModelEdit {
    pub changed: Vec<String>,
    pub added: Vec<String>,
    pub removed: Vec<String>,
    /// Every pinned block after the edit (the user's text the model kept).
    pub kept_pinned: Vec<String>,
    pub words: u32,
}

fn describe_edit(old_md: &str, old: &[Block], new_md: &str, new: &[Block]) -> ModelEdit {
    let mut edit = ModelEdit {
        words: draft_blocks::words_in(new_md, new),
        ..Default::default()
    };
    for block in new {
        match old.iter().find(|o| o.id == block.id) {
            Some(o) if o.text(old_md) != block.text(new_md) => edit.changed.push(block.id.clone()),
            Some(_) => {}
            None => edit.added.push(block.id.clone()),
        }
        if block.pinned {
            edit.kept_pinned.push(block.id.clone());
        }
    }
    edit.removed = old
        .iter()
        .filter(|o| !new.iter().any(|n| n.id == o.id))
        .map(|o| o.id.clone())
        .collect();
    edit
}

fn require_stage(draft: &Loaded, stage: DraftStage) -> Result<(), DbError> {
    if draft.stage == stage {
        return Ok(());
    }
    Err(invalid(match stage {
        DraftStage::Draft => OUTLINE_NOT_APPROVED,
        DraftStage::Outline => OUTLINE_APPROVED,
    }))
}

async fn apply_model_change(
    pool: &SqlitePool,
    enc: &Encryption,
    draft: &Loaded,
    new_md: &str,
    released: &[String],
) -> Result<ModelEdit, DbError> {
    let blocks = store_change(pool, enc, draft, new_md, EditMode::Ai, released).await?;
    Ok(describe_edit(
        &draft.markdown,
        &draft.blocks,
        new_md,
        &blocks,
    ))
}

/// The model's outline (outline stage only); `title` renames the draft and
/// its chat.
pub async fn model_set_outline(
    pool: &SqlitePool,
    enc: &Encryption,
    draft: &Loaded,
    sections: Vec<OutlineSection>,
    title: Option<&str>,
) -> Result<DraftDetail, DbError> {
    require_stage(draft, DraftStage::Outline)?;
    let title = title
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(validate_title)
        .transpose()?;
    let detail = set_outline(pool, enc, &draft.id, sections, true).await?;
    match title {
        Some(title) if title != draft.title => rename(pool, enc, &draft.id, &title).await,
        _ => Ok(detail),
    }
}

/// Write one section (draft stage only): replace the blocks under that
/// heading, or add the section where the outline puts it.
/// What one `write_section` call did.
#[derive(Debug, Clone)]
pub struct WrittenSection {
    pub edit: ModelEdit,
    /// The ids of the section's blocks after the write.
    pub section: Vec<String>,
    /// Outline headings still without content, in outline order.
    pub remaining: Vec<String>,
}

pub async fn model_write_section(
    pool: &SqlitePool,
    enc: &Encryption,
    draft: &Loaded,
    heading: &str,
    markdown: &str,
) -> Result<WrittenSection, DbError> {
    require_stage(draft, DraftStage::Draft)?;
    if heading.trim().is_empty() {
        return Err(invalid("write_section needs the section's heading."));
    }
    let headings: Vec<String> = draft.outline.iter().map(|s| s.heading.clone()).collect();
    let new_md =
        draft_blocks::write_section(&draft.markdown, &draft.blocks, &headings, heading, markdown);
    let blocks = store_change(pool, enc, draft, &new_md, EditMode::Ai, &[]).await?;
    let section: Vec<String> = draft_blocks::section_range(&new_md, &blocks, heading)
        .map(|r| blocks[r].iter().map(|b| b.id.clone()).collect())
        .unwrap_or_default();
    Ok(WrittenSection {
        edit: describe_edit(&draft.markdown, &draft.blocks, &new_md, &blocks),
        section,
        remaining: draft_blocks::unwritten_sections(&new_md, &headings),
    })
}

/// Replace blocks by id (draft stage only). An empty replacement deletes the
/// block; a replacement may hold several blocks.
pub async fn model_edit_blocks(
    pool: &SqlitePool,
    enc: &Encryption,
    draft: &Loaded,
    edits: &[(String, String)],
    released: &[String],
) -> Result<ModelEdit, DbError> {
    require_stage(draft, DraftStage::Draft)?;
    if edits.is_empty() {
        return Err(invalid("edit_blocks needs at least one edit."));
    }
    let new_md =
        draft_blocks::replace_blocks(&draft.markdown, &draft.blocks, edits).map_err(invalid)?;
    apply_model_change(pool, enc, draft, &new_md, released).await
}

/// What a draft-wide find and replace did.
#[derive(Debug, Clone, Default)]
pub struct ReplaceOutcome {
    pub total: u32,
    /// `(block id, count)` for each block that changed (ids as before the swap).
    pub blocks: Vec<(String, u32)>,
    /// Pinned blocks whose text the swap changed.
    pub pinned_changed: Vec<String>,
    pub words: u32,
}

/// A word swap the user named, across every block of the draft, pinned ones
/// included; blocks keep their owner and pin. `match_case` and `whole_word`
/// as in Slides' replace.
pub async fn model_replace(
    pool: &SqlitePool,
    enc: &Encryption,
    draft: &Loaded,
    find: &str,
    replace: &str,
    match_case: bool,
    whole_word: bool,
) -> Result<ReplaceOutcome, DbError> {
    require_stage(draft, DraftStage::Draft)?;
    if find.is_empty() {
        return Err(invalid("Give the text to find."));
    }
    if find.chars().count() > MAX_FIND_CHARS || replace.chars().count() > MAX_FIND_CHARS {
        return Err(invalid(format!(
            "Keep the find and replace text under {MAX_FIND_CHARS} characters."
        )));
    }
    let mut outcome = ReplaceOutcome::default();
    let mut edits: Vec<(String, String)> = Vec::new();
    for block in &draft.blocks {
        let (text, count) = slide_html::replace_plain(
            draft.block_text(block),
            find,
            replace,
            match_case,
            whole_word,
        );
        if count == 0 {
            continue;
        }
        outcome.total += count;
        outcome.blocks.push((block.id.clone(), count));
        if block.pinned {
            outcome.pinned_changed.push(block.id.clone());
        }
        edits.push((block.id.clone(), text));
    }
    if edits.is_empty() {
        outcome.words = draft.words();
        return Ok(outcome);
    }
    let new_md =
        draft_blocks::replace_blocks(&draft.markdown, &draft.blocks, &edits).map_err(invalid)?;
    let blocks = store_change(pool, enc, draft, &new_md, EditMode::Named, &[]).await?;
    outcome.words = draft_blocks::words_in(&new_md, &blocks);
    Ok(outcome)
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/// The draft's state as stored in a snapshot payload.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftState {
    markdown: String,
    blocks: Vec<StoredBlock>,
    outline: Vec<OutlineSection>,
    stage: DraftStage,
}

fn snapshot_summary(row: (String, String, Option<String>, i64, String)) -> DraftSnapshotSummary {
    let (id, cause, label, words, created_at) = row;
    DraftSnapshotSummary {
        id,
        cause: DraftSnapshotCause::parse(&cause).unwrap_or(DraftSnapshotCause::Manual),
        label,
        words: u32::try_from(words).unwrap_or(0),
        created_at,
    }
}

/// The draft's history, newest first.
pub async fn list_snapshots(
    pool: &SqlitePool,
    draft_id: &str,
) -> Result<Vec<DraftSnapshotSummary>, DbError> {
    let rows: Vec<(String, String, Option<String>, i64, String)> = sqlx::query_as(
        "SELECT id, cause, label, words, created_at FROM draft_snapshots \
         WHERE draft_id = ? ORDER BY created_at DESC, rowid DESC",
    )
    .bind(draft_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(snapshot_summary).collect())
}

fn clean_label(label: Option<&str>) -> Option<String> {
    label
        .map(|l| {
            l.trim()
                .chars()
                .take(MAX_SNAPSHOT_LABEL_CHARS)
                .collect::<String>()
        })
        .filter(|l| !l.is_empty())
}

/// Record the draft's current state in its history. Returns `None` when the
/// state is identical to the newest snapshot. Keeps the newest
/// [`MAX_SNAPSHOTS`] per draft.
pub async fn snapshot(
    pool: &SqlitePool,
    enc: &Encryption,
    draft_id: &str,
    cause: DraftSnapshotCause,
    label: Option<&str>,
) -> Result<Option<DraftSnapshotSummary>, DbError> {
    let draft = require(pool, enc, draft_id).await?;
    let words = draft.words();
    let state = DraftState {
        markdown: draft.markdown.clone(),
        blocks: draft_blocks::stored(&draft.blocks),
        outline: draft.outline.clone(),
        stage: draft.stage,
    };
    let payload = serde_json::to_string(&state)
        .map_err(|e| invalid(format!("encode draft snapshot: {e}")))?;
    let hash = sha256_hex(payload.as_bytes());

    let newest: Option<(String,)> = sqlx::query_as(
        "SELECT payload_hash FROM draft_snapshots WHERE draft_id = ? \
         ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .bind(draft_id)
    .fetch_optional(pool)
    .await?;
    if newest.is_some_and(|(h,)| h == hash) {
        return Ok(None);
    }

    let label = clean_label(label);
    let id = Uuid::new_v4().to_string();
    let now = now_iso8601();
    sqlx::query(
        "INSERT INTO draft_snapshots (id, draft_id, cause, label, payload, payload_hash, words, \
                                      created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(draft_id)
    .bind(cause.as_str())
    .bind(&label)
    .bind(enc.encrypt(&payload)?)
    .bind(&hash)
    .bind(i64::from(words))
    .bind(&now)
    .execute(pool)
    .await?;
    sqlx::query(
        "DELETE FROM draft_snapshots WHERE draft_id = ? AND id NOT IN \
         (SELECT id FROM draft_snapshots WHERE draft_id = ? \
          ORDER BY created_at DESC, rowid DESC LIMIT ?)",
    )
    .bind(draft_id)
    .bind(draft_id)
    .bind(MAX_SNAPSHOTS)
    .execute(pool)
    .await?;
    Ok(Some(DraftSnapshotSummary {
        id,
        cause,
        label,
        words,
        created_at: now,
    }))
}

/// Put a draft back to a snapshot's state (Markdown, blocks, outline and
/// stage), then record a `restore` snapshot carrying the restored entry's
/// label. Ids handed out since the snapshot are never reused.
pub async fn restore_snapshot(
    pool: &SqlitePool,
    enc: &Encryption,
    draft_id: &str,
    snapshot_id: &str,
) -> Result<DraftDetail, DbError> {
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT payload, label FROM draft_snapshots WHERE draft_id = ? AND id = ?")
            .bind(draft_id)
            .bind(snapshot_id)
            .fetch_optional(pool)
            .await?;
    let (payload, label) = row.ok_or_else(|| invalid("That history entry no longer exists."))?;
    let state: DraftState = serde_json::from_str(&enc.decrypt(&payload)?)
        .map_err(|e| invalid(format!("decode draft snapshot: {e}")))?;
    let current = require(pool, enc, draft_id).await?;

    let mut sidecar = Sidecar {
        next: current.sidecar.next,
        blocks: state.blocks,
    };
    let stored_blocks = sidecar.blocks.clone();
    sidecar.bump_past(&stored_blocks);
    sidecar.bump_past(&current.sidecar.blocks);
    let blocks = draft_blocks::blocks(&state.markdown, &sidecar);
    sidecar.blocks = draft_blocks::stored(&blocks);
    let words = draft_blocks::words_in(&state.markdown, &blocks);
    sqlx::query(
        "UPDATE drafts SET markdown = ?, blocks_json = ?, words = ?, outline_json = ?, stage = ?, \
                           updated_at = ? WHERE id = ?",
    )
    .bind(enc.encrypt(&state.markdown)?)
    .bind(encode_json(enc, &sidecar, "draft blocks")?)
    .bind(i64::from(words))
    .bind(encode_json(enc, &state.outline, "draft outline")?)
    .bind(state.stage.as_str())
    .bind(now_iso8601())
    .bind(draft_id)
    .execute(pool)
    .await?;

    snapshot(
        pool,
        enc,
        draft_id,
        DraftSnapshotCause::Restore,
        label.as_deref(),
    )
    .await?;
    Ok(require(pool, enc, draft_id).await?.detail())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_come_from_the_brief() {
        assert_eq!(
            title_from_brief("  # A post about Rust\n\nmore"),
            "A post about Rust"
        );
        assert_eq!(title_from_brief("\n\n- bullet brief"), "bullet brief");
        let long = "Write a long blog post about how we migrated our build system to Bazel and what we learned";
        let title = title_from_brief(long);
        assert!(title.chars().count() <= BRIEF_TITLE_CHARS, "{title}");
        assert!(
            title.ends_with('…') && title.starts_with("Write a long blog post"),
            "{title}"
        );
        assert!(!title.contains("  "));
        let one_word = "x".repeat(100);
        assert_eq!(
            title_from_brief(&one_word).chars().count(),
            BRIEF_TITLE_CHARS
        );
    }

    #[test]
    fn outlines_are_checked() {
        let section = |h: &str| OutlineSection {
            heading: h.into(),
            intent: " why ".into(),
            target_words: Some(0),
        };
        let ok = normalize_outline(vec![section(" A "), section("B")], true).unwrap();
        assert_eq!(ok[0].heading, "A");
        assert_eq!(ok[0].intent, "why");
        assert_eq!(ok[0].target_words, None);
        assert!(normalize_outline(vec![section("A")], true).is_err());
        assert!(normalize_outline(vec![section("A")], false).is_ok());
        assert!(normalize_outline(vec![section(""), section("B")], true).is_err());
        assert!(normalize_outline((0..13).map(|_| section("x")).collect(), true).is_err());
        assert!(normalize_outline(Vec::new(), false).is_ok());
    }
}
