// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! The person's saved API keys, which an agent is never let type into a page
//! (workflows and chat both check them before `type_text`).

use crate::state::AppState;

/// Provider ids whose saved keys are checked before an agent types text.
/// The keychain can't list what it holds, so these plus the active provider
/// and any with a custom endpoint are looked up.
pub const KEYED_PROVIDERS: &[&str] = &[
    "anthropic",
    "openai",
    "openrouter",
    "groq",
    "google",
    "gemini",
    "mistral",
    "deepseek",
    "xai",
    "together",
    "fireworks",
    "cohere",
    "perplexity",
    "cerebras",
    "moonshot",
    "zai",
];

/// The person's saved API keys, to refuse typing them into a page. Read from
/// the keychain each time; never logged or sent.
pub fn saved_secrets(state: &AppState) -> Vec<String> {
    let mut ids: Vec<String> = KEYED_PROVIDERS.iter().map(|s| s.to_string()).collect();
    if let Ok(settings) = state.settings() {
        ids.push(settings.active_provider.clone());
        ids.extend(settings.provider_endpoints.keys().cloned());
    }
    ids.sort();
    ids.dedup();
    let store = state.credential_store();
    ids.iter()
        .filter_map(|id| store.get_secret(id).ok())
        .filter(|s| !s.trim().is_empty())
        .collect()
}
