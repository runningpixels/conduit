//! Secret redaction for connector logs and tool output.
//!
//! Connector-emitted text (stderr logs, tool result content destined for
//! display or persistence) is untrusted and may echo back secrets that
//! happened to pass through the connector. These helpers scrub the obvious
//! patterns before the text crosses the trust boundary. This is an inline
//! default; a richer redaction policy is a 04b deep-dive target.

use serde_json::Value;

/// Redact known secret patterns in a string:
/// - `keychain://service/...` refs → `keychain://[redacted]`
/// - `Bearer <token>` / `token <...>` auth headers → `Bearer [redacted]`
/// - `Authorization: ...` header lines → `Authorization: [redacted]`
/// - `password=...` / `secret=...` / `api_key=...` / `token=...` assignments
pub fn redact_text(input: &str) -> String {
    let mut s = input.to_string();
    // keychain refs
    if let Some(idx) = s.find("keychain://") {
        let rest = &s[idx..];
        if let Some(end) = rest.find(' ') {
            s.replace_range(idx..idx + end, "keychain://[redacted]");
        } else {
            s.truncate(idx);
            s.push_str("keychain://[redacted]");
        }
    }
    // `Bearer <token>` / `bearer <token>` — redact the token that follows, not
    // just the scheme (replacing "Bearer " alone would glue the token to the
    // marker and leave it exposed).
    s = scrub_prefix(&s, "Bearer ");
    s = scrub_prefix(&s, "bearer ");
    // naive header/assignment scrubbing
    s = scrub_assign(&s, "password");
    s = scrub_assign(&s, "secret");
    s = scrub_assign(&s, "api_key");
    s = scrub_assign(&s, "apikey");
    s = scrub_assign(&s, "token");
    s = scrub_assign(&s, "Authorization");
    s
}

/// Redact the token immediately following a literal prefix (e.g. `Bearer `).
/// Advances a cursor past each replacement so the marker (which still contains
/// the prefix) is not re-matched in an infinite loop.
fn scrub_prefix(s: &str, prefix: &str) -> String {
    let mut out = s.to_string();
    let mut cursor = 0usize;
    let marker = format!("{}[redacted]", prefix);
    while let Some(rel) = out[cursor..].find(prefix) {
        let i = cursor + rel;
        let after = i + prefix.len();
        let bytes = out.as_bytes();
        let mut end = after;
        while end < bytes.len()
            && bytes[end] != b' '
            && bytes[end] != b'"'
            && bytes[end] != b'\''
            && bytes[end] != b'\n'
            && bytes[end] != b'\r'
        {
            end += 1;
        }
        out.replace_range(i..end, &marker);
        // Resume searching after the inserted marker.
        cursor = i + marker.len();
    }
    out
}

fn scrub_assign(s: &str, key: &str) -> String {
    // matches `key=value` or `key: value` up to the next whitespace/quote
    let mut out = s.to_string();
    let needle = format!("{key}=");
    if let Some(i) = out.find(&needle) {
        let after = i + needle.len();
        redact_until_boundary(&mut out, after);
    }
    let needle2 = format!("{key}:");
    if let Some(i) = out.find(&needle2) {
        let after = i + needle2.len();
        redact_until_boundary(&mut out, after);
    }
    out
}

fn redact_until_boundary(s: &mut String, from: usize) {
    let bytes = s.as_bytes();
    if from >= bytes.len() {
        return;
    }
    // skip a single leading space/quote
    let mut start = from;
    while start < bytes.len()
        && (bytes[start] == b' ' || bytes[start] == b'"' || bytes[start] == b'\'')
    {
        start += 1;
    }
    // find end boundary: whitespace, quote, or end
    let mut end = start;
    while end < bytes.len()
        && bytes[end] != b' '
        && bytes[end] != b'"'
        && bytes[end] != b'\''
        && bytes[end] != b'\n'
        && bytes[end] != b'\r'
    {
        end += 1;
    }
    if end > start {
        s.replace_range(start..end, "[redacted]");
    }
}

/// Redact a JSON value by redacting every string it contains. Non-string
/// scalars pass through. Used before persisting tool result content.
pub fn redact_value(v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(redact_text(s)),
        Value::Array(a) => Value::Array(a.iter().map(redact_value).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, val)| (k.clone(), redact_value(val)))
                .collect(),
        ),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_bearer_token() {
        let out = redact_text("Authorization: Bearer abc123");
        assert!(!out.contains("abc123"), "got {out}");
        assert!(out.contains("[redacted]"));
    }

    #[test]
    fn redacts_bearer_then_does_not_loop() {
        // The marker "Bearer [redacted]" still contains "Bearer "; the scrubber
        // must advance past it rather than re-match forever.
        let out = redact_text("Bearer sekrit");
        assert!(!out.contains("sekrit"));
        assert!(out.contains("[redacted]"));
    }

    #[test]
    fn redacts_nested_token_equals_bearer() {
        // `token=Bearer <tok>` — the token follows a scheme inside an assignment.
        let out = redact_text("token=Bearer sekrit");
        assert!(!out.contains("sekrit"), "got {out}");
        assert!(out.contains("[redacted]"));
    }

    #[test]
    fn redacts_keychain_ref() {
        assert_eq!(
            redact_text("use keychain://conduit/slack/token here"),
            "use keychain://[redacted] here"
        );
    }

    #[test]
    fn redacts_value_object_recursively() {
        let v = serde_json::json!({ "header": "Bearer sekrit", "nested": { "pw": "password=hunter2" } });
        let out = redact_value(&v);
        let s = out.to_string();
        assert!(!s.contains("sekrit"));
        assert!(!s.contains("hunter2"));
        assert!(s.contains("[redacted]"));
    }
}
