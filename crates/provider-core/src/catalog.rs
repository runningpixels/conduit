//! Provider catalog — metadata for settings UI, credential gates, and onboarding.
//! Every adapter registered in `adapter::registry()` must have a descriptor here.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialMode {
    /// No API key (e.g. local Ollama).
    None,
    /// Key optional — local OpenAI-compatible servers often accept any bearer token.
    Optional,
    /// Key required for chat streams.
    Required,
}

#[derive(Debug, Clone, Copy)]
pub struct ProviderDescriptor {
    pub id: &'static str,
    pub display_name: &'static str,
    pub default_base_url: Option<&'static str>,
    pub credential_mode: CredentialMode,
    pub is_local: bool,
    pub show_base_url_field: bool,
    /// Adoption-priority tier from `docs/guides/provider-target-list.md`:
    /// 0 = ship first (Anthropic, OpenAI, Ollama, OpenRouter, Zen, compat),
    /// 1 = add next (Gemini, Groq, LM Studio), 2/3 reserved for M3+.
    pub tier: u8,
    pub description: Option<&'static str>,
}

pub const PROVIDER_DESCRIPTORS: &[ProviderDescriptor] = &[
    ProviderDescriptor {
        id: "anthropic",
        display_name: "Anthropic",
        default_base_url: None,
        credential_mode: CredentialMode::Required,
        is_local: false,
        show_base_url_field: false,
        tier: 0,
        description: None,
    },
    ProviderDescriptor {
        id: "openai",
        display_name: "OpenAI",
        default_base_url: None,
        credential_mode: CredentialMode::Required,
        is_local: false,
        show_base_url_field: false,
        tier: 0,
        description: None,
    },
    ProviderDescriptor {
        id: "gemini",
        display_name: "Google Gemini",
        default_base_url: None,
        credential_mode: CredentialMode::Required,
        is_local: false,
        show_base_url_field: false,
        tier: 1,
        description: None,
    },
    ProviderDescriptor {
        id: "openrouter",
        display_name: "OpenRouter",
        default_base_url: Some("https://openrouter.ai/api/v1"),
        credential_mode: CredentialMode::Required,
        is_local: false,
        show_base_url_field: false,
        tier: 0,
        description: Some("One API key, many models"),
    },
    ProviderDescriptor {
        id: "opencode_zen",
        display_name: "OpenCode Zen",
        default_base_url: Some("https://opencode.ai/zen/v1"),
        credential_mode: CredentialMode::Required,
        is_local: false,
        show_base_url_field: false,
        tier: 0,
        description: Some("Curated coding models — Claude, GPT, Gemini, and chat-compat"),
    },
    ProviderDescriptor {
        id: "ollama",
        display_name: "Ollama",
        default_base_url: Some("http://127.0.0.1:11434"),
        credential_mode: CredentialMode::None,
        is_local: true,
        show_base_url_field: true,
        tier: 0,
        description: None,
    },
    ProviderDescriptor {
        id: "lmstudio",
        display_name: "LM Studio",
        default_base_url: Some("http://localhost:1234/v1"),
        credential_mode: CredentialMode::Optional,
        is_local: true,
        show_base_url_field: true,
        tier: 1,
        description: None,
    },
    ProviderDescriptor {
        id: "groq",
        display_name: "Groq",
        default_base_url: Some("https://api.groq.com/openai/v1"),
        credential_mode: CredentialMode::Required,
        is_local: false,
        show_base_url_field: false,
        tier: 1,
        description: None,
    },
    ProviderDescriptor {
        id: "deepseek",
        display_name: "DeepSeek",
        default_base_url: Some("https://api.deepseek.com"),
        credential_mode: CredentialMode::Required,
        is_local: false,
        show_base_url_field: false,
        tier: 1,
        description: Some("Cost-efficient V4 models"),
    },
    ProviderDescriptor {
        id: "mistral",
        display_name: "Mistral",
        default_base_url: Some("https://api.mistral.ai/v1"),
        credential_mode: CredentialMode::Required,
        is_local: false,
        show_base_url_field: false,
        tier: 1,
        description: Some("Codestral and Mistral Large"),
    },
    ProviderDescriptor {
        id: "openai_compat",
        display_name: "OpenAI Compatible",
        default_base_url: Some("http://localhost:8080/v1"),
        credential_mode: CredentialMode::Optional,
        is_local: true,
        show_base_url_field: true,
        tier: 0,
        description: Some("Custom endpoint (vLLM, LiteLLM, etc.)"),
    },
];

pub fn list_descriptors() -> &'static [ProviderDescriptor] {
    PROVIDER_DESCRIPTORS
}

pub fn descriptor(id: &str) -> Option<&'static ProviderDescriptor> {
    PROVIDER_DESCRIPTORS.iter().find(|d| d.id == id)
}

/// Pricing model for a specific provider/model combination.
/// Used by usage analytics to compute best-effort cost estimates.
#[derive(Debug, Clone, Copy)]
pub struct ModelPricing {
    pub provider_id: &'static str,
    pub model_id: &'static str,
    /// USD per million input tokens.
    pub input_per_mtok: f64,
    /// USD per million output tokens.
    pub output_per_mtok: f64,
    /// USD per million cache-hit (read) tokens.
    pub cache_read_per_mtok: f64,
    /// USD per million cache-write (creation) tokens.
    pub cache_write_per_mtok: f64,
}

/// Best-effort pricing table for known provider/model combinations.
/// Unknown models, local models (Ollama, LM Studio) default to $0.
pub const MODEL_PRICING: &[ModelPricing] = &[
    // Anthropic
    ModelPricing {
        provider_id: "anthropic",
        model_id: "claude-sonnet-4",
        input_per_mtok: 3.0,
        output_per_mtok: 15.0,
        cache_read_per_mtok: 0.30,
        cache_write_per_mtok: 3.75,
    },
    ModelPricing {
        provider_id: "anthropic",
        model_id: "claude-sonnet-4-20250514",
        input_per_mtok: 3.0,
        output_per_mtok: 15.0,
        cache_read_per_mtok: 0.30,
        cache_write_per_mtok: 3.75,
    },
    ModelPricing {
        provider_id: "anthropic",
        model_id: "claude-3-5-sonnet-20241022",
        input_per_mtok: 3.0,
        output_per_mtok: 15.0,
        cache_read_per_mtok: 0.30,
        cache_write_per_mtok: 3.75,
    },
    ModelPricing {
        provider_id: "anthropic",
        model_id: "claude-opus-4-20250514",
        input_per_mtok: 15.0,
        output_per_mtok: 75.0,
        cache_read_per_mtok: 1.50,
        cache_write_per_mtok: 18.75,
    },
    ModelPricing {
        provider_id: "anthropic",
        model_id: "claude-3-haiku-20240307",
        input_per_mtok: 0.25,
        output_per_mtok: 1.25,
        cache_read_per_mtok: 0.03,
        cache_write_per_mtok: 0.30,
    },
    // OpenAI
    ModelPricing {
        provider_id: "openai",
        model_id: "gpt-4o",
        input_per_mtok: 2.50,
        output_per_mtok: 10.0,
        cache_read_per_mtok: 1.25,
        cache_write_per_mtok: 2.50,
    },
    ModelPricing {
        provider_id: "openai",
        model_id: "gpt-4o-mini",
        input_per_mtok: 0.15,
        output_per_mtok: 0.60,
        cache_read_per_mtok: 0.075,
        cache_write_per_mtok: 0.15,
    },
    ModelPricing {
        provider_id: "openai",
        model_id: "o3-mini",
        input_per_mtok: 1.10,
        output_per_mtok: 4.40,
        cache_read_per_mtok: 0.55,
        cache_write_per_mtok: 1.10,
    },
    // Gemini
    ModelPricing {
        provider_id: "gemini",
        model_id: "gemini-1.5-pro",
        input_per_mtok: 1.25,
        output_per_mtok: 5.0,
        cache_read_per_mtok: 0.0,
        cache_write_per_mtok: 0.0,
    },
    ModelPricing {
        provider_id: "gemini",
        model_id: "gemini-1.5-flash",
        input_per_mtok: 0.075,
        output_per_mtok: 0.30,
        cache_read_per_mtok: 0.0,
        cache_write_per_mtok: 0.0,
    },
    ModelPricing {
        provider_id: "gemini",
        model_id: "gemini-2.0-flash",
        input_per_mtok: 0.10,
        output_per_mtok: 0.40,
        cache_read_per_mtok: 0.0,
        cache_write_per_mtok: 0.0,
    },
    // Local / unknown — wildcard defaults to $0
    ModelPricing {
        provider_id: "ollama",
        model_id: "*",
        input_per_mtok: 0.0,
        output_per_mtok: 0.0,
        cache_read_per_mtok: 0.0,
        cache_write_per_mtok: 0.0,
    },
    ModelPricing {
        provider_id: "lmstudio",
        model_id: "*",
        input_per_mtok: 0.0,
        output_per_mtok: 0.0,
        cache_read_per_mtok: 0.0,
        cache_write_per_mtok: 0.0,
    },
];

/// Look up pricing for a provider/model combination.
/// Exact match first, then wildcard (`*`), then zero-price default.
pub fn lookup_pricing(provider_id: &str, model_id: &str) -> ModelPricing {
    MODEL_PRICING
        .iter()
        .find(|p| p.provider_id == provider_id && (p.model_id == model_id || p.model_id == "*"))
        .copied()
        .unwrap_or(ModelPricing {
            provider_id: "",
            model_id: "",
            input_per_mtok: 0.0,
            output_per_mtok: 0.0,
            cache_read_per_mtok: 0.0,
            cache_write_per_mtok: 0.0,
        })
}

/// Compute a cost estimate in USD cents from usage + pricing.
/// Returns None when the total cost rounds to zero.
pub fn estimate_cost_cents(
    usage: &crate::schema::ProviderUsage,
    pricing: &ModelPricing,
) -> Option<String> {
    let input = usage.input_tokens.unwrap_or(0) as f64 / 1_000_000.0 * pricing.input_per_mtok;
    let output = usage.output_tokens.unwrap_or(0) as f64 / 1_000_000.0 * pricing.output_per_mtok;
    let cache_read =
        usage.cache_read_tokens.unwrap_or(0) as f64 / 1_000_000.0 * pricing.cache_read_per_mtok;
    let cache_write =
        usage.cache_write_tokens.unwrap_or(0) as f64 / 1_000_000.0 * pricing.cache_write_per_mtok;
    let total = input + output + cache_read + cache_write;
    if total <= 0.0 {
        return None;
    }
    Some(format!("{:.4}", total))
}

/// Returns true when onboarding / BYOK gate is satisfied for the active provider
/// or any stored cloud credential exists.
pub fn has_usable_provider_credential(
    active_provider: &str,
    has_keychain_secret: impl Fn(&str) -> bool,
) -> bool {
    if let Some(desc) = descriptor(active_provider) {
        if matches!(
            desc.credential_mode,
            CredentialMode::None | CredentialMode::Optional
        ) {
            return true;
        }
    }

    PROVIDER_DESCRIPTORS
        .iter()
        .filter(|d| d.credential_mode == CredentialMode::Required)
        .any(|d| has_keychain_secret(d.id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_registry_adapter_has_descriptor() {
        for adapter in crate::adapter::registry() {
            assert!(
                descriptor(adapter.id()).is_some(),
                "missing catalog descriptor for adapter {}",
                adapter.id()
            );
        }
    }

    #[test]
    fn every_descriptor_has_registry_adapter() {
        for desc in PROVIDER_DESCRIPTORS {
            let found = crate::adapter::registry()
                .iter()
                .any(|adapter| adapter.id() == desc.id);
            assert!(
                found,
                "catalog descriptor {} has no registered adapter",
                desc.id
            );
        }
    }

    #[test]
    fn credential_gate_ollama_active_without_key() {
        assert!(has_usable_provider_credential("ollama", |_| false));
    }

    #[test]
    fn credential_gate_openai_requires_stored_key_when_active() {
        assert!(!has_usable_provider_credential("openai", |_| false));
        assert!(has_usable_provider_credential("openai", |id| id == "openai"));
    }

    #[test]
    fn credential_gate_any_stored_cloud_key() {
        assert!(has_usable_provider_credential("anthropic", |id| id == "openrouter"));
    }
}
