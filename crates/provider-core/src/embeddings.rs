//! Outbound embedding capability helpers for t1-6.
//!
//! Decides which provider has an embeddings endpoint and what its default
//! model is, and holds the shared response-shape validation every adapter's
//! `generate_embeddings` funnels through. Kept as its own module rather than
//! folded into `image_generation.rs`, which is documented as an
//! image-specific capability helper — this is the same *shape* of problem
//! (an outbound, non-streaming provider call with a small capability table)
//! but a different feature.

use crate::error::fatal;
use crate::image_generation::top_level_keys;
use crate::schema::{EmbeddingResult, ProviderError};
use serde_json::Value;

/// The per-provider default embedding model to use when a caller wants to
/// embed text but has no embedding-specific model selected — mirrors
/// `image_generation::default_image_model`'s reasoning: the turn's active
/// *chat* model is never an embedding model, so gating on the provider and
/// picking a hardcoded default is the deliberate tradeoff here too.
///
/// The ids below are verified-current as of 2026-09, against each provider's
/// live docs (see the t1-6 plan's contract notes). Providers rename and
/// retire embedding models without much notice; like `default_image_model`,
/// this will need revisiting when that happens — accepted as the known price
/// of the "pick a default" approach.
pub fn default_embedding_model(provider_id: &str) -> Option<&'static str> {
    match provider_id.trim().to_ascii_lowercase().as_str() {
        "openai" => Some("text-embedding-3-small"),
        "openrouter" => Some("openai/text-embedding-3-small"),
        "gemini" => Some("gemini-embedding-001"),
        "ollama" => Some("nomic-embed-text"),
        _ => None,
    }
}

/// The output dimensionality of [`default_embedding_model`]'s pick, per
/// provider. Paired with it — if one gains a provider the other must too.
///
/// A knowledge collection has to record its dimensions when it is *created*,
/// which is before anything has been embedded, so the number cannot be
/// observed and has to be known up front. Asking the provider would mean a
/// network call (and a billable one) at collection-creation time, before the
/// user has consented to anything being sent, which is the wrong trade for a
/// constant that changes about as often as the model ids above.
///
/// Getting one of these wrong is safe in the way that matters: ingest
/// validates every returned vector's length against the collection's recorded
/// dimensions and fails the import, so a stale constant surfaces as a clear
/// error on the first import rather than as a table of unusable vectors.
pub fn default_embedding_dimensions(provider_id: &str) -> Option<usize> {
    match provider_id.trim().to_ascii_lowercase().as_str() {
        // text-embedding-3-small
        "openai" | "openrouter" => Some(1536),
        // gemini-embedding-001 emits 3072 unless `outputDimensionality` asks
        // for less; we don't ask, so this is what comes back.
        "gemini" => Some(3072),
        // nomic-embed-text
        "ollama" => Some(768),
        _ => None,
    }
}

/// Validates a decoded batch of embedding vectors before they leave the
/// adapter layer. Every `generate_embeddings` implementation funnels its
/// parsed result through this — a silently short or ragged result would
/// corrupt whatever index consumes it (t1-6 M3's vector sidecar file) in a
/// way that is very hard to debug later, so all three failure modes are
/// rejected here, once, rather than left to each adapter to remember:
///
/// - **count mismatch**: fewer or more vectors than inputs sent.
/// - **any empty vector**: a `[]` embedding, which a provider returning
///   `null`/an empty array for an input it couldn't embed would produce.
/// - **inconsistent dimensions**: every vector in one response must have the
///   same length; a provider silently switching model/dimension mid-batch
///   (or a response-shape bug) is exactly the drift this catches.
///
/// Every error names the provider and the numbers involved, not just "bad
/// response" — this is the kind of error someone debugs from the message
/// alone, months from now, without re-reading this function.
pub(crate) fn validate_vectors(
    provider: &str,
    expected: usize,
    vectors: Vec<Vec<f32>>,
) -> Result<Vec<Vec<f32>>, ProviderError> {
    if vectors.len() != expected {
        return Err(fatal(format!(
            "{provider} returned {} embedding vector(s) for {expected} input(s)",
            vectors.len()
        )));
    }

    let mut dim: Option<usize> = None;
    for (index, vector) in vectors.iter().enumerate() {
        if vector.is_empty() {
            return Err(fatal(format!(
                "{provider} returned an empty embedding vector at index {index}"
            )));
        }
        match dim {
            None => dim = Some(vector.len()),
            Some(first_dim) if first_dim != vector.len() => {
                return Err(fatal(format!(
                    "{provider} returned inconsistent embedding dimensions: vector 0 has \
                     {first_dim} dimensions, vector {index} has {}",
                    vector.len()
                )));
            }
            _ => {}
        }
    }

    Ok(vectors)
}

/// Decodes the OpenAI-shaped embeddings response shared by `openai` and the
/// `openrouter` preset: `{"data":[{"embedding":[...],"index":0}],...}`.
/// **Order is not guaranteed** — verified against live docs (t1-6) — so
/// entries are sorted by `index` before being handed to `validate_vectors`.
/// An entry missing `index` falls back to its position in the array, which
/// keeps a response that *does* happen to omit indices (undocumented, but
/// cheap to tolerate) from being rejected outright.
pub(crate) fn parse_openai_style_embeddings_response(
    provider: &str,
    value: &Value,
    expected: usize,
    model_id: String,
) -> Result<EmbeddingResult, ProviderError> {
    let data = value
        .get("data")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            fatal(format!(
                "{provider} embeddings response had no data array (top-level keys: {})",
                top_level_keys(value)
            ))
        })?;

    let mut entries: Vec<(usize, Vec<f32>)> = Vec::with_capacity(data.len());
    for (position, item) in data.iter().enumerate() {
        let index = item
            .get("index")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(position);

        let embedding = item
            .get("embedding")
            .and_then(|v| v.as_array())
            .ok_or_else(|| {
                fatal(format!(
                "{provider} embeddings response data[{position}] had no embedding array (keys: {})",
                top_level_keys(item)
            ))
            })?;

        let vector: Vec<f32> = embedding
            .iter()
            .filter_map(|n| n.as_f64())
            .map(|n| n as f32)
            .collect();
        if vector.len() != embedding.len() {
            return Err(fatal(format!(
                "{provider} embeddings response data[{position}] contained a non-numeric \
                 value in its embedding array"
            )));
        }

        entries.push((index, vector));
    }

    entries.sort_by_key(|(index, _)| *index);
    let vectors: Vec<Vec<f32>> = entries.into_iter().map(|(_, vector)| vector).collect();

    let vectors = validate_vectors(provider, expected, vectors)?;
    Ok(EmbeddingResult { vectors, model_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_embedding_model_covers_the_four_implemented_providers() {
        assert_eq!(
            default_embedding_model("openai"),
            Some("text-embedding-3-small")
        );
        assert_eq!(
            default_embedding_model("openrouter"),
            Some("openai/text-embedding-3-small")
        );
        assert_eq!(
            default_embedding_model("gemini"),
            Some("gemini-embedding-001")
        );
        assert_eq!(default_embedding_model("ollama"), Some("nomic-embed-text"));
    }

    /// Invariant: the model table and the dimension table describe the same
    /// set of providers. They are two halves of one fact, and a provider with
    /// a default model but no known dimensions would fail only at collection
    /// creation, in the UI, on someone else's machine.
    #[test]
    fn default_embedding_dimensions_covers_exactly_the_same_providers() {
        for provider in ["openai", "openrouter", "gemini", "ollama"] {
            assert!(
                default_embedding_model(provider).is_some(),
                "{provider} lost its default model"
            );
            assert!(
                default_embedding_dimensions(provider).is_some(),
                "{provider} has a default embedding model but no known dimensions"
            );
        }
        for provider in ["anthropic", "made-up-provider"] {
            assert_eq!(default_embedding_model(provider), None);
            assert_eq!(default_embedding_dimensions(provider), None);
        }
    }

    #[test]
    fn default_embedding_model_is_none_elsewhere() {
        assert_eq!(default_embedding_model("anthropic"), None);
        assert_eq!(default_embedding_model("made-up-provider"), None);
    }

    #[test]
    fn default_embedding_model_matching_is_case_insensitive() {
        assert_eq!(
            default_embedding_model("OpenAI"),
            Some("text-embedding-3-small")
        );
        assert_eq!(
            default_embedding_model("GEMINI"),
            Some("gemini-embedding-001")
        );
        assert_eq!(default_embedding_model("Ollama"), Some("nomic-embed-text"));
        assert_eq!(
            default_embedding_model("OpenRouter"),
            Some("openai/text-embedding-3-small")
        );
    }

    /// Invariant: every provider `default_embedding_model` names must be one
    /// of the four adapters that actually implement `generate_embeddings`
    /// (M1/M2). If a future edit adds a fifth default without wiring the
    /// adapter, this is the test that catches it going stale.
    #[test]
    fn every_provider_with_a_default_model_is_implemented() {
        const IMPLEMENTED: [&str; 4] = ["openai", "openrouter", "gemini", "ollama"];
        for provider in [
            "openai",
            "openrouter",
            "gemini",
            "ollama",
            "anthropic",
            "deepseek",
        ] {
            if default_embedding_model(provider).is_some() {
                assert!(
                    IMPLEMENTED.contains(&provider),
                    "default_embedding_model({provider}) is Some, but {provider} is not in \
                     the implemented-adapter list"
                );
            }
        }
    }

    #[test]
    fn validate_vectors_accepts_matching_count_and_dimensions() {
        let vectors = vec![vec![0.1, 0.2, 0.3], vec![0.4, 0.5, 0.6]];
        let result = validate_vectors("openai", 2, vectors.clone()).expect("should validate");
        assert_eq!(result, vectors);
    }

    #[test]
    fn validate_vectors_rejects_count_mismatch() {
        let err = validate_vectors("openai", 3, vec![vec![0.1], vec![0.2]])
            .expect_err("2 vectors for 3 inputs should be rejected");
        assert!(err.message.contains("openai"));
        assert!(err.message.contains('2'));
        assert!(err.message.contains('3'));
    }

    #[test]
    fn validate_vectors_rejects_empty_vector() {
        let err = validate_vectors("ollama", 2, vec![vec![0.1, 0.2], vec![]])
            .expect_err("an empty vector should be rejected");
        assert!(err.message.contains("ollama"));
        assert!(err.message.contains("empty"));
        assert!(
            err.message.contains('1'),
            "should name the offending index: {}",
            err.message
        );
    }

    #[test]
    fn validate_vectors_rejects_inconsistent_dimensions() {
        let err = validate_vectors("gemini", 2, vec![vec![0.1, 0.2, 0.3], vec![0.4, 0.5]])
            .expect_err("ragged dimensions should be rejected");
        assert!(err.message.contains("gemini"));
        assert!(err.message.contains("inconsistent"));
        assert!(err.message.contains('3'));
        assert!(err.message.contains('2'));
    }

    #[test]
    fn parse_openai_style_embeddings_response_sorts_out_of_order_indices() {
        let value = serde_json::json!({
            "object": "list",
            "data": [
                { "object": "embedding", "index": 1, "embedding": [0.4, 0.5] },
                { "object": "embedding", "index": 0, "embedding": [0.1, 0.2] },
            ],
            "model": "text-embedding-3-small",
            "usage": { "prompt_tokens": 8, "total_tokens": 8 },
        });
        let result = parse_openai_style_embeddings_response(
            "openai",
            &value,
            2,
            "text-embedding-3-small".to_string(),
        )
        .expect("should decode");
        assert_eq!(result.vectors, vec![vec![0.1, 0.2], vec![0.4, 0.5]]);
        assert_eq!(result.model_id, "text-embedding-3-small");
    }

    #[test]
    fn parse_openai_style_embeddings_response_reports_missing_data_array() {
        let value = serde_json::json!({ "error": { "message": "invalid_request" } });
        let err = parse_openai_style_embeddings_response("openai", &value, 1, "m".to_string())
            .expect_err("missing data array should error");
        assert!(err.message.contains("openai"));
        assert!(err.message.contains("error"));
    }

    #[test]
    fn parse_openai_style_embeddings_response_rejects_count_mismatch() {
        let value = serde_json::json!({
            "data": [{ "index": 0, "embedding": [0.1, 0.2] }],
        });
        let err = parse_openai_style_embeddings_response("openrouter", &value, 2, "m".to_string())
            .expect_err("1 vector for 2 inputs should be rejected");
        assert!(err.message.contains("openrouter"));
    }
}
