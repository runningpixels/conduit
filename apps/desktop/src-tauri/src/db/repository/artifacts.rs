//! `artifacts` + `artifact_versions` repository (M4) — append-only versioned
//! blob store.
//!
//! Blob layout for file payloads: `artifacts/<artifact_id>/<version_id>/<filename>`.
//! Small payloads are stored inline (`content_text` / `content_json`); large or
//! binary payloads are written as a blob with `content_path` + `content_hash`.
//! Versions are **append-only and immutable**; "restore" re-points
//! `artifacts.current_version_id` rather than mutating history.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    db::DbError,
    encryption::Encryption,
    time::now_iso8601,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub conversation_id: String,
    pub current_version_id: String,
    pub kind: String,
    pub title: Option<String>,
    pub source_message_id: Option<String>,
    pub cloud_share_id: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactVersion {
    pub id: String,
    pub artifact_id: String,
    pub index: u32,
    pub mime_type: Option<String>,
    pub content_text: Option<String>,
    pub content_json: Option<serde_json::Value>,
    pub content_path: Option<String>,
    pub content_hash: Option<String>,
    pub size_bytes: Option<i64>,
    pub created_at: String,
}

/// Content for a new version. `Text`/`Json` are stored inline; `File` is written
/// as a blob under `artifacts/<artifact_id>/<version_id>/<filename>`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VersionContent {
    Text { text: String },
    Json { json: serde_json::Value },
    File { bytes: Vec<u8>, filename: String },
}

/// The spec §8.3 file-state machine, extended with `NoFileContent` for inline
/// (non-file) versions.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileState {
    Ok,
    Missing,
    Modified,
    NoFileContent,
}

/// Create an artifact row. `current_version_id` is empty until the first
/// version is added.
pub async fn create(
    pool: &SqlitePool,
    conversation_id: &str,
    kind: &str,
    title: Option<&str>,
    source_message_id: Option<&str>,
) -> Result<Artifact, DbError> {
    let id = Uuid::new_v4().to_string();
    let now = now_iso8601();
    let title = title.map(|t| t.trim()).filter(|t| !t.is_empty()).map(|s| s.to_string());
    sqlx::query(
        "INSERT INTO artifacts \
         (id, conversation_id, current_version_id, kind, title, source_message_id, created_at) \
         VALUES (?, ?, '', ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(conversation_id)
    .bind(kind)
    .bind(&title)
    .bind(source_message_id)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(Artifact {
        id,
        conversation_id: conversation_id.to_string(),
        current_version_id: String::new(),
        kind: kind.to_string(),
        title,
        source_message_id: source_message_id.map(|s| s.to_string()),
        cloud_share_id: None,
        metadata: None,
        created_at: now,
    })
}

/// Append a new immutable version and point `current_version_id` at it, in one
/// transaction. Inline `content_text`/`content_json` are encrypted at the bind
/// boundary when `enc.tier() == On`; the returned [`ArtifactVersion`] carries
/// the **plaintext** content (the renderer-facing shape is unchanged). File
/// payloads are written to disk as encrypted blobs; the stored `content_hash`
/// is over the plaintext so `check_file_state` can detect tampering.
pub async fn add_version(
    pool: &SqlitePool,
    artifacts_dir: &Path,
    enc: &Encryption,
    artifact_id: &str,
    mime_type: Option<&str>,
    content: &VersionContent,
) -> Result<ArtifactVersion, DbError> {
    let version_id = Uuid::new_v4().to_string();
    let now = now_iso8601();

    let (content_text, content_json, content_path, content_hash, size_bytes) =
        materialize_content(artifacts_dir, enc, artifact_id, &version_id, content)?;

    // Encrypt inline columns for storage; the struct below keeps plaintext.
    let stored_text = enc.encrypt_opt(content_text.as_deref())?;
    let stored_json = match &content_json {
        Some(v) => Some(enc.encrypt(&v.to_string())?),
        None => None,
    };
    let enc_key_version = if enc.is_on() {
        Some(enc.key_version() as i64)
    } else {
        None
    };

    let mut tx = pool.begin().await?;
    let next_idx: (i64,) = sqlx::query_as(
        "SELECT COALESCE(MAX(idx), -1) + 1 FROM artifact_versions WHERE artifact_id = ?",
    )
    .bind(artifact_id)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO artifact_versions \
         (id, artifact_id, idx, mime_type, content_text, content_json, content_path, \
          content_hash, size_bytes, enc_key_version, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&version_id)
    .bind(artifact_id)
    .bind(next_idx.0)
    .bind(mime_type)
    .bind(&stored_text)
    .bind(&stored_json)
    .bind(&content_path)
    .bind(&content_hash)
    .bind(size_bytes)
    .bind(enc_key_version)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    sqlx::query("UPDATE artifacts SET current_version_id = ? WHERE id = ?")
        .bind(&version_id)
        .bind(artifact_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(ArtifactVersion {
        id: version_id,
        artifact_id: artifact_id.to_string(),
        index: next_idx.0.max(0) as u32,
        mime_type: mime_type.map(|s| s.to_string()),
        content_text,
        content_json,
        content_path,
        content_hash,
        size_bytes,
        created_at: now,
    })
}

/// List artifacts for a conversation, newest-first.
pub async fn list(
    pool: &SqlitePool,
    conversation_id: &str,
) -> Result<Vec<Artifact>, DbError> {
    let rows: Vec<(
        String, String, String, String, Option<String>, Option<String>, Option<String>,
        Option<String>, String,
    )> = sqlx::query_as(
        "SELECT id, conversation_id, current_version_id, kind, title, source_message_id, \
                cloud_share_id, metadata, created_at FROM artifacts \
         WHERE conversation_id = ? ORDER BY created_at DESC",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(id, conversation_id, current_version_id, kind, title, source_message_id, cloud_share_id, metadata, created_at)| Artifact {
            id, conversation_id, current_version_id, kind, title, source_message_id, cloud_share_id,
            metadata: metadata.and_then(|s| serde_json::from_str(&s).ok()),
            created_at,
        })
        .collect())
}

/// All versions of an artifact, ordered by version ordinal. Inline
/// `content_text`/`content_json` are decrypted (plaintext) in the returned
/// structs; the on-disk/blob form may be ciphertext.
pub async fn get_versions(
    pool: &SqlitePool,
    enc: &Encryption,
    artifact_id: &str,
) -> Result<Vec<ArtifactVersion>, DbError> {
    let rows: Vec<(
        String, String, i64, Option<String>, Option<String>, Option<String>, Option<String>,
        Option<String>, Option<i64>, String,
    )> = sqlx::query_as(
        "SELECT id, artifact_id, idx, mime_type, content_text, content_json, content_path, \
                content_hash, size_bytes, created_at FROM artifact_versions \
         WHERE artifact_id = ? ORDER BY idx ASC",
    )
    .bind(artifact_id)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for (id, artifact_id, idx, mime_type, content_text, content_json, content_path, content_hash, size_bytes, created_at) in rows {
        let content_text = enc.decrypt_opt(content_text.as_deref())?;
        let content_json = match content_json {
            Some(s) => {
                let plain = enc.decrypt(&s)?;
                Some(serde_json::from_str(&plain).unwrap_or(serde_json::Value::Null))
            }
            None => None,
        };
        out.push(ArtifactVersion {
            id, artifact_id, index: idx.max(0) as u32, mime_type, content_text,
            content_json, content_path, content_hash, size_bytes, created_at,
        });
    }
    Ok(out)
}

/// File-state of the artifact's current version (spec §8.3). Inline versions
/// report `NoFileContent`; file versions are hashed against the stored
/// `content_hash`.
pub async fn check_file_state(
    pool: &SqlitePool,
    artifacts_dir: &Path,
    enc: &Encryption,
    artifact_id: &str,
) -> Result<FileState, DbError> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT current_version_id FROM artifacts WHERE id = ?")
            .bind(artifact_id)
            .fetch_optional(pool)
            .await?;
    let Some((current_version_id,)) = row else {
        return Ok(FileState::Missing);
    };
    if current_version_id.is_empty() {
        return Ok(FileState::Missing);
    }

    let vrow: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT content_path, content_hash FROM artifact_versions WHERE id = ?",
    )
    .bind(&current_version_id)
    .fetch_optional(pool)
    .await?;
    let Some((content_path, content_hash)) = vrow else {
        return Ok(FileState::Missing);
    };

    let Some(rel_path) = content_path else {
        return Ok(FileState::NoFileContent);
    };
    let abs = artifacts_dir.join(&rel_path);
    let bytes = match std::fs::read(&abs) {
        Ok(b) => b,
        Err(_) => return Ok(FileState::Missing),
    };
    let plaintext = enc.decode_blob(&bytes)?;
    let Some(stored_hash) = content_hash else {
        return Ok(FileState::Modified);
    };
    let mut hasher = Sha256::new();
    hasher.update(&plaintext);
    if hex_encode(&hasher.finalize()) == stored_hash {
        Ok(FileState::Ok)
    } else {
        Ok(FileState::Modified)
    }
}

/// Re-point `current_version_id` at an existing version. Versions themselves are
/// immutable; restore only changes which version is current.
pub async fn restore_version(
    pool: &SqlitePool,
    artifact_id: &str,
    version_id: &str,
) -> Result<(), DbError> {
    let exists: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM artifact_versions WHERE id = ? AND artifact_id = ?")
            .bind(version_id)
            .bind(artifact_id)
            .fetch_one(pool)
            .await?;
    if exists.0 == 0 {
        return Err(DbError::Query("version not found for artifact".to_string()));
    }
    sqlx::query("UPDATE artifacts SET current_version_id = ? WHERE id = ?")
        .bind(version_id)
        .bind(artifact_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Absolute path for a stored version blob (used by tests / future export).
pub fn resolve_version_path(artifacts_dir: &Path, rel_path: &str) -> PathBuf {
    artifacts_dir.join(rel_path)
}

// --- helpers -----------------------------------------------------------------

fn materialize_content(
    artifacts_dir: &Path,
    enc: &Encryption,
    artifact_id: &str,
    version_id: &str,
    content: &VersionContent,
) -> Result<(Option<String>, Option<serde_json::Value>, Option<String>, Option<String>, Option<i64>), DbError> {
    match content {
        VersionContent::Text { text } => {
            let hash = sha256_hex(text.as_bytes());
            Ok((
                Some(text.clone()),
                None,
                None,
                Some(hash),
                Some(text.len() as i64),
            ))
        }
        VersionContent::Json { json } => {
            let serialized = serde_json::to_string(json)
                .map_err(|e| DbError::Query(format!("encode artifact json: {e}")))?;
            let hash = sha256_hex(serialized.as_bytes());
            Ok((
                None,
                Some(json.clone()),
                None,
                Some(hash),
                Some(serialized.len() as i64),
            ))
        }
        VersionContent::File { bytes, filename } => {
            let rel_path = format!("{artifact_id}/{version_id}/{filename}");
            let abs = artifacts_dir.join(&rel_path);
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| DbError::RecoveryIo(format!("create artifact dir: {e}")))?;
            }
            // Encrypt the blob for on-disk storage; hash is over the plaintext.
            let on_disk = enc.encode_blob(bytes)?;
            let temp = abs.with_extension("tmp.part");
            std::fs::write(&temp, &on_disk)
                .map_err(|e| DbError::RecoveryIo(format!("write artifact temp: {e}")))?;
            std::fs::rename(&temp, &abs)
                .map_err(|e| DbError::RecoveryIo(format!("rename artifact blob: {e}")))?;
            let hash = sha256_hex(bytes);
            Ok((None, None, Some(rel_path), Some(hash), Some(bytes.len() as i64)))
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex_encode(&hasher.finalize())
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}