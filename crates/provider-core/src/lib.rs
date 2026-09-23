// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

pub mod adapter;
pub mod adapters;
pub mod brand;
pub mod brand_emit;
pub mod catalog;
pub mod embeddings;
pub mod error;
pub mod fixtures;
pub mod image_generation;
pub mod normalize;
pub mod output_limits;
pub mod retry;
pub mod schema;
pub mod transport;
pub mod user_theme;
pub mod vision;

pub use adapter::{get_adapter, AdapterContext, ModelInfo, ProviderAdapter};
pub use catalog::{
    descriptor, has_usable_provider_credential, list_descriptors, CredentialMode,
    ProviderDescriptor,
};
pub use embeddings::{default_embedding_dimensions, default_embedding_model};
pub use image_generation::{default_image_model, model_generates_images};
pub use normalize::{validate, NormalizedRequest};
pub use schema::*;
pub use vision::model_accepts_images;

pub fn crate_name() -> &'static str {
    "provider-core"
}
