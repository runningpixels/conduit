//! The deck tools: they act on the deck bound to the chat they run in.

#[path = "common/mod.rs"]
mod common;

use conduit_desktop::{
    agent_tools::{
        self, AgentToolContext, AgentToolExecution, ADD_SLIDE_TOOL, DELETE_SLIDE_TOOL,
        MOVE_SLIDE_TOOL, PATCH_SLIDE_TOOL, READ_DECK_TOOL, REPLACE_IN_DECK_TOOL,
        SET_STORYLINE_TOOL, SET_THEME_TOOL, UPDATE_SLIDE_TOOL, UPDATE_SLOTS_TOOL,
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

    /// Add a custom slide (the model writes its html).
    async fn add(&self, html: &str) -> String {
        let out = self
            .ok(ADD_SLIDE_TOOL, json!({ "layout": "custom", "html": html }))
            .await;
        out["slide_id"].as_str().unwrap().to_string()
    }

    /// Add a slide built from fields.
    async fn add_typed(&self, args: Value) -> String {
        let out = self.ok(ADD_SLIDE_TOOL, args).await;
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
        (REPLACE_IN_DECK_TOOL, json!({ "find": "a", "replace": "b" })),
        (
            UPDATE_SLOTS_TOOL,
            json!({ "edits": [{ "slide_id": "s", "slot": "t", "html": "x" }] }),
        ),
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
                "headline": "Q3 & beyond",
                "sub": "Where we are",
                "notes": "Say hello",
            }),
        )
        .await;
    assert_eq!(first["position"], 0);
    assert_eq!(first["slide_count"], 1);
    let second = h
        .ok(
            ADD_SLIDE_TOOL,
            json!({ "layout": "custom", "html": "<p>Revenue is up</p>", "after_slide_id": first["slide_id"] }),
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
    assert_eq!(
        one["fields"],
        json!({ "headline": "Q3 &amp; beyond", "sub": "Where we are" })
    );
    assert!(
        one.get("html").is_none(),
        "a slide built from fields is read as fields"
    );
    let custom = h
        .ok(READ_DECK_TOOL, json!({ "slide_id": second["slide_id"] }))
        .await;
    assert_eq!(custom["fields"], Value::Null);
    assert_eq!(custom["html"], "<p>Revenue is up</p>");
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
            json!({ "layout": "custom", "html": "<p>x</p><SCRIPT>1</SCRIPT>" }),
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
        json!({ "slide_id": a, "headline": "A", "layout": "title", "notes": "n" }),
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
    assert_eq!(
        deck.slides[0].html,
        r#"<h1 class="headline" data-text="headline">A</h1>"#
    );
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

const PINNED_SLIDE: &str =
    r#"<h1 data-text="title">Revenue</h1><p data-text="note" data-owner="user">Written by me</p>"#;

async fn html_of(h: &Harness, slide_id: &str) -> String {
    slides::get_slide(&h.pool, &h.enc, &h.deck_id, slide_id)
        .await
        .unwrap()
        .unwrap()
        .html
}

#[tokio::test]
async fn read_deck_lists_slots_with_pinned_flags() {
    let h = Harness::bound().await;
    let id = h.add(PINNED_SLIDE).await;
    let outline = h.ok(READ_DECK_TOOL, json!({})).await;
    assert_eq!(
        outline["slides"][0]["slots"],
        json!([
            { "name": "title", "text": "Revenue", "pinned": false },
            { "name": "note", "text": "Written by me", "pinned": true },
        ])
    );
    let long = h
        .add(&format!(
            r#"<p data-text="body">{}</p>"#,
            "word ".repeat(100)
        ))
        .await;
    let outline = h.ok(READ_DECK_TOOL, json!({})).await;
    let clipped = outline["slides"][1]["slots"][0]["text"].as_str().unwrap();
    assert_eq!(clipped.chars().count(), 120);
    let full = h.ok(READ_DECK_TOOL, json!({ "slide_id": long })).await;
    assert!(full["slots"][0]["text"].as_str().unwrap().chars().count() > 120);
    let one = h.ok(READ_DECK_TOOL, json!({ "slide_id": id })).await;
    assert_eq!(one["slots"][1]["pinned"], true);
}

#[tokio::test]
async fn update_slide_protects_pinned_slots() {
    let h = Harness::bound().await;
    let id = h.add(PINNED_SLIDE).await;

    let changed =
        r#"<h1 data-text="title">Revenue</h1><p data-text="note" data-owner="user">Rewritten</p>"#;
    let err = h
        .err(
            UPDATE_SLIDE_TOOL,
            json!({ "slide_id": id, "html": changed }),
        )
        .await;
    assert!(
        err.contains(r#"Slot "note""#) && err.contains("release_pinned"),
        "{err}"
    );
    assert_eq!(html_of(&h, &id).await, PINNED_SLIDE);

    h.ok(
        UPDATE_SLIDE_TOOL,
        json!({ "slide_id": id, "html": changed, "release_pinned": ["note"] }),
    )
    .await;
    assert_eq!(html_of(&h, &id).await, changed);
}

#[tokio::test]
async fn update_slide_re_adds_a_dropped_marker_when_content_is_kept() {
    let h = Harness::bound().await;
    let id = h.add(PINNED_SLIDE).await;
    let dropped = r#"<section><h1 data-text="title">Sales</h1><p data-text="note">Written by me</p></section>"#;
    h.ok(
        UPDATE_SLIDE_TOOL,
        json!({ "slide_id": id, "html": dropped }),
    )
    .await;
    assert_eq!(
        html_of(&h, &id).await,
        r#"<section><h1 data-text="title">Sales</h1><p data-text="note" data-owner="user">Written by me</p></section>"#
    );
}

#[tokio::test]
async fn patch_slide_protects_pinned_slots() {
    let h = Harness::bound().await;
    let id = h.add(PINNED_SLIDE).await;
    let err = h
        .err(
            PATCH_SLIDE_TOOL,
            json!({ "slide_id": id, "edits": [{ "old_text": "Written by me", "new_text": "Mine" }] }),
        )
        .await;
    assert!(err.contains("release_pinned"), "{err}");
    h.ok(
        PATCH_SLIDE_TOOL,
        json!({ "slide_id": id, "edits": [{ "old_text": "Revenue", "new_text": "Sales" }] }),
    )
    .await;
    h.ok(
        PATCH_SLIDE_TOOL,
        json!({
            "slide_id": id,
            "edits": [{ "old_text": "Written by me", "new_text": "Mine" }],
            "release_pinned": ["note"],
        }),
    )
    .await;
    assert!(html_of(&h, &id).await.contains(">Mine<"));
}

#[tokio::test]
async fn update_slots_skips_pinned_and_checks_content() {
    let h = Harness::bound().await;
    let a = h.add(PINNED_SLIDE).await;
    let b = h
        .add(r#"<p data-text="line">one</p><p data-text="line">two</p>"#)
        .await;

    let out = h
        .ok(
            UPDATE_SLOTS_TOOL,
            json!({ "edits": [
                { "slide_id": a, "slot": "title", "html": "Sales <em>up</em>" },
                { "slide_id": a, "slot": "note", "html": "Overwritten" },
                { "slide_id": b, "slot": "line", "index": 1, "html": "TWO" },
            ] }),
        )
        .await;
    assert_eq!(out["updated"], 2);
    assert_eq!(
        out["skipped_pinned"],
        json!([{ "slide_id": a, "slot": "note" }])
    );
    assert_eq!(
        html_of(&h, &a).await,
        r#"<h1 data-text="title">Sales <em>up</em></h1><p data-text="note" data-owner="user">Written by me</p>"#
    );
    assert_eq!(
        html_of(&h, &b).await,
        r#"<p data-text="line">one</p><p data-text="line">TWO</p>"#
    );

    let bad = h
        .err(
            UPDATE_SLOTS_TOOL,
            json!({ "edits": [
                { "slide_id": b, "slot": "line", "html": "changed" },
                { "slide_id": b, "slot": "line", "index": 1, "html": "<div>x</div>" },
            ] }),
        )
        .await;
    assert!(bad.contains("can only use"), "{bad}");
    assert_eq!(
        html_of(&h, &b).await,
        r#"<p data-text="line">one</p><p data-text="line">TWO</p>"#,
        "all or nothing"
    );
    let missing = h
        .err(
            UPDATE_SLOTS_TOOL,
            json!({ "edits": [{ "slide_id": b, "slot": "nope", "html": "x" }] }),
        )
        .await;
    assert!(missing.contains("No slot"), "{missing}");
    assert!(h
        .err(UPDATE_SLOTS_TOOL, json!({ "edits": [] }))
        .await
        .contains("at least one"));
}

#[tokio::test]
async fn replace_in_deck_reports_pinned_changes() {
    let h = Harness::bound().await;
    let a = h.add(PINNED_SLIDE).await;
    let b = h.add(r#"<p data-text="x">Revenue and revenue</p>"#).await;

    let out = h
        .ok(
            REPLACE_IN_DECK_TOOL,
            json!({ "find": "written by", "replace": "authored by" }),
        )
        .await;
    assert_eq!(out["total"], 1);
    assert_eq!(out["slides"], json!([{ "slide_id": a, "count": 1 }]));
    assert_eq!(
        out["pinned_changed"],
        json!([{ "slide_id": a, "slot": "note" }])
    );
    assert!(html_of(&h, &a).await.contains("authored by me"));

    let out = h
        .ok(
            REPLACE_IN_DECK_TOOL,
            json!({ "find": "revenue", "replace": "sales", "match_case": true, "whole_word": true }),
        )
        .await;
    assert_eq!(out["total"], 1);
    assert_eq!(out["pinned_changed"], json!([]));
    assert_eq!(
        html_of(&h, &b).await,
        r#"<p data-text="x">Revenue and sales</p>"#
    );
    assert!(h
        .err(REPLACE_IN_DECK_TOOL, json!({ "find": "", "replace": "x" }))
        .await
        .contains("find"));
}

// ---------------------------------------------------------------------------
// Typed slides
// ---------------------------------------------------------------------------

async fn slide_of(h: &Harness, slide_id: &str) -> provider_core::schema::DeckSlide {
    slides::get_slide(&h.pool, &h.enc, &h.deck_id, slide_id)
        .await
        .unwrap()
        .unwrap()
}

fn bar_chart() -> Value {
    json!({
        "type": "bar",
        "categories": ["Q1", "Q2", "Q3"],
        "series": [{ "name": "Revenue", "values": [3.0, 5.0, 8.0] }],
        "unit_prefix": "$",
        "unit_suffix": "M",
        "highlight": [2]
    })
}

#[tokio::test]
async fn add_slide_builds_typed_layouts() {
    let h = Harness::bound().await;
    let cases = [
        json!({ "layout": "title", "kicker": "Q3", "headline": "We grew", "sub": "And kept margins" }),
        json!({ "layout": "statement", "headline": "Ship less, better" }),
        json!({ "layout": "bullets", "headline": "Why now", "bullets": ["One", "Two", "Three"] }),
        json!({ "layout": "stat-row", "stats": [{ "value": "42%", "label": "faster builds" }, { "value": "3x", "label": "more teams" }] }),
        json!({ "layout": "two-col", "headline": "Before and after", "columns": [{ "kicker": "Before", "body": "Slow" }, { "kicker": "After", "bullets": ["Fast", "Cheap"] }] }),
        json!({ "layout": "quote", "quote": "Make it simple", "cite": "A. Person" }),
        json!({ "layout": "section", "kicker": "Part 2", "headline": "The plan" }),
        json!({ "layout": "image-left", "headline": "Reach", "body": "Two regions", "chart": bar_chart() }),
        json!({ "layout": "chart", "headline": "Revenue tripled", "chart": bar_chart(), "footnote": "FY25" }),
    ];
    for args in cases {
        let layout = args["layout"].as_str().unwrap().to_string();
        let id = h.add_typed(args.clone()).await;
        let slide = slide_of(&h, &id).await;
        assert_eq!(slide.layout, layout);
        let one = h.ok(READ_DECK_TOOL, json!({ "slide_id": id })).await;
        let mut expected = args.clone();
        expected.as_object_mut().unwrap().remove("layout");
        assert_eq!(one["fields"], expected, "{layout} reads back as its fields");
    }
    // Every text slot carries the builder's names.
    let deck = slides::get(&h.pool, &h.enc, &h.deck_id)
        .await
        .unwrap()
        .unwrap();
    let names: Vec<&str> = deck.slides[3]
        .slots
        .iter()
        .map(|s| s.name.as_str())
        .collect();
    assert_eq!(
        names,
        [
            "stat-1-value",
            "stat-1-label",
            "stat-2-value",
            "stat-2-label"
        ]
    );
}

#[tokio::test]
async fn add_slide_reports_every_budget_problem_at_once() {
    let h = Harness::bound().await;
    let err = h
        .err(
            ADD_SLIDE_TOOL,
            json!({
                "layout": "stat-row",
                "headline": "Memory",
                "stats": [{ "value": "16 B/param", "label": "weights" }, { "value": "2", "label": "x" }],
                "bullets": ["a", "b", "c", "d", "e", "f", "g"],
            }),
        )
        .await;
    assert_eq!(
        err,
        "stat-row does not use bullets — leave it out. stats[0].value \"16 B/param\" is 10 characters; at most 6 — put the unit or context in the label."
    );
    let err = h
        .err(
            ADD_SLIDE_TOOL,
            json!({ "layout": "bullets", "headline": "Too many", "bullets": ["a", "b", "c", "d", "e", "f", "g"] }),
        )
        .await;
    assert_eq!(err, "bullets has 7 items; at most 5 — split the slide.");
    let err = h
        .err(
            ADD_SLIDE_TOOL,
            json!({ "layout": "stat-row", "html": "<div class=\"stat\">x</div>" }),
        )
        .await;
    assert_eq!(
        err,
        "html is only for layout custom; for stat-row pass headline and stats."
    );
    let err = h
        .err(
            ADD_SLIDE_TOOL,
            json!({ "layout": "agenda", "headline": "x" }),
        )
        .await;
    assert!(
        err.starts_with("layout \"agenda\" is not a layout"),
        "{err}"
    );
    let deck = slides::get(&h.pool, &h.enc, &h.deck_id)
        .await
        .unwrap()
        .unwrap();
    assert!(deck.slides.is_empty(), "nothing is stored");
}

#[tokio::test]
async fn update_slide_merges_fields() {
    let h = Harness::bound().await;
    let id = h
        .add_typed(json!({ "layout": "title", "kicker": "Q3", "headline": "We grew", "sub": "Margins held" }))
        .await;
    h.ok(
        UPDATE_SLIDE_TOOL,
        json!({ "slide_id": id, "headline": "We grew 40%", "kicker": null }),
    )
    .await;
    let one = h.ok(READ_DECK_TOOL, json!({ "slide_id": id })).await;
    assert_eq!(
        one["fields"],
        json!({ "headline": "We grew 40%", "sub": "Margins held" })
    );

    // A layout change carries fields by name and needs the new layout's own.
    let err = h
        .err(
            UPDATE_SLIDE_TOOL,
            json!({ "slide_id": id, "layout": "bullets" }),
        )
        .await;
    assert_eq!(err, "bullets is required for layout bullets.");
    h.ok(
        UPDATE_SLIDE_TOOL,
        json!({ "slide_id": id, "layout": "bullets", "bullets": ["Revenue", "Margin"] }),
    )
    .await;
    let one = h.ok(READ_DECK_TOOL, json!({ "slide_id": id })).await;
    assert_eq!(one["layout"], "bullets");
    assert_eq!(
        one["fields"],
        json!({ "headline": "We grew 40%", "bullets": ["Revenue", "Margin"] })
    );

    // A wording edit through update_slots keeps the slide readable as fields.
    h.ok(
        UPDATE_SLOTS_TOOL,
        json!({ "edits": [{ "slide_id": id, "slot": "bullet-2", "html": "Gross <em>margin</em>" }] }),
    )
    .await;
    let one = h.ok(READ_DECK_TOOL, json!({ "slide_id": id })).await;
    assert_eq!(
        one["fields"]["bullets"],
        json!(["Revenue", "Gross <em>margin</em>"])
    );

    // notes alone touch nothing else.
    let before = slide_of(&h, &id).await.html;
    h.ok(
        UPDATE_SLIDE_TOOL,
        json!({ "slide_id": id, "notes": "Pause here" }),
    )
    .await;
    let after = slide_of(&h, &id).await;
    assert_eq!((after.html, after.notes.as_str()), (before, "Pause here"));

    // A chart is edited through its spec.
    let chart = h
        .add_typed(json!({ "layout": "chart", "headline": "Revenue", "chart": bar_chart() }))
        .await;
    let mut spec = bar_chart();
    spec["series"][0]["values"] = json!([3, 5, 13]);
    h.ok(
        UPDATE_SLIDE_TOOL,
        json!({ "slide_id": chart, "chart": spec }),
    )
    .await;
    let one = h.ok(READ_DECK_TOOL, json!({ "slide_id": chart })).await;
    assert_eq!(
        one["fields"]["chart"]["series"][0]["values"],
        json!([3.0, 5.0, 13.0])
    );
    assert_eq!(one["fields"]["headline"], "Revenue");
}

#[tokio::test]
async fn update_slide_keeps_pinned_slots_by_name() {
    let h = Harness::bound().await;
    let id = h
        .add_typed(json!({ "layout": "bullets", "headline": "Mine", "bullets": ["a", "b"] }))
        .await;
    slides::set_slot_pinned(&h.pool, &h.enc, &h.deck_id, &id, 0, "headline", true)
        .await
        .unwrap();

    let out = h
        .ok(
            UPDATE_SLIDE_TOOL,
            json!({ "slide_id": id, "headline": "Theirs", "bullets": ["c", "d", "e"] }),
        )
        .await;
    assert_eq!(out["kept_pinned"], json!(["headline"]));
    let html = slide_of(&h, &id).await.html;
    assert!(
        html.contains(r#"<h2 class="headline" data-text="headline" data-owner="user">Mine</h2>"#),
        "{html}"
    );
    assert!(html.contains(">e</li>"));

    // A layout without that slot: release it or keep the layout.
    let err = h
        .err(
            UPDATE_SLIDE_TOOL,
            json!({ "slide_id": id, "layout": "quote", "quote": "Q" }),
        )
        .await;
    assert!(
        err.starts_with("Slot \"headline\" is pinned")
            && err.contains("release_pinned: [\"headline\"]"),
        "{err}"
    );
    h.ok(
        UPDATE_SLIDE_TOOL,
        json!({ "slide_id": id, "headline": "Theirs", "release_pinned": ["headline"] }),
    )
    .await;
    let one = h.ok(READ_DECK_TOOL, json!({ "slide_id": id })).await;
    assert_eq!(one["fields"]["headline"], "Theirs");
    assert_eq!(one["slots"][0]["pinned"], false);
}

#[tokio::test]
async fn legacy_slides_need_every_field() {
    let h = Harness::bound().await;
    // An older slide: hand-written html under a typed layout name.
    let (legacy, _) = slides::add_slide(
        &h.pool,
        &h.enc,
        &h.deck_id,
        "bullets",
        r#"<h2 class="headline" data-text="title">Old</h2><ul><li data-text="b">x</li></ul>"#,
        "",
        None,
    )
    .await
    .unwrap();
    let one = h.ok(READ_DECK_TOOL, json!({ "slide_id": legacy.id })).await;
    assert_eq!(one["fields"], Value::Null);
    assert!(one["html"].as_str().unwrap().contains("Old"));

    let err = h
        .err(
            UPDATE_SLIDE_TOOL,
            json!({ "slide_id": legacy.id, "headline": "New" }),
        )
        .await;
    assert_eq!(
        err,
        "This slide was not built from fields, so pass every field for layout bullets. bullets is required for layout bullets."
    );
    h.ok(
        UPDATE_SLIDE_TOOL,
        json!({ "slide_id": legacy.id, "headline": "New", "bullets": ["a", "b"] }),
    )
    .await;
    let one = h.ok(READ_DECK_TOOL, json!({ "slide_id": legacy.id })).await;
    assert_eq!(
        one["fields"],
        json!({ "headline": "New", "bullets": ["a", "b"] })
    );

    // A layout name outside the typed set.
    let (odd, _) = slides::add_slide(&h.pool, &h.enc, &h.deck_id, "agenda", "<p>x</p>", "", None)
        .await
        .unwrap();
    let err = h
        .err(
            UPDATE_SLIDE_TOOL,
            json!({ "slide_id": odd.id, "headline": "New" }),
        )
        .await;
    assert!(
        err.starts_with("This slide's layout \"agenda\" is not one of the layouts"),
        "{err}"
    );
    // html on a typed layout is refused; with layout custom it is the slide.
    let err = h
        .err(
            UPDATE_SLIDE_TOOL,
            json!({ "slide_id": odd.id, "layout": "statement", "html": "<p>y</p>" }),
        )
        .await;
    assert!(
        err.contains("html is only for layout custom; for statement pass headline."),
        "{err}"
    );
    h.ok(
        UPDATE_SLIDE_TOOL,
        json!({ "slide_id": odd.id, "layout": "custom", "html": "<p data-text=\"y\">y</p>" }),
    )
    .await;
    let slide = slide_of(&h, &odd.id).await;
    assert_eq!(
        (slide.layout.as_str(), slide.html.as_str()),
        ("custom", "<p data-text=\"y\">y</p>")
    );
}
