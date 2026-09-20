//! Hybrid retrieval over the knowledge base (t1-6 M3): brute-force vector
//! search, FTS5 keyword search, and a Reciprocal Rank Fusion merge of the two.
//!
//! RRF (rather than normalizing and summing the two raw scores) because
//! cosine similarity and FTS5's bm25 rank are not on comparable scales — bm25
//! is an unbounded, corpus-dependent, *lower-is-better* number, cosine is a
//! bounded, *higher-is-better* `[-1, 1]`. Trying to normalize and blend those
//! is guesswork; fusing by rank position (`score = Σ 1/(60 + rank)` over the
//! lists a chunk appears in, 1-based rank, `k=60` is the standard RRF
//! constant from the original paper) sidesteps the scale problem entirely.

use std::collections::HashMap;

use sqlx::SqlitePool;

use crate::{
    db::{repository::knowledge as repo, DbError},
    encryption::Encryption,
};

use super::vector::{cosine_similarity, decode_vector};

/// The RRF constant. Chunks ranked further down either list contribute less
/// (`1/(60+rank)` flattens quickly), but never zero — a chunk that barely
/// made the tail of one list can still surface if it also did well in the
/// other.
const RRF_K: f32 = 60.0;

/// How many candidates each half of a hybrid search pulls before fusing and
/// truncating to the caller's `k`. Wider than `k` so a chunk that ranks, say,
/// 15th on the keyword side but 1st on the vector side still gets fused in
/// rather than being cut before RRF ever sees it.
const CANDIDATE_POOL_FLOOR: usize = 20;

#[derive(Debug, Clone, PartialEq)]
pub struct Scored {
    pub chunk_id: String,
    pub document_id: String,
    pub collection_id: String,
    pub content: String,
    pub score: f32,
    /// The chunk's position within its document, and its character range in
    /// the document's original extracted text — everything a citation needs
    /// to point at a place, without the caller re-fetching and decrypting
    /// the chunk again just to recover three integers this query already
    /// had in hand.
    pub ordinal: i64,
    pub char_start: i64,
    pub char_end: i64,
}

/// Brute-force cosine similarity search over every embedded chunk in
/// `collection_ids`. See migration 0017's doc comment for why a table scan
/// is fine at this scale (inline BLOBs, no ANN index).
pub async fn vector_search(
    pool: &SqlitePool,
    enc: &Encryption,
    collection_ids: &[String],
    query_vector: &[f32],
    k: usize,
) -> Result<Vec<Scored>, DbError> {
    if collection_ids.is_empty() || query_vector.is_empty() || k == 0 {
        return Ok(Vec::new());
    }

    let rows = repo::list_chunk_vectors(pool, collection_ids).await?;
    let mut scored = Vec::with_capacity(rows.len());
    for row in rows {
        // A row whose embedding blob is malformed (wrong length, corrupt)
        // is skipped rather than failing the whole search — one bad row
        // must not take down retrieval for every other chunk in the
        // collection.
        let Ok(vector) = decode_vector(&row.embedding, None) else {
            continue;
        };
        let score = cosine_similarity(query_vector, &vector);
        let content = match enc.decrypt(&row.content_encrypted) {
            Ok(c) => c,
            Err(_) => continue,
        };
        scored.push(Scored {
            chunk_id: row.chunk_id,
            document_id: row.document_id,
            collection_id: row.collection_id,
            content,
            score,
            ordinal: row.ordinal,
            char_start: row.char_start,
            char_end: row.char_end,
        });
    }
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored.truncate(k);
    Ok(scored)
}

/// Turn a raw user query into a safe FTS5 `MATCH` expression.
///
/// FTS5 gives syntactic meaning to quotes, `*` (prefix), `NEAR`, `-`
/// (column filter / exclusion depending on position), `:` (column filter),
/// and bareword `AND`/`OR`/`NOT`. A real question — `what is "foo`, `re-entrant
/// systems`, `NEAR misses in aviation` — trips one of these and `MATCH`
/// throws a syntax error, which today's `search::search_messages` does not
/// guard against at all (it passes the trimmed query straight through).
/// Knowledge-base retrieval is worse exposed to this because it runs on every
/// turn against whatever the user (or the model, echoing the user) typed,
/// not just an explicit "search" action, so a malformed query here must not
/// take down the whole turn.
///
/// The fix: never pass the user's text to `MATCH` as syntax. Split it into
/// alphanumeric (Unicode-aware) runs — which necessarily strips every FTS5
/// operator character, since none of them are alphanumeric — double-quote
/// each run so it's a literal-string token even if it happens to spell an
/// operator keyword (`"NEAR"`, `"AND"`), and join with spaces (FTS5's
/// implicit `AND` between tokens). A query that is pure punctuation/operators
/// (nothing alphanumeric survives) returns `None` so the caller can skip
/// keyword search instead of sending `MATCH ""`, which FTS5 also rejects.
pub fn sanitize_fts_query(raw: &str) -> Option<String> {
    let tokens: Vec<String> = raw
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect();
    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" "))
    }
}

/// FTS5 keyword search over `knowledge_chunk_fts`, scoped to
/// `collection_ids`. Sanitizes `query` first (see [`sanitize_fts_query`]);
/// if sanitization leaves nothing to search, or the `MATCH` itself still
/// errors for some reason sanitization didn't anticipate, returns an empty
/// result rather than failing the caller's turn — the caller only loses the
/// keyword half of retrieval, not the whole response.
pub async fn keyword_search(
    pool: &SqlitePool,
    enc: &Encryption,
    collection_ids: &[String],
    query: &str,
    k: usize,
) -> Result<Vec<Scored>, DbError> {
    if collection_ids.is_empty() || k == 0 {
        return Ok(Vec::new());
    }
    let Some(sanitized) = sanitize_fts_query(query) else {
        return Ok(Vec::new());
    };

    let rows = match repo::keyword_match(pool, collection_ids, &sanitized, k as i64).await {
        Ok(rows) => rows,
        // Belt-and-braces: sanitize_fts_query is built to never produce a
        // malformed expression, but if SQLite/FTS5 rejects it for a reason
        // we didn't anticipate, keyword search degrades to "no results"
        // rather than the error propagating up and failing hybrid search
        // (and whatever turn triggered it) entirely.
        Err(_) => return Ok(Vec::new()),
    };

    let mut scored = Vec::with_capacity(rows.len());
    for (rank, row) in rows.into_iter().enumerate() {
        let Ok(content) = enc.decrypt(&row.content_encrypted) else {
            continue;
        };
        // rank-based score for standalone keyword_search callers; hybrid_search
        // re-derives its own rank-based RRF score from list position, so this
        // number is only meaningful on its own (higher = better, matches the
        // "higher is better" convention `Scored::score` uses everywhere else).
        let score = 1.0 / (1.0 + rank as f32);
        scored.push(Scored {
            chunk_id: row.chunk_id,
            document_id: row.document_id,
            collection_id: row.collection_id,
            content,
            score,
            ordinal: row.ordinal,
            char_start: row.char_start,
            char_end: row.char_end,
        });
    }
    Ok(scored)
}

/// Hybrid retrieval: run vector and keyword search independently, then merge
/// by Reciprocal Rank Fusion. A chunk that appears in only one list still
/// scores (from that list alone); a chunk in both lists gets both
/// contributions summed, which is what lets RRF reward chunks strong on
/// *either* signal without needing the two raw scores to be comparable.
pub async fn hybrid_search(
    pool: &SqlitePool,
    enc: &Encryption,
    collection_ids: &[String],
    query_vector: &[f32],
    query_text: &str,
    k: usize,
) -> Result<Vec<Scored>, DbError> {
    if k == 0 {
        return Ok(Vec::new());
    }
    let pool_size = k.max(CANDIDATE_POOL_FLOOR);
    let vector_results = vector_search(pool, enc, collection_ids, query_vector, pool_size).await?;
    let keyword_results = keyword_search(pool, enc, collection_ids, query_text, pool_size).await?;

    let mut fused: HashMap<String, (f32, Scored)> = HashMap::new();
    for (rank, item) in vector_results.into_iter().enumerate() {
        let contribution = 1.0 / (RRF_K + (rank + 1) as f32);
        fused
            .entry(item.chunk_id.clone())
            .and_modify(|(score, _)| *score += contribution)
            .or_insert((contribution, item));
    }
    for (rank, item) in keyword_results.into_iter().enumerate() {
        let contribution = 1.0 / (RRF_K + (rank + 1) as f32);
        fused
            .entry(item.chunk_id.clone())
            .and_modify(|(score, _)| *score += contribution)
            .or_insert((contribution, item));
    }

    let mut merged: Vec<Scored> = fused
        .into_values()
        .map(|(score, mut item)| {
            item.score = score;
            item
        })
        .collect();
    merged.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    merged.truncate(k);
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_fts5_operator_characters() {
        let sanitized = sanitize_fts_query(r#"what is "foo"#).unwrap();
        // Every run of alphanumerics becomes its own quoted literal token;
        // the stray unbalanced quote is gone entirely.
        assert_eq!(sanitized, "\"what\" \"is\" \"foo\"");
    }

    #[test]
    fn sanitize_neutralizes_operator_keywords() {
        let sanitized = sanitize_fts_query("NEAR misses in aviation").unwrap();
        assert_eq!(sanitized, "\"NEAR\" \"misses\" \"in\" \"aviation\"");
    }

    #[test]
    fn sanitize_handles_leading_dash_and_colon() {
        let sanitized = sanitize_fts_query("re-entrant col:value *prefix").unwrap();
        assert_eq!(sanitized, "\"re\" \"entrant\" \"col\" \"value\" \"prefix\"");
    }

    #[test]
    fn sanitize_of_pure_punctuation_is_none() {
        assert_eq!(sanitize_fts_query("*** --- :::"), None);
        assert_eq!(sanitize_fts_query(""), None);
        assert_eq!(sanitize_fts_query("   "), None);
    }

    #[test]
    fn sanitize_preserves_unicode_words() {
        let sanitized = sanitize_fts_query("知識ベース").unwrap();
        assert_eq!(sanitized, "\"知識ベース\"");
    }
}
