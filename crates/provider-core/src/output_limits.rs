//! Output-token ceilings, and the stop reason for a response that reached one.
//!
//! A response that runs out of output tokens stops mid-sentence — or, while
//! the model is writing a document through a tool call, mid-argument, leaving
//! JSON that cannot be parsed and a document that cannot be saved. Every
//! provider reports this differently; adapters map their own value onto
//! [`FINISH_REASON_LENGTH`] so the agent loop can tell a cut-off round from a
//! finished one.

/// `MessageComplete.finish_reason` for a response that stopped because it
/// reached its output-token limit: Anthropic `max_tokens` and
/// `model_context_window_exceeded`, OpenAI and Ollama `length`, the Responses
/// API's `max_output_tokens`, Gemini `MAX_TOKENS`.
pub const FINISH_REASON_LENGTH: &str = "length";

/// Default for Anthropic models that are not recognised as Claude — typically
/// another vendor's model behind an Anthropic-compatible endpoint, whose limits
/// are unknown. Large enough for a substantial document; small enough that
/// endpoints with a lower ceiling are unlikely to reject it.
const UNKNOWN_MODEL_MAX_TOKENS: u32 = 16_000;

/// `max_tokens` sent to the Anthropic Messages API when the user has not set
/// one. The field is required there, and output tokens are only billed and
/// rate-limited as they are generated, so a low default buys nothing — it only
/// cuts long answers and documents off. Claude models get their full output
/// ceiling, up to 64K (responses are always streamed, so request timeouts do
/// not apply).
pub fn anthropic_default_max_tokens(model_id: &str) -> u32 {
    let model = model_id.trim().to_ascii_lowercase();
    // Gateway ids carry a vendor prefix (`anthropic/claude-…`).
    let model = model.rsplit('/').next().unwrap_or(&model);

    if model.contains("claude-3-haiku") || model.contains("claude-3-opus") {
        return 4_096;
    }
    if model.contains("claude-3-5-") || model.contains("claude-3.5") {
        return 8_192;
    }
    if is_claude_opus_4_0_or_4_1(model) {
        return 32_000;
    }
    if model.contains("claude") {
        return 64_000;
    }
    UNKNOWN_MODEL_MAX_TOKENS
}

/// Whether an Anthropic model accepts `output_config.effort`: Claude Opus 4.5
/// and later, Sonnet 4.6 and later, and every Claude 5 generation model. Older
/// models return an error for it, and other vendors' models behind an
/// Anthropic-compatible endpoint are not assumed to know it.
pub fn anthropic_supports_effort(model_id: &str) -> bool {
    let model = model_id.trim().to_ascii_lowercase();
    let model = model.rsplit('/').next().unwrap_or(&model);
    if !model.contains("claude") {
        return false;
    }
    const KNOWN: &[&str] = &[
        "opus-4-5",
        "opus-4.5",
        "opus-4-6",
        "opus-4.6",
        "opus-4-7",
        "opus-4.7",
        "opus-4-8",
        "opus-4.8",
        "sonnet-4-6",
        "sonnet-4.6",
        "fable",
        "mythos",
    ];
    if KNOWN.iter().any(|needle| model.contains(needle)) {
        return true;
    }
    // `claude-opus-5`, `claude-sonnet-5-1`, and later generations.
    ["opus-", "sonnet-", "haiku-"].iter().any(|family| {
        model
            .split(family)
            .nth(1)
            .and_then(|rest| rest.split(['-', '.', '@']).next())
            .and_then(|major| major.parse::<u32>().ok())
            .is_some_and(|major| (5..100).contains(&major))
    })
}

/// The output limit a request ran under, when it is known: the user's
/// `max_tokens`, or the default this crate sends to Anthropic. Other providers
/// apply their own defaults, which are not known here.
pub fn effective_max_output_tokens(
    provider_id: &str,
    model_id: &str,
    requested: Option<u32>,
) -> Option<u32> {
    requested
        .or_else(|| (provider_id == "anthropic").then(|| anthropic_default_max_tokens(model_id)))
}

/// Claude Opus 4 and 4.1 — `claude-opus-4-0`, `claude-opus-4-20250514`,
/// `claude-opus-4-1`, `claude-opus-4.1`, `claude-opus-4-1-20250805` — but not
/// Opus 4.5 and later.
fn is_claude_opus_4_0_or_4_1(model: &str) -> bool {
    let Some(start) = model.find("claude-opus-4") else {
        return false;
    };
    let rest = &model[start + "claude-opus-4".len()..];
    let Some(version) = rest.strip_prefix(['-', '.']) else {
        // Bare `claude-opus-4`, or `claude-opus-4@20250514` on Vertex.
        return rest.is_empty() || rest.starts_with('@');
    };
    let minor = version.split(['-', '@']).next().unwrap_or_default();
    // `claude-opus-4-20250514` is a dated snapshot of Opus 4 itself.
    minor == "0" || minor == "1" || minor.len() == 8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_claude_models_get_64k() {
        for model in [
            "claude-opus-5",
            "claude-fable-5-1",
            "claude-sonnet-5",
            "claude-opus-4-8",
            "claude-opus-4-5-20251101",
            "claude-sonnet-4-5",
            "claude-sonnet-4-20250514",
            "claude-haiku-4-5",
            "claude-3-7-sonnet-20250219",
            "anthropic/claude-sonnet-4.6",
        ] {
            assert_eq!(anthropic_default_max_tokens(model), 64_000, "{model}");
        }
    }

    #[test]
    fn older_claude_models_keep_their_lower_ceilings() {
        assert_eq!(anthropic_default_max_tokens("claude-opus-4-0"), 32_000);
        assert_eq!(
            anthropic_default_max_tokens("claude-opus-4-20250514"),
            32_000
        );
        assert_eq!(anthropic_default_max_tokens("claude-opus-4-1"), 32_000);
        assert_eq!(
            anthropic_default_max_tokens("claude-opus-4-1-20250805"),
            32_000
        );
        assert_eq!(
            anthropic_default_max_tokens("claude-opus-4@20250514"),
            32_000
        );
        assert_eq!(
            anthropic_default_max_tokens("anthropic/claude-opus-4.1"),
            32_000
        );
        assert_eq!(
            anthropic_default_max_tokens("claude-3-5-sonnet-20241022"),
            8_192
        );
        assert_eq!(
            anthropic_default_max_tokens("claude-3-5-haiku-20241022"),
            8_192
        );
        assert_eq!(
            anthropic_default_max_tokens("claude-3-haiku-20240307"),
            4_096
        );
        assert_eq!(
            anthropic_default_max_tokens("claude-3-opus-20240229"),
            4_096
        );
    }

    #[test]
    fn effective_limit_is_known_for_user_settings_and_anthropic_defaults() {
        assert_eq!(
            effective_max_output_tokens("openai", "gpt-5", Some(900)),
            Some(900)
        );
        assert_eq!(effective_max_output_tokens("openai", "gpt-5", None), None);
        assert_eq!(
            effective_max_output_tokens("anthropic", "claude-sonnet-5", None),
            Some(64_000)
        );
    }

    #[test]
    fn other_models_behind_anthropic_endpoints_get_a_moderate_default() {
        assert_eq!(anthropic_default_max_tokens("glm-4.6"), 16_000);
        assert_eq!(anthropic_default_max_tokens("kimi-k2-instruct"), 16_000);
    }
}

#[cfg(test)]
mod effort_tests {
    use super::anthropic_supports_effort;

    #[test]
    fn effort_is_sent_only_to_claude_models_that_accept_it() {
        for model in [
            "claude-opus-5",
            "claude-sonnet-5",
            "claude-fable-5-1",
            "claude-opus-4-8",
            "claude-opus-4-5-20251101",
            "claude-sonnet-4-6",
            "anthropic/claude-sonnet-4.6",
        ] {
            assert!(anthropic_supports_effort(model), "{model}");
        }
        for model in [
            "claude-sonnet-4-5",
            "claude-haiku-4-5",
            "claude-opus-4-1",
            "claude-sonnet-4-20250514",
            "claude-3-7-sonnet-20250219",
            "glm-4.6",
        ] {
            assert!(!anthropic_supports_effort(model), "{model}");
        }
    }
}
