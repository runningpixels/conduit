//! Local knowledge base (RAG) — t1-6 M3.
//!
//! Everything here operates purely in memory or through
//! `crate::db::repository::knowledge`; nothing in this module writes SQL
//! directly. Submodules:
//!
//! - [`chunk`] — splits extracted document text into overlapping,
//!   citation-addressable chunks.
//! - [`vector`] — the little-endian `Vec<f32>` <-> BLOB encoding used for
//!   `knowledge_chunks.embedding`, and cosine similarity.
//! - [`search`] — vector search, FTS5 keyword search (with query
//!   sanitization), and hybrid retrieval via Reciprocal Rank Fusion.
//! - [`ingest`] — orchestrates hash-based dedup, chunking, batched embedding
//!   calls, and the atomic document+chunks write.
//! - [`extract`] — turns a file on disk (txt/md/csv/docx/pdf) into indexable
//!   plain text, with size/timeout/panic guards against a malformed input.
//!
//! M3's bar (per the t1-6 plan): reachable from a Rust integration test, not
//! yet from the app — no Tauri commands, no UI, no i18n. Those are later
//! milestones.

pub mod chunk;
pub mod extract;
pub mod ingest;
pub mod search;
pub mod vector;
