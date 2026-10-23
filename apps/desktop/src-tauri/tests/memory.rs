//! t1-5: persistent memory store — active injects, pending does not, disable-all empties.
//! Scopes: the user's own memory and each agent's notes are kept apart.
mod common;

use conduit_desktop::db::repository::memory::{
    self, agent_scope, compose_prompt_block, MemoryKind, MemoryOrigin, MemoryStatus, NewMemory,
};

#[tokio::test]
async fn active_fact_injects_pending_does_not_until_accepted() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();

    let pending = memory::create(
        &pool,
        &enc,
        NewMemory::global(
            MemoryKind::Core,
            "User prefers PENDING-MEMORY.",
            None,
            MemoryStatus::Pending,
        ),
    )
    .await
    .expect("create pending");

    let active_only = memory::list(&pool, &enc, Some(MemoryStatus::Active))
        .await
        .expect("list active");
    assert!(
        compose_prompt_block(&active_only, true).is_empty(),
        "pending rows must not inject"
    );

    memory::create(
        &pool,
        &enc,
        NewMemory::global(
            MemoryKind::Core,
            "User prefers BANANA-MEMORY.",
            None,
            MemoryStatus::Active,
        ),
    )
    .await
    .expect("create active");

    let active_only = memory::list(&pool, &enc, Some(MemoryStatus::Active))
        .await
        .expect("list active after create");
    let on = compose_prompt_block(&active_only, true);
    assert!(on.contains("BANANA-MEMORY"), "{on}");
    assert!(!on.contains("PENDING-MEMORY"), "{on}");

    let off = compose_prompt_block(&active_only, false);
    assert!(off.is_empty(), "disable-all must drop the memory block");

    memory::accept(&pool, &enc, &pending.id)
        .await
        .expect("accept pending");
    let after = memory::list(&pool, &enc, Some(MemoryStatus::Active))
        .await
        .expect("list after accept");
    let both = compose_prompt_block(&after, true);
    assert!(both.contains("PENDING-MEMORY"), "{both}");
    assert!(both.contains("BANANA-MEMORY"), "{both}");
}

#[tokio::test]
async fn an_agents_notes_stay_out_of_the_users_own_memory() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    memory::create(
        &pool,
        &enc,
        NewMemory::global(MemoryKind::Core, "Mine.", None, MemoryStatus::Pending),
    )
    .await
    .unwrap();
    let note = memory::create(
        &pool,
        &enc,
        NewMemory {
            kind: MemoryKind::Note,
            body: "Last report covered 1.80.".into(),
            source_conversation_id: None,
            pinned: false,
            status: MemoryStatus::Active,
            scope: agent_scope("researcher"),
            origin: Some(MemoryOrigin::ScheduledRun),
        },
    )
    .await
    .unwrap();

    // What lists the user's memory (the Memory page, the pending count on
    // Home, the chat's prompt block) sees only theirs.
    let all = memory::list(&pool, &enc, None).await.unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].body, "Mine.");
    assert_eq!(all[0].scope, "global");
    assert!(memory::list(&pool, &enc, Some(MemoryStatus::Active))
        .await
        .unwrap()
        .is_empty());
    let block = compose_prompt_block(&all, true);
    assert!(!block.contains("1.80"), "{block}");

    // The agent's own list has its note, with where it came from.
    let notes = memory::list_in(&pool, &enc, None, &agent_scope("researcher"))
        .await
        .unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].id, note.id);
    assert_eq!(notes[0].origin, Some(MemoryOrigin::ScheduledRun));
    let json = serde_json::to_value(&notes[0]).unwrap();
    assert_eq!(json["scope"], "agent:researcher");
    assert_eq!(json["origin"], "scheduled_run");
    assert!(memory::list_in(&pool, &enc, None, &agent_scope("writer"))
        .await
        .unwrap()
        .is_empty());
    let counts = memory::agent_note_counts(&pool).await.unwrap();
    assert_eq!(counts.get("researcher"), Some(&1));
    assert_eq!(counts.len(), 1);

    // A rewrite keeps its scope and takes the new origin.
    let rewritten = memory::rewrite(
        &pool,
        &enc,
        &note.id,
        "Last report covered 1.81.",
        Some(MemoryOrigin::Chat),
    )
    .await
    .unwrap();
    assert_eq!(rewritten.scope, "agent:researcher");
    let again = memory::get(&pool, &enc, &note.id).await.unwrap().unwrap();
    assert_eq!(again.body, "Last report covered 1.81.");
    assert_eq!(again.origin, Some(MemoryOrigin::Chat));
}

#[tokio::test]
async fn migration_46_keeps_existing_memory_as_the_users_own() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    for migration in conduit_desktop::db::MIGRATOR
        .iter()
        .filter(|m| m.version <= 45)
    {
        sqlx::raw_sql(&migration.sql).execute(&pool).await.unwrap();
    }
    sqlx::query(
        "INSERT INTO memory_items (id, kind, body, pinned, status, created_at, updated_at) \
         VALUES ('m1', 'core', 'Likes tea.', 0, 'pending', 't', 't')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let sql = conduit_desktop::db::MIGRATOR
        .iter()
        .find(|m| m.version == 46)
        .expect("migration 46")
        .sql
        .clone();
    sqlx::raw_sql(&sql).execute(&pool).await.unwrap();
    let row: (String, Option<String>) =
        sqlx::query_as("SELECT scope, origin FROM memory_items WHERE id = 'm1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(row, ("global".to_string(), None));
    let enc = common::setup_encryption();
    let pending = memory::list(&pool, &enc, Some(MemoryStatus::Pending))
        .await
        .unwrap();
    assert_eq!(pending.len(), 1, "the Home count still sees it");
    let index: Option<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_memory_items_scope_status'",
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(index.is_some());
}

#[tokio::test]
async fn a_scope_that_isnt_global_or_an_agents_is_refused() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let mut new = NewMemory::global(MemoryKind::Note, "x", None, MemoryStatus::Active);
    new.scope = "workflow:digest".into();
    let error = memory::create(&pool, &enc, new).await.unwrap_err();
    assert!(
        error.to_string().contains("unknown memory scope"),
        "{error}"
    );
}
