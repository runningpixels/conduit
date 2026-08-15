//! Validation functions for settings patches and user-supplied configuration.
//!
//! Extracted from `state.rs` to keep the state module focused on structure and
//! persistence.

/// Validate agent loop guardrails on save. Bounds match the Settings UI and
/// `run_agent_turn` enforcement in `stream_manager.rs`.
pub fn validate_agent_guardrails(
    guardrails: &provider_core::schema::AgentGuardrails,
) -> Result<(), String> {
    const MIN_STEPS: u32 = 1;
    const MAX_STEPS: u32 = 50;
    const MIN_WALL_CLOCK_SECS: u32 = 30;
    const MAX_WALL_CLOCK_SECS: u32 = 1800;

    if !(MIN_STEPS..=MAX_STEPS).contains(&guardrails.max_steps) {
        return Err(format!(
            "agent max_steps must be between {MIN_STEPS} and {MAX_STEPS}"
        ));
    }
    if !(MIN_WALL_CLOCK_SECS..=MAX_WALL_CLOCK_SECS).contains(&guardrails.wall_clock_budget_secs) {
        return Err(format!(
            "agent wall_clock_budget_secs must be between {MIN_WALL_CLOCK_SECS} and {MAX_WALL_CLOCK_SECS}"
        ));
    }
    Ok(())
}

/// Validate persistent web search defaults on save. Domain lists must be bare
/// hosts (no http(s) prefix, ≤253 chars, no whitespace) and bounded to 100
/// entries per list (OpenAI's provider-side cap).
pub fn validate_web_search_defaults(
    defaults: &provider_core::schema::WebSearchDefaults,
) -> Result<(), String> {
    const MAX_DOMAIN_ENTRIES: usize = 100;
    if defaults.allowed_domains.len() > MAX_DOMAIN_ENTRIES {
        return Err(format!(
            "web search allowed_domains exceeds the {MAX_DOMAIN_ENTRIES}-entry provider cap"
        ));
    }
    if defaults.blocked_domains.len() > MAX_DOMAIN_ENTRIES {
        return Err(format!(
            "web search blocked_domains exceeds the {MAX_DOMAIN_ENTRIES}-entry provider cap"
        ));
    }
    for domain in defaults
        .allowed_domains
        .iter()
        .chain(defaults.blocked_domains.iter())
    {
        validate_web_search_domain(domain)?;
    }
    if let Some(loc) = &defaults.user_location {
        if loc.country.len() != 2 || !loc.country.chars().all(|c| c.is_ascii_alphabetic()) {
            return Err(format!(
                "web search user_location.country must be a 2-letter ISO 3166-1 alpha-2 code (got {:?})",
                loc.country
            ));
        }
    }
    Ok(())
}

fn validate_web_search_domain(raw: &str) -> Result<(), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("web search domain entries cannot be empty".to_string());
    }
    if trimmed.len() > 253 {
        return Err(format!(
            "web search domain entry {:?} exceeds 253 characters",
            trimmed
        ));
    }
    if trimmed.contains(' ') || trimmed.contains('\t') {
        return Err(format!(
            "web search domain entry {:?} contains whitespace",
            trimmed
        ));
    }
    if trimmed.contains("://") {
        return Err(format!(
            "web search domain entry {:?} must omit the http(s):// prefix",
            trimmed
        ));
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return Err(format!(
            "web search domain entry {:?} contains invalid characters (allowed: letters, digits, '.', '-', '_')",
            trimmed
        ));
    }
    if !trimmed.contains('.') {
        return Err(format!(
            "web search domain entry {:?} must contain at least one '.'",
            trimmed
        ));
    }
    Ok(())
}

/// Validate an artifact remote-allowlist entry and normalize it to an origin
/// (`scheme://host[:port]`). Accepts only absolute `http(s)` URLs with a
/// non-empty host and no whitespace; path/query/fragment are stripped. Returns
/// `None` for anything else so the caller can reject the whole update.
/// Uses `url::Url` for correct parsing (rejects userinfo, etc.).
pub fn validate_artifact_origin(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed = url::Url::parse(trimmed).ok()?;
    if parsed.username() != "" || parsed.password().is_some() {
        return None;
    }
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    let host = parsed.host_str()?;
    if host.is_empty() {
        return None;
    }
    let port = parsed.port().map(|p| format!(":{}", p)).unwrap_or_default();
    Some(format!("{}://{}{}", parsed.scheme(), host, port))
}

/// Max length for a URL opened in the system browser via `open_external_url`.
const MAX_EXTERNAL_OPEN_URL_LEN: usize = 2048;

/// Validate a renderer-supplied URL before `shell().open`. Accepts only absolute
/// `http(s)` URLs with a non-empty host and no userinfo. Keeps path / query /
/// fragment (unlike `validate_artifact_origin`, which strips to origin). Returns
/// the normalized URL string, or `None` for anything else.
pub fn validate_external_open_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_EXTERNAL_OPEN_URL_LEN {
        return None;
    }
    if trimmed.chars().any(|c| c.is_whitespace()) {
        return None;
    }
    let parsed = url::Url::parse(trimmed).ok()?;
    if parsed.username() != "" || parsed.password().is_some() {
        return None;
    }
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    let host = parsed.host_str()?;
    if host.is_empty() {
        return None;
    }
    Some(parsed.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------
    // Artifact origin validation
    // -----------------------------------------------------------------

    #[test]
    fn validate_artifact_origin_strips_path_and_rejects_bad_schemes() {
        assert_eq!(
            validate_artifact_origin("https://fonts.example.com/style.css"),
            Some("https://fonts.example.com".to_string())
        );
        assert_eq!(
            validate_artifact_origin("http://localhost:8080"),
            Some("http://localhost:8080".to_string())
        );
        // Whitespace is trimmed, path/query/fragment stripped.
        assert_eq!(
            validate_artifact_origin("  https://cdn.example.com/x?y=1#z  "),
            Some("https://cdn.example.com".to_string())
        );
        // Rejected: bad scheme, bare host, empty, whitespace in host.
        assert_eq!(validate_artifact_origin("javascript:alert(1)"), None);
        assert_eq!(validate_artifact_origin("data:text/html,x"), None);
        assert_eq!(validate_artifact_origin("fonts.example.com"), None);
        assert_eq!(validate_artifact_origin("https://"), None);
        assert_eq!(validate_artifact_origin("https://a b"), None);
        assert_eq!(validate_artifact_origin(""), None);
        // Userinfo is rejected (prevents spoofing like trusted@attacker).
        assert_eq!(
            validate_artifact_origin("https://trusted.example@attacker.example"),
            None
        );
        assert_eq!(
            validate_artifact_origin("https://user:pass@example.com"),
            None
        );
    }

    // -----------------------------------------------------------------
    // External open URL validation
    // -----------------------------------------------------------------

    #[test]
    fn validate_external_open_url_keeps_path_query_fragment() {
        assert_eq!(
            validate_external_open_url(
                "https://www.bloomberg.com/news/articles/2026-08-12/stock-market-today?q=1#frag"
            ),
            Some(
                "https://www.bloomberg.com/news/articles/2026-08-12/stock-market-today?q=1#frag"
                    .to_string()
            )
        );
        assert_eq!(
            validate_external_open_url("http://localhost:8080/path"),
            Some("http://localhost:8080/path".to_string())
        );
    }

    #[test]
    fn validate_external_open_url_rejects_bad_schemes_userinfo_and_overlong() {
        assert_eq!(validate_external_open_url("javascript:alert(1)"), None);
        assert_eq!(validate_external_open_url("file:///etc/passwd"), None);
        assert_eq!(validate_external_open_url("data:text/html,x"), None);
        assert_eq!(validate_external_open_url("mailto:a@b.com"), None);
        assert_eq!(
            validate_external_open_url("https://user:pass@example.com/x"),
            None
        );
        assert_eq!(validate_external_open_url("https://"), None);
        assert_eq!(validate_external_open_url("https://a b.com"), None);
        assert_eq!(validate_external_open_url(""), None);
        let overlong = format!("https://example.com/{}", "x".repeat(2100));
        assert_eq!(validate_external_open_url(&overlong), None);
    }

    // -----------------------------------------------------------------
    // Web search defaults validation
    // -----------------------------------------------------------------

    #[test]
    fn web_search_defaults_accept_clean_payload() {
        let defaults = provider_core::schema::WebSearchDefaults {
            allowed_domains: vec!["pubmed.ncbi.nlm.nih.gov".into()],
            blocked_domains: vec!["reddit.com".into()],
            user_location: Some(provider_core::schema::UserLocation {
                country: "GB".into(),
                city: Some("London".into()),
                region: None,
            }),
            ..provider_core::schema::WebSearchDefaults::default()
        };
        validate_web_search_defaults(&defaults).expect("clean payload must pass");
    }

    #[test]
    fn web_search_defaults_reject_http_prefix() {
        let defaults = provider_core::schema::WebSearchDefaults {
            allowed_domains: vec!["https://pubmed.ncbi.nlm.nih.gov".into()],
            ..provider_core::schema::WebSearchDefaults::default()
        };
        let err = validate_web_search_defaults(&defaults).unwrap_err();
        assert!(
            err.contains("http(s)://"),
            "rejection must mention the http(s):// prefix rule: {err}"
        );
    }

    #[test]
    fn web_search_defaults_reject_whitespace_and_empty() {
        let cases = vec!["", "  ", "exam ple.com", "example .com"];
        for bad in cases {
            let defaults = provider_core::schema::WebSearchDefaults {
                allowed_domains: vec![bad.into()],
                ..provider_core::schema::WebSearchDefaults::default()
            };
            assert!(
                validate_web_search_defaults(&defaults).is_err(),
                "expected rejection for {bad:?}"
            );
        }
    }

    #[test]
    fn web_search_defaults_reject_too_many_entries() {
        let domains: Vec<String> = (0..101).map(|i| format!("host{i}.example.com")).collect();
        let defaults = provider_core::schema::WebSearchDefaults {
            allowed_domains: domains,
            ..provider_core::schema::WebSearchDefaults::default()
        };
        let err = validate_web_search_defaults(&defaults).unwrap_err();
        assert!(
            err.contains("100-entry"),
            "rejection must mention the 100-entry provider cap: {err}"
        );
    }

    #[test]
    fn web_search_defaults_reject_bad_country_code() {
        let cases = vec![
            ("USA", "too long"), // ISO 3166-1 alpha-2 is exactly 2 letters
            ("G", "too short"),
            ("G1", "non-alpha char"),
            ("", "empty"),
        ];
        for (bad, label) in cases {
            let defaults = provider_core::schema::WebSearchDefaults {
                user_location: Some(provider_core::schema::UserLocation {
                    country: bad.into(),
                    city: None,
                    region: None,
                }),
                ..provider_core::schema::WebSearchDefaults::default()
            };
            let result = validate_web_search_defaults(&defaults);
            assert!(
                result.is_err(),
                "expected rejection for {bad:?} ({label}), got {result:?}"
            );
        }
    }

    #[test]
    fn web_search_defaults_reject_domain_without_dot() {
        let defaults = provider_core::schema::WebSearchDefaults {
            blocked_domains: vec!["localhost".into()],
            ..provider_core::schema::WebSearchDefaults::default()
        };
        let err = validate_web_search_defaults(&defaults).unwrap_err();
        assert!(
            err.contains("at least one '.'"),
            "rejection must mention the dot requirement: {err}"
        );
    }

    // -----------------------------------------------------------------
    // Agent guardrails validation
    // -----------------------------------------------------------------

    #[test]
    fn agent_guardrails_accept_defaults() {
        let guardrails = provider_core::schema::AgentGuardrails::default();
        validate_agent_guardrails(&guardrails).expect("defaults must pass");
        assert_eq!(guardrails.max_steps, 25);
        assert_eq!(guardrails.wall_clock_budget_secs, 300);
    }

    #[test]
    fn agent_guardrails_reject_zero_steps() {
        let guardrails = provider_core::schema::AgentGuardrails {
            max_steps: 0,
            ..provider_core::schema::AgentGuardrails::default()
        };
        let err = validate_agent_guardrails(&guardrails).unwrap_err();
        assert!(
            err.contains("max_steps"),
            "rejection must mention max_steps: {err}"
        );
    }

    #[test]
    fn agent_guardrails_reject_excessive_wall_clock() {
        let guardrails = provider_core::schema::AgentGuardrails {
            wall_clock_budget_secs: 9999,
            ..provider_core::schema::AgentGuardrails::default()
        };
        let err = validate_agent_guardrails(&guardrails).unwrap_err();
        assert!(
            err.contains("wall_clock_budget_secs"),
            "rejection must mention wall_clock_budget_secs: {err}"
        );
    }
}
