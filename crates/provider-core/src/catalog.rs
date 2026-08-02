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
