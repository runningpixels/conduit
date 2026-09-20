//! Embedding vector <-> BLOB encoding, and cosine similarity (t1-6 M3).
//!
//! `knowledge_chunks.embedding` stores a raw little-endian `f32` BLOB (see
//! migration 0017's doc comment for why inline-BLOB over a sidecar file).
//! This module is the single place that encodes/decodes that BLOB, so every
//! caller (ingest writing it, search reading it) agrees on the byte layout.

use crate::db::DbError;

/// Encode a vector as a little-endian `f32` BLOB — 4 bytes per dimension, in
/// order.
pub fn encode_vector(vector: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(vector.len() * 4);
    for value in vector {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

/// Decode a little-endian `f32` BLOB back into a vector.
///
/// Rejects rather than silently truncating or padding:
/// - a byte length that isn't a multiple of 4 (can't be a whole number of
///   `f32`s) is an error, not a shorter vector;
/// - when `expected_dims` is given (the collection's known
///   `embedding_dimensions`), a decoded length that disagrees is an error —
///   a corrupt or foreign-model BLOB must never be handed to the caller as if
///   it were a valid vector of a different length.
pub fn decode_vector(bytes: &[u8], expected_dims: Option<usize>) -> Result<Vec<f32>, DbError> {
    if !bytes.len().is_multiple_of(4) {
        return Err(DbError::Query(format!(
            "embedding blob has {} byte(s), which is not a multiple of 4",
            bytes.len()
        )));
    }
    let dims = bytes.len() / 4;
    if let Some(expected) = expected_dims {
        if dims != expected {
            return Err(DbError::Query(format!(
                "embedding blob decodes to {dims} dimension(s), expected {expected}"
            )));
        }
    }
    let mut out = Vec::with_capacity(dims);
    for word in bytes.chunks_exact(4) {
        let arr: [u8; 4] = word
            .try_into()
            .expect("chunks_exact(4) yields 4-byte slices");
        out.push(f32::from_le_bytes(arr));
    }
    Ok(out)
}

/// Cosine similarity between two vectors of equal length, in `[-1.0, 1.0]`
/// for non-degenerate inputs. Returns `0.0` (rather than dividing by zero and
/// producing `NaN`) when either vector has zero magnitude, when the vectors
/// differ in length, or when either is empty — none of these are a
/// meaningful "similarity", and `0.0` sorts as "no signal" rather than
/// poisoning a ranked list with `NaN`.
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0f32;
    let mut norm_a = 0f32;
    let mut norm_b = 0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a.sqrt() * norm_b.sqrt())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_decode_round_trips() {
        let vector = vec![0.0, 1.5, -2.25, f32::MIN_POSITIVE, -1.0];
        let bytes = encode_vector(&vector);
        assert_eq!(bytes.len(), vector.len() * 4);
        let decoded = decode_vector(&bytes, None).unwrap();
        assert_eq!(decoded, vector);
    }

    #[test]
    fn decode_rejects_length_not_multiple_of_four() {
        let err = decode_vector(&[0u8; 6], None).expect_err("6 bytes is not a whole f32 count");
        assert!(err.to_string().contains("not a multiple of 4"));
    }

    #[test]
    fn decode_rejects_dimension_mismatch() {
        let bytes = encode_vector(&[1.0, 2.0, 3.0]);
        let err = decode_vector(&bytes, Some(4)).expect_err("3 dims != expected 4");
        assert!(err.to_string().contains("expected 4"));
    }

    #[test]
    fn decode_accepts_matching_expected_dims() {
        let bytes = encode_vector(&[1.0, 2.0, 3.0]);
        let decoded = decode_vector(&bytes, Some(3)).unwrap();
        assert_eq!(decoded, vec![1.0, 2.0, 3.0]);
    }

    #[test]
    fn cosine_of_identical_vectors_is_one() {
        let a = vec![1.0, 2.0, 3.0];
        let sim = cosine_similarity(&a, &a);
        assert!((sim - 1.0).abs() < 1e-6, "{sim}");
    }

    #[test]
    fn cosine_of_orthogonal_vectors_is_zero() {
        let a = vec![1.0, 0.0];
        let b = vec![0.0, 1.0];
        let sim = cosine_similarity(&a, &b);
        assert!(sim.abs() < 1e-6, "{sim}");
    }

    #[test]
    fn cosine_of_opposite_vectors_is_negative_one() {
        let a = vec![1.0, 0.0];
        let b = vec![-1.0, 0.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim + 1.0).abs() < 1e-6, "{sim}");
    }

    #[test]
    fn cosine_handles_zero_magnitude_vector_without_nan() {
        let zero = vec![0.0, 0.0, 0.0];
        let other = vec![1.0, 2.0, 3.0];
        let sim = cosine_similarity(&zero, &other);
        assert_eq!(sim, 0.0);
        assert!(!sim.is_nan());
    }

    #[test]
    fn cosine_handles_mismatched_lengths() {
        let a = vec![1.0, 2.0];
        let b = vec![1.0, 2.0, 3.0];
        assert_eq!(cosine_similarity(&a, &b), 0.0);
    }

    #[test]
    fn cosine_handles_empty_vectors() {
        assert_eq!(cosine_similarity(&[], &[]), 0.0);
    }
}
