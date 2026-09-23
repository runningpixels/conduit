//! t1-6 M3: local knowledge base (RAG) — ingest, vector/keyword/hybrid
//! search, dedup, and cascading delete.
//!
//! Same fake-adapter seam `tests/generate_image_tool.rs` uses for t0-8:
//! `FakeEmbeddingAdapter` implements `ProviderAdapter::generate_embeddings`
//! directly and is handed to `knowledge::ingest::EmbeddingConfig`, so no
//! network call happens anywhere in this file. The fake computes a small,
//! deterministic bag-of-words vector over a fixed vocabulary — enough to make
//! "semantically closest" a meaningful, reproducible assertion without a real
//! embedding model.

mod common;

use std::pin::Pin;

use async_trait::async_trait;
use conduit_desktop::{
    db::repository::knowledge as repo,
    knowledge::{
        ingest::{ingest_text, EmbeddingConfig, IngestOutcome},
        search::{hybrid_search, keyword_search, sanitize_fts_query, vector_search},
    },
};
use futures::stream::Stream;
use provider_core::{
    schema::{EmbeddingRequest, EmbeddingResult, ProviderEvent, ProviderRequest},
    AdapterContext, ModelInfo, ProviderAdapter, ProviderError,
};
use sqlx::SqlitePool;
use tokio_util::sync::CancellationToken;

/// Fixed vocabulary the fake embeds against. Each dimension counts (a lower-
/// cased, case-insensitive) occurrences of that word in the input text.
/// Small and topic-separated on purpose — "tomato"/"garden"/"soil"/"water"
/// cluster one topic, "quantum"/"qubit"/"physics"/"computer" cluster another
/// — so cosine similarity actually discriminates between the two chunks a
/// test document is built from.
const VOCAB: [&str; 8] = [
    "tomato", "garden", "soil", "water", "quantum", "qubit", "physics", "computer",
];

fn fake_embed(text: &str) -> Vec<f32> {
    let lower = text.to_lowercase();
    VOCAB
        .iter()
        .map(|word| lower.matches(word).count() as f32)
        .collect()
}

struct FakeEmbeddingAdapter;

#[async_trait]
impl ProviderAdapter for FakeEmbeddingAdapter {
    fn id(&self) -> &'static str {
        "fake-embedding-provider"
    }

    fn display_name(&self) -> &'static str {
        "Fake Embedding Provider"
    }

    async fn validate_credentials(&self, _ctx: &AdapterContext) -> Result<(), ProviderError> {
        Ok(())
    }

    async fn list_models(&self, _ctx: &AdapterContext) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(Vec::new())
    }

    async fn stream_chat(
        &self,
        _request: ProviderRequest,
        _ctx: AdapterContext,
        _cancel: CancellationToken,
    ) -> Result<Pin<Box<dyn Stream<Item = ProviderEvent> + Send>>, ProviderError> {
        Err(provider_core::error::fatal(
            "stream_chat is not exercised by this test",
        ))
    }

    async fn generate_embeddings(
        &self,
        request: EmbeddingRequest,
        _ctx: &AdapterContext,
    ) -> Result<EmbeddingResult, ProviderError> {
        let vectors = request.inputs.iter().map(|s| fake_embed(s)).collect();
        Ok(EmbeddingResult {
            vectors,
            model_id: request.model_id,
        })
    }
}

/// An adapter whose `generate_embeddings` always fails, for the "embedding
/// failure mid-import leaves nothing behind" test.
struct FailingEmbeddingAdapter;

#[async_trait]
impl ProviderAdapter for FailingEmbeddingAdapter {
    fn id(&self) -> &'static str {
        "failing-embedding-provider"
    }

    fn display_name(&self) -> &'static str {
        "Failing Embedding Provider"
    }

    async fn validate_credentials(&self, _ctx: &AdapterContext) -> Result<(), ProviderError> {
        Ok(())
    }

    async fn list_models(&self, _ctx: &AdapterContext) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(Vec::new())
    }

    async fn stream_chat(
        &self,
        _request: ProviderRequest,
        _ctx: AdapterContext,
        _cancel: CancellationToken,
    ) -> Result<Pin<Box<dyn Stream<Item = ProviderEvent> + Send>>, ProviderError> {
        Err(provider_core::error::fatal(
            "stream_chat is not exercised by this test",
        ))
    }

    async fn generate_embeddings(
        &self,
        _request: EmbeddingRequest,
        _ctx: &AdapterContext,
    ) -> Result<EmbeddingResult, ProviderError> {
        Err(provider_core::error::fatal(
            "the embedding provider is down",
        ))
    }
}

fn fake_adapter_ctx() -> AdapterContext {
    AdapterContext {
        api_key: None,
        base_url: None,
        http: provider_core::transport::HttpClient::new(),
        local_only: false,
    }
}

fn embedding_config() -> EmbeddingConfig {
    EmbeddingConfig {
        provider_id: "fake-embedding-provider".to_string(),
        model_id: "fake-embed-1".to_string(),
        adapter: Box::new(FakeEmbeddingAdapter),
        adapter_ctx: fake_adapter_ctx(),
    }
}

fn failing_embedding_config() -> EmbeddingConfig {
    EmbeddingConfig {
        provider_id: "failing-embedding-provider".to_string(),
        model_id: "fake-embed-1".to_string(),
        adapter: Box::new(FailingEmbeddingAdapter),
        adapter_ctx: fake_adapter_ctx(),
    }
}

async fn create_test_collection(pool: &SqlitePool) -> repo::Collection {
    repo::create_collection(
        pool,
        repo::NewCollection {
            name: "Test Collection".to_string(),
            provider_id: "fake-embedding-provider".to_string(),
            embedding_model: "fake-embed-1".to_string(),
            embedding_dimensions: VOCAB.len() as i64,
        },
    )
    .await
    .unwrap()
}

/// Two clearly-separated topics, each long enough on its own to force
/// `chunk_text` to produce at least one whole chunk about each topic (so
/// vector search has a real choice to make between chunks, not just within
/// one).
fn gardening_paragraph() -> String {
    "Growing healthy tomato plants starts with good garden soil. \
     Tomato roots need loose, well-drained soil and consistent water. \
     A tomato garden bed should get full sun and regular water. \
     Amend the soil with compost before you plant tomato seedlings in the garden. "
        .repeat(6)
}

fn physics_paragraph() -> String {
    "Quantum computers use qubits instead of classical bits. \
     A qubit can represent a superposition of states, which is the core idea \
     behind quantum computing. Physics research into quantum computer \
     hardware focuses on keeping qubits stable long enough to compute. "
        .repeat(6)
}

fn markdown_document() -> String {
    format!(
        "# Gardening and Physics\n\n{}\n\n{}",
        gardening_paragraph(),
        physics_paragraph()
    )
}

#[tokio::test]
async fn ingest_stores_chunks_with_vectors() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let collection = create_test_collection(&pool).await;
    let embedding = embedding_config();

    let outcome = ingest_text(
        &pool,
        &enc,
        &embedding,
        &collection.id,
        "test://doc-1.md",
        "Gardening and Physics",
        &markdown_document(),
    )
    .await
    .expect("ingest succeeds");

    let (document_id, chunk_count) = match outcome {
        IngestOutcome::Imported {
            document_id,
            chunk_count,
        } => (document_id, chunk_count),
        other => panic!("expected Imported, got {other:?}"),
    };
    assert!(chunk_count >= 1);

    let chunks = repo::list_chunks_by_document(&pool, &enc, &document_id)
        .await
        .unwrap();
    assert_eq!(chunks.len(), chunk_count);
    for chunk in &chunks {
        let vector = chunk.embedding.as_ref().expect("chunk has an embedding");
        assert_eq!(vector.len(), VOCAB.len());
        assert!(!chunk.content.is_empty());
    }

    let doc = repo::find_by_hash(
        &pool,
        &collection.id,
        &sha256_hex_for_test(&markdown_document()),
    )
    .await
    .unwrap()
    .expect("document findable by hash");
    assert_eq!(doc.id, document_id);
    assert_eq!(doc.chunk_count, chunk_count as i64);
}

#[tokio::test]
async fn vector_search_finds_the_semantically_closest_chunk() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let collection = create_test_collection(&pool).await;
    let embedding = embedding_config();

    ingest_text(
        &pool,
        &enc,
        &embedding,
        &collection.id,
        "test://doc-1.md",
        "Gardening and Physics",
        &markdown_document(),
    )
    .await
    .unwrap();

    let query_vector = fake_embed("How do I water my tomato garden soil?");
    let results = vector_search(
        &pool,
        &enc,
        std::slice::from_ref(&collection.id),
        &query_vector,
        5,
    )
    .await
    .unwrap();

    assert!(!results.is_empty());
    let top = &results[0];
    assert!(
        top.content.to_lowercase().contains("tomato"),
        "top vector result should be the gardening chunk, got: {}",
        top.content
    );
    // The top result should score strictly higher than a physics-only query
    // against the same corpus would for this chunk — sanity check the score
    // itself isn't degenerate.
    assert!(top.score > 0.0);

    // Citation fields: ordinal/char_start/char_end must match the chunk's
    // actual row (not just be present), and get_document must resolve the
    // title a citation would show.
    assert!(top.char_end > top.char_start);
    assert!(top.ordinal >= 0);
    let chunks = repo::list_chunks_by_document(&pool, &enc, &top.document_id)
        .await
        .unwrap();
    let matching = chunks
        .iter()
        .find(|c| c.id == top.chunk_id)
        .expect("scored chunk exists in its document's chunk list");
    assert_eq!(matching.ordinal, top.ordinal);
    assert_eq!(matching.char_start, top.char_start);
    assert_eq!(matching.char_end, top.char_end);

    let doc = repo::get_document(&pool, &top.document_id)
        .await
        .unwrap()
        .expect("get_document resolves the citation's source document");
    assert_eq!(doc.title, "Gardening and Physics");
}

#[tokio::test]
async fn get_document_returns_none_for_unknown_id() {
    let pool = common::setup_pool().await;
    let missing = repo::get_document(&pool, "not-a-real-id").await.unwrap();
    assert!(missing.is_none());
}

#[tokio::test]
async fn keyword_search_finds_an_exact_term() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let collection = create_test_collection(&pool).await;
    let embedding = embedding_config();

    ingest_text(
        &pool,
        &enc,
        &embedding,
        &collection.id,
        "test://doc-1.md",
        "Gardening and Physics",
        &markdown_document(),
    )
    .await
    .unwrap();

    let results = keyword_search(
        &pool,
        &enc,
        std::slice::from_ref(&collection.id),
        "qubit",
        5,
    )
    .await
    .unwrap();
    assert!(!results.is_empty(), "should find the qubit chunk");
    assert!(results
        .iter()
        .any(|r| r.content.to_lowercase().contains("qubit")));
    // keyword_search populates citation fields too, not just vector_search.
    for r in &results {
        assert!(r.char_end > r.char_start);
        assert!(r.ordinal >= 0);
    }
}

#[tokio::test]
async fn hybrid_search_returns_results_from_both_signals() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let collection = create_test_collection(&pool).await;
    let embedding = embedding_config();

    ingest_text(
        &pool,
        &enc,
        &embedding,
        &collection.id,
        "test://doc-1.md",
        "Gardening and Physics",
        &markdown_document(),
    )
    .await
    .unwrap();

    let query_vector = fake_embed("tomato garden");
    let results = hybrid_search(
        &pool,
        &enc,
        std::slice::from_ref(&collection.id),
        &query_vector,
        "qubit physics",
        5,
    )
    .await
    .unwrap();

    assert!(!results.is_empty());
    // The gardening chunk should be pulled in via the vector query, the
    // physics chunk via the keyword query -- hybrid fuses both lists, so
    // both topics should be represented among the results.
    assert!(results
        .iter()
        .any(|r| r.content.to_lowercase().contains("tomato")));
    assert!(results
        .iter()
        .any(|r| r.content.to_lowercase().contains("qubit")));
    // Scores are RRF sums and therefore monotonically non-increasing.
    for pair in results.windows(2) {
        assert!(pair[0].score >= pair[1].score);
    }
}

#[tokio::test]
async fn reimporting_identical_text_is_deduped() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let collection = create_test_collection(&pool).await;
    let embedding = embedding_config();
    let text = markdown_document();

    let first = ingest_text(
        &pool,
        &enc,
        &embedding,
        &collection.id,
        "test://doc-1.md",
        "Gardening and Physics",
        &text,
    )
    .await
    .unwrap();
    let first_id = match first {
        IngestOutcome::Imported { document_id, .. } => document_id,
        other => panic!("expected Imported on first import, got {other:?}"),
    };

    let second = ingest_text(
        &pool,
        &enc,
        &embedding,
        &collection.id,
        "test://doc-1-again.md",
        "Gardening and Physics (again)",
        &text,
    )
    .await
    .unwrap();
    match second {
        IngestOutcome::AlreadyImported { document_id } => assert_eq!(document_id, first_id),
        other => panic!("expected AlreadyImported on re-import, got {other:?}"),
    }

    let docs = repo::list_documents_by_collection(&pool, &collection.id)
        .await
        .unwrap();
    assert_eq!(docs.len(), 1, "re-import must not create a second document");
}

#[tokio::test]
async fn deleting_a_document_removes_its_chunks_and_fts_rows() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let collection = create_test_collection(&pool).await;
    let embedding = embedding_config();

    let outcome = ingest_text(
        &pool,
        &enc,
        &embedding,
        &collection.id,
        "test://doc-1.md",
        "Gardening and Physics",
        &markdown_document(),
    )
    .await
    .unwrap();
    let document_id = match outcome {
        IngestOutcome::Imported { document_id, .. } => document_id,
        other => panic!("expected Imported, got {other:?}"),
    };

    let (chunk_count_before,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM knowledge_chunks WHERE document_id = ?")
            .bind(&document_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(chunk_count_before > 0);
    let (fts_count_before,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM knowledge_chunk_fts WHERE document_id = ?")
            .bind(&document_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(fts_count_before > 0);

    repo::delete_document(&pool, &document_id).await.unwrap();

    let (chunk_count_after,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM knowledge_chunks WHERE document_id = ?")
            .bind(&document_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(chunk_count_after, 0);
    let (fts_count_after,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM knowledge_chunk_fts WHERE document_id = ?")
            .bind(&document_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(fts_count_after, 0);
}

#[tokio::test]
async fn ingest_handles_cjk_and_emoji_without_panicking() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let collection = create_test_collection(&pool).await;
    let embedding = embedding_config();

    let text = format!(
        "# 知識ベース\n\n{}\n\n{}",
        "植物には水と土と太陽の光が必要です。トマトを育てるのは簡単です。".repeat(40),
        "🚀🎉👨‍👩‍👧‍👦😀🔥 quantum qubit physics computer ".repeat(40)
    );

    let outcome = ingest_text(
        &pool,
        &enc,
        &embedding,
        &collection.id,
        "test://doc-cjk.md",
        "CJK and emoji doc",
        &text,
    )
    .await
    .expect("ingest of CJK/emoji text should not panic and should succeed");

    let document_id = match outcome {
        IngestOutcome::Imported { document_id, .. } => document_id,
        other => panic!("expected Imported, got {other:?}"),
    };
    let chunks = repo::list_chunks_by_document(&pool, &enc, &document_id)
        .await
        .unwrap();
    assert!(!chunks.is_empty());
}

#[tokio::test]
async fn malformed_fts_query_does_not_error_the_search() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let collection = create_test_collection(&pool).await;
    let embedding = embedding_config();

    ingest_text(
        &pool,
        &enc,
        &embedding,
        &collection.id,
        "test://doc-1.md",
        "Gardening and Physics",
        &markdown_document(),
    )
    .await
    .unwrap();

    // Unbalanced quote, a leading NOT-like dash, and a bare operator keyword
    // -- all of these are FTS5 syntax errors if passed through raw.
    for raw in ["what is \"foo", "-leading-dash", "NEAR", "***", ""] {
        let result =
            keyword_search(&pool, &enc, std::slice::from_ref(&collection.id), raw, 5).await;
        assert!(
            result.is_ok(),
            "keyword_search({raw:?}) should not error, got {result:?}"
        );
    }

    // sanitize_fts_query itself: pure punctuation/empty sanitizes to None.
    assert_eq!(sanitize_fts_query("***"), None);
    assert_eq!(sanitize_fts_query(""), None);

    // And a malformed query must not break hybrid search either.
    let query_vector = fake_embed("tomato garden");
    let hybrid = hybrid_search(
        &pool,
        &enc,
        std::slice::from_ref(&collection.id),
        &query_vector,
        "what is \"foo",
        5,
    )
    .await;
    assert!(hybrid.is_ok());
}

#[tokio::test]
async fn embedding_failure_leaves_no_partial_document() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let collection = create_test_collection(&pool).await;
    let embedding = failing_embedding_config();

    let result = ingest_text(
        &pool,
        &enc,
        &embedding,
        &collection.id,
        "test://doc-1.md",
        "Gardening and Physics",
        &markdown_document(),
    )
    .await;
    assert!(
        result.is_err(),
        "embedding failure should surface as an error"
    );

    let docs = repo::list_documents_by_collection(&pool, &collection.id)
        .await
        .unwrap();
    assert!(
        docs.is_empty(),
        "a failed embedding call must not leave a half-imported document behind"
    );

    let (chunk_count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM knowledge_chunks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(chunk_count, 0);
}

#[tokio::test]
async fn conversation_collections_full_replace_matches_skills_shape() {
    let pool = common::setup_pool().await;
    let conv = conduit_desktop::db::repository::conversations::create(&pool, None)
        .await
        .unwrap();
    let collection_a = create_test_collection(&pool).await;
    let collection_b = create_test_collection(&pool).await;

    let enabled = repo::set_enabled(
        &pool,
        &conv.id,
        &[collection_a.id.clone(), collection_b.id.clone()],
    )
    .await
    .unwrap();
    assert_eq!(enabled.len(), 2);

    let listed = repo::list_enabled(&pool, &conv.id).await.unwrap();
    assert_eq!(listed.len(), 2);

    // Full replace: enabling just collection_a should turn collection_b off.
    let replaced = repo::set_enabled(&pool, &conv.id, std::slice::from_ref(&collection_a.id))
        .await
        .unwrap();
    assert_eq!(replaced, vec![collection_a.id.clone()]);
    let listed = repo::list_enabled(&pool, &conv.id).await.unwrap();
    assert_eq!(listed, vec![collection_a.id.clone()]);
}

/// Local re-implementation of `ingest::sha256_hex` (private to the crate) so
/// the test can look a document up by hash the same way `ingest_text` does.
fn sha256_hex_for_test(text: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    let digest = hasher.finalize();
    let mut s = String::with_capacity(digest.len() * 2);
    for byte in digest {
        s.push_str(&format!("{byte:02x}"));
    }
    s
}

/// A citation chip opens its passage by chunk id. The lookup must return the
/// decrypted text, and must return `None` — not an error — once the document is
/// deleted, because a citation in an old answer can outlive its document.
#[tokio::test]
async fn get_chunk_returns_the_passage_and_none_after_delete() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let collection = create_test_collection(&pool).await;
    let embedding = embedding_config();

    let document_id = match ingest_text(
        &pool,
        &enc,
        &embedding,
        &collection.id,
        "test://cite.md",
        "Citable",
        &markdown_document(),
    )
    .await
    .unwrap()
    {
        IngestOutcome::Imported { document_id, .. } => document_id,
        other => panic!("expected Imported, got {other:?}"),
    };

    let chunks = repo::list_chunks_by_document(&pool, &enc, &document_id)
        .await
        .unwrap();
    let first = &chunks[0];

    let fetched = repo::get_chunk(&pool, &enc, &first.id)
        .await
        .unwrap()
        .expect("an existing chunk is found");
    assert_eq!(
        fetched.content, first.content,
        "content comes back decrypted"
    );
    assert_eq!(fetched.document_id, document_id);
    assert_eq!(fetched.char_start, first.char_start);

    assert!(repo::get_chunk(&pool, &enc, "no-such-chunk")
        .await
        .unwrap()
        .is_none());

    repo::delete_document(&pool, &document_id).await.unwrap();
    assert!(
        repo::get_chunk(&pool, &enc, &first.id)
            .await
            .unwrap()
            .is_none(),
        "a deleted document's chunks are gone, and that is not an error"
    );
}
