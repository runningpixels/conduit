pub mod adapter;
pub mod adapters;
pub mod catalog;
pub mod error;
pub mod fixtures;
pub mod normalize;
pub mod retry;
pub mod schema;
pub mod transport;

pub use adapter::{get_adapter, AdapterContext, ModelInfo, ProviderAdapter};
pub use catalog::{
    descriptor, has_usable_provider_credential, list_descriptors, CredentialMode,
    ProviderDescriptor,
};
pub use normalize::{validate, NormalizedRequest};
pub use schema::*;

pub fn crate_name() -> &'static str {
    "provider-core"
}
