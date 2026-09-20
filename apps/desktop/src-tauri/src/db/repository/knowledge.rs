//! `knowledge_*` repository (t1-6 M3) — local knowledge base (RAG) storage.
//!
//! Five tables, one repository file (migration 0017 documents the schema
//! decisions — inline vector BLOBs, standalone FTS5, cascading deletes). This
//! module owns every SQL statement touching those tables; `crate::knowledge`
//! (chunking, vector math, hybrid search, ingest orchestration) calls into it
//! and never writes SQL of its own.
//!
//! `knowledge_chunks.content` is encrypted at the column layer exactly like
//! `memory_items.body` and `artifacts.content_text` — `enc.encrypt()` on
//! write (identity when the tier is `Off`), `enc.decrypt()` on read, and
//! `enc_key_version` stamped from `enc.key_version()` only when the tier is
//! actually `On` (the `tool_calls::insert_tool_result` pattern), so
//! `encrypted_data_exists` can tell an encrypted row from a plaintext one.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{db::DbError, encryption::Encryption, time::now_iso8601};

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub provider_id: String,
    pub embedding_model: String,
    pub embedding_dimensions: i64,
    pub created_at: String,
    pub updated_at: String,
}

type CollectionRow = (String, String, String, String, i64, String, String);

fn row_to_collection(row: CollectionRow) -> Collection {
    let (id, name, provider_id, embedding_model, embedding_dimensions, created_at, updated_at) =
        row;
    Collection {
        id,
        name,
        provider_id,
        embedding_model,
        embedding_dimensions,
        created_at,
        updated_at,
    }
}

pub struct NewCollection {
    pub name: String,
    pub provider_id: String,
    pub embedding_model: String,
    pub embedding_dimensions: i64,
}

/// Create a collection. The `(provider_id, embedding_model,
/// embedding_dimensions)` triple is fixed at creation — see 0017's doc
/// comment for why mixing embedding spaces inside one collection is refused
/// rather than silently tolerated.
pub async fn create_collection(
    pool: &SqlitePool,
    new: NewCollection,
) -> Result<Collection, DbError> {
    let name = new.name.trim();
    if name.is_empty() {
        return Err(DbError::Query("collection name cannot be empty".into()));
    }
    let id = Uuid::new_v4().to_string();
    let now = now_iso8601();
    sqlx::query(
        "INSERT INTO knowledge_collections \
         (id, name, provider_id, embedding_model, embedding_dimensions, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(name)
    .bind(&new.provider_id)
    .bind(&new.embedding_model)
    .bind(new.embedding_dimensions)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(Collection {
        id,
        name: name.to_string(),
        provider_id: new.provider_id,
        embedding_model: new.embedding_model,
        embedding_dimensions: new.embedding_dimensions,
        created_at: now.clone(),
        updated_at: now,
    })
}

pub async fn list_collections(pool: &SqlitePool) -> Result<Vec<Collection>, DbError> {
    let rows: Vec<CollectionRow> = sqlx::query_as(
        "SELECT id, name, provider_id, embedding_model, embedding_dimensions, created_at, updated_at \
         FROM knowledge_collections ORDER BY name COLLATE NOCASE",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(row_to_collection).collect())
}

pub async fn get_collection(pool: &SqlitePool, id: &str) -> Result<Option<Collection>, DbError> {
    let row: Option<CollectionRow> = sqlx::query_as(
        "SELECT id, name, provider_id, embedding_model, embedding_dimensions, created_at, updated_at \
         FROM knowledge_collections WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(row_to_collection))
}

/// Rename a collection. `updated_at` moves; `created_at` and the embedding
/// triple do not.
pub async fn rename_collection(
    pool: &SqlitePool,
    id: &str,
    name: &str,
) -> Result<Collection, DbError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(DbError::Query("collection name cannot be empty".into()));
    }
    let now = now_iso8601();
    let result =
        sqlx::query("UPDATE knowledge_collections SET name = ?, updated_at = ? WHERE id = ?")
            .bind(trimmed)
            .bind(&now)
            .bind(id)
            .execute(pool)
            .await?;
    if result.rows_affected() == 0 {
        return Err(DbError::Query("collection not found".into()));
    }
    get_collection(pool, id)
        .await?
        .ok_or_else(|| DbError::Query("collection not found".into()))
}

/// Delete a collection. Cascades (FK `ON DELETE CASCADE`) to its documents,
/// their chunks, the chunks' FTS rows (via trigger), and any
/// `conversation_collections` rows that had it enabled.
pub async fn delete_collection(pool: &SqlitePool, id: &str) -> Result<(), DbError> {
    let result = sqlx::query("DELETE FROM knowledge_collections WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(DbError::Query("collection not found".into()));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: String,
    pub collection_id: String,
    pub source: String,
    pub title: String,
    pub mime_type: Option<String>,
    pub content_hash: String,
    pub byte_size: i64,
    pub chunk_count: i64,
    pub imported_at: String,
}

type DocumentRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    i64,
    i64,
    String,
);

fn row_to_document(row: DocumentRow) -> Document {
    let (
        id,
        collection_id,
        source,
        title,
        mime_type,
        content_hash,
        byte_size,
        chunk_count,
        imported_at,
    ) = row;
    Document {
        id,
        collection_id,
        source,
        title,
        mime_type,
        content_hash,
        byte_size,
        chunk_count,
        imported_at,
    }
}

const DOCUMENT_COLUMNS: &str = "id, collection_id, source, title, mime_type, content_hash, byte_size, chunk_count, imported_at";

pub struct NewDocument {
    pub collection_id: String,
    pub source: String,
    pub title: String,
    pub mime_type: Option<String>,
    pub content_hash: String,
    pub byte_size: i64,
    pub chunk_count: i64,
}

/// Insert a document row on its own (no chunks). Used directly only by
/// callers that manage their own chunk-insert transaction; `knowledge::ingest`
/// uses [`insert_document_with_chunks`] instead so the document row and its
/// chunks land atomically.
pub async fn insert_document(pool: &SqlitePool, new: NewDocument) -> Result<Document, DbError> {
    let id = Uuid::new_v4().to_string();
    let now = now_iso8601();
    sqlx::query(
        "INSERT INTO knowledge_documents \
         (id, collection_id, source, title, mime_type, content_hash, byte_size, chunk_count, imported_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&new.collection_id)
    .bind(&new.source)
    .bind(&new.title)
    .bind(&new.mime_type)
    .bind(&new.content_hash)
    .bind(new.byte_size)
    .bind(new.chunk_count)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(Document {
        id,
        collection_id: new.collection_id,
        source: new.source,
        title: new.title,
        mime_type: new.mime_type,
        content_hash: new.content_hash,
        byte_size: new.byte_size,
        chunk_count: new.chunk_count,
        imported_at: now,
    })
}

/// A chunk plus its already-computed embedding vector, ready to be persisted.
/// `crate::knowledge::chunk::Chunk` carries the text + character offsets;
/// the vector is appended once the embedding call for it has returned.
pub struct ChunkToInsert {
    pub content: String,
    pub char_start: i64,
    pub char_end: i64,
    pub embedding: Vec<f32>,
}

/// Insert a document row and every one of its chunks (with embeddings
/// already computed) in a single transaction. This is the write side of
/// `knowledge::ingest::ingest_text`'s atomicity guarantee: by the time this
/// function is called, the only failure-prone step (the provider embedding
/// call) has already succeeded for every chunk, so everything left is a
/// fast, synchronous DB write — either the whole document lands with all its
/// chunks, or (on any error, including a mid-batch one) the transaction rolls
/// back and nothing is written at all. No caller ever sees a document row
/// with a `chunk_count` that doesn't match its actual chunk rows.
pub async fn insert_document_with_chunks(
    pool: &SqlitePool,
    enc: &Encryption,
    new: NewDocument,
    chunks: &[ChunkToInsert],
) -> Result<Document, DbError> {
    let document_id = Uuid::new_v4().to_string();
    let now = now_iso8601();
    let enc_key_version = if enc.is_on() {
        Some(enc.key_version() as i64)
    } else {
        None
    };

    let mut tx = pool.begin().await?;

    sqlx::query(
        "INSERT INTO knowledge_documents \
         (id, collection_id, source, title, mime_type, content_hash, byte_size, chunk_count, imported_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&document_id)
    .bind(&new.collection_id)
    .bind(&new.source)
    .bind(&new.title)
    .bind(&new.mime_type)
    .bind(&new.content_hash)
    .bind(new.byte_size)
    .bind(chunks.len() as i64)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    for (ordinal, chunk) in chunks.iter().enumerate() {
        let chunk_id = Uuid::new_v4().to_string();
        let encrypted_content = enc.encrypt(&chunk.content)?;
        let blob = crate::knowledge::vector::encode_vector(&chunk.embedding);
        sqlx::query(
            "INSERT INTO knowledge_chunks \
             (id, document_id, ordinal, content, char_start, char_end, embedding, enc_key_version) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&chunk_id)
        .bind(&document_id)
        .bind(ordinal as i64)
        .bind(&encrypted_content)
        .bind(chunk.char_start)
        .bind(chunk.char_end)
        .bind(&blob)
        .bind(enc_key_version)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    Ok(Document {
        id: document_id,
        collection_id: new.collection_id,
        source: new.source,
        title: new.title,
        mime_type: new.mime_type,
        content_hash: new.content_hash,
        byte_size: new.byte_size,
        chunk_count: chunks.len() as i64,
        imported_at: now,
    })
}

pub async fn list_documents_by_collection(
    pool: &SqlitePool,
    collection_id: &str,
) -> Result<Vec<Document>, DbError> {
    let sql = format!(
        "SELECT {DOCUMENT_COLUMNS} FROM knowledge_documents \
         WHERE collection_id = ? ORDER BY imported_at DESC"
    );
    let rows: Vec<DocumentRow> = sqlx::query_as(&sql)
        .bind(collection_id)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(row_to_document).collect())
}

/// Look up a single document by id — e.g. to recover its title/source when
/// rendering a citation for a chunk a search returned.
pub async fn get_document(pool: &SqlitePool, id: &str) -> Result<Option<Document>, DbError> {
    let sql = format!("SELECT {DOCUMENT_COLUMNS} FROM knowledge_documents WHERE id = ?");
    let row: Option<DocumentRow> = sqlx::query_as(&sql).bind(id).fetch_optional(pool).await?;
    Ok(row.map(row_to_document))
}

/// Dedup lookup: does this collection already have a document whose
/// extracted-text hash matches? `knowledge::ingest::ingest_text` uses this to
/// skip (not re-import) text it has already indexed.
pub async fn find_by_hash(
    pool: &SqlitePool,
    collection_id: &str,
    content_hash: &str,
) -> Result<Option<Document>, DbError> {
    let sql = format!(
        "SELECT {DOCUMENT_COLUMNS} FROM knowledge_documents \
         WHERE collection_id = ? AND content_hash = ? LIMIT 1"
    );
    let row: Option<DocumentRow> = sqlx::query_as(&sql)
        .bind(collection_id)
        .bind(content_hash)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(row_to_document))
}

/// Delete a document. Cascades to its chunks and (via trigger) their FTS
/// rows.
pub async fn delete_document(pool: &SqlitePool, id: &str) -> Result<(), DbError> {
    let result = sqlx::query("DELETE FROM knowledge_documents WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(DbError::Query("document not found".into()));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeChunk {
    pub id: String,
    pub document_id: String,
    pub ordinal: i64,
    pub content: String,
    pub char_start: i64,
    pub char_end: i64,
    /// Decoded from the raw little-endian BLOB; `None` if the row has no
    /// embedding yet (shouldn't happen via `ingest_text`, but a chunk row
    /// isn't wrong to exist without one).
    pub embedding: Option<Vec<f32>>,
}

type ChunkRow = (String, String, i64, String, i64, i64, Option<Vec<u8>>);

fn row_to_chunk(row: ChunkRow, enc: &Encryption) -> Result<KnowledgeChunk, DbError> {
    let (id, document_id, ordinal, content, char_start, char_end, embedding) = row;
    let embedding = embedding
        .map(|bytes| crate::knowledge::vector::decode_vector(&bytes, None))
        .transpose()?;
    Ok(KnowledgeChunk {
        id,
        document_id,
        ordinal,
        content: enc.decrypt(&content)?,
        char_start,
        char_end,
        embedding,
    })
}

/// Batch-insert chunks (with already-computed embeddings) for a document that
/// already exists. Wrapped in its own transaction so the batch is all-or-
/// nothing; does **not** touch `knowledge_documents.chunk_count` (callers
/// that use this standalone — as opposed to
/// [`insert_document_with_chunks`], which is what `ingest_text` actually
/// uses — are responsible for that bookkeeping).
pub async fn insert_chunks_batch(
    pool: &SqlitePool,
    enc: &Encryption,
    document_id: &str,
    chunks: &[ChunkToInsert],
) -> Result<Vec<String>, DbError> {
    let enc_key_version = if enc.is_on() {
        Some(enc.key_version() as i64)
    } else {
        None
    };
    let mut ids = Vec::with_capacity(chunks.len());
    let mut tx = pool.begin().await?;
    for (ordinal, chunk) in chunks.iter().enumerate() {
        let chunk_id = Uuid::new_v4().to_string();
        let encrypted_content = enc.encrypt(&chunk.content)?;
        let blob = crate::knowledge::vector::encode_vector(&chunk.embedding);
        sqlx::query(
            "INSERT INTO knowledge_chunks \
             (id, document_id, ordinal, content, char_start, char_end, embedding, enc_key_version) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&chunk_id)
        .bind(document_id)
        .bind(ordinal as i64)
        .bind(&encrypted_content)
        .bind(chunk.char_start)
        .bind(chunk.char_end)
        .bind(&blob)
        .bind(enc_key_version)
        .execute(&mut *tx)
        .await?;
        ids.push(chunk_id);
    }
    tx.commit().await?;
    Ok(ids)
}

pub async fn list_chunks_by_document(
    pool: &SqlitePool,
    enc: &Encryption,
    document_id: &str,
) -> Result<Vec<KnowledgeChunk>, DbError> {
    let rows: Vec<ChunkRow> = sqlx::query_as(
        "SELECT id, document_id, ordinal, content, char_start, char_end, embedding \
         FROM knowledge_chunks WHERE document_id = ? ORDER BY ordinal",
    )
    .bind(document_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(|r| row_to_chunk(r, enc)).collect()
}

pub async fn delete_chunks_by_document(
    pool: &SqlitePool,
    document_id: &str,
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM knowledge_chunks WHERE document_id = ?")
        .bind(document_id)
        .execute(pool)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Hybrid-search read paths (used by `crate::knowledge::search`)
// ---------------------------------------------------------------------------

/// One chunk with a stored embedding, scoped to the requested collections.
/// `content` is still column-encrypted (`enc.decrypt()` happens in
/// `knowledge::search`, which is where the scoring math also lives); this
/// repository layer's job stops at "which rows, which bytes".
pub struct ChunkVectorRow {
    pub chunk_id: String,
    pub document_id: String,
    pub collection_id: String,
    pub content_encrypted: String,
    pub embedding: Vec<u8>,
    pub ordinal: i64,
    pub char_start: i64,
    pub char_end: i64,
}

/// Every chunk with a non-NULL embedding across `collection_ids`. Brute-force
/// vector search (`knowledge::search::vector_search`) scans this in memory —
/// see 0017's doc comment for why that's fine at this scale.
pub async fn list_chunk_vectors(
    pool: &SqlitePool,
    collection_ids: &[String],
) -> Result<Vec<ChunkVectorRow>, DbError> {
    if collection_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = collection_ids
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT c.id, c.document_id, d.collection_id, c.content, c.embedding, \
                c.ordinal, c.char_start, c.char_end \
         FROM knowledge_chunks c \
         JOIN knowledge_documents d ON d.id = c.document_id \
         WHERE d.collection_id IN ({placeholders}) AND c.embedding IS NOT NULL"
    );
    let mut query = sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            String,
            Option<Vec<u8>>,
            i64,
            i64,
            i64,
        ),
    >(&sql);
    for id in collection_ids {
        query = query.bind(id);
    }
    let rows = query.fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .filter_map(
            |(
                chunk_id,
                document_id,
                collection_id,
                content_encrypted,
                embedding,
                ordinal,
                char_start,
                char_end,
            )| {
                embedding.map(|embedding| ChunkVectorRow {
                    chunk_id,
                    document_id,
                    collection_id,
                    content_encrypted,
                    embedding,
                    ordinal,
                    char_start,
                    char_end,
                })
            },
        )
        .collect())
}

/// One FTS5 keyword match, scoped to the requested collections, in `rank`
/// order (best match first — FTS5's implicit `bm25()`-backed `rank` column,
/// same as `search::search_messages`).
pub struct ChunkKeywordRow {
    pub chunk_id: String,
    pub document_id: String,
    pub collection_id: String,
    pub content_encrypted: String,
    pub ordinal: i64,
    pub char_start: i64,
    pub char_end: i64,
}

/// Run an FTS5 `MATCH` against `knowledge_chunk_fts`, scoped to
/// `collection_ids`, ordered by relevance. `sanitized_query` must already be
/// a safe FTS5 match expression (see `knowledge::search::sanitize_fts_query`)
/// — this function does not sanitize, only sanitized queries reach it.
pub async fn keyword_match(
    pool: &SqlitePool,
    collection_ids: &[String],
    sanitized_query: &str,
    limit: i64,
) -> Result<Vec<ChunkKeywordRow>, DbError> {
    if collection_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = collection_ids
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT f.chunk_id, f.document_id, f.collection_id, c.content, \
                c.ordinal, c.char_start, c.char_end \
         FROM knowledge_chunk_fts f \
         JOIN knowledge_chunks c ON c.id = f.chunk_id \
         WHERE knowledge_chunk_fts MATCH ? AND f.collection_id IN ({placeholders}) \
         ORDER BY rank LIMIT ?"
    );
    let mut query = sqlx::query_as::<_, (String, String, String, String, i64, i64, i64)>(&sql)
        .bind(sanitized_query);
    for id in collection_ids {
        query = query.bind(id);
    }
    let rows = query.bind(limit).fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(
            |(
                chunk_id,
                document_id,
                collection_id,
                content_encrypted,
                ordinal,
                char_start,
                char_end,
            )| {
                ChunkKeywordRow {
                    chunk_id,
                    document_id,
                    collection_id,
                    content_encrypted,
                    ordinal,
                    char_start,
                    char_end,
                }
            },
        )
        .collect())
}

// ---------------------------------------------------------------------------
// conversation_collections — per-conversation enabled set
// ---------------------------------------------------------------------------

/// List the collection ids enabled for a conversation. Shape and rationale
/// mirror `skills::list_enabled` exactly — presence of a row means "on".
pub async fn list_enabled(
    pool: &SqlitePool,
    conversation_id: &str,
) -> Result<Vec<String>, DbError> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT collection_id FROM conversation_collections \
         WHERE conversation_id = ? ORDER BY collection_id",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Replace the enabled set for `conversation_id`. Copies
/// `skills::set_enabled`'s full-replace transactional shape exactly:
/// dedupe, delete every existing row, reinsert the new set, all inside one
/// transaction. Unknown/since-deleted collection ids are stored anyway (same
/// leniency as skills) so a collection that disappears can still be toggled
/// off later without a special case.
pub async fn set_enabled(
    pool: &SqlitePool,
    conversation_id: &str,
    collection_ids: &[String],
) -> Result<Vec<String>, DbError> {
    let mut unique = Vec::new();
    for id in collection_ids {
        let trimmed = id.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !unique.iter().any(|e: &String| e == trimmed) {
            unique.push(trimmed.to_string());
        }
    }

    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM conversation_collections WHERE conversation_id = ?")
        .bind(conversation_id)
        .execute(&mut *tx)
        .await?;
    for id in &unique {
        sqlx::query(
            "INSERT INTO conversation_collections (conversation_id, collection_id) VALUES (?, ?)",
        )
        .bind(conversation_id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(unique)
}
