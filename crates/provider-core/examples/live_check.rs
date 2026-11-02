//! Live check for the OpenAI-compatible provider presets, run by hand with a
//! real key before a preset merges. Not part of CI (it needs the network).
//!
//! ```text
//! cargo run -p provider-core --example live_check -- <provider_id|all> [model]
//! ```
//!
//! Keys: env var `CONDUIT_LIVE_<ID>_KEY` (e.g. `CONDUIT_LIVE_CEREBRAS_KEY`), or
//! a dotenv-style `KEY=VALUE` file named by `CONDUIT_LIVE_KEYS_FILE` (keep it
//! outside the repo). A provider without a key
//! is skipped, not failed. Keys are never printed; anything key-like is
//! redacted from error text.
//!
//! Checks per provider: (a) models list, (b) a short message streams to
//! completion, (c) a stream cancelled mid-flight ends cleanly, (d) a tool call
//! round-trips (informational FAIL if the model simply does not call the tool).
//! Every request uses `max_tokens <= 64`.

use futures::StreamExt;
use provider_core::schema::{
    GenerationControls, Message, MessagePart, MessagePartKind, MessageRole, ProviderEvent,
    ProviderRequest, ToolChoice, ToolDefinition,
};
use provider_core::{get_adapter, AdapterContext, ModelInfo, ProviderAdapter};
use serde_json::json;
use std::collections::HashMap;
use std::pin::Pin;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

const PROVIDERS: [&str; 6] = [
    "cerebras",
    "sambanova",
    "deepinfra",
    "novita",
    "minimax",
    "nvidia",
];

const MAX_TOKENS: u32 = 64;
const STREAM_TIMEOUT: Duration = Duration::from_secs(60);
const CANCEL_DRAIN_TIMEOUT: Duration = Duration::from_secs(10);

/// Small/cheap chat model per provider, used when the listing carries no
/// prices (or the priced pick is not a chat model). Chosen from each
/// provider's docs; verify against the live listing.
fn default_model(provider: &str) -> &'static str {
    match provider {
        "cerebras" => "llama3.1-8b",
        "sambanova" => "Meta-Llama-3.1-8B-Instruct",
        "deepinfra" => "meta-llama/Meta-Llama-3.1-8B-Instruct",
        "novita" => "meta-llama/llama-3.1-8b-instruct",
        "minimax" => "MiniMax-M2",
        "nvidia" => "meta/llama-3.1-8b-instruct",
        _ => "",
    }
}

type EventStream = Pin<Box<dyn futures::Stream<Item = ProviderEvent> + Send>>;

struct Report {
    fails: Vec<String>,
}

impl Report {
    fn check(&mut self, provider: &str, name: &str, ok: bool, detail: &str) {
        let tag = if ok { "PASS" } else { "FAIL" };
        println!("  [{tag}] {provider}: {name}{}", sep(detail));
        if !ok {
            self.fails.push(format!("{provider}: {name}"));
        }
    }
}

fn sep(detail: &str) -> String {
    if detail.is_empty() {
        String::new()
    } else {
        format!(" - {detail}")
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(target) = args.first() else {
        eprintln!("usage: live_check <provider_id|all> [model]");
        std::process::exit(2);
    };
    let model_arg = args.get(1).cloned();
    let ids: Vec<String> = if target == "all" {
        PROVIDERS.iter().map(|s| s.to_string()).collect()
    } else {
        vec![target.to_lowercase()]
    };

    let file_keys = load_env_file();
    let mut report = Report { fails: Vec::new() };
    let mut ran = 0;

    for id in &ids {
        println!("== {id}");
        let var = format!("CONDUIT_LIVE_{}_KEY", id.to_uppercase());
        let key = std::env::var(&var)
            .ok()
            .filter(|k| !k.trim().is_empty())
            .or_else(|| file_keys.get(&var).cloned())
            .map(|k| k.trim().to_string());
        let Some(key) = key else {
            println!("  skipped: no key ({var})");
            continue;
        };
        let Some(adapter) = get_adapter(id) else {
            report.check(id, "adapter registered", false, "unknown provider id");
            continue;
        };
        ran += 1;
        run_provider(
            adapter.as_ref(),
            id,
            &key,
            model_arg.as_deref(),
            &mut report,
        )
        .await;
    }

    println!();
    if report.fails.is_empty() {
        println!(
            "RESULT: ok ({ran} provider(s) checked, {} skipped)",
            ids.len() - ran
        );
    } else {
        println!("RESULT: FAIL");
        for f in &report.fails {
            println!("  failed: {f}");
        }
        std::process::exit(1);
    }
}

async fn run_provider(
    adapter: &dyn ProviderAdapter,
    id: &str,
    key: &str,
    model_arg: Option<&str>,
    report: &mut Report,
) {
    let ctx = AdapterContext {
        api_key: Some(key.to_string()),
        base_url: None,
        http: provider_core::transport::HttpClient::new(),
        local_only: false,
    };

    // (a) model list
    let models = match adapter.list_models(&ctx).await {
        Ok(m) => m,
        Err(e) => {
            report.check(id, "models", false, &redact(&e.message, key));
            return;
        }
    };
    let priced = models.iter().filter(|m| m.price.is_some()).count();
    println!(
        "  models: {} listed, {} with price (context length is not part of ModelInfo)",
        models.len(),
        priced
    );
    report.check(id, "models", !models.is_empty(), "");

    let model = match model_arg {
        Some(m) => m.to_string(),
        None => pick_model(id, &models),
    };
    println!("  model: {model}");

    // (b) streaming
    let t0 = Instant::now();
    let req = request(
        &model,
        "Reply with one short sentence about the sea.",
        vec![],
        None,
    );
    match adapter
        .stream_chat(req, ctx.clone(), CancellationToken::new())
        .await
    {
        Err(e) => report.check(id, "stream", false, &redact(&e.message, key)),
        Ok(mut stream) => {
            let mut text = String::new();
            let mut reasoning = false;
            let mut first: Option<Duration> = None;
            let mut usage = None;
            let mut complete = None;
            let mut error = None;
            let drained = tokio::time::timeout(STREAM_TIMEOUT, async {
                while let Some(ev) = stream.next().await {
                    match ev {
                        ProviderEvent::ContentDelta { content, .. } => {
                            first.get_or_insert_with(|| t0.elapsed());
                            text.push_str(&content);
                        }
                        ProviderEvent::ReasoningDelta { .. } => {
                            first.get_or_insert_with(|| t0.elapsed());
                            reasoning = true;
                        }
                        ProviderEvent::Usage { usage: u, .. } => usage = Some(u),
                        ProviderEvent::MessageComplete { finish_reason, .. } => {
                            complete = Some(finish_reason)
                        }
                        ProviderEvent::Error { error: e, .. } => error = Some(e.message),
                        _ => {}
                    }
                }
            })
            .await;
            println!("  text: {}", truncate(&redact(&text, key), 120));
            if let Some(u) = &usage {
                println!("  usage: in={:?} out={:?}", u.input_tokens, u.output_tokens);
            } else {
                println!("  usage: not reported");
            }
            match first {
                Some(d) => println!("  time to first token: {} ms", d.as_millis()),
                None => println!("  time to first token: n/a"),
            }
            let ok = drained.is_ok()
                && error.is_none()
                && complete.is_some()
                && (!text.is_empty() || reasoning);
            let detail = if drained.is_err() {
                "timed out".to_string()
            } else if let Some(e) = error {
                redact(&e, key)
            } else if complete.is_none() {
                "no MessageComplete".to_string()
            } else if text.is_empty() && !reasoning {
                "no content".to_string()
            } else {
                format!("finish_reason={}", complete.unwrap_or_default())
            };
            report.check(id, "stream", ok, &detail);
        }
    }

    // (c) cancel mid-stream
    let req = request(
        &model,
        "Write a long story about a lighthouse keeper, at least 500 words.",
        vec![],
        None,
    );
    let cancel = CancellationToken::new();
    match adapter.stream_chat(req, ctx.clone(), cancel.clone()).await {
        Err(e) => report.check(id, "cancel", false, &redact(&e.message, key)),
        Ok(mut stream) => {
            let mut got_delta = false;
            let mut error = None;
            let pre = tokio::time::timeout(STREAM_TIMEOUT, async {
                while let Some(ev) = stream.next().await {
                    match ev {
                        ProviderEvent::ContentDelta { .. }
                        | ProviderEvent::ReasoningDelta { .. } => {
                            got_delta = true;
                            break;
                        }
                        ProviderEvent::Error { error: e, .. } => {
                            error = Some(e.message);
                            break;
                        }
                        _ => {}
                    }
                }
            })
            .await;
            if pre.is_err() || !got_delta {
                let why = match (pre.is_err(), error) {
                    (true, _) => "no delta before timeout".to_string(),
                    (_, Some(e)) => format!("error before cancel: {}", redact(&e, key)),
                    _ => "stream ended before any delta".to_string(),
                };
                report.check(id, "cancel", false, &why);
            } else {
                cancel.cancel();
                let c0 = Instant::now();
                let mut post_error = None;
                let drain = tokio::time::timeout(CANCEL_DRAIN_TIMEOUT, async {
                    while let Some(ev) = stream.next().await {
                        // The transport reports its own cancellation as an
                        // Error("request cancelled") event; that is the clean
                        // signal. Anything else is a real failure.
                        if let ProviderEvent::Error { error: e, .. } = ev {
                            if e.message != "request cancelled" {
                                post_error = Some(e.message);
                            }
                        }
                    }
                })
                .await;
                let ms = c0.elapsed().as_millis();
                let (ok, detail) = if drain.is_err() {
                    (
                        false,
                        "stream still open 10s after cancel (hang)".to_string(),
                    )
                } else if let Some(e) = post_error {
                    (
                        false,
                        format!("error event after cancel: {}", redact(&e, key)),
                    )
                } else {
                    (
                        true,
                        format!("stream ended {ms} ms after cancel, no error event"),
                    )
                };
                report.check(id, "cancel", ok, &detail);
            }
        }
    }

    // (d) tool call round trip
    let tool = ToolDefinition {
        tool_id: "get_weather".into(),
        name: "get_weather".into(),
        description: "Get the current weather for a city.".into(),
        input_schema: json!({
            "type": "object",
            "properties": { "city": { "type": "string" } },
            "required": ["city"]
        }),
        kind: None,
        host_config: None,
        permission_level: None,
        display_group: None,
        tenant_scope: None,
    };
    let user_text = "What is the weather in Paris? Use the get_weather tool.";
    let req = request(
        &model,
        user_text,
        vec![tool.clone()],
        Some(ToolChoice::Required),
    );
    let call = match adapter
        .stream_chat(req, ctx.clone(), CancellationToken::new())
        .await
    {
        Err(e) => {
            report.check(id, "tool call", false, &redact(&e.message, key));
            return;
        }
        Ok(stream) => collect_tool_call(stream, key).await,
    };
    let Some((call_id, args)) = call else {
        report.check(id, "tool call", false, "model made no tool call");
        return;
    };
    println!(
        "  tool call: get_weather {}",
        truncate(&args.to_string(), 80)
    );

    // Send the result back and expect a final text answer.
    let mut call_part = part("a1", 0, MessagePartKind::ToolCall, &args.to_string());
    call_part.tool_call_id = Some(call_id.clone());
    call_part.metadata = Some(json!({ "name": "get_weather" }));
    let mut result_part = part("t1", 0, MessagePartKind::ToolResult, "Sunny, 21 C");
    result_part.tool_call_id = Some(call_id);
    let mut req = request(&model, user_text, vec![tool], None);
    req.messages
        .push(message("a1", MessageRole::Assistant, vec![call_part]));
    req.messages
        .push(message("t1", MessageRole::Tool, vec![result_part]));
    match adapter
        .stream_chat(req, ctx, CancellationToken::new())
        .await
    {
        Err(e) => report.check(id, "tool call", false, &redact(&e.message, key)),
        Ok(mut stream) => {
            let mut text = String::new();
            let mut error = None;
            let mut done = false;
            let r = tokio::time::timeout(STREAM_TIMEOUT, async {
                while let Some(ev) = stream.next().await {
                    match ev {
                        ProviderEvent::ContentDelta { content, .. } => text.push_str(&content),
                        ProviderEvent::MessageComplete { .. } => done = true,
                        ProviderEvent::Error { error: e, .. } => error = Some(e.message),
                        _ => {}
                    }
                }
            })
            .await;
            println!("  tool answer: {}", truncate(&redact(&text, key), 100));
            let ok = r.is_ok() && error.is_none() && done;
            let detail = match (r.is_err(), error) {
                (true, _) => "timed out after tool result".to_string(),
                (_, Some(e)) => redact(&e, key),
                _ if !done => "no MessageComplete after tool result".to_string(),
                _ => String::new(),
            };
            report.check(id, "tool call", ok, &detail);
        }
    }
}

async fn collect_tool_call(
    mut stream: EventStream,
    key: &str,
) -> Option<(String, serde_json::Value)> {
    let mut found = None;
    let _ = tokio::time::timeout(STREAM_TIMEOUT, async {
        while let Some(ev) = stream.next().await {
            match ev {
                ProviderEvent::ToolCallComplete {
                    tool_call_id,
                    arguments,
                    ..
                } if found.is_none() => found = Some((tool_call_id, arguments)),
                ProviderEvent::Error { error, .. } => {
                    println!("  tool request error: {}", redact(&error.message, key));
                }
                _ => {}
            }
        }
    })
    .await;
    found
}

/// Cheapest listed chat-looking model by listed price; the per-provider
/// default when the listing carries no prices.
fn pick_model(provider: &str, models: &[ModelInfo]) -> String {
    let default = default_model(provider);
    let chat = |m: &&ModelInfo| {
        let id = m.id.to_lowercase();
        ![
            "embed",
            "rerank",
            "whisper",
            "tts",
            "guard",
            "image",
            "flux",
            "stable",
            "sdxl",
            "diffusion",
            "moderation",
            "safety",
            "reward",
            "parse",
            "clip",
            "vision",
            "-vl",
            "ocr",
            "audio",
            "speech",
        ]
        .iter()
        .any(|w| id.contains(w))
    };
    let cheapest = models
        .iter()
        .filter(chat)
        .filter_map(|m| m.price.map(|p| (p.input_per_mtok + p.output_per_mtok, m)))
        .filter(|(cost, _)| *cost > 0.0)
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, m)| m.id.clone());
    if let Some(id) = cheapest {
        return id;
    }
    if models.iter().any(|m| m.id == default) || models.is_empty() {
        return default.to_string();
    }
    println!("  note: default {default} not in listing, using first chat-like model");
    models
        .iter()
        .find(chat)
        .map(|m| m.id.clone())
        .unwrap_or_else(|| default.to_string())
}

fn part(msg: &str, index: u32, kind: MessagePartKind, content: &str) -> MessagePart {
    MessagePart {
        id: format!("{msg}-p{index}"),
        message_id: msg.into(),
        index,
        kind,
        content: Some(content.into()),
        mime_type: None,
        tool_call_id: None,
        artifact_id: None,
        attachment_id: None,
        blob_ref: None,
        metadata: None,
        created_at: "2026-01-01T00:00:00Z".into(),
    }
}

fn message(id: &str, role: MessageRole, parts: Vec<MessagePart>) -> Message {
    Message {
        id: id.into(),
        conversation_id: "live-check".into(),
        role,
        author_label: None,
        provider_message_id: None,
        request_id: None,
        interrupted_at: None,
        metadata: None,
        parts,
        created_at: "2026-01-01T00:00:00Z".into(),
    }
}

fn request(
    model: &str,
    user_text: &str,
    tools: Vec<ToolDefinition>,
    tool_choice: Option<ToolChoice>,
) -> ProviderRequest {
    ProviderRequest {
        request_id: "live-check".into(),
        conversation_id: "live-check".into(),
        model_id: model.into(),
        messages: vec![message(
            "u1",
            MessageRole::User,
            vec![part("u1", 0, MessagePartKind::Text, user_text)],
        )],
        system_prompt: None,
        developer_prompt: None,
        attachments: None,
        tool_definitions: tools,
        generation_controls: Some(GenerationControls {
            temperature: None,
            top_p: None,
            max_tokens: Some(MAX_TOKENS),
            stop_sequences: None,
            tool_choice,
            reasoning_effort: None,
            parallel_tool_calls: None,
        }),
        response_format: None,
        web_search: None,
        continue_message_id: None,
    }
}

fn truncate(s: &str, max: usize) -> String {
    let flat = s.replace(['\n', '\r'], " ");
    if flat.chars().count() <= max {
        flat
    } else {
        let cut: String = flat.chars().take(max).collect();
        format!("{cut}...")
    }
}

/// Remove the exact key and anything that looks like a bearer token.
fn redact(s: &str, key: &str) -> String {
    let mut out = if key.is_empty() {
        s.to_string()
    } else {
        s.replace(key, "[redacted]")
    };
    let looks_like_key = |w: &str| {
        let w = w.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_');
        w.len() >= 20
            && w.chars().any(|c| c.is_ascii_digit())
            && w.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            && (w.starts_with("sk-")
                || w.starts_with("nvapi-")
                || w.starts_with("csk-")
                || w.starts_with("eyJ")
                || w.starts_with("sk_")
                || w.starts_with("key_")
                || w.len() >= 32)
    };
    let words: Vec<String> = out
        .split(' ')
        .map(|w| {
            if looks_like_key(w) {
                "[redacted]".to_string()
            } else {
                w.to_string()
            }
        })
        .collect();
    out = words.join(" ");
    out
}

fn load_env_file() -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(path) = std::env::var("CONDUIT_LIVE_KEYS_FILE") else {
        return map;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return map;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let v = v.trim().trim_matches(|c| c == '"' || c == '\'');
        if !v.is_empty() {
            map.insert(k.trim().to_string(), v.to_string());
        }
    }
    map
}
