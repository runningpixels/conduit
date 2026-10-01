//! Slides repository: decks, slide ordering, snapshots and the chat binding.

#[path = "common/mod.rs"]
mod common;

use conduit_desktop::db::repository::{conversations, slides};
use provider_core::schema::{DeckDetail, DeckSnapshotCause, DeckStage, StorylineItem};
use sqlx::SqlitePool;

async fn new_deck(pool: &SqlitePool, conversation_id: Option<&str>) -> DeckDetail {
    let enc = common::setup_encryption();
    slides::create(
        pool,
        &enc,
        "  Q3 review ",
        "ink",
        ".slide{color:red}",
        conversation_id,
    )
    .await
    .unwrap()
}

async fn add(pool: &SqlitePool, deck: &str, html: &str) -> String {
    let enc = common::setup_encryption();
    slides::add_slide(pool, &enc, deck, "content", html, "", None)
        .await
        .unwrap()
        .0
        .id
}

async fn order(pool: &SqlitePool, deck: &str) -> Vec<(String, u32)> {
    let enc = common::setup_encryption();
    slides::get(pool, &enc, deck)
        .await
        .unwrap()
        .unwrap()
        .slides
        .into_iter()
        .map(|s| (s.html, s.position))
        .collect()
}

fn htmls(order: &[(String, u32)]) -> Vec<&str> {
    order.iter().map(|(h, _)| h.as_str()).collect()
}

#[tokio::test]
async fn create_and_get_round_trip() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let conv = conversations::create(&pool, Some("Deck chat"))
        .await
        .unwrap();
    let deck = new_deck(&pool, Some(&conv.id)).await;

    assert_eq!(deck.title, "Q3 review");
    assert_eq!(deck.theme_name, "ink");
    assert_eq!(deck.theme_css, ".slide{color:red}");
    assert_eq!(deck.stage, DeckStage::Storyline);
    assert!(deck.storyline.is_empty() && deck.slides.is_empty());

    let by_id = slides::get(&pool, &enc, &deck.id).await.unwrap().unwrap();
    assert_eq!(by_id.conversation_id.as_deref(), Some(conv.id.as_str()));
    let by_chat = slides::get_by_conversation(&pool, &enc, &conv.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(by_chat.id, deck.id);
    assert!(slides::get_by_conversation(&pool, &enc, "nope")
        .await
        .unwrap()
        .is_none());

    let list = slides::list(&pool).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].slide_count, 0);
    assert_eq!(list[0].stage, DeckStage::Storyline);
}

#[tokio::test]
async fn one_deck_per_chat() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let conv = conversations::create(&pool, None).await.unwrap();
    new_deck(&pool, Some(&conv.id)).await;
    assert!(
        slides::create(&pool, &enc, "Again", "ink", "", Some(&conv.id))
            .await
            .is_err()
    );
    // Decks without a chat are unconstrained.
    new_deck(&pool, None).await;
    new_deck(&pool, None).await;
}

#[tokio::test]
async fn content_is_encrypted_at_rest() {
    let pool = common::setup_pool().await;
    let enc = conduit_desktop::encryption::Encryption::on_with_key(
        conduit_desktop::encryption::generate_key(),
        1,
    );
    let deck = slides::create(&pool, &enc, "Secret", "ink", ".secret-css{}", None)
        .await
        .unwrap();
    slides::add_slide(
        &pool,
        &enc,
        &deck.id,
        "title",
        "<h1>secret slide</h1>",
        "private note",
        None,
    )
    .await
    .unwrap();
    let (css,): (String,) = sqlx::query_as("SELECT theme_css FROM decks")
        .fetch_one(&pool)
        .await
        .unwrap();
    let (html, notes): (String, String) = sqlx::query_as("SELECT html, notes FROM deck_slides")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(!css.contains("secret-css") && !html.contains("secret") && !notes.contains("private"));
    let back = slides::get(&pool, &enc, &deck.id).await.unwrap().unwrap();
    assert_eq!(back.slides[0].html, "<h1>secret slide</h1>");
    assert_eq!(back.slides[0].notes, "private note");
}

#[tokio::test]
async fn storyline_keeps_ids_and_fills_blanks() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let deck = new_deck(&pool, None).await;
    let updated = slides::set_storyline(
        &pool,
        &enc,
        &deck.id,
        vec![
            StorylineItem {
                id: "keep".into(),
                text: "Intro".into(),
            },
            StorylineItem {
                id: " ".into(),
                text: "Numbers".into(),
            },
        ],
    )
    .await
    .unwrap();
    assert_eq!(updated.storyline[0].id, "keep");
    assert!(!updated.storyline[1].id.trim().is_empty());
    let too_many = (0..61)
        .map(|i| StorylineItem {
            id: i.to_string(),
            text: "x".into(),
        })
        .collect();
    assert!(slides::set_storyline(&pool, &enc, &deck.id, too_many)
        .await
        .is_err());
}

#[tokio::test]
async fn slides_stay_densely_numbered() {
    let pool = common::setup_pool().await;
    let deck = new_deck(&pool, None).await;
    let enc = common::setup_encryption();
    let a = add(&pool, &deck.id, "a").await;
    let b = add(&pool, &deck.id, "b").await;
    let c = add(&pool, &deck.id, "c").await;
    assert_eq!(htmls(&order(&pool, &deck.id).await), ["a", "b", "c"]);

    // Insert after the first.
    let (d, count) = slides::add_slide(&pool, &enc, &deck.id, "content", "d", "", Some(&a))
        .await
        .unwrap();
    assert_eq!((d.position, count), (1, 4));
    assert_eq!(htmls(&order(&pool, &deck.id).await), ["a", "d", "b", "c"]);

    // Move last to the front, then past the end (clamped).
    assert_eq!(slides::move_slide(&pool, &deck.id, &c, 0).await.unwrap(), 0);
    assert_eq!(htmls(&order(&pool, &deck.id).await), ["c", "a", "d", "b"]);
    assert_eq!(
        slides::move_slide(&pool, &deck.id, &c, 99).await.unwrap(),
        3
    );
    assert_eq!(htmls(&order(&pool, &deck.id).await), ["a", "d", "b", "c"]);

    // Delete closes the gap.
    assert_eq!(
        slides::delete_slide(&pool, &deck.id, &d.id).await.unwrap(),
        3
    );
    let now = order(&pool, &deck.id).await;
    assert_eq!(htmls(&now), ["a", "b", "c"]);
    assert_eq!(now.iter().map(|(_, p)| *p).collect::<Vec<_>>(), [0, 1, 2]);
    assert_eq!(
        slides::list(&pool).await.unwrap()[0].slide_count,
        3,
        "summary counts the slides"
    );

    assert!(slides::delete_slide(&pool, &deck.id, "missing")
        .await
        .is_err());
    assert!(slides::move_slide(&pool, &deck.id, "missing", 0)
        .await
        .is_err());
    assert!(
        slides::add_slide(&pool, &enc, &deck.id, "content", "x", "", Some("missing"))
            .await
            .is_err()
    );
    assert_eq!(slides::move_slide(&pool, &deck.id, &b, 0).await.unwrap(), 0);
}

#[tokio::test]
async fn slide_validation_is_readable() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let deck = new_deck(&pool, None).await;

    let script = slides::add_slide(
        &pool,
        &enc,
        &deck.id,
        "content",
        "<p>x</p><ScRiPt>1</ScRiPt>",
        "",
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(
        slides::user_message(script),
        "Slides can't contain scripts. Draw charts as inline SVG."
    );
    for bad_layout in ["Title", "9col", "", "has space"] {
        assert!(
            slides::add_slide(&pool, &enc, &deck.id, bad_layout, "x", "", None)
                .await
                .is_err(),
            "{bad_layout:?}"
        );
    }
    let long = "x".repeat(60_001);
    assert!(
        slides::add_slide(&pool, &enc, &deck.id, "content", &long, "", None)
            .await
            .is_err()
    );
    let long_notes = "n".repeat(10_001);
    assert!(
        slides::add_slide(&pool, &enc, &deck.id, "content", "x", &long_notes, None)
            .await
            .is_err()
    );
    assert!(
        slides::set_theme(&pool, &enc, &deck.id, "big", &"c".repeat(100_001))
            .await
            .is_err()
    );
    assert!(slides::rename(&pool, &deck.id, "   ").await.is_err());
    assert!(order(&pool, &deck.id).await.is_empty(), "nothing was saved");

    let slide = add(&pool, &deck.id, "<p>ok</p>").await;
    assert!(slides::update_slide(
        &pool,
        &enc,
        &deck.id,
        &slide,
        slides::SlideChanges {
            html: Some("<script>x</script>".into()),
            ..Default::default()
        }
    )
    .await
    .is_err());
}

#[tokio::test]
async fn deck_is_capped_at_eighty_slides() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let deck = new_deck(&pool, None).await;
    for i in 0..80 {
        add(&pool, &deck.id, &format!("s{i}")).await;
    }
    let err = slides::add_slide(&pool, &enc, &deck.id, "content", "one more", "", None)
        .await
        .unwrap_err();
    assert!(slides::user_message(err).contains("80"));
}

#[tokio::test]
async fn snapshots_dedupe_restore_and_prune() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let deck = new_deck(&pool, None).await;

    let first = slides::snapshot(
        &pool,
        &enc,
        &deck.id,
        DeckSnapshotCause::Created,
        "Q3 review",
    )
    .await
    .unwrap()
    .expect("first snapshot is recorded");
    assert_eq!(first.slide_count, 0);
    assert!(
        slides::snapshot(&pool, &enc, &deck.id, DeckSnapshotCause::Manual, "same")
            .await
            .unwrap()
            .is_none(),
        "an unchanged deck is not snapshotted again"
    );

    let a = add(&pool, &deck.id, "<p>a</p>").await;
    add(&pool, &deck.id, "<p>b</p>").await;
    slides::set_stage(&pool, &enc, &deck.id, DeckStage::Slides)
        .await
        .unwrap();
    let second = slides::snapshot(&pool, &enc, &deck.id, DeckSnapshotCause::AiTurn, "build it")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(second.slide_count, 2);

    // Change things, then go back to the first (empty) state.
    slides::delete_slide(&pool, &deck.id, &a).await.unwrap();
    slides::set_theme(&pool, &enc, &deck.id, "paper", ".x{}")
        .await
        .unwrap();
    slides::rename(&pool, &deck.id, "Renamed").await.unwrap();
    let restored = slides::restore_snapshot(&pool, &enc, &deck.id, &first.id)
        .await
        .unwrap();
    assert_eq!(restored.title, "Q3 review");
    assert_eq!(restored.theme_name, "ink");
    assert_eq!(restored.stage, DeckStage::Storyline);
    assert!(restored.slides.is_empty());

    // And forward again: ids and order come back with it.
    let forward = slides::restore_snapshot(&pool, &enc, &deck.id, &second.id)
        .await
        .unwrap();
    assert_eq!(forward.stage, DeckStage::Slides);
    assert_eq!(forward.slides.len(), 2);
    assert_eq!(forward.slides[0].id, a);
    assert_eq!(forward.slides[1].position, 1);

    let history = slides::list_snapshots(&pool, &deck.id).await.unwrap();
    assert_eq!(history[0].cause, DeckSnapshotCause::Restore);
    assert_eq!(history[0].label, "Restored: build it");
    assert_eq!(history[1].label, "Restored: Q3 review");
    assert!(slides::restore_snapshot(&pool, &enc, &deck.id, "missing")
        .await
        .is_err());

    // A snapshot of another deck can't be restored here.
    let other = new_deck(&pool, None).await;
    assert!(slides::restore_snapshot(&pool, &enc, &other.id, &first.id)
        .await
        .is_err());
}

#[tokio::test]
async fn snapshot_history_keeps_the_newest_two_hundred() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let deck = new_deck(&pool, None).await;
    for i in 0..205 {
        slides::set_storyline(
            &pool,
            &enc,
            &deck.id,
            vec![StorylineItem {
                id: "one".into(),
                text: format!("version {i}"),
            }],
        )
        .await
        .unwrap();
        slides::snapshot(
            &pool,
            &enc,
            &deck.id,
            DeckSnapshotCause::Manual,
            &format!("v{i}"),
        )
        .await
        .unwrap()
        .expect("each version differs");
    }
    let history = slides::list_snapshots(&pool, &deck.id).await.unwrap();
    assert_eq!(history.len(), 200);
    assert_eq!(history[0].label, "v204");
    assert_eq!(history[199].label, "v5");
}

#[tokio::test]
async fn deleting_the_chat_leaves_the_deck() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let conv = conversations::create(&pool, None).await.unwrap();
    let deck = new_deck(&pool, Some(&conv.id)).await;
    add(&pool, &deck.id, "<p>kept</p>").await;

    conversations::delete(&pool, &conv.id).await.unwrap();

    let after = slides::get(&pool, &enc, &deck.id).await.unwrap().unwrap();
    assert_eq!(after.conversation_id, None);
    assert_eq!(after.slides.len(), 1);

    // Opening again binds a fresh chat.
    let again = conversations::create(&pool, None).await.unwrap();
    slides::bind_conversation(&pool, &deck.id, &again.id)
        .await
        .unwrap();
    assert_eq!(
        slides::get_by_conversation(&pool, &enc, &again.id)
            .await
            .unwrap()
            .unwrap()
            .id,
        deck.id
    );
}

#[tokio::test]
async fn deleting_a_deck_removes_slides_and_history() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let conv = conversations::create(&pool, None).await.unwrap();
    let deck = new_deck(&pool, Some(&conv.id)).await;
    add(&pool, &deck.id, "<p>x</p>").await;
    slides::snapshot(&pool, &enc, &deck.id, DeckSnapshotCause::Created, "x")
        .await
        .unwrap();

    let bound = slides::delete(&pool, &deck.id).await.unwrap();
    assert_eq!(bound.as_deref(), Some(conv.id.as_str()));
    for table in ["decks", "deck_slides", "deck_snapshots"] {
        let (n,): (i64,) = sqlx::query_as(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 0, "{table}");
    }
    // The chat is the command's to remove; the repository only reports it.
    assert!(conversations::get(&pool, &conv.id).await.unwrap().is_some());
}
