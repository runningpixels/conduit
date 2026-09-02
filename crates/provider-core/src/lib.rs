// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

pub mod adapter;
pub mod adapters;
pub mod brand;
pub mod brand_emit;
pub mod catalog;
pub mod error;
pub mod fixtures;
pub mod normalize;
pub mod retry;
pub mod schema;
pub mod transport;
pub mod vision;

pub use adapter::{get_adapter, AdapterContext, ModelInfo, ProviderAdapter};
pub use catalog::{
    descriptor, has_usable_provider_credential, list_descriptors, CredentialMode,
    ProviderDescriptor,
};
pub use normalize::{validate, NormalizedRequest};
pub use schema::*;
pub use vision::model_accepts_images;

pub fn crate_name() -> &'static str {
    "provider-core"
}
