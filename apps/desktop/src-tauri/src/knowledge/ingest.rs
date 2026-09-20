//! Ingest orchestration (t1-6 M3): hash → dedup → chunk → embed → store.
//!
//! **Transaction choice.** Embedding is an async provider call, and the
//! SQLite pool here is a single connection (`SqlitePoolOptions::max_connections(1)`,
//! see `db::init_pool`'s doc comment) — SQLite serializes writers anyway, so
//! there is only ever one connection to hold. Opening a DB transaction and
//! then `.await`ing a network round-trip *inside* it would hold that one
//! connection for as long as the provider takes to answer, blocking every
//! other query the app needs to run (message send, a second concurrent
//! ingest, anything) for that whole window. So embedding happens first, in
//! full, with **no transaction open** — every batch either succeeds or the
//! whole `ingest_text` call fails and returns before touching the database at
//! all. Only once every vector is in hand does
//! `knowledge::insert_document_with_chunks` open a transaction and write the
//! document row plus all of its chunk rows atomically. That single
//! transaction is pure, fast, synchronous DB writes — nothing in it can fail
//! partway through in a way that leaves a document with some but not all of
//! its chunks; a failure there (disk full, corruption) rolls the whole insert
//! back via `tx` drop/rollback, so there is never a document row to clean up
//! after the fact.

use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::{
    db::{
        repository::knowledge::{self as repo, ChunkToInsert, Document, NewDocument},
        DbError,
    },
    encryption::Encryption,
};

use super::chunk::chunk_text;

/// How many chunks go into a single `generate_embeddings` call. Keeps a
/// large document (which can chunk into thousands of pieces) from being sent
/// to the provider as one enormous request — batching bounds both the
/// request size and the blast radius of a single failed call.
pub const EMBEDDING_BATCH_SIZE: usize = 64;

/// The provider call needed to embed chunks during ingest. Mirrors
/// `agent_tools::ImageToolConfig`'s shape: an already-resolved adapter +
/// context, plus the identifying fields needed for error messages.
pub struct EmbeddingConfig {
    /// Kept alongside `adapter` for error messages, same rationale as
    /// `ImageToolConfig::provider_id`.
    pub provider_id: String,
    pub model_id: String,
    pub adapter: Box<dyn provider_core::ProviderAdapter>,
    pub adapter_ctx: provider_core::AdapterContext,
}

#[derive(Debug, Clone)]
pub enum IngestOutcome {
    /// A new document was chunked, embedded, and stored.
    Imported {
        document_id: String,
        chunk_count: usize,
    },
    /// `text`'s content hash already exists in this collection; nothing was
    /// written. Not an error — re-importing the same source is a normal
    /// thing to do (e.g. re-running an import script) and should be a no-op,
    /// not a duplicate.
    AlreadyImported { document_id: String },
}

/// Hash, dedup, chunk, embed (batched), and store `text` as a new document in
/// `collection_id`.
///
/// `source` is the document's origin (a path or URL); `title` is the
/// human-readable name. Both are stored as-is on the `knowledge_documents`
/// row.
pub async fn ingest_text(
    pool: &SqlitePool,
    enc: &Encryption,
    embedding: &EmbeddingConfig,
    collection_id: &str,
    source: &str,
    title: &str,
    text: &str,
) -> Result<IngestOutcome, DbError> {
    let collection = repo::get_collection(pool, collection_id)
        .await?
        .ok_or_else(|| DbError::Query(format!("collection {collection_id} not found")))?;

    let content_hash = sha256_hex(text);

    if let Some(existing) = repo::find_by_hash(pool, collection_id, &content_hash).await? {
        return Ok(IngestOutcome::AlreadyImported {
            document_id: existing.id,
        });
    }

    let chunks = chunk_text(text);
    if chunks.is_empty() {
        return Err(DbError::Query(
            "document has no extractable text to import".into(),
        ));
    }

    let vectors = embed_all(embedding, &chunks).await?;
    if vectors.len() != chunks.len() {
        // Defensive: every adapter's `generate_embeddings` is supposed to
        // funnel through `provider_core::embeddings::validate_vectors`,
        // which already rejects a count mismatch per batch, but the batches
        // are concatenated here, so double-check the total too.
        return Err(DbError::Query(format!(
            "embedding returned {} vector(s) for {} chunk(s)",
            vectors.len(),
            chunks.len()
        )));
    }
    let expected_dims = collection.embedding_dimensions as usize;
    if let Some(bad) = vectors.iter().find(|v| v.len() != expected_dims) {
        // 0017's doc comment: mixing embedding spaces inside one collection
        // is refused, not silently tolerated. A vector whose length doesn't
        // match the collection's declared `embedding_dimensions` means the
        // provider/model actually used doesn't match what the collection was
        // created with — never store it.
        return Err(DbError::Query(format!(
            "embedding vector has {} dimension(s), but collection {collection_id} expects {expected_dims}",
            bad.len()
        )));
    }

    let to_insert: Vec<ChunkToInsert> = chunks
        .into_iter()
        .zip(vectors)
        .map(|(chunk, vector)| ChunkToInsert {
            content: chunk.content,
            char_start: chunk.char_start as i64,
            char_end: chunk.char_end as i64,
            embedding: vector,
        })
        .collect();

    let new_document = NewDocument {
        collection_id: collection_id.to_string(),
        source: source.to_string(),
        title: title.to_string(),
        mime_type: None,
        content_hash,
        byte_size: text.len() as i64,
        chunk_count: to_insert.len() as i64,
    };

    let document: Document =
        repo::insert_document_with_chunks(pool, enc, new_document, &to_insert).await?;

    Ok(IngestOutcome::Imported {
        document_id: document.id,
        chunk_count: to_insert.len(),
    })
}

/// Embed every chunk's text, `EMBEDDING_BATCH_SIZE` at a time, concatenating
/// the resulting vectors in chunk order. No DB access — pure provider calls.
async fn embed_all(
    embedding: &EmbeddingConfig,
    chunks: &[super::chunk::Chunk],
) -> Result<Vec<Vec<f32>>, DbError> {
    let mut vectors = Vec::with_capacity(chunks.len());
    for batch in chunks.chunks(EMBEDDING_BATCH_SIZE) {
        let inputs: Vec<String> = batch.iter().map(|c| c.content.clone()).collect();
        let request = provider_core::EmbeddingRequest {
            model_id: embedding.model_id.clone(),
            inputs,
        };
        let result = embedding
            .adapter
            .generate_embeddings(request, &embedding.adapter_ctx)
            .await
            .map_err(|e| {
                DbError::Query(format!(
                    "{} embedding failed: {}",
                    embedding.provider_id, e.message
                ))
            })?;
        if result.vectors.len() != batch.len() {
            return Err(DbError::Query(format!(
                "{} returned {} embedding vector(s) for a batch of {}",
                embedding.provider_id,
                result.vectors.len(),
                batch.len()
            )));
        }
        vectors.extend(result.vectors);
    }
    Ok(vectors)
}

fn sha256_hex(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    let digest = hasher.finalize();
    let mut s = String::with_capacity(digest.len() * 2);
    for byte in digest {
        s.push_str(&format!("{byte:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_is_stable_and_case_lowercase() {
        let h1 = sha256_hex("hello world");
        let h2 = sha256_hex("hello world");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
        assert!(h1
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(h1, sha256_hex("hello world!"));
    }
}
