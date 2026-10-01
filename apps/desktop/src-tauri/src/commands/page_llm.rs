//! IPC for `window.conduit.llm` (ADR-014): a page's one-shot model
//! completion. Every error is `Err(String)` starting with a bridge error code
//! and a colon (`not_granted:`, `unavailable:`, `rate_limited:`, `invalid:`,
//! `timeout:`), matching `page_storage`'s convention; the renderer maps the
//! prefix to the bridge's `{ code, message }` and the rest to the message.
//!
//! The actual work lives in `crate::page_llm` — this module only parses the
//! principal and forwards to it. `page_llm_complete` never goes through
//! `StreamManager::start_chat_stream` and writes nothing to the database.

use provider_core::schema::{
    AppLlmSlot, PageLlmProviderGrant, PageLlmReply, PageLlmRequest, PageLlmState,
};
use serde::Deserialize;
use tauri::State;

use crate::{
    db::repository::{artifact_network::Principal, page_llm as grants},
    page_llm::{self, GrantScope as PageLlmGrantScope},
    state::AppState,
    stream_manager::StreamManager,
};

/// The renderer never names its own principal freely, but a malformed string
/// still has to fail as `invalid:`, not panic or fall through.
fn parse_principal(raw: &str) -> Result<Principal, String> {
    Principal::parse(raw).map_err(|e| format!("invalid: {e}"))
}

#[tauri::command]
pub async fn page_llm_state(
    state: State<'_, AppState>,
    stream_manager: State<'_, StreamManager>,
    principal: String,
    slot: Option<AppLlmSlot>,
) -> Result<PageLlmState, String> {
    let principal = parse_principal(&principal)?;
    page_llm::state(&state, &stream_manager, &principal, slot)
        .await
        .map_err(|e| e.to_string())
}

/// `session` ("Allow this time") or `page` ("Always allow for this page").
/// Mirrors `commands::artifact_network::GrantScope` — matching names for a
/// matching shape of decision — but its own type, so the two commands' glob
/// re-exports from `commands::mod` never collide.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PageLlmGrantScopeArg {
    Session,
    Page,
}

impl From<PageLlmGrantScopeArg> for PageLlmGrantScope {
    fn from(scope: PageLlmGrantScopeArg) -> Self {
        match scope {
            PageLlmGrantScopeArg::Session => PageLlmGrantScope::Session,
            PageLlmGrantScopeArg::Page => PageLlmGrantScope::Page,
        }
    }
}

#[tauri::command]
pub async fn grant_page_llm(
    state: State<'_, AppState>,
    stream_manager: State<'_, StreamManager>,
    principal: String,
    scope: PageLlmGrantScopeArg,
    slot: Option<AppLlmSlot>,
) -> Result<(), String> {
    let principal = parse_principal(&principal)?;
    page_llm::grant(&state, &stream_manager, &principal, scope.into(), slot)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn revoke_page_llm(state: State<'_, AppState>, principal: String) -> Result<(), String> {
    let principal = parse_principal(&principal)?;
    page_llm::revoke(&state, &principal)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn page_llm_complete(
    state: State<'_, AppState>,
    stream_manager: State<'_, StreamManager>,
    principal: String,
    request: PageLlmRequest,
) -> Result<PageLlmReply, String> {
    let principal = parse_principal(&principal)?;
    page_llm::complete(&state, &stream_manager, &principal, request)
        .await
        .map_err(|e| e.to_string())
}

/// Every provider `principal` is always allowed to use, for an app's
/// Permissions section. A provider that has since been removed from the
/// catalog is listed under its id.
#[tauri::command]
pub async fn list_page_llm_grants(
    state: State<'_, AppState>,
    stream_manager: State<'_, StreamManager>,
    principal: String,
) -> Result<Vec<PageLlmProviderGrant>, String> {
    let principal = parse_principal(&principal)?;
    let rows = grants::list_grants(&state.db, &principal)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(provider_id, created_at)| {
            let descriptor = provider_core::descriptor(&provider_id);
            let is_local = stream_manager
                .resolve_adapter(&provider_id)
                .map(|a| a.is_local())
                .unwrap_or_else(|| descriptor.is_some_and(|d| d.is_local));
            PageLlmProviderGrant {
                provider_name: descriptor
                    .map(|d| d.display_name.to_string())
                    .unwrap_or_else(|| provider_id.clone()),
                provider_id,
                is_local,
                created_at,
            }
        })
        .collect())
}

/// Take back the model access given for one provider, leaving the others.
#[tauri::command]
pub async fn revoke_page_llm_provider(
    state: State<'_, AppState>,
    principal: String,
    provider_id: String,
) -> Result<(), String> {
    let principal = parse_principal(&principal)?;
    page_llm::revoke_provider(&state, &principal, &provider_id)
        .await
        .map_err(|e| e.to_string())
}
