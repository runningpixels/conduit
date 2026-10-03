//! The real [`ResearchIo`]: the settings' local search backend (never a
//! provider's hosted search, which answers instead of returning pages), the
//! guarded page fetch (public https addresses only, checked again after DNS
//! and on every redirect), and tool-less model calls in the run's hidden
//! conversation. Also starts the background work for the commands.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use provider_core::schema::{
    GenerationControls, Message, MessagePart, MessagePartKind, MessageRole, ProviderEvent,
    ProviderRequest, ReasoningEffort, ResearchBrief, ResearchRunUpdated, ResearchStatus,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{service, FetchedPage, ResearchIo, ResearchRuns, SearchHit, RUN_UPDATED_EVENT};
use crate::artifact_network::AddressPolicy;
use crate::event_sink;
use crate::state::AppState;
use crate::stream_manager::StreamManager;
use crate::time::now_iso8601;
use crate::web_page;

/// Readable text kept per page.
const MAX_PAGE_CHARS: usize = 50_000;

pub struct AppIo {
    app: AppHandle,
    run_id: String,
    /// The run's hidden conversation, where its model calls land.
    conversation_id: String,
    /// The run's stop token; a model call in flight is cancelled with it.
    stop: CancellationToken,
    tokens: Arc<AtomicU64>,
    /// `None` until a reply reports usage.
    reported: Arc<std::sync::atomic::AtomicBool>,
}

impl AppIo {
    pub fn new(
        app: AppHandle,
        run_id: &str,
        conversation_id: &str,
        stop: CancellationToken,
    ) -> Self {
        Self {
            app,
            run_id: run_id.to_string(),
            conversation_id: conversation_id.to_string(),
            stop,
            tokens: Arc::new(AtomicU64::new(0)),
            reported: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
}

#[async_trait]
impl ResearchIo for AppIo {
    async fn search(&self, query: &str) -> Result<Vec<SearchHit>, String> {
        let state = self.app.state::<AppState>();
        let settings = state.settings()?;
        let backend = settings.web_search.local_backend;
        let api_key = crate::search::credential_id(backend).and_then(|id| {
            match state.credential_store().get_secret(id) {
                Ok(secret) if !secret.trim().is_empty() => Some(secret),
                _ => None,
            }
        });
        let config = crate::search::LocalSearchConfig {
            backend,
            api_key,
            searxng_base_url: settings.web_search.searxng_base_url.clone(),
        };
        let results = crate::search::search(&config, query).await?;
        Ok(results
            .into_iter()
            .filter_map(|r| {
                let url = r["url"].as_str()?.trim().to_string();
                (!url.is_empty()).then(|| SearchHit {
                    title: r["title"].as_str().unwrap_or_default().to_string(),
                    url,
                    snippet: r["snippet"].as_str().unwrap_or_default().to_string(),
                })
            })
            .collect())
    }

    async fn fetch(&self, url: &str) -> Result<FetchedPage, String> {
        // The network path speaks https only; most http pages are served there too.
        let url = web_page::upgrade_to_https(url);
        let principal = format!("research:{}", self.run_id);
        let page = web_page::fetch(&url, &principal, AddressPolicy::APP, MAX_PAGE_CHARS)
            .await
            .map_err(|e| e.to_string())?;
        Ok(FetchedPage {
            url: page.url,
            title: page.title,
            text: page.text,
        })
    }

    async fn complete(&self, system: &str, user: &str) -> Result<String, String> {
        // The call runs as its own task so that dropping this future (the run
        // was stopped, or ran out of time) still cancels the stream properly:
        // the guard cancels `abort`, and the task winds the stream down.
        let abort = self.stop.child_token();
        let guard = abort.clone().drop_guard();
        let app = self.app.clone();
        let conversation_id = self.conversation_id.clone();
        let system = system.to_string();
        let user = user.to_string();
        let tokens = self.tokens.clone();
        let reported = self.reported.clone();
        let task = tauri::async_runtime::spawn(async move {
            let state = app.state::<AppState>();
            let streams = app.state::<StreamManager>();
            let request = request(&state, &conversation_id, &system, &user)?;
            let request_id = request.request_id.clone();
            let (sink, events) = event_sink::collector::<ProviderEvent>();
            let stream = streams.start_chat_stream(&state, request, sink);
            tokio::pin!(stream);
            tokio::select! {
                result = &mut stream => { result?; }
                _ = abort.cancelled() => {
                    // Retried: a cancel in the first moment can land before
                    // the stream is registered.
                    loop {
                        let _ = streams
                            .cancel_stream(&state, &request_id, Some(&conversation_id))
                            .await;
                        tokio::select! {
                            _ = &mut stream => break,
                            _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => {}
                        }
                    }
                    return Err("Stopped before it finished.".to_string());
                }
            }
            let events = events
                .lock()
                .map_err(|_| "the reply could not be read".to_string())?;
            let mut reply = String::new();
            for event in events.iter() {
                match event {
                    ProviderEvent::ContentDelta { content, .. } => reply.push_str(content),
                    ProviderEvent::Error { error, .. } => return Err(error.message.clone()),
                    ProviderEvent::Usage { usage, .. } => {
                        let used =
                            usage.input_tokens.unwrap_or(0) + usage.output_tokens.unwrap_or(0);
                        tokens.fetch_add(used, Ordering::Relaxed);
                        reported.store(true, Ordering::Relaxed);
                    }
                    _ => {}
                }
            }
            let reply = reply.trim().to_string();
            if reply.is_empty() {
                return Err("The model returned nothing.".to_string());
            }
            Ok(reply)
        });
        let result = task.await.map_err(|e| e.to_string())?;
        guard.disarm();
        result
    }

    fn tokens_used(&self) -> Option<u64> {
        self.reported
            .load(Ordering::Relaxed)
            .then(|| self.tokens.load(Ordering::Relaxed))
    }
}

/// A one-turn, tool-less request in `conversation_id` with the settings' model.
fn request(
    state: &AppState,
    conversation_id: &str,
    system: &str,
    user: &str,
) -> Result<ProviderRequest, String> {
    let settings = state.settings()?;
    let now = now_iso8601();
    let message_id = Uuid::new_v4().to_string();
    Ok(ProviderRequest {
        request_id: Uuid::new_v4().to_string(),
        conversation_id: conversation_id.to_string(),
        model_id: settings.active_model.clone(),
        messages: vec![Message {
            id: message_id.clone(),
            conversation_id: conversation_id.to_string(),
            role: MessageRole::User,
            author_label: None,
            provider_message_id: None,
            request_id: None,
            interrupted_at: None,
            metadata: None,
            parts: vec![MessagePart {
                id: format!("{message_id}/p0"),
                message_id,
                index: 0,
                kind: MessagePartKind::Text,
                content: Some(user.to_string()),
                mime_type: None,
                tool_call_id: None,
                artifact_id: None,
                attachment_id: None,
                blob_ref: None,
                metadata: None,
                created_at: now.clone(),
            }],
            created_at: now,
        }],
        system_prompt: Some(system.to_string()),
        developer_prompt: None,
        attachments: None,
        tool_definitions: Vec::new(),
        generation_controls: low_effort(&settings.active_provider),
        response_format: None,
        web_search: None,
    })
}

/// Ask for little reasoning: each call is a narrow, well-specified task, and
/// a thinking model otherwise spends a minute per page. Only for providers
/// where it is safe: OpenRouter passes it on to models that support it and
/// drops it for the rest, and the Anthropic adapter sends it only to models
/// that accept it. Plain OpenAI-style endpoints reject the field on models
/// without reasoning, so they get nothing.
fn low_effort(provider: &str) -> Option<GenerationControls> {
    matches!(provider, "openrouter" | "anthropic").then(|| GenerationControls {
        temperature: None,
        top_p: None,
        max_tokens: None,
        stop_sequences: None,
        tool_choice: None,
        reasoning_effort: Some(ReasoningEffort::Low),
    })
}

/// Tell the renderer a run changed.
pub fn announce(app: &AppHandle, run_id: &str, status: ResearchStatus) {
    let payload = ResearchRunUpdated {
        run_id: run_id.to_string(),
        status,
    };
    if let Err(e) = app.emit(RUN_UPDATED_EVENT, payload) {
        tracing::warn!(error = %e, "could not announce a research run update");
    }
}

/// The hidden conversation a run's model calls go to.
async fn hidden_conversation(app: &AppHandle, run_id: &str) -> Option<String> {
    let state = app.state::<AppState>();
    super::repo::get_row(&state.db, &state.encryption, run_id)
        .await
        .ok()
        .flatten()
        .and_then(|row| row.hidden_conversation_id)
}

/// Plan `run_id` in the background.
pub fn spawn_plan(app: AppHandle, run_id: String, question: String) {
    let Some(stop) = app.state::<ResearchRuns>().begin(&run_id) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let conversation_id = hidden_conversation(&app, &run_id).await.unwrap_or_default();
        let io = AppIo::new(app.clone(), &run_id, &conversation_id, stop.clone());
        let notify = |id: &str, status: ResearchStatus| announce(&app, id, status);
        let state = app.state::<AppState>();
        service::plan_run(&state, &io, &run_id, &question, &stop, &notify).await;
        app.state::<ResearchRuns>().end(&run_id);
    });
}

/// Run an approved `brief` in the background.
pub fn spawn_run(app: AppHandle, run_id: String, brief: ResearchBrief) {
    let Some(stop) = app.state::<ResearchRuns>().begin(&run_id) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let conversation_id = hidden_conversation(&app, &run_id).await.unwrap_or_default();
        let io = AppIo::new(app.clone(), &run_id, &conversation_id, stop.clone());
        let notify = |id: &str, status: ResearchStatus| announce(&app, id, status);
        let state = app.state::<AppState>();
        service::execute(&state, &io, &run_id, &brief, &stop, &notify).await;
        app.state::<ResearchRuns>().end(&run_id);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn low_reasoning_is_asked_only_where_it_is_safe() {
        for provider in ["openrouter", "anthropic"] {
            let controls = low_effort(provider).expect(provider);
            assert_eq!(controls.reasoning_effort, Some(ReasoningEffort::Low));
            assert_eq!(controls.max_tokens, None);
        }
        for provider in ["openai", "openai_compat", "ollama", "gemini"] {
            assert!(low_effort(provider).is_none(), "{provider}");
        }
    }
}
