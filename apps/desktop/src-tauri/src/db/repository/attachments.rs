//! `attachments` repository (M4) — content-addressed blob store + metadata.
//!
//! Blob layout: `attachments/<sha256[:2]>/<sha256[2:]>` (content-addressed, so
//! identical content dedupes on disk). The `attachments.path` column stores the
//! workspace-relative path. Multiple metadata rows may reference the same blob
//! (distinct logical attachments with identical content); physical file deletion
//! happens only via `cleanup::gc_orphan_blobs` once no live row references the
//! hash. `set_retention('deleted')` is a soft delete — the file is not touched.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{db::DbError, encryption::Encryption, time::now_iso8601};

/// Row shape for [`get`] / [`list_for_conversation`] (both select the same columns).
type AttachmentRow = (
    String,
    String,
    String,
    String,
    i64,
    Option<String>,
    Option<String>,
    String,
    String,
);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub conversation_id: String,
    pub path: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub hash: Option<String>,
    pub origin: Option<String>,
    pub retention_state: String,
    pub created_at: String,
}

/// Save `bytes` as a content-addressed blob and insert a metadata row. Dedupes
/// on hash: if the blob file already exists it is not rewritten, but a new
/// metadata row is always inserted (each attachment is a distinct logical
/// reference). The write is atomic (temp file + rename).
///
/// The stored `hash` and `size_bytes` are over the **plaintext** bytes; the
/// on-disk blob is encrypted when `enc.tier() == On` (the file is ciphertext,
/// so a casual on-disk inspection does not reveal the content).
pub async fn save(
    pool: &SqlitePool,
    attachments_dir: &Path,
    enc: &Encryption,
    conversation_id: &str,
    bytes: &[u8],
    mime_type: &str,
    origin: Option<&str>,
) -> Result<Attachment, DbError> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let hex = hex_encode(&hasher.finalize());
    let rel_path = format!("{}/{}", &hex[..2], &hex[2..]);
    let abs_path = attachments_dir.join(&rel_path);

    if !abs_path.exists() {
        let on_disk = enc.encode_blob(bytes)?;
        write_atomic(&abs_path, &on_disk)?;
    }

    let id = Uuid::new_v4().to_string();
    let now = now_iso8601();
    let size_bytes = bytes.len() as i64;
    sqlx::query(
        "INSERT INTO attachments \
         (id, conversation_id, path, mime_type, size_bytes, hash, origin, retention_state, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)",
    )
    .bind(&id)
    .bind(conversation_id)
    .bind(&rel_path)
    .bind(mime_type)
    .bind(size_bytes)
    .bind(&hex)
    .bind(origin)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(Attachment {
        id,
        conversation_id: conversation_id.to_string(),
        path: rel_path,
        mime_type: mime_type.to_string(),
        size_bytes,
        hash: Some(hex),
        origin: origin.map(|s| s.to_string()),
        retention_state: "active".to_string(),
        created_at: now,
    })
}

/// Fetch one attachment by id.
pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<Attachment>, DbError> {
    let row: Option<AttachmentRow> = sqlx::query_as(
        "SELECT id, conversation_id, path, mime_type, size_bytes, hash, origin, \
                retention_state, created_at FROM attachments WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(
        |(
            id,
            conversation_id,
            path,
            mime_type,
            size_bytes,
            hash,
            origin,
            retention_state,
            created_at,
        )| Attachment {
            id,
            conversation_id,
            path,
            mime_type,
            size_bytes,
            hash,
            origin,
            retention_state,
            created_at,
        },
    ))
}

/// List attachments for a conversation (any retention state, newest-first).
pub async fn list_for_conversation(
    pool: &SqlitePool,
    conversation_id: &str,
) -> Result<Vec<Attachment>, DbError> {
    let rows: Vec<AttachmentRow> = sqlx::query_as(
        "SELECT id, conversation_id, path, mime_type, size_bytes, hash, origin, \
                retention_state, created_at FROM attachments \
         WHERE conversation_id = ? ORDER BY created_at DESC",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                conversation_id,
                path,
                mime_type,
                size_bytes,
                hash,
                origin,
                retention_state,
                created_at,
            )| Attachment {
                id,
                conversation_id,
                path,
                mime_type,
                size_bytes,
                hash,
                origin,
                retention_state,
                created_at,
            },
        )
        .collect())
}

/// Soft-delete: set `retention_state`. The blob file is not touched here.
pub async fn set_retention(pool: &SqlitePool, id: &str, state: &str) -> Result<(), DbError> {
    sqlx::query("UPDATE attachments SET retention_state = ? WHERE id = ?")
        .bind(state)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Re-hash the blob on disk and compare to the stored `hash`. `Ok(true)` when
/// the file matches; `Ok(false)` when it has been modified or is missing. The
/// stored hash is over the **plaintext**, so the on-disk (possibly encrypted)
/// bytes are decoded before hashing.
pub async fn verify_integrity(
    pool: &SqlitePool,
    attachments_dir: &Path,
    enc: &Encryption,
    id: &str,
) -> Result<bool, DbError> {
    let Some(att) = get(pool, id).await? else {
        return Ok(false);
    };
    let Some(stored_hash) = att.hash else {
        return Ok(false);
    };
    let abs = attachments_dir.join(&att.path);
    let bytes = match std::fs::read(&abs) {
        Ok(b) => b,
        Err(_) => return Ok(false),
    };
    let plaintext = enc.decode_blob(&bytes)?;
    let mut hasher = Sha256::new();
    hasher.update(&plaintext);
    Ok(hex_encode(&hasher.finalize()) == stored_hash)
}

/// Read the blob bytes for an attachment (for IPC delivery to the renderer).
/// Decodes the on-disk (possibly encrypted) blob back to plaintext.
pub fn read_bytes(
    attachments_dir: &Path,
    enc: &Encryption,
    rel_path: &str,
) -> Result<Vec<u8>, DbError> {
    let raw = std::fs::read(attachments_dir.join(rel_path))
        .map_err(|e| DbError::RecoveryIo(format!("read attachment blob: {e}")))?;
    enc.decode_blob(&raw)
}

/// Absolute path on disk for a stored relative path (used by cleanup / tests).
pub fn resolve_blob_path(attachments_dir: &Path, rel_path: &str) -> PathBuf {
    attachments_dir.join(rel_path)
}

// --- helpers -----------------------------------------------------------------

fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), DbError> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| DbError::RecoveryIo(format!("create attachment dir: {e}")))?;
    }
    let temp = target.with_extension("tmp.part");
    std::fs::write(&temp, bytes)
        .map_err(|e| DbError::RecoveryIo(format!("write attachment temp: {e}")))?;
    std::fs::rename(&temp, target)
        .map_err(|e| DbError::RecoveryIo(format!("rename attachment blob: {e}")))?;
    Ok(())
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}
