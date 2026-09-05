//! t1-4: SKILL.md discovery, per-conversation enablement, prompt injection.
mod common;

use conduit_desktop::db::repository::{conversations, messages, skills as skill_repo};
use conduit_desktop::skills::{
    compose_skill_prompt_block, discover_skills, import_skill_dir, SkillRoots,
};
use provider_core::schema::{Message, MessagePart, MessagePartKind, MessageRole};

fn user_message(conversation_id: &str, id: &str, content: &str) -> Message {
    Message {
        id: id.to_string(),
        conversation_id: conversation_id.to_string(),
        role: MessageRole::User,
        author_label: None,
        provider_message_id: None,
        request_id: None,
        interrupted_at: None,
        metadata: None,
        parts: vec![MessagePart {
            id: format!("{id}-p0"),
            message_id: id.to_string(),
            index: 0,
            kind: MessagePartKind::Text,
            content: Some(content.to_string()),
            mime_type: None,
            tool_call_id: None,
            artifact_id: None,
            attachment_id: None,
            blob_ref: None,
            metadata: None,
            created_at: "2026-06-22T00:00:00Z".to_string(),
        }],
        created_at: "2026-06-22T00:00:00Z".to_string(),
    }
}

#[tokio::test]
async fn enablement_persists_and_fork_copies_it() {
    let pool = common::setup_pool().await;
    let convo = conversations::create(&pool, Some("Skills chat"))
        .await
        .unwrap();
    skill_repo::set_enabled(&pool, &convo.id, &["conduit:pdf-processing".into()])
        .await
        .unwrap();
    let listed = skill_repo::list_enabled(&pool, &convo.id).await.unwrap();
    assert_eq!(listed, vec!["conduit:pdf-processing"]);

    messages::insert_message(&pool, &user_message(&convo.id, "m1", "hi"))
        .await
        .unwrap();

    let fork = conversations::fork_at(&pool, &convo.id, "m1", Some("Fork"))
        .await
        .unwrap();
    let forked = skill_repo::list_enabled(&pool, &fork.id).await.unwrap();
    assert_eq!(forked, vec!["conduit:pdf-processing"]);
}

#[test]
fn dropping_a_package_into_the_conduit_dir_lists_it() {
    let tmp = tempfile::tempdir().unwrap();
    let conduit = tmp.path().join("skills");
    let src_parent = tmp.path().join("incoming");
    std::fs::create_dir_all(src_parent.join("demo-skill")).unwrap();
    std::fs::write(
        src_parent.join("demo-skill").join("SKILL.md"),
        "---\nname: demo-skill\ndescription: A dropped package used when testing skills.\n---\n\nAlways mention DROPPED-SKILL.\n",
    )
    .unwrap();
    import_skill_dir(&conduit, &src_parent.join("demo-skill")).unwrap();
    let roots = SkillRoots {
        conduit,
        ..SkillRoots::default()
    };
    let listed = discover_skills(&roots);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, "conduit:demo-skill");
    let on = compose_skill_prompt_block(&roots, &["conduit:demo-skill".into()]);
    assert!(on.contains("DROPPED-SKILL"), "{on}");
    let off = compose_skill_prompt_block(&roots, &[]);
    assert!(!off.contains("DROPPED-SKILL"));
}
