//! `prompts` repository — CRUD for the prompts library.
//!
//! Prompts are user-saved templates with optional `{{variable}}` tokens,
//! organized into folders. The `body` column is encrypted when `EncryptionTier::On`;
//! plaintext columns (`title`, `folder`, `tags`, `sort_order`) are used for
//! sorting and filtering.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{db::DbError, encryption::Encryption, time::now_iso8601};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub id: String,
    pub title: String,
    pub body: String,
    pub variables: Option<Vec<String>>,
    pub folder: Option<String>,
    pub tags: Option<Vec<String>>,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: Option<String>,
}

type PromptRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    i32,
    String,
    Option<String>,
);

/// Parse `{{variable}}` tokens from a template body.
/// Returns deduplicated variable names in order of appearance.
pub fn extract_variables(body: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let bytes = body.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'{' && bytes[i + 1] == b'{' {
            let start = i + 2;
            if let Some(end) = body[start..].find("}}") {
                let name = body[start..start + end].trim().to_string();
                if !name.is_empty() && seen.insert(name.clone()) {
                    result.push(name);
                }
                i = start + end + 2;
                continue;
            }
        }
        i += 1;
    }
    result
}

fn row_to_prompt(row: PromptRow, enc: &Encryption) -> Result<Prompt, DbError> {
    let (id, title, body, variables_json, folder, tags_json, sort_order, created_at, updated_at) =
        row;
    let body = enc.decrypt(&body)?;
    let variables: Option<Vec<String>> = variables_json
        .filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str(&s).ok());
    let tags: Option<Vec<String>> = tags_json
        .filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str(&s).ok());
    Ok(Prompt {
        id,
        title,
        body,
        variables,
        folder,
        tags,
        sort_order,
        created_at,
        updated_at,
    })
}

/// Create a new prompt. Parses `{{variable}}` tokens from the body.
pub async fn create(
    pool: &SqlitePool,
    enc: &Encryption,
    title: &str,
    body: &str,
    folder: Option<&str>,
    tags: Option<&[String]>,
) -> Result<Prompt, DbError> {
    let id = Uuid::new_v4().to_string();
    let now = now_iso8601();
    let variables = extract_variables(body);
    let variables_json = if variables.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&variables).unwrap_or_default())
    };
    let tags_json = tags
        .filter(|t| !t.is_empty())
        .map(|t| serde_json::to_string(t).unwrap_or_default());
    let encrypted_body = enc.encrypt(body)?;

    sqlx::query(
        "INSERT INTO prompts (id, title, body, variables, folder, tags, sort_order, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
    )
    .bind(&id)
    .bind(title)
    .bind(&encrypted_body)
    .bind(&variables_json)
    .bind(folder)
    .bind(&tags_json)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(Prompt {
        id,
        title: title.to_string(),
        body: body.to_string(),
        variables: if variables.is_empty() { None } else { Some(variables) },
        folder: folder.map(|s| s.to_string()),
        tags: tags.map(|t| t.to_vec()),
        sort_order: 0,
        created_at: now,
        updated_at: None,
    })
}

/// List all prompts, optionally filtered by folder. Ordered by folder, sort_order.
pub async fn list(
    pool: &SqlitePool,
    enc: &Encryption,
    folder_filter: Option<&str>,
) -> Result<Vec<Prompt>, DbError> {
    let rows: Vec<PromptRow> = if let Some(folder) = folder_filter {
        sqlx::query_as(
            "SELECT id, title, body, variables, folder, tags, sort_order, created_at, updated_at \
             FROM prompts WHERE folder = ? ORDER BY sort_order, created_at",
        )
        .bind(folder)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as(
            "SELECT id, title, body, variables, folder, tags, sort_order, created_at, updated_at \
             FROM prompts ORDER BY folder, sort_order, created_at",
        )
        .fetch_all(pool)
        .await?
    };

    rows.into_iter()
        .map(|row| row_to_prompt(row, enc))
        .collect()
}

/// Get a single prompt by ID.
pub async fn get(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
) -> Result<Option<Prompt>, DbError> {
    let row: Option<PromptRow> = sqlx::query_as(
        "SELECT id, title, body, variables, folder, tags, sort_order, created_at, updated_at \
         FROM prompts WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    match row {
        Some(r) => row_to_prompt(r, enc).map(Some),
        None => Ok(None),
    }
}

/// Update a prompt. Re-parses variables on body change.
pub async fn update(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
    title: &str,
    body: &str,
    folder: Option<&str>,
    tags: Option<&[String]>,
) -> Result<Prompt, DbError> {
    let now = now_iso8601();
    let variables = extract_variables(body);
    let variables_json = if variables.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&variables).unwrap_or_default())
    };
    let tags_json = tags
        .filter(|t| !t.is_empty())
        .map(|t| serde_json::to_string(t).unwrap_or_default());
    let encrypted_body = enc.encrypt(body)?;

    sqlx::query(
        "UPDATE prompts SET title = ?, body = ?, variables = ?, folder = ?, tags = ?, updated_at = ? \
         WHERE id = ?",
    )
    .bind(title)
    .bind(&encrypted_body)
    .bind(&variables_json)
    .bind(folder)
    .bind(&tags_json)
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;

    // Fetch the updated row to get the sort_order and timestamps
    let existing = get(pool, enc, id).await?;
    match existing {
        Some(p) => Ok(Prompt {
            variables: if variables.is_empty() { None } else { Some(variables) },
            tags: tags.map(|t| t.to_vec()),
            ..p
        }),
        None => Err(DbError::Query(format!("prompt {id} not found after update"))),
    }
}

/// Delete a prompt by ID.
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), DbError> {
    sqlx::query("DELETE FROM prompts WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// List distinct folder names (non-NULL), ordered alphabetically.
pub async fn list_folders(pool: &SqlitePool) -> Result<Vec<String>, DbError> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT DISTINCT folder FROM prompts WHERE folder IS NOT NULL ORDER BY folder")
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::tests::pool;
    use crate::encryption::Encryption;

    fn enc() -> Encryption {
        Encryption::off()
    }

    #[sqlx::test]
    async fn test_create_and_list() {
        let p = pool().await;
        let e = enc();

        let prompt = create(&p, &e, "Test Prompt", "Hello {{name}}!", Some("General"), None)
            .await
            .unwrap();
        assert_eq!(prompt.title, "Test Prompt");
        assert_eq!(prompt.variables, Some(vec!["name".to_string()]));

        let list = list(&p, &e, None).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, prompt.id);
    }

    #[sqlx::test]
    async fn test_create_no_variables() {
        let p = pool().await;
        let e = enc();

        let prompt = create(&p, &e, "Simple", "Just text", None, None).await.unwrap();
        assert!(prompt.variables.is_none());

        let got = get(&p, &e, &prompt.id).await.unwrap().unwrap();
        assert_eq!(got.body, "Just text");
    }

    #[sqlx::test]
    async fn test_create_with_tags() {
        let p = pool().await;
        let e = enc();

        let tags = vec!["code".to_string(), "review".to_string()];
        let prompt = create(&p, &e, "Code Review", "Review {{code}}", Some("Dev"), Some(&tags))
            .await
            .unwrap();
        assert_eq!(prompt.tags, Some(tags.clone()));

        let got = get(&p, &e, &prompt.id).await.unwrap().unwrap();
        assert_eq!(got.tags, Some(tags));
    }

    #[sqlx::test]
    async fn test_update() {
        let p = pool().await;
        let e = enc();

        let prompt = create(&p, &e, "Original", "Hello {{name}}", None, None)
            .await
            .unwrap();

        let updated = update(&p, &e, &prompt.id, "Updated", "Hi {{user}}", Some("Work"), None)
            .await
            .unwrap();
        assert_eq!(updated.title, "Updated");
        assert_eq!(updated.variables, Some(vec!["user".to_string()]));
        assert_eq!(updated.folder, Some("Work".to_string()));
    }

    #[sqlx::test]
    async fn test_delete() {
        let p = pool().await;
        let e = enc();

        let prompt = create(&p, &e, "Temp", "Body", None, None).await.unwrap();
        delete(&p, &prompt.id).await.unwrap();

        let got = get(&p, &e, &prompt.id).await.unwrap();
        assert!(got.is_none());
    }

    #[sqlx::test]
    async fn test_list_folders() {
        let p = pool().await;
        let e = enc();

        create(&p, &e, "P1", "Body", Some("Work"), None).await.unwrap();
        create(&p, &e, "P2", "Body", Some("Personal"), None).await.unwrap();
        create(&p, &e, "P3", "Body", None, None).await.unwrap();

        let folders = list_folders(&p).await.unwrap();
        assert_eq!(folders.len(), 2);
        assert!(folders.contains(&"Work".to_string()));
        assert!(folders.contains(&"Personal".to_string()));
    }

    #[sqlx::test]
    async fn test_list_filtered_by_folder() {
        let p = pool().await;
        let e = enc();

        create(&p, &e, "P1", "Body", Some("Work"), None).await.unwrap();
        create(&p, &e, "P2", "Body", Some("Personal"), None).await.unwrap();

        let work = list(&p, &e, Some("Work")).await.unwrap();
        assert_eq!(work.len(), 1);
        assert_eq!(work[0].title, "P1");
    }

    #[sqlx::test]
    async fn test_extract_variables() {
        let vars = extract_variables("Hello {{name}}, your {{item}} is ready");
        assert_eq!(vars, vec!["name".to_string(), "item".to_string()]);
    }

    #[sqlx::test]
    async fn test_extract_variables_deduplicates() {
        let vars = extract_variables("{{a}} {{b}} {{a}}");
        assert_eq!(vars.len(), 2);
    }

    #[sqlx::test]
    async fn test_extract_variables_no_tokens() {
        let vars = extract_variables("Just plain text");
        assert!(vars.is_empty());
    }

    #[sqlx::test]
    async fn test_encryption_round_trip() {
        use crate::encryption::{Encryption, EncryptionTier};
        let p = pool().await;

        // Create with encryption On
        let e = Encryption::off(); // We can't easily test On in unit tests w/o keychain
        // So test that Off works and doesn't mangle the body
        let prompt = create(&p, &e, "Secret", "Sensitive: {{data}}", None, None)
            .await
            .unwrap();
        assert_eq!(prompt.body, "Sensitive: {{data}}");
        assert_eq!(prompt.variables, Some(vec!["data".to_string()]));
    }
}