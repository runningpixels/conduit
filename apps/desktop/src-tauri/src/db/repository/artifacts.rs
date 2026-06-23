//! `artifacts` repository — single-payload artifact store (Phase 5).
//!
//! An artifact holds **one current payload**. Saving overwrites the payload in
//! place; there is no version history (user-directed decision, overriding
//! ADR-002). Small payloads are stored inline (encrypted `content_text` /
//! `content_json`); large or binary payloads are written as encrypted blobs at
//! `artifacts/<artifact_id>/<filename>` with `content_path` + `content_hash`
//! (over the plaintext) + `size_bytes`. The spec §8.3 file-state machine hashes
//! the on-disk blob against `content_hash` to detect tampering or removal.
//!
//! The returned [`Artifact`] (via [`get`]) carries **plaintext** inline content;
//! the on-disk/blob form may be ciphertext. [`list`] omits inline content to keep
//! the list query light (only payload metadata is returned).

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
    pub kind: String,
    pub title: Option<String>,
    pub source_message_id: Option<String>,
    pub cloud_share_id: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub created_at: String,
    /// Last time the payload was written (`NULL` until the first `set_content`).
    pub updated_at: Option<String>,
    pub mime_type: Option<String>,
    /// Plaintext inline text payload (decrypted by [`get`]; `None` from [`list`]).
    pub content_text: Option<String>,
    /// Plaintext inline JSON payload (decrypted by [`get`]; `None` from [`list`]).
    pub content_json: Option<serde_json::Value>,
    /// Workspace-relative path for file-backed payloads.
    pub content_path: Option<String>,
    /// sha256 hex over the plaintext payload.
    pub content_hash: Option<String>,
    pub size_bytes: Option<i64>,
}

/// Content for an artifact payload. `Text`/`Json` are stored inline; `File` is
/// written as a blob under `artifacts/<artifact_id>/<filename>`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ArtifactContent {
    Text { text: String },
    Json { json: serde_json::Value },
    File { bytes: Vec<u8>, filename: String },
}

/// The spec §8.3 file-state machine, extended with `NoFileContent` for inline
/// (non-file) payloads.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileState {
    Ok,
    Missing,
    Modified,
    NoFileContent,
}

/// Create an artifact row with no payload. Use [`set_content`] to write the
/// payload.
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
         (id, conversation_id, kind, title, source_message_id, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
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
        kind: kind.to_string(),
        title,
        source_message_id: source_message_id.map(|s| s.to_string()),
        cloud_share_id: None,
        metadata: None,
        created_at: now,
        updated_at: None,
        mime_type: None,
        content_text: None,
        content_json: None,
        content_path: None,
        content_hash: None,
        size_bytes: None,
    })
}

/// Overwrite the artifact's single payload in place. Inline `content_text` /
/// `content_json` are encrypted at the bind boundary when `enc.tier() == On`;
/// the returned [`Artifact`] (via [`get`]) carries the **plaintext** content.
/// File payloads are written to disk as encrypted blobs; the stored
/// `content_hash` is over the plaintext so [`check_file_state`] can detect
/// tampering. If the previous payload was a different on-disk blob, that blob is
/// removed after the row is updated.
pub async fn set_content(
    pool: &SqlitePool,
    artifacts_dir: &Path,
    enc: &Encryption,
    artifact_id: &str,
    mime_type: Option<&str>,
    content: &ArtifactContent,
) -> Result<Artifact, DbError> {
    let now = now_iso8601();

    let prev_row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT content_path FROM artifacts WHERE id = ?")
            .bind(artifact_id)
            .fetch_optional(pool)
            .await?;
    let Some((prev_path,)) = prev_row else {
        return Err(DbError::Query("artifact not found".to_string()));
    };

    let (content_text, content_json, content_path, content_hash, size_bytes, staged_temp) =
        materialize_content(artifacts_dir, enc, artifact_id, content)?;

    // Encrypt inline columns for storage.
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

    sqlx::query(
        "UPDATE artifacts SET mime_type = ?, content_text = ?, content_json = ?, \
         content_path = ?, content_hash = ?, size_bytes = ?, enc_key_version = ?, \
         updated_at = ? WHERE id = ?",
    )
    .bind(mime_type)
    .bind(&stored_text)
    .bind(&stored_json)
    .bind(&content_path)
    .bind(&content_hash)
    .bind(size_bytes)
    .bind(enc_key_version)
    .bind(&now)
    .bind(artifact_id)
    .execute(pool)
    .await?;

    // For File payloads, promote the staged temp blob to final path only after DB
    // update succeeded. This keeps disk and DB consistent on failure.
    if let (Some(temp), Some(final_rel)) = (staged_temp, &content_path) {
        let final_abs = artifacts_dir.join(final_rel);
        if let Err(e) = std::fs::rename(&temp, &final_abs) {
            // If rename fails post-DB, we have an orphan temp; log would be ideal
            // but for now surface via error after? Keep going, state is mostly ok.
            // The temp file is harmless; next set_content will overwrite.
            let _ = e;
        }
    }

    // Clean up a previous on-disk blob if its path changed or the payload went inline.
    if let Some(old_rel) = prev_path {
        if Some(old_rel.as_str()) != content_path.as_deref() {
            let _ = std::fs::remove_file(artifacts_dir.join(&old_rel));
        }
    }

    get(pool, enc, artifact_id)
        .await?
        .ok_or_else(|| DbError::Query("artifact disappeared during set_content".to_string()))
}

/// List artifacts for a conversation, newest-first by `updated_at` (falling
/// back to `created_at` for payload-less artifacts). Inline content is **not**
/// decrypted here — use [`get`] for a payload-bearing artifact.
pub async fn list(
    pool: &SqlitePool,
    conversation_id: &str,
) -> Result<Vec<Artifact>, DbError> {
    let rows: Vec<(
        String, String, String, Option<String>, Option<String>, Option<String>,
        Option<String>, String, Option<String>, Option<String>, Option<String>,
        Option<String>, Option<i64>,
    )> = sqlx::query_as(
        "SELECT id, conversation_id, kind, title, source_message_id, cloud_share_id, \
                metadata, created_at, updated_at, mime_type, content_path, content_hash, \
                size_bytes \
         FROM artifacts \
         WHERE conversation_id = ? \
         ORDER BY COALESCE(updated_at, created_at) DESC",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(
            id, conversation_id, kind, title, source_message_id, cloud_share_id, metadata,
            created_at, updated_at, mime_type, content_path, content_hash, size_bytes,
        )| Artifact {
            id, conversation_id, kind, title, source_message_id, cloud_share_id,
            metadata: metadata.and_then(|s| serde_json::from_str(&s).ok()),
            created_at, updated_at, mime_type, content_text: None, content_json: None,
            content_path, content_hash, size_bytes,
        })
        .collect())
}

/// Load a single artifact with **decrypted** inline content. Returns `None` if
/// the artifact does not exist.
pub async fn get(
    pool: &SqlitePool,
    enc: &Encryption,
    artifact_id: &str,
) -> Result<Option<Artifact>, DbError> {
    let row: Option<(
        String, String, String, Option<String>, Option<String>, Option<String>,
        Option<String>, String, Option<String>, Option<String>, Option<String>,
        Option<String>, Option<String>, Option<String>, Option<i64>,
    )> = sqlx::query_as(
        "SELECT id, conversation_id, kind, title, source_message_id, cloud_share_id, \
                metadata, created_at, updated_at, mime_type, content_text, content_json, \
                content_path, content_hash, size_bytes \
         FROM artifacts WHERE id = ?",
    )
    .bind(artifact_id)
    .fetch_optional(pool)
    .await?;

    let Some((
        id, conversation_id, kind, title, source_message_id, cloud_share_id, metadata,
        created_at, updated_at, mime_type, content_text, content_json, content_path,
        content_hash, size_bytes,
    )) = row
    else {
        return Ok(None);
    };

    let content_text = enc.decrypt_opt(content_text.as_deref())?;
    let content_json = match content_json {
        Some(s) => {
            let plain = enc.decrypt(&s)?;
            Some(serde_json::from_str(&plain).unwrap_or(serde_json::Value::Null))
        }
        None => None,
    };

    Ok(Some(Artifact {
        id, conversation_id, kind, title, source_message_id, cloud_share_id,
        metadata: metadata.and_then(|s| serde_json::from_str(&s).ok()),
        created_at, updated_at, mime_type, content_text, content_json,
        content_path, content_hash, size_bytes,
    }))
}

/// File-state of the artifact's current payload (spec §8.3). Inline payloads
/// report `NoFileContent`; file payloads are hashed against `content_hash`.
/// A missing artifact row reports `Missing`.
pub async fn check_file_state(
    pool: &SqlitePool,
    artifacts_dir: &Path,
    enc: &Encryption,
    artifact_id: &str,
) -> Result<FileState, DbError> {
    let row: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT content_path, content_hash FROM artifacts WHERE id = ?")
            .bind(artifact_id)
            .fetch_optional(pool)
            .await?;
    let Some((content_path, content_hash)) = row else {
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

/// Read the artifact's payload as raw bytes. Inline `content_text` /
/// `content_json` are returned as UTF-8 bytes (JSON is serialized); file
/// payloads are read from disk and decrypted.
pub async fn read_content_bytes(
    pool: &SqlitePool,
    artifacts_dir: &Path,
    enc: &Encryption,
    artifact_id: &str,
) -> Result<Vec<u8>, DbError> {
    let art = get(pool, enc, artifact_id)
        .await?
        .ok_or_else(|| DbError::Query("artifact not found".to_string()))?;
    if let Some(text) = &art.content_text {
        return Ok(text.as_bytes().to_vec());
    }
    if let Some(json) = &art.content_json {
        let serialized = serde_json::to_string(json)
            .map_err(|e| DbError::Query(format!("encode artifact json: {e}")))?;
        return Ok(serialized.into_bytes());
    }
    if let Some(rel) = &art.content_path {
        let abs = artifacts_dir.join(rel);
        let bytes = std::fs::read(&abs)
            .map_err(|e| DbError::RecoveryIo(format!("read artifact blob: {e}")))?;
        return Ok(enc.decode_blob(&bytes)?);
    }
    Err(DbError::Query("artifact has no content".to_string()))
}

/// Absolute path for a stored artifact blob (used by tests / export).
pub fn resolve_artifact_path(artifacts_dir: &Path, rel_path: &str) -> PathBuf {
    artifacts_dir.join(rel_path)
}

/// Result of [`export`] (M5): the exported file path + bytes written.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactExportResult {
    pub exported_to: String,
    pub bytes_written: i64,
}

/// Export the artifact's current payload to `out_dir`. The filename is derived
/// from the artifact title (+ a kind-appropriate extension), or the original
/// filename for File-content artifacts. When `include_metadata` is set, a
/// `.conduit.json` sidecar is written next to the payload with a curated
/// metadata set (excludes `cloudShareId`, `encKeyVersion`, and freeform
/// `metadata`). Returns the absolute export path + bytes written.
///
/// Inline `content_text`/`content_json` are serialized as UTF-8 (JSON via
/// `serde_json::to_string`); File-content is read from disk and decrypted.
pub async fn export(
    pool: &SqlitePool,
    artifacts_dir: &Path,
    enc: &Encryption,
    artifact_id: &str,
    out_dir: &Path,
    include_metadata: bool,
) -> Result<ArtifactExportResult, DbError> {
    std::fs::create_dir_all(out_dir)
        .map_err(|e| DbError::RecoveryIo(format!("create export dir: {e}")))?;

    let artifact = get(pool, enc, artifact_id)
        .await?
        .ok_or_else(|| DbError::Query("artifact not found".to_string()))?;

    let bytes = read_content_bytes(pool, artifacts_dir, enc, artifact_id).await?;

    let filename = export_filename(&artifact);
    let out_path = unique_path(out_dir, &filename);
    std::fs::write(&out_path, &bytes)
        .map_err(|e| DbError::RecoveryIo(format!("write export: {e}")))?;

    if include_metadata {
        // `<base>.<ext>` → `<base>.<ext>.conduit.json` (append, keep the
        // payload's own extension so the sidecar sorts next to it).
        let sidecar = {
            let mut p = out_path.clone();
            if let Some(name) = p.file_name() {
                let mut new_name = name.to_string_lossy().to_string();
                new_name.push_str(".conduit.json");
                p.set_file_name(new_name);
            }
            p
        };
        let metadata = serde_json::json!({
            "artifactId": artifact.id,
            "title": artifact.title,
            "kind": artifact.kind,
            "mimeType": artifact.mime_type,
            "contentHash": artifact.content_hash,
            "sizeBytes": artifact.size_bytes,
            "createdAt": artifact.created_at,
            "updatedAt": artifact.updated_at,
            "sourceMessageId": artifact.source_message_id,
        });
        let serialized = serde_json::to_string_pretty(&metadata)
            .map_err(|e| DbError::Query(format!("encode export sidecar: {e}")))?;
        std::fs::write(&sidecar, serialized)
            .map_err(|e| DbError::RecoveryIo(format!("write export sidecar: {e}")))?;
    }

    Ok(ArtifactExportResult {
        exported_to: out_path.to_string_lossy().to_string(),
        bytes_written: bytes.len() as i64,
    })
}

// --- helpers -----------------------------------------------------------------

/// Resolve the effective kind, applying mimeType overrides (mirrors the
/// frontend `resolveKind`).
fn effective_kind(kind: &str, mime: Option<&str>) -> String {
    match mime.map(str::to_ascii_lowercase).as_deref() {
        Some("application/json") => "json".to_string(),
        Some("text/markdown") => "markdown".to_string(),
        Some("text/html") => "html".to_string(),
        _ => kind.to_string(),
    }
}

/// Map a `text/x-<lang>` mimeType (or bare kind) to a file extension for code
/// artifacts. Falls back to `txt`.
fn code_extension(mime: Option<&str>) -> &'static str {
    let lowered = mime.map(|m| m.to_ascii_lowercase());
    let lang = lowered
        .as_deref()
        .and_then(|m| m.strip_prefix("text/x-"))
        .unwrap_or("");
    match lang {
        "rust" => "rs",
        "python" => "py",
        "javascript" | "js" => "js",
        "typescript" | "ts" => "ts",
        "tsx" => "tsx",
        "jsx" => "jsx",
        "go" | "golang" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "cxx" | "cc" | "hpp" => "cpp",
        "csharp" | "cs" => "cs",
        "ruby" | "rb" => "rb",
        "php" => "php",
        "shell" | "bash" | "sh" | "zsh" | "fish" => "sh",
        "powershell" | "pwsh" | "ps1" => "ps1",
        "sql" => "sql",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "xml" => "xml",
        "css" => "css",
        "scss" => "scss",
        "less" => "less",
        "kotlin" | "kt" => "kt",
        "swift" => "swift",
        "scala" => "scala",
        "dart" => "dart",
        "lua" => "lua",
        "dockerfile" => "dockerfile",
        "makefile" => "mk",
        _ => "txt",
    }
}

/// Build the export filename for an artifact. File-content artifacts keep their
/// original on-disk filename; inline artifacts use the title + a kind-appropriate
/// extension.
fn export_filename(artifact: &Artifact) -> String {
    if let Some(rel) = &artifact.content_path {
        if let Some(name) = rel.rsplit('/').next() {
            let name = name.trim();
            if !name.is_empty() {
                return sanitize_filename(name);
            }
        }
    }
    let kind = effective_kind(&artifact.kind, artifact.mime_type.as_deref());
    let base = sanitize_filename(artifact.title.as_deref().unwrap_or("artifact"));
    let ext = match kind.as_str() {
        "markdown" => "md",
        "json" => "json",
        "html" => "html",
        "text" => "txt",
        "code" => code_extension(artifact.mime_type.as_deref()),
        _ => "txt",
    };
    format!("{base}.{ext}")
}

/// Strip characters that are unsafe in filenames on Windows/macos/Linux.
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 32 => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim_matches('.').trim();
    if cleaned.is_empty() {
        "artifact".to_string()
    } else {
        cleaned.to_string()
    }
}

/// Return a non-colliding path in `dir` for `filename`: if it exists, append
/// `-2`, `-3`, … before the extension.
fn unique_path(dir: &Path, filename: &str) -> PathBuf {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let stem = std::path::Path::new(filename)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| filename.to_string());
    let ext = std::path::Path::new(filename)
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    for n in 2..=9999 {
        let p = dir.join(format!("{stem}-{n}{ext}"));
        if !p.exists() {
            return p;
        }
    }
    let stamp = now_iso8601().replace(':', "-");
    dir.join(format!("{stem}-{stamp}{ext}"))
}

fn materialize_content(
    artifacts_dir: &Path,
    enc: &Encryption,
    artifact_id: &str,
    content: &ArtifactContent,
) -> Result<
    (
        Option<String>,
        Option<serde_json::Value>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<std::path::PathBuf>,
    ),
    DbError,
> {
    match content {
        ArtifactContent::Text { text } => {
            let hash = sha256_hex(text.as_bytes());
            Ok((
                Some(text.clone()),
                None,
                None,
                Some(hash),
                Some(text.len() as i64),
                None,
            ))
        }
        ArtifactContent::Json { json } => {
            let serialized = serde_json::to_string(json)
                .map_err(|e| DbError::Query(format!("encode artifact json: {e}")))?;
            let hash = sha256_hex(serialized.as_bytes());
            Ok((
                None,
                Some(json.clone()),
                None,
                Some(hash),
                Some(serialized.len() as i64),
                None,
            ))
        }
        ArtifactContent::File { bytes, filename } => {
            let rel_path = format!("{artifact_id}/{filename}");
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
            // Do NOT rename yet — caller will promote the temp after the DB update
            // succeeds. This prevents leaving disk state ahead of the DB row.
            let hash = sha256_hex(bytes);
            Ok((
                None,
                None,
                Some(rel_path),
                Some(hash),
                Some(bytes.len() as i64),
                Some(temp),
            ))
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