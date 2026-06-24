use keyring::Entry;
// C1: `CredentialSummary` is defined in `provider_core::schema` and codegen'd
// into `@conduit/config-schema`.
pub use provider_core::schema::CredentialSummary;

/// OS keychain service name. The sole source of truth for stored provider
/// secrets (keyed by provider_id). Centralized so the BYOK onboarding gate
/// (`AppState::has_any_provider_credential`) and the save/load commands agree.
pub const KEYCHAIN_SERVICE: &str = "conduit";

pub struct CredentialStore {
    service_name: String,
}

impl CredentialStore {
    pub fn new(service_name: impl Into<String>) -> Self {
        Self {
            service_name: service_name.into(),
        }
    }

    /// Construct a store for the canonical Conduit keychain service.
    pub fn default_service() -> Self {
        Self::new(KEYCHAIN_SERVICE)
    }

    pub fn save_provider_secret(
        &self,
        provider_id: &str,
        secret: &str,
    ) -> Result<CredentialSummary, String> {
        let entry =
            Entry::new(&self.service_name, provider_id).map_err(|error| error.to_string())?;
        entry
            .set_password(secret)
            .map_err(|error| error.to_string())?;

        Ok(CredentialSummary {
            provider_id: provider_id.to_string(),
            credential_ref: self.reference(provider_id),
            stored_in_keychain: true,
        })
    }

    pub fn reference(&self, provider_id: &str) -> String {
        format!("keychain://{}/{}", self.service_name, provider_id)
    }

    pub fn has_provider_secret(&self, provider_id: &str) -> bool {
        let Ok(entry) = Entry::new(&self.service_name, provider_id) else {
            return false;
        };
        entry.get_password().is_ok()
    }

    /// Retrieve a secret from the keychain for provider API calls.
    /// Returns Err if the secret doesn't exist or can't be retrieved.
    ///
    /// Note: Currently unused in Phase 1 (shell only). Will be used in Phase 2
    /// when implementing the provider abstraction layer for actual API calls.
    pub fn get_secret(&self, provider_id: &str) -> Result<String, String> {
        let entry = Entry::new(&self.service_name, provider_id)
            .map_err(|error| format!("Failed to access keychain: {}", error))?;
        entry
            .get_password()
            .map_err(|error| format!("Failed to retrieve secret: {}", error))
    }
}
