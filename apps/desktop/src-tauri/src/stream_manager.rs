use crate::{
    credentials::CredentialStore,
    db::repository::{conversations, event_log, messages},
    state::AppState,
};
use futures::StreamExt;
use provider_core::{
    schema::{ProviderEvent, ProviderRequest},
    AdapterContext, ModelInfo,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamHandle {
    pub request_id: String,
}

pub(crate) struct ActiveStream {
    pub(crate) cancel: CancellationToken,
}

pub struct StreamManager {
    active: Arc<Mutex<HashMap<String, ActiveStream>>>,
}

impl StreamManager {
    pub fn new() -> Self {
        Self {
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn build_adapter_context(
        state: &AppState,
        provider_id: &str,
    ) -> Result<AdapterContext, String> {
        let settings = state.settings()?;
        let store = CredentialStore::new("conduit");

        let api_key = if provider_id == "ollama" {
            None
        } else if store.has_provider_secret(provider_id) {
            Some(store.get_secret(provider_id)?)
        } else if provider_id == "openai_compat" {
            None
        } else {
            return Err(format!("No credential stored for provider {provider_id}"));
        };

        let base_url = settings
            .provider_endpoints
            .get(provider_id)
            .and_then(|cfg| cfg.base_url.clone());

        Ok(AdapterContext {
            api_key,
            base_url,
            http: state.http.clone(),
        })
    }

    pub async fn validate_credentials(state: &AppState, provider_id: &str) -> Result<(), String> {
        let adapter = provider_core::get_adapter(provider_id)
            .ok_or_else(|| format!("Unknown provider: {provider_id}"))?;
        let ctx = Self::build_adapter_context(state, provider_id)?;
        adapter
            .validate_credentials(&ctx)
            .await
            .map_err(|e| e.message)
    }

    pub async fn list_models(
        state: &AppState,
        provider_id: &str,
    ) -> Result<Vec<ModelInfo>, String> {
        let adapter = provider_core::get_adapter(provider_id)
            .ok_or_else(|| format!("Unknown provider: {provider_id}"))?;
        let ctx = Self::build_adapter_context(state, provider_id)?;
        let models = adapter.list_models(&ctx).await.map_err(|e| e.message)?;
        Ok(models)
    }

    pub async fn start_chat_stream(
        &self,
        state: &AppState,
        request: ProviderRequest,
        channel: Channel<ProviderEvent>,
    ) -> Result<StreamHandle, String> {
        let settings = state.settings()?;
        let provider_id = settings.active_provider.clone();
        let conversation_id = request.conversation_id.clone();
        let request_id = if request.request_id.trim().is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            request.request_id.clone()
        };

        let adapter = provider_core::get_adapter(&provider_id)
            .ok_or_else(|| format!("Unknown provider: {provider_id}"))?;

        // M4: honor `local_only` — block cloud providers when the user has opted
        // into local-only mode. Local-served adapters (ollama, openai_compat)
        // report `is_local()` and are always allowed.
        if settings.local_only && !adapter.is_local() {
            return Err(format!(
                "Cloud provider '{provider_id}' is disabled while local_only mode is on"
            ));
        }

        let ctx = Self::build_adapter_context(state, &provider_id)?;

        let cancel = self.register_stream(&request_id)?;

        // Phase 3 cut-over: the stream persists through the SQLite event log +
        // materialized view. Ensure the conversation row exists (the request may
        // reference a not-yet-persisted id), persist the request's user/system/
        // developer messages so the conversation reloads fully, and bump the
        // conversation's updated_at so it surfaces newest-first in the rail.
        let pool = state.db.clone();
        conversations::ensure_exists(&pool, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;
        messages::persist_request_messages(&pool, &request.messages)
            .await
            .map_err(|e| e.to_string())?;
        conversations::touch(&pool, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;

        let mut provider_request = request;
        provider_request.request_id = request_id.clone();

        let request_model = provider_request.model_id.clone();
        let stream = match adapter
            .stream_chat(provider_request, ctx, cancel.clone())
            .await
        {
            Ok(s) => s,
            Err(e) => {
                // The provider rejected the request before streaming (HTTP 4xx
                // from a bad model/key, no credential stored, connection
                // failure). Without this log the failure reached the UI only as
                // a one-line status string that is easy to miss; surface it in
                // the process log too.
                warn!(
                    provider = %provider_id,
                    model = %request_model,
                    error = %e.message,
                    "provider stream_chat failed before any output"
                );
                return Err(e.message);
            }
        };
        info!(provider = %provider_id, model = %request_model, "provider stream started");

        let active = self.active.clone();
        let request_id_task = request_id.clone();
        let conversation_id_task = conversation_id.clone();
        let pool_task = pool.clone();
        let provider_id_task = provider_id.clone();

        tauri::async_runtime::spawn(async move {
            futures::pin_mut!(stream);
            while let Some(event) = stream.next().await {
                if let ProviderEvent::Error { error, .. } = &event {
                    warn!(
                        request_id = %request_id_task,
                        provider = %provider_id_task,
                        error = %error.message,
                        "provider stream error"
                    );
                }
                // The persistence invariant: append the event to the log and
                // update the materialized view in one transaction. Best-effort
                // on failure — the stream still reaches the UI, and the
                // startup reconciliation/recovery sweep repairs drift.
                let _ = event_log::append_and_apply(
                    &pool_task,
                    &conversation_id_task,
                    &request_id_task,
                    &event,
                )
                .await;

                if channel.send(event.clone()).is_err() {
                    cancel.cancel();
                    let _ =
                        messages::mark_interrupted_by_request(&pool_task, &request_id_task).await;
                    break;
                }

                if matches!(
                    event,
                    ProviderEvent::MessageComplete { .. } | ProviderEvent::Error { .. }
                ) {
                    let _ = conversations::touch(&pool_task, &conversation_id_task).await;
                    break;
                }
            }

            let _ = active
                .lock()
                .map(|mut guard| guard.remove(&request_id_task));
        });

        Ok(StreamHandle { request_id })
    }

    pub async fn cancel_stream(
        &self,
        state: &AppState,
        request_id: &str,
        _conversation_id: Option<&str>,
    ) -> Result<bool, String> {
        let cancelled = {
            let guard = self
                .active
                .lock()
                .map_err(|_| "Stream lock poisoned".to_string())?;
            if let Some(active) = guard.get(request_id) {
                active.cancel.cancel();
                true
            } else {
                false
            }
        };

        if cancelled {
            // Phase 3 cut-over: mark the assistant turn interrupted in the
            // materialized view. The `request_id` identifies the turn; the
            // conversation_id is no longer needed (kept in the signature for IPC
            // stability).
            let pool = state.db.clone();
            let _ = messages::mark_interrupted_by_request(&pool, request_id).await;
        }

        Ok(cancelled)
    }

    /// Registers a new active stream and returns the `CancellationToken` that
    /// drives it. Callers poll `is_cancelled()` (cooperative) or `cancel()` it.
    /// M1: the single cancellation authority — both real and mock streams
    /// register here.
    pub fn register_stream(&self, request_id: &str) -> Result<CancellationToken, String> {
        let cancel = CancellationToken::new();
        self.active
            .lock()
            .map_err(|_| "Stream lock poisoned".to_string())?
            .insert(
                request_id.to_string(),
                ActiveStream {
                    cancel: cancel.clone(),
                },
            );
        Ok(cancel)
    }

    /// Handle to the active-stream map, for spawned tasks that need to remove
    /// their own entry on completion (mirrors the chat-stream cleanup path).
    pub(crate) fn active_handle(&self) -> Arc<Mutex<HashMap<String, ActiveStream>>> {
        self.active.clone()
    }
}

impl Default for StreamManager {
    fn default() -> Self {
        Self::new()
    }
}
