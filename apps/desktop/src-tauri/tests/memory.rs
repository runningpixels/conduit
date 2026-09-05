//! t1-5: persistent memory store — active injects, pending does not, disable-all empties.
mod common;

use conduit_desktop::db::repository::memory::{
    self, compose_prompt_block, MemoryKind, MemoryStatus, NewMemory,
};

#[tokio::test]
async fn active_fact_injects_pending_does_not_until_accepted() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();

    let pending = memory::create(
        &pool,
        &enc,
        NewMemory {
            kind: MemoryKind::Core,
            body: "User prefers PENDING-MEMORY.".into(),
            source_conversation_id: None,
            pinned: false,
            status: MemoryStatus::Pending,
        },
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
        NewMemory {
            kind: MemoryKind::Core,
            body: "User prefers BANANA-MEMORY.".into(),
            source_conversation_id: None,
            pinned: false,
            status: MemoryStatus::Active,
        },
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
