//! Writing: the drafts repository (chat binding, user edits and pins,
//! snapshots, encryption) and the draft tools run against a draft's chat.

#[path = "common/mod.rs"]
mod common;

use conduit_desktop::{
    agent_tools::{
        self, AgentToolContext, AgentToolExecution, EDIT_BLOCKS_TOOL, READ_DRAFT_TOOL,
        REPLACE_IN_DRAFT_TOOL, SET_OUTLINE_TOOL, WRITE_SECTION_TOOL,
    },
    commands::export_draft_impl,
    db::repository::{conversations, drafts},
    encryption::Encryption,
};
use provider_core::schema::{
    BlockOwner, DraftBlock, DraftDetail, DraftSnapshotCause, DraftStage, OutlineSection,
};
use serde_json::{json, Value};
use sqlx::SqlitePool;

fn block<'a>(draft: &'a DraftDetail, text: &str) -> &'a DraftBlock {
    draft
        .blocks
        .iter()
        .find(|b| block_text(draft, b) == text)
        .unwrap_or_else(|| panic!("no block {text:?} in {:#?}", draft.blocks))
}

/// A block's text, cut from the Markdown by its UTF-16 offsets as the editor
/// does.
fn block_text(draft: &DraftDetail, b: &DraftBlock) -> String {
    let units: Vec<u16> = draft.markdown.encode_utf16().collect();
    String::from_utf16(&units[b.start as usize..b.end as usize]).unwrap()
}

fn section(heading: &str) -> OutlineSection {
    OutlineSection {
        heading: heading.into(),
        intent: format!("Explain {heading}"),
        target_words: Some(200),
    }
}

async fn new_draft(pool: &SqlitePool, enc: &Encryption) -> DraftDetail {
    drafts::create(
        pool,
        enc,
        "  A blog post about tea for beginners\nkeep it light",
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn create_binds_a_hidden_chat_and_records_a_created_snapshot() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let draft = new_draft(&pool, &enc).await;

    assert_eq!(draft.title, "A blog post about tea for beginners");
    assert_eq!(draft.stage, DraftStage::Outline);
    assert_eq!(draft.markdown, "");
    assert!(draft.blocks.is_empty() && draft.outline.is_empty());
    assert_eq!(draft.words, 0);
    assert!(draft.brief.starts_with("A blog post about tea"));

    // The chat exists, is titled like the draft, and stays out of Chats.
    let chat = conversations::get_summary(&pool, &draft.conversation_id)
        .await
        .unwrap()
        .expect("the draft's chat");
    assert_eq!(chat.title.as_deref(), Some(draft.title.as_str()));
    let (kind,): (String,) = sqlx::query_as("SELECT kind FROM conversations WHERE id = ?")
        .bind(&draft.conversation_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(kind, "draft");
    let plain = conversations::create(&pool, None).await.unwrap();
    let listed: Vec<String> = conversations::list(&pool)
        .await
        .unwrap()
        .into_iter()
        .map(|c| c.id)
        .collect();
    assert_eq!(listed, [plain.id]);

    let by_chat = drafts::get_by_conversation(&pool, &enc, &draft.conversation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(by_chat.id, draft.id);
    let history = drafts::list_snapshots(&pool, &draft.id).await.unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].cause, DraftSnapshotCause::Created);
    assert_eq!(history[0].label, None);

    let list = drafts::list(&pool).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].stage, list[0].words), (DraftStage::Outline, 0));

    assert!(drafts::create(&pool, &enc, "   ").await.is_err());
}

#[tokio::test]
async fn deleting_the_chat_deletes_the_draft_and_its_history() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let draft = new_draft(&pool, &enc).await;
    conversations::delete(&pool, &draft.conversation_id)
        .await
        .unwrap();
    for table in ["drafts", "draft_snapshots"] {
        let (n,): (i64,) = sqlx::query_as(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 0, "{table}");
    }

    // The repository delete reports the chat for the command to remove.
    let other = new_draft(&pool, &enc).await;
    let chat = drafts::delete(&pool, &other.id).await.unwrap();
    assert_eq!(chat.as_deref(), Some(other.conversation_id.as_str()));
    assert!(drafts::get(&pool, &enc, &other.id).await.unwrap().is_none());
}

#[tokio::test]
async fn rename_outline_and_stage() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let draft = new_draft(&pool, &enc).await;

    let renamed = drafts::rename(&pool, &enc, &draft.id, "  Tea 101 ")
        .await
        .unwrap();
    assert_eq!(renamed.title, "Tea 101");
    let chat = conversations::get_summary(&pool, &draft.conversation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(chat.title.as_deref(), Some("Tea 101"));
    assert!(drafts::rename(&pool, &enc, &draft.id, " ").await.is_err());

    // The user may keep a one-section outline; the model may not.
    let one = drafts::set_outline(&pool, &enc, &draft.id, vec![section("Why")], false)
        .await
        .unwrap();
    assert_eq!(one.outline.len(), 1);
    assert!(
        drafts::set_outline(&pool, &enc, &draft.id, vec![section("Why")], true)
            .await
            .is_err()
    );

    let staged = drafts::set_stage(&pool, &enc, &draft.id, DraftStage::Draft)
        .await
        .unwrap();
    assert_eq!(staged.stage, DraftStage::Draft);
    assert_eq!(
        drafts::list(&pool).await.unwrap()[0].stage,
        DraftStage::Draft
    );
}

#[tokio::test]
async fn user_edits_pin_what_they_change_and_type() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let draft = new_draft(&pool, &enc).await;
    // The model writes first (blocks owned by the model, unpinned).
    let loaded = drafts::require(&pool, &enc, &draft.id).await.unwrap();
    drafts::set_stage(&pool, &enc, &draft.id, DraftStage::Draft)
        .await
        .unwrap();
    let loaded = drafts::Loaded {
        stage: DraftStage::Draft,
        ..loaded
    };
    drafts::model_write_section(
        &pool,
        &enc,
        &loaded,
        "Intro",
        "Tea is a leaf.\n\nIt is old.",
    )
    .await
    .unwrap();
    let before = drafts::get(&pool, &enc, &draft.id).await.unwrap().unwrap();
    assert_eq!(
        before.markdown,
        "## Intro\n\nTea is a leaf.\n\nIt is old.\n"
    );
    assert!(before
        .blocks
        .iter()
        .all(|b| b.owner == BlockOwner::Ai && !b.pinned));
    assert_eq!(before.words, 8);

    // The user rewrites one paragraph and adds another.
    let edited_md = "## Intro\n\nTea is a leaf, Camellia sinensis.\n\nIt is old.\n\nMy own line.\n";
    let after = drafts::save_markdown(&pool, &enc, &draft.id, edited_md)
        .await
        .unwrap();
    let changed = block(&after, "Tea is a leaf, Camellia sinensis.");
    assert_eq!(changed.id, block(&before, "Tea is a leaf.").id);
    assert_eq!((changed.owner, changed.pinned), (BlockOwner::Mixed, true));
    let typed = block(&after, "My own line.");
    assert_eq!((typed.owner, typed.pinned), (BlockOwner::User, true));
    let kept = block(&after, "It is old.");
    assert_eq!((kept.owner, kept.pinned), (BlockOwner::Ai, false));
    assert_eq!(after.words, 13);

    // "Let AI edit" releases it; pinning it again keeps the owner.
    let released = drafts::set_block_pinned(&pool, &enc, &draft.id, &changed.id, false)
        .await
        .unwrap();
    assert!(!block(&released, "Tea is a leaf, Camellia sinensis.").pinned);
    assert!(
        drafts::set_block_pinned(&pool, &enc, &draft.id, "b999", true)
            .await
            .is_err()
    );

    // Saving the same Markdown again changes nothing.
    let same = drafts::save_markdown(&pool, &enc, &draft.id, edited_md)
        .await
        .unwrap();
    assert_eq!(same.blocks, released.blocks);
}

#[tokio::test]
async fn snapshots_skip_duplicates_and_restore_brings_state_back() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let draft = new_draft(&pool, &enc).await;
    // Unchanged since `created`: nothing recorded.
    assert!(
        drafts::snapshot(&pool, &enc, &draft.id, DraftSnapshotCause::Manual, None)
            .await
            .unwrap()
            .is_none()
    );

    drafts::save_markdown(&pool, &enc, &draft.id, "# Mine\n\nFirst version.")
        .await
        .unwrap();
    let first = drafts::snapshot(
        &pool,
        &enc,
        &draft.id,
        DraftSnapshotCause::Manual,
        Some("  Edited by you "),
    )
    .await
    .unwrap()
    .expect("a new entry");
    assert_eq!(first.label.as_deref(), Some("Edited by you"));
    assert_eq!(first.words, 3);
    let v1 = drafts::get(&pool, &enc, &draft.id).await.unwrap().unwrap();

    drafts::save_markdown(
        &pool,
        &enc,
        &draft.id,
        "# Mine\n\nSecond version, longer.\n\nNew.",
    )
    .await
    .unwrap();
    drafts::set_stage(&pool, &enc, &draft.id, DraftStage::Draft)
        .await
        .unwrap();
    drafts::snapshot(
        &pool,
        &enc,
        &draft.id,
        DraftSnapshotCause::AiTurn,
        Some("Make it longer"),
    )
    .await
    .unwrap()
    .expect("changed");
    let v2 = drafts::get(&pool, &enc, &draft.id).await.unwrap().unwrap();
    let new_id = block(&v2, "New.").id.clone();

    let restored = drafts::restore_snapshot(&pool, &enc, &draft.id, &first.id)
        .await
        .unwrap();
    assert_eq!(restored.markdown, v1.markdown);
    assert_eq!(restored.blocks, v1.blocks);
    assert_eq!(restored.stage, DraftStage::Outline);
    let history = drafts::list_snapshots(&pool, &draft.id).await.unwrap();
    assert_eq!(
        history.iter().map(|s| s.cause).collect::<Vec<_>>(),
        [
            DraftSnapshotCause::Restore,
            DraftSnapshotCause::AiTurn,
            DraftSnapshotCause::Manual,
            DraftSnapshotCause::Created
        ]
    );
    assert_eq!(history[0].label.as_deref(), Some("Edited by you"));

    // An id handed out after the snapshot is never reused once restored.
    let more = drafts::save_markdown(
        &pool,
        &enc,
        &draft.id,
        "# Mine\n\nFirst version.\n\nAnother.",
    )
    .await
    .unwrap();
    assert_ne!(block(&more, "Another.").id, new_id);

    assert!(drafts::restore_snapshot(&pool, &enc, &draft.id, "missing")
        .await
        .is_err());
}

#[tokio::test]
async fn snapshots_are_capped() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let draft = new_draft(&pool, &enc).await;
    for i in 0..(drafts::MAX_SNAPSHOTS + 5) {
        drafts::save_markdown(&pool, &enc, &draft.id, &format!("Version {i}"))
            .await
            .unwrap();
        drafts::snapshot(&pool, &enc, &draft.id, DraftSnapshotCause::Manual, None)
            .await
            .unwrap();
    }
    let history = drafts::list_snapshots(&pool, &draft.id).await.unwrap();
    assert_eq!(history.len() as i64, drafts::MAX_SNAPSHOTS);
}

#[tokio::test]
async fn content_is_encrypted_at_rest() {
    let pool = common::setup_pool().await;
    let enc = Encryption::on_with_key(conduit_desktop::encryption::generate_key(), 1);
    let draft = drafts::create(&pool, &enc, "secret brief").await.unwrap();
    drafts::set_outline(
        &pool,
        &enc,
        &draft.id,
        vec![section("Hidden heading")],
        false,
    )
    .await
    .unwrap();
    drafts::save_markdown(&pool, &enc, &draft.id, "secret paragraph")
        .await
        .unwrap();
    drafts::snapshot(&pool, &enc, &draft.id, DraftSnapshotCause::Manual, None)
        .await
        .unwrap();
    let (brief, outline, markdown, blocks): (String, String, String, String) =
        sqlx::query_as("SELECT brief, outline_json, markdown, blocks_json FROM drafts")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(!brief.contains("secret") && !outline.contains("Hidden"));
    assert!(!markdown.contains("secret") && !blocks.contains("\"b1\""));
    let payloads: Vec<(String,)> = sqlx::query_as("SELECT payload FROM draft_snapshots")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert!(payloads.iter().all(|(p,)| !p.contains("secret")));
    let back = drafts::get(&pool, &enc, &draft.id).await.unwrap().unwrap();
    assert_eq!(back.markdown, "secret paragraph");
    assert_eq!(back.brief, "secret brief");
}

#[test]
fn export_writes_the_file_or_reports_a_cancel() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("Tea 101.md");
    assert_eq!(export_draft_impl(None, "x").unwrap(), None);
    let saved = export_draft_impl(Some(path.clone()), "# Tea\n").unwrap();
    assert_eq!(saved.as_deref(), Some(path.to_string_lossy().as_ref()));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "# Tea\n");
}

// ---------------------------------------------------------------------------
// Draft tools
// ---------------------------------------------------------------------------

struct Harness {
    pool: SqlitePool,
    enc: Encryption,
    artifacts: tempfile::TempDir,
    exports: tempfile::TempDir,
    conversation_id: String,
    draft_id: String,
}

impl Harness {
    async fn new() -> Self {
        let pool = common::setup_pool().await;
        let enc = common::setup_encryption();
        let draft = new_draft(&pool, &enc).await;
        Self {
            pool,
            enc,
            artifacts: tempfile::tempdir().unwrap(),
            exports: tempfile::tempdir().unwrap(),
            conversation_id: draft.conversation_id,
            draft_id: draft.id,
        }
    }

    async fn run(&self, tool: &str, args: Value) -> AgentToolExecution {
        let ctx = AgentToolContext {
            db: &self.pool,
            artifacts_dir: self.artifacts.path(),
            exports_dir: self.exports.path(),
            encryption: &self.enc,
            conversation_id: &self.conversation_id,
            source_message_id: None,
            workspace: None,
            search: Default::default(),
            image: None,
        };
        agent_tools::execute_builtin_tool(&ctx, "call-1", "req-1", tool, &args)
            .await
            .unwrap()
    }

    async fn ok(&self, tool: &str, args: Value) -> Value {
        let out = self.run(tool, args).await;
        assert!(!out.is_error, "{tool} failed: {}", out.output);
        out.output
    }

    async fn err(&self, tool: &str, args: Value) -> String {
        let out = self.run(tool, args).await;
        assert!(out.is_error, "{tool} should have failed: {}", out.output);
        out.output["error"].as_str().unwrap().to_string()
    }

    async fn draft(&self) -> DraftDetail {
        drafts::get(&self.pool, &self.enc, &self.draft_id)
            .await
            .unwrap()
            .unwrap()
    }
}

fn outline_args() -> Value {
    json!({
        "title": "Tea for beginners",
        "sections": [
            { "heading": "What tea is", "intent": "Define it", "target_words": 150 },
            { "heading": "Brewing", "intent": "How to brew", "target_words": 250.0 },
            { "heading": "Next steps", "intent": "Where to go" },
        ]
    })
}

#[tokio::test]
async fn tools_need_a_draft_chat() {
    let mut h = Harness::new().await;
    h.conversation_id = conversations::create(&h.pool, None).await.unwrap().id;
    let err = h.err(READ_DRAFT_TOOL, json!({})).await;
    assert_eq!(err, "This chat isn't attached to a draft.");
}

#[tokio::test]
async fn the_outline_stage_gates_writing_and_the_draft_stage_gates_the_outline() {
    let h = Harness::new().await;
    let err = h
        .err(
            WRITE_SECTION_TOOL,
            json!({ "heading": "Brewing", "markdown": "x" }),
        )
        .await;
    assert!(err.contains("isn't approved"), "{err}");
    let err = h
        .err(
            SET_OUTLINE_TOOL,
            json!({ "sections": [{ "heading": "Only", "intent": "x" }] }),
        )
        .await;
    assert!(err.contains("2 to 12"), "{err}");

    let out = h.ok(SET_OUTLINE_TOOL, outline_args()).await;
    assert_eq!(out["sections"], 3);
    let draft = h.draft().await;
    assert_eq!(draft.title, "Tea for beginners");
    assert_eq!(draft.outline[1].target_words, Some(250));
    assert_eq!(draft.outline[2].target_words, None);

    drafts::set_stage(&h.pool, &h.enc, &h.draft_id, DraftStage::Draft)
        .await
        .unwrap();
    let err = h.err(SET_OUTLINE_TOOL, outline_args()).await;
    assert!(err.contains("already approved"), "{err}");
}

#[tokio::test]
async fn sections_are_written_in_outline_order_and_read_back() {
    let h = Harness::new().await;
    h.ok(SET_OUTLINE_TOOL, outline_args()).await;
    drafts::set_stage(&h.pool, &h.enc, &h.draft_id, DraftStage::Draft)
        .await
        .unwrap();

    let out = h
        .ok(
            WRITE_SECTION_TOOL,
            json!({ "heading": "Next steps", "markdown": "Try oolong.", "more_to_write": true }),
        )
        .await;
    assert_eq!(out["more_to_write"], true);
    assert_eq!(out["section_blocks"].as_array().unwrap().len(), 2);
    h.ok(
        WRITE_SECTION_TOOL,
        json!({ "heading": "What tea is", "markdown": "## What tea is\n\nA drink.\n\n- green\n- black" }),
    )
    .await;
    let draft = h.draft().await;
    assert_eq!(
        draft.markdown,
        "## What tea is\n\nA drink.\n\n- green\n- black\n\n## Next steps\n\nTry oolong.\n"
    );

    // Rewriting a section keeps the ids of what it kept.
    let heading_id = block(&draft, "## What tea is").id.clone();
    let out = h
        .ok(
            WRITE_SECTION_TOOL,
            json!({ "heading": "what tea is", "markdown": "A drink made from leaves.\n\n- green\n- black" }),
        )
        .await;
    let draft = h.draft().await;
    assert_eq!(block(&draft, "## What tea is").id, heading_id);
    assert_eq!(out["changed"].as_array().unwrap().len(), 1);

    let read = h.ok(READ_DRAFT_TOOL, json!({})).await;
    assert_eq!(read["stage"], "draft");
    assert_eq!(read["outline"].as_array().unwrap().len(), 3);
    let blocks = read["blocks"].as_array().unwrap();
    assert_eq!(blocks.len(), draft.blocks.len());
    assert_eq!(blocks[1]["text"], "A drink made from leaves.");
    assert_eq!(blocks[2]["kind"], "list");
    assert_eq!(blocks[0]["owner"], "ai");
    assert!(read.get("note").is_none());

    let ranged = h
        .ok(
            READ_DRAFT_TOOL,
            json!({ "from_block": blocks[1]["id"], "to_block": blocks[2]["id"] }),
        )
        .await;
    assert_eq!(ranged["blocks"].as_array().unwrap().len(), 2);
    let err = h
        .err(READ_DRAFT_TOOL, json!({ "from_block": "b999" }))
        .await;
    assert!(err.contains("read_draft"), "{err}");
}

#[tokio::test]
async fn read_draft_cuts_a_long_draft_and_says_where_to_continue() {
    let h = Harness::new().await;
    let paragraph = "word ".repeat(2_000);
    let md: Vec<String> = (0..20).map(|i| format!("{i} {paragraph}")).collect();
    drafts::save_markdown(&h.pool, &h.enc, &h.draft_id, &md.join("\n\n"))
        .await
        .unwrap();
    let read = h.ok(READ_DRAFT_TOOL, json!({})).await;
    let returned = read["blocks"].as_array().unwrap().len();
    assert!(returned < 20 && returned > 0);
    let note = read["note"].as_str().unwrap();
    assert!(note.contains("from_block"), "{note}");
    assert_eq!(read["block_count"], 20);
}

#[tokio::test]
async fn pinned_blocks_are_kept_unless_released_and_replace_passes_pins() {
    let h = Harness::new().await;
    h.ok(SET_OUTLINE_TOOL, outline_args()).await;
    drafts::set_stage(&h.pool, &h.enc, &h.draft_id, DraftStage::Draft)
        .await
        .unwrap();
    h.ok(
        WRITE_SECTION_TOOL,
        json!({ "heading": "Brewing", "markdown": "Boil water.\n\nSteep the tea." }),
    )
    .await;
    let draft = h.draft().await;
    let edited = draft
        .markdown
        .replace("Boil water.", "Heat water to 80C, not boiling.");
    let draft = drafts::save_markdown(&h.pool, &h.enc, &h.draft_id, &edited)
        .await
        .unwrap();
    let mine = block(&draft, "Heat water to 80C, not boiling.").clone();
    assert!(mine.pinned);

    // Rewriting the section without the user's paragraph is refused.
    let err = h
        .err(
            WRITE_SECTION_TOOL,
            json!({ "heading": "Brewing", "markdown": "Boil water.\n\nSteep it." }),
        )
        .await;
    assert!(
        err.contains(&mine.id) && err.contains("release_pinned"),
        "{err}"
    );
    // Keeping it word for word is fine.
    let out = h
        .ok(
            WRITE_SECTION_TOOL,
            json!({ "heading": "Brewing", "markdown": "Heat water to 80C, not boiling.\n\nSteep it for three minutes." }),
        )
        .await;
    assert_eq!(out["kept_pinned"], json!([mine.id]));

    // edit_blocks on it: refused, then allowed with release_pinned.
    let err = h
        .err(
            EDIT_BLOCKS_TOOL,
            json!({ "edits": [{ "block_id": mine.id, "markdown": "Use hot water." }] }),
        )
        .await;
    assert!(err.contains("written by the user"), "{err}");
    assert_eq!(h.draft().await.markdown, draft_markdown_with_steep());
    let out = h
        .ok(
            EDIT_BLOCKS_TOOL,
            json!({ "edits": [{ "block_id": mine.id, "markdown": "Use water just off the boil." }], "release_pinned": [mine.id] }),
        )
        .await;
    assert_eq!(out["changed"], json!([mine.id]));
    let draft = h.draft().await;
    let now = block(&draft, "Use water just off the boil.");
    assert_eq!((now.owner, now.pinned), (BlockOwner::Ai, false));

    // replace_in_draft changes pinned blocks too and keeps them pinned.
    let draft = drafts::save_markdown(
        &h.pool,
        &h.enc,
        &h.draft_id,
        &draft.markdown.replace("Steep it for", "Steep the tea for"),
    )
    .await
    .unwrap();
    let pinned_id = block(&draft, "Steep the tea for three minutes.").id.clone();
    let out = h
        .ok(
            REPLACE_IN_DRAFT_TOOL,
            json!({ "find": "tea", "replace": "leaves", "whole_word": true }),
        )
        .await;
    assert_eq!(out["total"], 1);
    assert_eq!(out["pinned_changed"], json!([pinned_id]));
    let draft = h.draft().await;
    let swapped = block(&draft, "Steep the leaves for three minutes.");
    assert_eq!(
        (swapped.id.as_str(), swapped.pinned),
        (pinned_id.as_str(), true)
    );

    // Split and delete through edit_blocks.
    let first = block(&draft, "Use water just off the boil.").id.clone();
    let out = h
        .ok(
            EDIT_BLOCKS_TOOL,
            json!({ "edits": [{ "block_id": first, "markdown": "Use fresh water.\n\nJust off the boil." }] }),
        )
        .await;
    assert_eq!(out["added"].as_array().unwrap().len(), 1);
    let draft = h.draft().await;
    let added = block(&draft, "Just off the boil.").id.clone();
    let out = h
        .ok(
            EDIT_BLOCKS_TOOL,
            json!({ "edits": [{ "block_id": added, "markdown": "" }] }),
        )
        .await;
    assert_eq!(out["removed"], json!([added]));
    assert!(h
        .draft()
        .await
        .markdown
        .contains("Use fresh water.\n\nSteep the leaves"));
}

fn draft_markdown_with_steep() -> String {
    "## Brewing\n\nHeat water to 80C, not boiling.\n\nSteep it for three minutes.\n".to_string()
}
