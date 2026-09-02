//! Conservative secret redaction for workspace tool outputs.

use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

fn patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            Regex::new(r"(?i)AKIA[0-9A-Z]{16}").expect("aws key regex"),
            Regex::new(r"(?i)gh[pousr]_[A-Za-z0-9_]{20,}").expect("github token regex"),
            Regex::new(r"(?i)glpat-[A-Za-z0-9\-_]{20,}").expect("gitlab token regex"),
            Regex::new(r"(?i)xox[baprs]-[A-Za-z0-9-]{10,}").expect("slack token regex"),
            Regex::new(r"(?i)Bearer\s+[A-Za-z0-9\-._~+/]+=*").expect("bearer regex"),
            Regex::new(r"(?i)(api[_-]?key|secret|password|token)\s*[=:]\s*\S+")
                .expect("key=value regex"),
            Regex::new(r"(?i)tvly-[A-Za-z0-9_-]{8,}").expect("tavily key regex"),
            Regex::new(
                r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
            )
            .expect("pem regex"),
        ]
    })
}

pub fn redact_text(input: &str) -> String {
    let mut out = input.to_string();
    for re in patterns() {
        out = re.replace_all(&out, "[REDACTED]").into_owned();
    }
    out
}

pub fn redact_json(value: Value) -> Value {
    match value {
        Value::String(s) => Value::String(redact_text(&s)),
        Value::Array(items) => Value::Array(items.into_iter().map(redact_json).collect()),
        Value::Object(map) => {
            Value::Object(map.into_iter().map(|(k, v)| (k, redact_json(v))).collect())
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_aws_and_bearer() {
        let s = "key=AKIAIOSFODNN7EXAMPLE and Bearer abc.def.ghi";
        let out = redact_text(s);
        assert!(!out.contains("AKIA"));
        assert!(!out.contains("Bearer abc"));
        assert!(out.contains("[REDACTED]"));
    }

    #[test]
    fn redacts_json_strings() {
        let v = json!({ "body": "api_key=supersecret123", "n": 1 });
        let out = redact_json(v);
        assert_eq!(out["n"], 1);
        assert!(out["body"].as_str().unwrap().contains("[REDACTED]"));
    }
}
