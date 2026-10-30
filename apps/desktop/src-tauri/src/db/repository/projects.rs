//! Projects: settings a folder gives every chat in it (instructions, skills,
//! Documents collections, a working folder).
//!
//! A project is a `conversation_folders` row; these tables only add settings.
//! Nothing but the working folder is copied into chats: the chat's folder is
//! looked up when a message is sent, so editing a project, or moving a chat in
//! or out, applies to the next message. A new chat in a project starts in its
//! working folder (`place_new_chat`). Rows cascade-delete with the folder.

use std::path::Path;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::{
    db::{repository::conversations, DbError},
    encryption::Encryption,
    time::now_iso8601,
};

/// A folder's project settings, with instructions decrypted.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    pub folder_id: String,
    pub user_instructions: Option<String>,
    pub workspace_root: Option<String>,
    pub skill_ids: Vec<String>,
    pub collection_ids: Vec<String>,
}

/// The project a chat is in, as the renderer needs it when composing a turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationProject {
    pub name: String,
    #[serde(flatten)]
    pub settings: ProjectSettings,
}

/// The folder a chat is in, or `None` when it is in no folder (or missing).
pub async fn folder_of_conversation(
    pool: &SqlitePool,
    conversation_id: &str,
) -> Result<Option<String>, DbError> {
    let folder: Option<Option<String>> =
        sqlx::query_scalar("SELECT folder_id FROM conversations WHERE id = ?")
            .bind(conversation_id)
            .fetch_optional(pool)
            .await?;
    Ok(folder.flatten())
}

/// A folder's settings. A folder with none set returns empty settings.
pub async fn get_settings(
    pool: &SqlitePool,
    enc: &Encryption,
    folder_id: &str,
) -> Result<ProjectSettings, DbError> {
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT user_instructions, workspace_root FROM project_settings WHERE folder_id = ?",
    )
    .bind(folder_id)
    .fetch_optional(pool)
    .await?;
    let (instructions, workspace_root) = row.unwrap_or_default();
    let user_instructions = match instructions {
        Some(raw) => Some(enc.decrypt(&raw)?).filter(|s| !s.trim().is_empty()),
        None => None,
    };
    Ok(ProjectSettings {
        folder_id: folder_id.to_string(),
        user_instructions,
        workspace_root: workspace_root.filter(|s| !s.trim().is_empty()),
        skill_ids: list_skills(pool, folder_id).await?,
        collection_ids: list_collections(pool, folder_id).await?,
    })
}

/// The project of the folder `conversation_id` is in, or `None` when the chat
/// is in no folder. A folder without settings still returns its name, so the
/// renderer can say which project a chat belongs to.
pub async fn for_conversation(
    pool: &SqlitePool,
    enc: &Encryption,
    conversation_id: &str,
) -> Result<Option<ConversationProject>, DbError> {
    let Some(folder_id) = folder_of_conversation(pool, conversation_id).await? else {
        return Ok(None);
    };
    let name: Option<String> =
        sqlx::query_scalar("SELECT name FROM conversation_folders WHERE id = ?")
            .bind(&folder_id)
            .fetch_optional(pool)
            .await?;
    let Some(name) = name else {
        // folder_id is not enforced by a foreign key (0012); a stale id is no project.
        return Ok(None);
    };
    Ok(Some(ConversationProject {
        name,
        settings: get_settings(pool, enc, &folder_id).await?,
    }))
}

/// Put a new chat in a folder. When the project has a working folder that
/// still exists, the chat starts in it: the one setting copied rather than
/// looked up, so the chat can still change it and editing the project leaves
/// existing chats where they are. Returns whether a working folder was set.
pub async fn place_new_chat(
    pool: &SqlitePool,
    conversation_id: &str,
    folder_id: &str,
) -> Result<bool, DbError> {
    conversations::set_folder(pool, conversation_id, Some(folder_id)).await?;
    let root: Option<Option<String>> =
        sqlx::query_scalar("SELECT workspace_root FROM project_settings WHERE folder_id = ?")
            .bind(folder_id)
            .fetch_optional(pool)
            .await?;
    let Some(root) = root
        .flatten()
        .filter(|r| !r.trim().is_empty() && Path::new(r.trim()).is_dir())
    else {
        return Ok(false);
    };
    conversations::set_workspace_root(pool, conversation_id, Some(root.trim())).await?;
    Ok(true)
}

/// Set a folder's instructions and working folder. Blank values clear them.
/// Instructions are encrypted when `enc` is On.
pub async fn set_settings(
    pool: &SqlitePool,
    enc: &Encryption,
    folder_id: &str,
    user_instructions: Option<&str>,
    workspace_root: Option<&str>,
) -> Result<(), DbError> {
    ensure_folder(pool, folder_id).await?;
    let instructions = match user_instructions.map(str::trim).filter(|s| !s.is_empty()) {
        Some(text) => Some(enc.encrypt(text)?),
        None => None,
    };
    let workspace_root = workspace_root.map(str::trim).filter(|s| !s.is_empty());
    sqlx::query(
        "INSERT INTO project_settings (folder_id, user_instructions, workspace_root, updated_at) \
         VALUES (?, ?, ?, ?) \
         ON CONFLICT(folder_id) DO UPDATE SET \
           user_instructions = excluded.user_instructions, \
           workspace_root = excluded.workspace_root, \
           updated_at = excluded.updated_at",
    )
    .bind(folder_id)
    .bind(instructions)
    .bind(workspace_root)
    .bind(now_iso8601())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_skills(pool: &SqlitePool, folder_id: &str) -> Result<Vec<String>, DbError> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT skill_id FROM project_skills WHERE folder_id = ? ORDER BY skill_id")
            .bind(folder_id)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Replace a folder's skills; same rules as `skills::set_enabled` for a chat.
pub async fn set_skills(
    pool: &SqlitePool,
    folder_id: &str,
    skill_ids: &[String],
) -> Result<Vec<String>, DbError> {
    ensure_folder(pool, folder_id).await?;
    let unique = dedupe(skill_ids);
    if let Some(bad) = unique
        .iter()
        .find(|id| crate::skills::parse_skill_id(id).is_none())
    {
        return Err(DbError::Query(format!("invalid skill id {bad:?}")));
    }
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM project_skills WHERE folder_id = ?")
        .bind(folder_id)
        .execute(&mut *tx)
        .await?;
    for id in &unique {
        sqlx::query("INSERT INTO project_skills (folder_id, skill_id) VALUES (?, ?)")
            .bind(folder_id)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(unique)
}

pub async fn list_collections(pool: &SqlitePool, folder_id: &str) -> Result<Vec<String>, DbError> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT collection_id FROM project_collections WHERE folder_id = ? ORDER BY collection_id",
    )
    .bind(folder_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Replace a folder's Documents collections. Unlike a chat's set, ids must
/// exist: the foreign key to `knowledge_collections` rejects unknown ones.
pub async fn set_collections(
    pool: &SqlitePool,
    folder_id: &str,
    collection_ids: &[String],
) -> Result<Vec<String>, DbError> {
    ensure_folder(pool, folder_id).await?;
    let unique = dedupe(collection_ids);
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM project_collections WHERE folder_id = ?")
        .bind(folder_id)
        .execute(&mut *tx)
        .await?;
    for id in &unique {
        sqlx::query("INSERT INTO project_collections (folder_id, collection_id) VALUES (?, ?)")
            .bind(folder_id)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(unique)
}

/// The Documents collections a chat searches: its own, then its project's.
pub async fn effective_collections(
    pool: &SqlitePool,
    conversation_id: &str,
) -> Result<Vec<String>, DbError> {
    let mut ids = super::knowledge::list_enabled(pool, conversation_id).await?;
    if let Some(folder_id) = folder_of_conversation(pool, conversation_id).await? {
        for id in list_collections(pool, &folder_id).await? {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    Ok(ids)
}

async fn ensure_folder(pool: &SqlitePool, folder_id: &str) -> Result<(), DbError> {
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM conversation_folders WHERE id = ?")
        .bind(folder_id)
        .fetch_optional(pool)
        .await?;
    match exists {
        Some(_) => Ok(()),
        None => Err(DbError::Query("folder not found".into())),
    }
}

fn dedupe(ids: &[String]) -> Vec<String> {
    let mut unique: Vec<String> = Vec::new();
    for id in ids.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        if !unique.iter().any(|e| e == id) {
            unique.push(id.to_string());
        }
    }
    unique
}
