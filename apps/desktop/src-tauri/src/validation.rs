//! Validation functions for settings patches and user-supplied configuration.
//!
//! Extracted from `state.rs` to keep the state module focused on structure and
//! persistence.
//!
//! Phase 3 of `docs/plans/localization.md` (D9/D10 item 1): this is the
//! highest-traffic user-facing Rust text in the app, rendered directly under
//! Settings inputs, so every validation message here carries a real
//! `error.validation.*` code rather than landing on `error.unknown`. Five
//! codes (`temperatureRange`, `topPRange`, `maxTokensRange`,
//! `stopSequenceCount`, `stopSequenceLength`) already exist in the renderer
//! catalog from earlier client-side validation work; this file reuses them
//! rather than minting duplicates, passing Rust's lowercase sentence as the
//! `fallback` and letting the catalog's wording win once a build ships with
//! it.
//!
//! `validate_generation_controls` and `validate_user_instructions` keep their
//! original `Result<(), String>` signatures because `commands/chat.rs`
//! (out of scope for this pass) calls them with a bare `?` inside a function
//! that returns `Result<_, String>` — changing the error type there would
//! break that call without touching a file this pass is not meant to touch.
//! The coded logic lives in the `_coded` twins below; `state.rs`'s
//! `update_settings` (the Settings-form path that actually needs the codes to
//! reach the renderer) calls those instead.

use provider_core::schema::AppError;

/// Upper bound for user-authored instructions (settings or per-conversation).
pub const USER_INSTRUCTIONS_MAX_CHARS: usize = 32 * 1024;
const STOP_SEQUENCE_MAX_COUNT: usize = 8;
const STOP_SEQUENCE_MAX_CHARS: usize = 64;

/// Validate generation controls on save. Ranges match `provider_core::normalize`.
///
/// Coded version. See the module doc comment for why this and the
/// String-returning [`validate_generation_controls`] both exist.
pub fn validate_generation_controls_coded(
    controls: &provider_core::schema::GenerationControls,
) -> Result<(), AppError> {
    if let Some(temp) = controls.temperature {
        if !(0.0..=2.0).contains(&temp) || temp.is_nan() {
            return Err(AppError::new(
                "error.validation.temperatureRange",
                "temperature must be between 0 and 2",
            ));
        }
    }
    if let Some(top_p) = controls.top_p {
        if !(0.0..=1.0).contains(&top_p) || top_p.is_nan() {
            return Err(AppError::new(
                "error.validation.topPRange",
                "top_p must be between 0 and 1",
            ));
        }
    }
    if let Some(max_tokens) = controls.max_tokens {
        if max_tokens == 0 {
            return Err(AppError::new(
                "error.validation.maxTokensRange",
                "max_tokens must be greater than 0",
            ));
        }
    }
    if let Some(stops) = &controls.stop_sequences {
        if stops.len() > STOP_SEQUENCE_MAX_COUNT {
            return Err(AppError::new(
                "error.validation.stopSequenceCount",
                format!("stop_sequences cannot have more than {STOP_SEQUENCE_MAX_COUNT} entries"),
            )
            .with("max", STOP_SEQUENCE_MAX_COUNT.to_string()));
        }
        for stop in stops {
            if stop.is_empty() {
                return Err(AppError::new(
                    "error.validation.stopSequenceEmpty",
                    "stop_sequences entries cannot be empty",
                ));
            }
            if stop.chars().count() > STOP_SEQUENCE_MAX_CHARS {
                return Err(AppError::new(
                    "error.validation.stopSequenceLength",
                    format!(
                        "stop_sequences entries cannot exceed {STOP_SEQUENCE_MAX_CHARS} characters"
                    ),
                )
                .with("max", STOP_SEQUENCE_MAX_CHARS.to_string()));
            }
        }
    }
    Ok(())
}

/// Validate generation controls on save. String-returning back-compat shim —
/// see the module doc comment. `Display` on `AppError` returns the fallback,
/// so this stays byte-identical to the pre-Phase-3 text.
pub fn validate_generation_controls(
    controls: &provider_core::schema::GenerationControls,
) -> Result<(), String> {
    validate_generation_controls_coded(controls).map_err(|e| e.fallback)
}

/// Validate user instructions length. Empty/whitespace is treated as unset by callers.
///
/// Coded version. See the module doc comment for why this and the
/// String-returning [`validate_user_instructions`] both exist.
pub fn validate_user_instructions_coded(text: &str) -> Result<(), AppError> {
    if text.chars().count() > USER_INSTRUCTIONS_MAX_CHARS {
        return Err(AppError::new(
            "error.validation.userInstructionsLength",
            format!("user instructions cannot exceed {USER_INSTRUCTIONS_MAX_CHARS} characters"),
        )
        .with("max", USER_INSTRUCTIONS_MAX_CHARS.to_string()));
    }
    Ok(())
}

/// Validate user instructions length. String-returning back-compat shim — see
/// the module doc comment.
pub fn validate_user_instructions(text: &str) -> Result<(), String> {
    validate_user_instructions_coded(text).map_err(|e| e.fallback)
}

/// True when every GenerationControls field is unset — treat as inherit/default.
pub fn generation_controls_is_empty(controls: &provider_core::schema::GenerationControls) -> bool {
    controls.temperature.is_none()
        && controls.top_p.is_none()
        && controls.max_tokens.is_none()
        && controls
            .stop_sequences
            .as_ref()
            .map(|s| s.is_empty())
            .unwrap_or(true)
        && controls.tool_choice.is_none()
}

/// Validate agent loop guardrails on save. Bounds match the Settings UI and
/// `run_agent_turn` enforcement in `stream_manager.rs`.
///
/// Only called from `state.rs`, so it converts directly — no String-returning
/// twin needed.
pub fn validate_agent_guardrails(
    guardrails: &provider_core::schema::AgentGuardrails,
) -> Result<(), AppError> {
    const MIN_STEPS: u32 = 1;
    const MAX_STEPS: u32 = 50;
    const MIN_WALL_CLOCK_SECS: u32 = 30;
    const MAX_WALL_CLOCK_SECS: u32 = 1800;

    if !(MIN_STEPS..=MAX_STEPS).contains(&guardrails.max_steps) {
        return Err(AppError::new(
            "error.validation.agentMaxStepsRange",
            format!("agent max_steps must be between {MIN_STEPS} and {MAX_STEPS}"),
        )
        .with("min", MIN_STEPS.to_string())
        .with("max", MAX_STEPS.to_string()));
    }
    if !(MIN_WALL_CLOCK_SECS..=MAX_WALL_CLOCK_SECS).contains(&guardrails.wall_clock_budget_secs) {
        return Err(AppError::new(
            "error.validation.agentWallClockRange",
            format!(
                "agent wall_clock_budget_secs must be between {MIN_WALL_CLOCK_SECS} and {MAX_WALL_CLOCK_SECS}"
            ),
        )
        .with("min", MIN_WALL_CLOCK_SECS.to_string())
        .with("max", MAX_WALL_CLOCK_SECS.to_string()));
    }
    Ok(())
}

/// Validate persistent web search defaults on save. Domain lists must be bare
/// hosts (no http(s) prefix, ≤253 chars, no whitespace) and bounded to 100
/// entries per list (OpenAI's provider-side cap).
///
/// Only called from `state.rs`, so it converts directly — no String-returning
/// twin needed.
pub fn validate_web_search_defaults(
    defaults: &provider_core::schema::WebSearchDefaults,
) -> Result<(), AppError> {
    const MAX_DOMAIN_ENTRIES: usize = 100;
    if defaults.allowed_domains.len() > MAX_DOMAIN_ENTRIES {
        return Err(AppError::new(
            "error.validation.webSearchAllowedDomainsCap",
            format!(
                "web search allowed_domains exceeds the {MAX_DOMAIN_ENTRIES}-entry provider cap"
            ),
        )
        .with("max", MAX_DOMAIN_ENTRIES.to_string()));
    }
    if defaults.blocked_domains.len() > MAX_DOMAIN_ENTRIES {
        return Err(AppError::new(
            "error.validation.webSearchBlockedDomainsCap",
            format!(
                "web search blocked_domains exceeds the {MAX_DOMAIN_ENTRIES}-entry provider cap"
            ),
        )
        .with("max", MAX_DOMAIN_ENTRIES.to_string()));
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
            return Err(AppError::new(
                "error.validation.webSearchCountryCode",
                format!(
                    "web search user_location.country must be a 2-letter ISO 3166-1 alpha-2 code (got {:?})",
                    loc.country
                ),
            )
            .with("country", loc.country.clone()));
        }
    }
    if defaults.local_backend == provider_core::schema::LocalSearchBackend::Searxng {
        let Some(raw) = defaults
            .searxng_base_url
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        else {
            return Err(AppError::new(
                "error.validation.webSearchSearxngRequired",
                "web search searxngBaseUrl is required when the local backend is SearXNG",
            ));
        };
        if validate_external_open_url(raw).is_none() {
            return Err(AppError::new(
                "error.validation.webSearchSearxngInvalidUrl",
                "web search searxngBaseUrl must be an absolute http(s) URL with no credentials",
            ));
        }
    } else if let Some(raw) = defaults.searxng_base_url.as_ref() {
        let trimmed = raw.trim();
        if !trimmed.is_empty() && validate_external_open_url(trimmed).is_none() {
            return Err(AppError::new(
                "error.validation.webSearchSearxngInvalidUrl",
                "web search searxngBaseUrl must be an absolute http(s) URL with no credentials",
            ));
        }
    }
    Ok(())
}

fn validate_web_search_domain(raw: &str) -> Result<(), AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::new(
            "error.validation.webSearchDomainEmpty",
            "web search domain entries cannot be empty",
        ));
    }
    if trimmed.len() > 253 {
        return Err(AppError::new(
            "error.validation.webSearchDomainTooLong",
            format!(
                "web search domain entry {:?} exceeds 253 characters",
                trimmed
            ),
        )
        .with("domain", trimmed.to_string()));
    }
    if trimmed.contains(' ') || trimmed.contains('\t') {
        return Err(AppError::new(
            "error.validation.webSearchDomainWhitespace",
            format!("web search domain entry {:?} contains whitespace", trimmed),
        )
        .with("domain", trimmed.to_string()));
    }
    if trimmed.contains("://") {
        return Err(AppError::new(
            "error.validation.webSearchDomainPrefix",
            format!(
                "web search domain entry {:?} must omit the http(s):// prefix",
                trimmed
            ),
        )
        .with("domain", trimmed.to_string()));
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return Err(AppError::new(
            "error.validation.webSearchDomainInvalidChars",
            format!(
                "web search domain entry {:?} contains invalid characters (allowed: letters, digits, '.', '-', '_')",
                trimmed
            ),
        )
        .with("domain", trimmed.to_string()));
    }
    if !trimmed.contains('.') {
        return Err(AppError::new(
            "error.validation.webSearchDomainNoDot",
            format!(
                "web search domain entry {:?} must contain at least one '.'",
                trimmed
            ),
        )
        .with("domain", trimmed.to_string()));
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
        assert_eq!(err.code, "error.validation.webSearchDomainPrefix");
        assert_eq!(
            err.params.get("domain").map(String::as_str),
            Some("https://pubmed.ncbi.nlm.nih.gov")
        );
        assert!(
            err.fallback.contains("http(s)://"),
            "rejection must mention the http(s):// prefix rule: {}",
            err.fallback
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
        assert_eq!(err.code, "error.validation.webSearchAllowedDomainsCap");
        assert_eq!(err.params.get("max").map(String::as_str), Some("100"));
        assert!(
            err.fallback.contains("100-entry"),
            "rejection must mention the 100-entry provider cap: {}",
            err.fallback
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
            assert_eq!(
                result.unwrap_err().code,
                "error.validation.webSearchCountryCode"
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
        assert_eq!(err.code, "error.validation.webSearchDomainNoDot");
        assert!(
            err.fallback.contains("at least one '.'"),
            "rejection must mention the dot requirement: {}",
            err.fallback
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
        assert_eq!(err.code, "error.validation.agentMaxStepsRange");
        assert!(
            err.fallback.contains("max_steps"),
            "rejection must mention max_steps: {}",
            err.fallback
        );
    }

    #[test]
    fn agent_guardrails_reject_excessive_wall_clock() {
        let guardrails = provider_core::schema::AgentGuardrails {
            wall_clock_budget_secs: 9999,
            ..provider_core::schema::AgentGuardrails::default()
        };
        let err = validate_agent_guardrails(&guardrails).unwrap_err();
        assert_eq!(err.code, "error.validation.agentWallClockRange");
        assert!(
            err.fallback.contains("wall_clock_budget_secs"),
            "rejection must mention wall_clock_budget_secs: {}",
            err.fallback
        );
    }

    // -----------------------------------------------------------------
    // Generation controls + user instructions (t0-6)
    // -----------------------------------------------------------------

    fn sample_controls() -> provider_core::schema::GenerationControls {
        provider_core::schema::GenerationControls {
            temperature: Some(0.7),
            top_p: Some(0.9),
            max_tokens: Some(1024),
            stop_sequences: None,
            tool_choice: None,
        }
    }

    #[test]
    fn generation_controls_accept_valid_ranges() {
        validate_generation_controls(&sample_controls()).expect("valid controls must pass");
        validate_generation_controls_coded(&sample_controls())
            .expect("valid controls must pass (coded)");
    }

    #[test]
    fn generation_controls_reject_temperature_out_of_range() {
        let mut c = sample_controls();
        c.temperature = Some(2.5);
        // String-returning shim: unchanged fallback text.
        let err = validate_generation_controls(&c).unwrap_err();
        assert!(err.contains("temperature"), "{err}");
        // Coded version: the code the renderer actually keys off of.
        let coded_err = validate_generation_controls_coded(&c).unwrap_err();
        assert_eq!(coded_err.code, "error.validation.temperatureRange");
        assert!(
            coded_err.fallback.contains("temperature"),
            "{}",
            coded_err.fallback
        );
    }

    #[test]
    fn generation_controls_reject_empty_stop_sequence() {
        let mut c = sample_controls();
        c.stop_sequences = Some(vec!["".into()]);
        let err = validate_generation_controls(&c).unwrap_err();
        assert!(err.contains("stop_sequences"), "{err}");
        let coded_err = validate_generation_controls_coded(&c).unwrap_err();
        assert_eq!(coded_err.code, "error.validation.stopSequenceEmpty");
    }

    #[test]
    fn generation_controls_reject_too_many_stop_sequences() {
        let mut c = sample_controls();
        c.stop_sequences = Some((0..9).map(|i| format!("stop{i}")).collect());
        let coded_err = validate_generation_controls_coded(&c).unwrap_err();
        assert_eq!(coded_err.code, "error.validation.stopSequenceCount");
        assert_eq!(coded_err.params.get("max").map(String::as_str), Some("8"));
    }

    #[test]
    fn generation_controls_reject_overlong_stop_sequence() {
        let mut c = sample_controls();
        c.stop_sequences = Some(vec!["x".repeat(65)]);
        let coded_err = validate_generation_controls_coded(&c).unwrap_err();
        assert_eq!(coded_err.code, "error.validation.stopSequenceLength");
        assert_eq!(coded_err.params.get("max").map(String::as_str), Some("64"));
    }

    #[test]
    fn generation_controls_reject_top_p_and_max_tokens() {
        let mut c = sample_controls();
        c.top_p = Some(1.5);
        assert_eq!(
            validate_generation_controls_coded(&c).unwrap_err().code,
            "error.validation.topPRange"
        );

        let mut c = sample_controls();
        c.max_tokens = Some(0);
        assert_eq!(
            validate_generation_controls_coded(&c).unwrap_err().code,
            "error.validation.maxTokensRange"
        );
    }

    #[test]
    fn user_instructions_reject_overlong() {
        let too_long = "x".repeat(USER_INSTRUCTIONS_MAX_CHARS + 1);
        let err = validate_user_instructions(&too_long).unwrap_err();
        assert!(err.contains("user instructions"), "{err}");
        let coded_err = validate_user_instructions_coded(&too_long).unwrap_err();
        assert_eq!(coded_err.code, "error.validation.userInstructionsLength");
        assert_eq!(
            coded_err.params.get("max").map(String::as_str),
            Some(USER_INSTRUCTIONS_MAX_CHARS.to_string().as_str())
        );
    }

    #[test]
    fn generation_controls_is_empty_when_all_unset() {
        let empty = provider_core::schema::GenerationControls {
            temperature: None,
            top_p: None,
            max_tokens: None,
            stop_sequences: None,
            tool_choice: None,
        };
        assert!(generation_controls_is_empty(&empty));
        assert!(!generation_controls_is_empty(&sample_controls()));
    }

    #[test]
    fn searxng_backend_requires_http_url() {
        let mut defaults = provider_core::schema::WebSearchDefaults {
            local_backend: provider_core::schema::LocalSearchBackend::Searxng,
            ..Default::default()
        };
        let err = validate_web_search_defaults(&defaults).unwrap_err();
        assert_eq!(err.code, "error.validation.webSearchSearxngRequired");
        assert!(err.fallback.contains("searxngBaseUrl"), "{}", err.fallback);

        defaults.searxng_base_url = Some("not-a-url".into());
        let err = validate_web_search_defaults(&defaults).unwrap_err();
        assert_eq!(err.code, "error.validation.webSearchSearxngInvalidUrl");
        assert!(err.fallback.contains("http"), "{}", err.fallback);

        defaults.searxng_base_url = Some("https://searx.example".into());
        validate_web_search_defaults(&defaults).expect("valid searxng url");
    }
}
