//! Canonical time helpers.
//!
//! `created_at` and all `*_at` timestamp fields are stored as ISO-8601 UTC
//! strings (e.g. `"2026-06-22T13:45:00Z"`) so they sort lexicographically and
//! match the renderer's `new Date().toISOString()` format. Unix seconds are
//! used only for filenames (diagnostics export) where a compact, sortable
//! suffix is wanted.

use chrono::Utc;

/// Canonical timestamp for `created_at` / `*_at` fields: ISO-8601 UTC.
pub fn now_iso8601() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Unix seconds since epoch, for filenames and non-field uses only.
pub fn now_unix() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_iso8601_is_zulu() {
        let s = now_iso8601();
        assert!(s.ends_with('Z'), "expected Zulu suffix, got {s}");
    }

    #[test]
    fn now_unix_is_monotonic_nondecreasing() {
        let a = now_unix();
        let b = now_unix();
        assert!(b >= a, "unix seconds went backwards: {a} -> {b}");
    }

    #[test]
    fn iso8601_sorts_lexicographically() {
        // Two strings a second apart must sort in creation order.
        let earlier = "2026-06-22T13:45:00Z";
        let later = "2026-06-22T13:45:01Z";
        assert!(earlier < later);
    }
}
