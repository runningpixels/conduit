//! The deck tools: they act on the deck bound to the chat they run in.

#[path = "common/mod.rs"]
mod common;

use conduit_desktop::{
    agent_tools::{
        self, AgentToolContext, AgentToolExecution, ADD_SLIDE_TOOL, DELETE_SLIDE_TOOL,
        MOVE_SLIDE_TOOL, PATCH_SLIDE_TOOL, READ_DECK_TOOL, SET_STORYLINE_TOOL, SET_THEME_TOOL,
        UPDATE_SLIDE_TOOL,
    },
    db::repository::{conversations, slides},
};
use provider_core::schema::DeckStage;
use serde_json::{json, Value};

struct Harness {
    pool: sqlx::SqlitePool,
    enc: conduit_desktop::encryption::Encryption,
    artifacts: tempfile::TempDir,
    exports: tempfile::TempDir,
    conversation_id: String,
    deck_id: String,
}

impl Harness {
    /// A chat with a deck bound to it.
    async fn bound() -> Self {
        let pool = common::setup_pool().await;
        let enc = common::setup_encryption();
        let conv = conversations::create(&pool, None).await.unwrap();
        let deck = slides::create(&pool, &enc, "Deck", "ink", ".slide{}", Some(&conv.id))
            .await
            .unwrap();
        Self {
            pool,
            enc,
            artifacts: tempfile::tempdir().unwrap(),
            exports: tempfile::tempdir().unwrap(),
            conversation_id: conv.id,
            deck_id: deck.id,
        }
    }

    /// A plain chat with no deck.
    async fn unbound() -> Self {
        let mut h = Self::bound().await;
        let conv = conversations::create(&h.pool, None).await.unwrap();
        h.conversation_id = conv.id;
        h
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

    async fn add(&self, html: &str) -> String {
        let out = self
            .ok(ADD_SLIDE_TOOL, json!({ "layout": "content", "html": html }))
            .await;
        out["slide_id"].as_str().unwrap().to_string()
    }
}

#[tokio::test]
async fn every_deck_tool_needs_a_bound_deck() {
    let h = Harness::unbound().await;
    let calls = [
        (READ_DECK_TOOL, json!({})),
        (SET_STORYLINE_TOOL, json!({ "lines": ["a"] })),
        (
            ADD_SLIDE_TOOL,
            json!({ "layout": "title", "html": "<h1>x</h1>" }),
        ),
        (UPDATE_SLIDE_TOOL, json!({ "slide_id": "s", "notes": "n" })),
        (
            PATCH_SLIDE_TOOL,
            json!({ "slide_id": "s", "edits": [{ "old_text": "a", "new_text": "b" }] }),
        ),
        (MOVE_SLIDE_TOOL, json!({ "slide_id": "s", "position": 0 })),
        (DELETE_SLIDE_TOOL, json!({ "slide_id": "s" })),
        (SET_THEME_TOOL, json!({ "css": ".x{}" })),
    ];
    for (tool, args) in calls {
        assert_eq!(
            h.err(tool, args).await,
            "This chat isn't attached to a deck.",
            "{tool}"
        );
    }
}

#[tokio::test]
async fn storyline_then_slides_then_outline() {
    let h = Harness::bound().await;
    let out = h
        .ok(
            SET_STORYLINE_TOOL,
            json!({ "lines": ["Intro", "  ", " Numbers "] }),
        )
        .await;
    assert_eq!(out["ok"], true);
    assert_eq!(out["lines"], 2);

    let first = h
        .ok(
            ADD_SLIDE_TOOL,
            json!({
                "layout": "title",
                "html": "<h1 data-text=\"title\">Q3 &amp; beyond</h1><p data-text=\"sub\">Where we are</p>",
                "notes": "Say hello",
            }),
        )
        .await;
    assert_eq!(first["position"], 0);
    assert_eq!(first["slide_count"], 1);
    let second = h
        .ok(
            ADD_SLIDE_TOOL,
            json!({ "layout": "content", "html": "<p>Revenue is up</p>", "after_slide_id": first["slide_id"] }),
        )
        .await;
    assert_eq!(second["position"], 1);

    let deck = slides::get(&h.pool, &h.enc, &h.deck_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        deck.stage,
        DeckStage::Slides,
        "adding a slide moves the deck on"
    );

    let outline = h.ok(READ_DECK_TOOL, json!({})).await;
    assert_eq!(outline["title"], "Deck");
    assert_eq!(outline["theme_name"], "ink");
    assert_eq!(outline["stage"], "slides");
    assert_eq!(outline["storyline"], json!(["Intro", "Numbers"]));
    let slides_out = outline["slides"].as_array().unwrap();
    assert_eq!(slides_out.len(), 2);
    assert_eq!(slides_out[0]["slide_id"], first["slide_id"]);
    assert_eq!(slides_out[0]["layout"], "title");
    assert_eq!(slides_out[0]["text"], "Q3 & beyond Where we are");
    assert_eq!(slides_out[1]["text"], "Revenue is up");

    let one = h
        .ok(READ_DECK_TOOL, json!({ "slide_id": first["slide_id"] }))
        .await;
    assert_eq!(one["notes"], "Say hello");
    assert!(one["html"]
        .as_str()
        .unwrap()
        .contains("data-text=\"title\""));
    assert!(h
        .err(READ_DECK_TOOL, json!({ "slide_id": "nope" }))
        .await
        .contains("No slide 'nope'"));
}

#[tokio::test]
async fn outline_text_is_clipped() {
    let h = Harness::bound().await;
    h.add(&format!("<p>{}</p>", "word ".repeat(200))).await;
    let outline = h.ok(READ_DECK_TOOL, json!({})).await;
    let text = outline["slides"][0]["text"].as_str().unwrap();
    assert_eq!(text.chars().count(), 300);
    assert!(text.ends_with('…'));
}

#[tokio::test]
async fn patch_slide_edits_one_slide() {
    let h = Harness::bound().await;
    let a = h.add("<h1>Revenue up 10%</h1>").await;
    let b = h.add("<h1>Revenue up 10%</h1>").await;

    let out = h
        .ok(
            PATCH_SLIDE_TOOL,
            json!({ "slide_id": a, "edits": [{ "old_text": "10%", "new_text": "12%" }] }),
        )
        .await;
    assert_eq!(out["edits_applied"], 1);
    let deck = slides::get(&h.pool, &h.enc, &h.deck_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(deck.slides[0].html, "<h1>Revenue up 12%</h1>");
    assert_eq!(
        deck.slides[1].html, "<h1>Revenue up 10%</h1>",
        "other slides are untouched"
    );

    let miss = h
        .err(
            PATCH_SLIDE_TOOL,
            json!({ "slide_id": b, "edits": [{ "old_text": "nowhere", "new_text": "x" }] }),
        )
        .await;
    assert!(miss.contains("edit 1"), "{miss}");
    let script = h
        .err(
            PATCH_SLIDE_TOOL,
            json!({ "slide_id": b, "edits": [{ "old_text": "10%", "new_text": "<script>x</script>" }] }),
        )
        .await;
    assert!(script.contains("can't contain scripts"), "{script}");
    let deck = slides::get(&h.pool, &h.enc, &h.deck_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(deck.slides[1].html, "<h1>Revenue up 10%</h1>");
}

#[tokio::test]
async fn scripts_are_rejected_with_a_hint() {
    let h = Harness::bound().await;
    let err = h
        .err(
            ADD_SLIDE_TOOL,
            json!({ "layout": "content", "html": "<p>x</p><SCRIPT>1</SCRIPT>" }),
        )
        .await;
    assert_eq!(
        err,
        "Slides can't contain scripts. Draw charts as inline SVG."
    );
    let id = h.add("<p>ok</p>").await;
    let err = h
        .err(
            UPDATE_SLIDE_TOOL,
            json!({ "slide_id": id, "html": "<script src=x></script>" }),
        )
        .await;
    assert!(err.contains("scripts"));
    assert!(h
        .err(UPDATE_SLIDE_TOOL, json!({ "slide_id": id }))
        .await
        .contains("at least one"));
    h.err(
        ADD_SLIDE_TOOL,
        json!({ "layout": "Bad Layout", "html": "x" }),
    )
    .await;
}

#[tokio::test]
async fn update_move_delete_and_theme() {
    let h = Harness::bound().await;
    let a = h.add("<p>a</p>").await;
    let b = h.add("<p>b</p>").await;
    let c = h.add("<p>c</p>").await;

    h.ok(
        UPDATE_SLIDE_TOOL,
        json!({ "slide_id": a, "html": "<p>A</p>", "layout": "title", "notes": "n" }),
    )
    .await;
    let moved = h
        .ok(MOVE_SLIDE_TOOL, json!({ "slide_id": c, "position": 0 }))
        .await;
    assert_eq!(moved["position"], 0);
    let clamped = h
        .ok(MOVE_SLIDE_TOOL, json!({ "slide_id": c, "position": 50 }))
        .await;
    assert_eq!(clamped["position"], 2);
    let gone = h.ok(DELETE_SLIDE_TOOL, json!({ "slide_id": b })).await;
    assert_eq!(gone["slide_count"], 2);
    assert!(h
        .err(DELETE_SLIDE_TOOL, json!({ "slide_id": b }))
        .await
        .contains("No slide"));

    h.ok(SET_THEME_TOOL, json!({ "css": ".slide{background:#000}" }))
        .await;
    let deck = slides::get(&h.pool, &h.enc, &h.deck_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(deck.theme_name, "Custom");
    assert_eq!(deck.theme_css, ".slide{background:#000}");
    assert_eq!(deck.slides.len(), 2);
    assert_eq!(deck.slides[0].html, "<p>A</p>");
    assert_eq!(deck.slides[0].layout, "title");
    assert_eq!(deck.slides[0].notes, "n");
    assert_eq!(deck.slides[1].id, c);
    assert_eq!(
        deck.slides.iter().map(|s| s.position).collect::<Vec<_>>(),
        [0, 1]
    );

    h.ok(SET_THEME_TOOL, json!({ "css": ".x{}", "name": "Sunrise" }))
        .await;
    let deck = slides::get(&h.pool, &h.enc, &h.deck_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(deck.theme_name, "Sunrise");
}

#[tokio::test]
async fn set_theme_saves_the_model_theme_without_shadowing_a_built_in() {
    let h = Harness::bound().await;
    h.ok(
        SET_THEME_TOOL,
        json!({ "css": ".ember{}", "name": "Ember" }),
    )
    .await;
    h.ok(SET_THEME_TOOL, json!({ "css": ".mine{}", "name": "Ink" }))
        .await;

    let deck = slides::get(&h.pool, &h.enc, &h.deck_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(deck.theme_name, "Ink (custom)");
    let mut saved: Vec<String> = slides::list_themes(&h.pool, &h.enc)
        .await
        .unwrap()
        .into_iter()
        .map(|t| t.name)
        .collect();
    saved.sort();
    assert_eq!(saved, vec!["Ember", "Ink (custom)"]);
}
