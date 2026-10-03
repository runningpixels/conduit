//! Pluggable local `web_search` backends (t0-7).
//!
//! Hosted search (OpenAI / Gemini / Anthropic) is adapter-owned. This module
//! only runs when the turn resolved to the local builtin. Result rows keep the
//! `{title, snippet, url}` contract the model already sees.

use provider_core::schema::LocalSearchBackend;
use serde_json::{json, Value};

pub const SEARCH_EXA_CREDENTIAL_ID: &str = "search/exa";
pub const SEARCH_TAVILY_CREDENTIAL_ID: &str = "search/tavily";
pub const SEARCH_BRAVE_CREDENTIAL_ID: &str = "search/brave";
pub const SEARCH_SEARXNG_CREDENTIAL_ID: &str = "search/searxng";

const MAX_RESULTS: usize = 10;

/// Exa's hosted MCP server. Keyless use is free and rate-limited; an Exa key
/// (sent as `x-api-key`) raises the limits.
pub const EXA_MCP_URL: &str = "https://mcp.exa.ai/mcp";
const EXA_PROTOCOL_VERSION: &str = "2025-03-26";
/// Longest snippet kept per Exa result; its highlights can run to pages.
const EXA_SNIPPET_CHARS: usize = 600;
const REQUEST_TIMEOUT_SECS: u64 = 15;

fn user_agent() -> String {
    format!("{}/1.0", crate::brand::app_name())
}

/// Guidance when Instant Answer returns nothing. Without this, models treat
/// empty `results` as "try another query" and binge until max_steps.
pub const EMPTY_INSTANT_ANSWER_NOTE: &str = "DuckDuckGo Instant Answer returned no hits. This backend is encyclopedic Instant Answer, not a live news index. Do not retry with similar queries; answer from what you know or tell the user local search cannot find live headlines.";

const EMPTY_LIVE_SEARCH_NOTE: &str = "Local web search returned no hits. Do not retry with similar queries; answer from what you know or tell the user search found nothing.";

/// Runtime config for one local search call. Keys are loaded from the
/// credential store by the stream manager — never from settings.json.
#[derive(Debug, Clone, Default)]
pub struct LocalSearchConfig {
    pub backend: LocalSearchBackend,
    pub api_key: Option<String>,
    pub searxng_base_url: Option<String>,
}

pub fn credential_id(backend: LocalSearchBackend) -> Option<&'static str> {
    match backend {
        LocalSearchBackend::Duckduckgo => None,
        LocalSearchBackend::Exa => Some(SEARCH_EXA_CREDENTIAL_ID),
        LocalSearchBackend::Tavily => Some(SEARCH_TAVILY_CREDENTIAL_ID),
        LocalSearchBackend::Brave => Some(SEARCH_BRAVE_CREDENTIAL_ID),
        LocalSearchBackend::Searxng => Some(SEARCH_SEARXNG_CREDENTIAL_ID),
    }
}

pub fn empty_note(backend: LocalSearchBackend) -> &'static str {
    match backend {
        LocalSearchBackend::Duckduckgo => EMPTY_INSTANT_ANSWER_NOTE,
        LocalSearchBackend::Exa
        | LocalSearchBackend::Tavily
        | LocalSearchBackend::Brave
        | LocalSearchBackend::Searxng => EMPTY_LIVE_SEARCH_NOTE,
    }
}

pub async fn search(config: &LocalSearchConfig, query: &str) -> Result<Vec<Value>, String> {
    match config.backend {
        LocalSearchBackend::Duckduckgo => duckduckgo_search(query).await,
        // The key is optional: without one, Exa's free, rate-limited tier answers.
        LocalSearchBackend::Exa => {
            let key = config
                .api_key
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            exa_search(EXA_MCP_URL, query, key).await
        }
        LocalSearchBackend::Tavily => {
            let key = require_key("Tavily", config.api_key.as_deref())?;
            tavily_search(query, key).await
        }
        LocalSearchBackend::Brave => {
            let key = require_key("Brave Search", config.api_key.as_deref())?;
            brave_search(query, key).await
        }
        LocalSearchBackend::Searxng => {
            let base = config
                .searxng_base_url
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    "SearXNG base URL is not set. Add it in Settings → Web search.".to_string()
                })?;
            searxng_search(query, base, config.api_key.as_deref()).await
        }
    }
}

fn require_key<'a>(label: &str, key: Option<&'a str>) -> Result<&'a str, String> {
    match key.map(str::trim).filter(|s| !s.is_empty()) {
        Some(key) => Ok(key),
        None => Err(format!(
            "{label} API key is not set. Add it in Settings → Web search, or switch the local backend to Exa, which needs no key."
        )),
    }
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("http client error: {e}"))
}

fn clamp_results(mut results: Vec<Value>) -> Vec<Value> {
    results.truncate(MAX_RESULTS);
    results
}

fn hit(title: impl Into<String>, snippet: impl Into<String>, url: impl Into<String>) -> Value {
    json!({
        "title": title.into(),
        "snippet": snippet.into(),
        "url": url.into(),
    })
}

fn json_string<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(|v| v.as_str()))
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

pub fn urlencoding(s: &str) -> String {
    let mut encoded = String::new();
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            b' ' => encoded.push_str("%20"),
            _ => encoded.push_str(&format!("%{:02X}", byte)),
        }
    }
    encoded
}

async fn duckduckgo_search(query: &str) -> Result<Vec<Value>, String> {
    let url = format!(
        "https://api.duckduckgo.com/?q={}&format=json&no_html=1&skip_disambig=1",
        urlencoding(query)
    );
    let resp = http_client()?
        .get(&url)
        .header("User-Agent", user_agent())
        .send()
        .await
        .map_err(|e| format!("search request failed: {e}"))?;
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("search response parse failed: {e}"))?;
    Ok(clamp_results(parse_duckduckgo_instant_answer(&body)))
}

/// Parse a DuckDuckGo Instant Answer JSON body into title/snippet/url rows.
pub fn parse_duckduckgo_instant_answer(body: &Value) -> Vec<Value> {
    let mut results = Vec::new();

    if let Some(answer) = body.get("AbstractText").and_then(|v| v.as_str()) {
        if !answer.is_empty() {
            let source = body
                .get("AbstractSource")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let url = body
                .get("AbstractURL")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            results.push(hit(source, answer, url));
        }
    }

    if let Some(topics) = body.get("RelatedTopics").and_then(|v| v.as_array()) {
        for topic in topics {
            if let Some(text) = topic.get("Text").and_then(|v| v.as_str()) {
                let url = topic.get("FirstURL").and_then(|v| v.as_str()).unwrap_or("");
                results.push(hit(url, text, url));
            }
            if let Some(subs) = topic.get("Topics").and_then(|v| v.as_array()) {
                for sub in subs {
                    if let Some(text) = sub.get("Text").and_then(|v| v.as_str()) {
                        let url = sub.get("FirstURL").and_then(|v| v.as_str()).unwrap_or("");
                        results.push(hit(url, text, url));
                    }
                }
            }
        }
    }

    if results.is_empty() {
        if let Some(abstract_text) = body.get("Abstract").and_then(|v| v.as_str()) {
            if !abstract_text.is_empty() {
                results.push(hit("Result", abstract_text, ""));
            }
        }
    }

    results
}

pub fn parse_tavily_search(body: &Value) -> Result<Vec<Value>, String> {
    let rows = body
        .get("results")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Tavily response did not contain a results array".to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let url = json_string(row, &["url", "link"]).unwrap_or("");
        let title = json_string(row, &["title", "name"]).unwrap_or(url);
        let snippet = json_string(row, &["content", "snippet", "description"]).unwrap_or("");
        if title.is_empty() && snippet.is_empty() && url.is_empty() {
            continue;
        }
        out.push(hit(title, snippet, url));
    }
    Ok(clamp_results(out))
}

/// One JSON-RPC exchange with an MCP server over Streamable HTTP. Returns the
/// session id the server assigned (if any) and the response message (`None`
/// for a notification). The reply may be plain JSON or an SSE stream.
async fn mcp_post(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: Option<&str>,
    session: Option<&str>,
    message: &Value,
) -> Result<(Option<String>, Option<Value>), String> {
    let mut req = client
        .post(endpoint)
        .header("User-Agent", user_agent())
        .header("Accept", "application/json, text/event-stream")
        .header("Content-Type", "application/json")
        .header("MCP-Protocol-Version", EXA_PROTOCOL_VERSION);
    if let Some(key) = api_key {
        req = req.header("x-api-key", key);
    }
    if let Some(session) = session {
        req = req.header("Mcp-Session-Id", session);
    }
    let resp = req
        .body(message.to_string())
        .send()
        .await
        .map_err(|e| format!("search request failed: {e}"))?;
    let status = resp.status();
    let session = resp
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let text = resp
        .text()
        .await
        .map_err(|e| format!("search response read failed: {e}"))?;
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(if api_key.is_some() {
            "Exa search hit its rate limit. Try again in a minute.".to_string()
        } else {
            "Exa's free search is busy (rate limit). Try again in a minute, or add a free Exa key in Settings → Web search for higher limits.".to_string()
        });
    }
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(
            "Exa rejected the API key. Check it in Settings → Web search, or remove it to use Exa's free tier."
                .to_string(),
        );
    }
    if !status.is_success() {
        return Err(format!("Exa HTTP {status}"));
    }
    if message.get("id").is_none() {
        return Ok((session, None));
    }
    Ok((session, Some(parse_mcp_reply(&text)?)))
}

/// The JSON-RPC response in a reply body: plain JSON, or the `data:` lines of
/// an SSE stream (the first message carrying a result or an error).
pub fn parse_mcp_reply(body: &str) -> Result<Value, String> {
    let trimmed = body.trim();
    if trimmed.starts_with('{') {
        return serde_json::from_str(trimmed)
            .map_err(|e| format!("search response parse failed: {e}"));
    }
    for line in trimmed.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        if let Ok(msg) = serde_json::from_str::<Value>(data.trim()) {
            if msg.get("result").is_some() || msg.get("error").is_some() {
                return Ok(msg);
            }
        }
    }
    Err("search response parse failed: no JSON-RPC message in the reply".to_string())
}

async fn exa_search(
    endpoint: &str,
    query: &str,
    api_key: Option<&str>,
) -> Result<Vec<Value>, String> {
    let client = http_client()?;
    let (session, init) = mcp_post(
        &client,
        endpoint,
        api_key,
        None,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": EXA_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": crate::brand::app_name(), "version": env!("CARGO_PKG_VERSION") },
            },
        }),
    )
    .await?;
    if let Some(err) = init.as_ref().and_then(|m| m.get("error")) {
        return Err(format!(
            "Exa search could not start: {}",
            rpc_error_message(err)
        ));
    }
    let session = session.as_deref();
    mcp_post(
        &client,
        endpoint,
        api_key,
        session,
        &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    )
    .await?;
    let (_, reply) = mcp_post(
        &client,
        endpoint,
        api_key,
        session,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "web_search_exa",
                "arguments": { "query": query, "numResults": MAX_RESULTS },
            },
        }),
    )
    .await?;
    let reply = reply.unwrap_or(Value::Null);
    if let Some(err) = reply.get("error") {
        return Err(format!("Exa search failed: {}", rpc_error_message(err)));
    }
    let result = reply.get("result").cloned().unwrap_or(Value::Null);
    let text = result
        .get("content")
        .and_then(|c| c.as_array())
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n\n---\n\n")
        })
        .unwrap_or_default();
    if result.get("isError").and_then(|v| v.as_bool()) == Some(true) {
        let detail: String = text.chars().take(300).collect();
        return Err(format!("Exa search failed: {detail}"));
    }
    Ok(parse_exa_results(&text))
}

fn rpc_error_message(err: &Value) -> String {
    err.get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("unknown error")
        .to_string()
}

/// Exa's search tool answers in text: one block per result, separated by a
/// `---` line, each with `Title:`, `URL:`, `Published:` and `Author:` lines,
/// then `Highlights:` (or `Text:` / `Summary:`) followed by the excerpt.
pub fn parse_exa_results(text: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for block in text.split("\n---\n") {
        let mut title = "";
        let mut url = "";
        let mut body: Vec<&str> = Vec::new();
        let mut in_body = false;
        for line in block.lines() {
            let trimmed = line.trim();
            if in_body {
                // Exa marks elided spans with a bare "..." line.
                if trimmed != "..." && !trimmed.is_empty() {
                    body.push(trimmed);
                }
                continue;
            }
            if let Some(v) = trimmed.strip_prefix("Title:") {
                title = v.trim();
            } else if let Some(v) = trimmed.strip_prefix("URL:") {
                url = v.trim();
            } else if let Some(v) = ["Highlights:", "Text:", "Summary:"]
                .iter()
                .find_map(|k| trimmed.strip_prefix(k))
            {
                in_body = true;
                if !v.trim().is_empty() {
                    body.push(v.trim());
                }
            }
        }
        if url.is_empty() {
            continue;
        }
        let joined = body.join(" ");
        let snippet: String = joined.chars().take(EXA_SNIPPET_CHARS).collect();
        out.push(hit(
            if title.is_empty() { url } else { title },
            snippet,
            url,
        ));
    }
    clamp_results(out)
}

async fn tavily_search(query: &str, api_key: &str) -> Result<Vec<Value>, String> {
    let resp = http_client()?
        .post("https://api.tavily.com/search")
        .header("User-Agent", user_agent())
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&json!({
            "query": query,
            "max_results": MAX_RESULTS,
        }))
        .send()
        .await
        .map_err(|e| format!("search request failed: {e}"))?;
    let status = resp.status();
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("search response parse failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("Tavily HTTP {status}"));
    }
    parse_tavily_search(&body)
}

pub fn parse_brave_search(body: &Value) -> Result<Vec<Value>, String> {
    let rows = body
        .pointer("/web/results")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Brave response did not contain web.results".to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let url = json_string(row, &["url", "link"]).unwrap_or("");
        let title = json_string(row, &["title", "name"]).unwrap_or(url);
        let snippet = json_string(row, &["description", "snippet", "content"]).unwrap_or("");
        if title.is_empty() && snippet.is_empty() && url.is_empty() {
            continue;
        }
        out.push(hit(title, snippet, url));
    }
    Ok(clamp_results(out))
}

async fn brave_search(query: &str, api_key: &str) -> Result<Vec<Value>, String> {
    let url = format!(
        "https://api.search.brave.com/res/v1/web/search?q={}&count={MAX_RESULTS}",
        urlencoding(query)
    );
    let resp = http_client()?
        .get(&url)
        .header("User-Agent", user_agent())
        .header("Accept", "application/json")
        .header("X-Subscription-Token", api_key)
        .send()
        .await
        .map_err(|e| format!("search request failed: {e}"))?;
    let status = resp.status();
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("search response parse failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("Brave Search HTTP {status}"));
    }
    parse_brave_search(&body)
}

pub fn parse_searxng_search(body: &Value) -> Result<Vec<Value>, String> {
    let rows = body
        .get("results")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            "SearXNG instance did not return JSON results; enable format=json on the instance"
                .to_string()
        })?;
    let mut out = Vec::new();
    for row in rows {
        let url = json_string(row, &["url", "link"]).unwrap_or("");
        let title = json_string(row, &["title", "name"]).unwrap_or(url);
        let snippet = json_string(row, &["content", "snippet", "description"]).unwrap_or("");
        if title.is_empty() && snippet.is_empty() && url.is_empty() {
            continue;
        }
        out.push(hit(title, snippet, url));
    }
    Ok(clamp_results(out))
}

async fn searxng_search(
    query: &str,
    base_url: &str,
    api_key: Option<&str>,
) -> Result<Vec<Value>, String> {
    let base = base_url.trim().trim_end_matches('/');
    let url = format!("{base}/search?q={}&format=json", urlencoding(query));
    let mut req = http_client()?
        .get(&url)
        .header("User-Agent", user_agent())
        .header("Accept", "application/json");
    if let Some(key) = api_key.map(str::trim).filter(|s| !s.is_empty()) {
        req = req.header("Authorization", format!("Bearer {key}"));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("search request failed: {e}"))?;
    let status = resp.status();
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("SearXNG instance did not return JSON; enable format=json ({e})"))?;
    if !status.is_success() {
        return Err(format!("SearXNG HTTP {status}"));
    }
    parse_searxng_search(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tavily_without_key_errors() {
        let err = require_key("Tavily", None).unwrap_err();
        assert!(err.contains("Tavily"));
        assert!(err.contains("Exa"));
    }

    #[test]
    fn parses_tavily_results_and_clamps() {
        let mut rows = Vec::new();
        for i in 0..12 {
            rows.push(json!({
                "title": format!("T{i}"),
                "url": format!("https://example.com/{i}"),
                "content": format!("snippet {i}"),
            }));
        }
        let out = parse_tavily_search(&json!({ "results": rows })).unwrap();
        assert_eq!(out.len(), 10);
        assert_eq!(out[0]["title"], "T0");
        assert_eq!(out[0]["snippet"], "snippet 0");
    }

    #[test]
    fn parses_brave_web_results() {
        let body = json!({
            "web": {
                "results": [
                    {
                        "title": "Brave",
                        "url": "https://search.brave.com",
                        "description": "Independent search"
                    }
                ]
            }
        });
        let out = parse_brave_search(&body).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["title"], "Brave");
        assert_eq!(out[0]["snippet"], "Independent search");
    }

    #[test]
    fn parses_searxng_results() {
        let body = json!({
            "results": [
                {
                    "title": "Self-hosted",
                    "url": "https://searx.example",
                    "content": "metasearch"
                }
            ]
        });
        let out = parse_searxng_search(&body).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["url"], "https://searx.example");
    }

    #[test]
    fn searxng_missing_results_array_is_an_error() {
        let err = parse_searxng_search(&json!({ "query": "x" })).unwrap_err();
        assert!(err.contains("format=json"));
    }

    #[test]
    fn credential_ids_are_namespaced() {
        assert_eq!(
            credential_id(LocalSearchBackend::Tavily),
            Some("search/tavily")
        );
        assert_eq!(credential_id(LocalSearchBackend::Duckduckgo), None);
        assert_eq!(credential_id(LocalSearchBackend::Exa), Some("search/exa"));
    }

    // The shape of a live `web_search_exa` reply (2026-10-02), trimmed.
    const EXA_SAMPLE: &str = "Title: tauri | Tauri\nURL: https://v2.tauri.app/release/tauri/\nPublished: N/A\nAuthor: N/A\nHighlights:\n### 2.12.0\n\nSep 26, 2026\n\n##### New Features\n...\n- Upgraded to `tauri-utils@2.10.0`\n\n---\n\nTitle: Tauri Ecosystem Releases\nURL: https://v2.tauri.app/release/\nPublished: N/A\nAuthor: N/A\nHighlights:\nRelease notes for every package in the Tauri core ecosystem.\n\n---\n\nTitle: no url here\nHighlights:\nignored";

    #[test]
    fn parses_exa_text_results() {
        let rows = parse_exa_results(EXA_SAMPLE);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["title"], "tauri | Tauri");
        assert_eq!(rows[0]["url"], "https://v2.tauri.app/release/tauri/");
        let snippet = rows[0]["snippet"].as_str().unwrap();
        assert!(snippet.starts_with("### 2.12.0 Sep 26, 2026"), "{snippet}");
        assert!(!snippet.contains("..."), "{snippet}");
        assert_eq!(
            rows[1]["snippet"],
            "Release notes for every package in the Tauri core ecosystem."
        );
    }

    #[test]
    fn exa_snippets_are_capped() {
        let long = format!(
            "Title: T\nURL: https://e.com\nHighlights:\n{}",
            "word ".repeat(400)
        );
        let rows = parse_exa_results(&long);
        assert_eq!(
            rows[0]["snippet"].as_str().unwrap().chars().count(),
            EXA_SNIPPET_CHARS
        );
    }

    #[test]
    fn reads_an_mcp_reply_from_sse_or_json() {
        let sse =
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"content\":[]}}\n\n";
        assert!(parse_mcp_reply(sse).unwrap().get("result").is_some());
        let json = "{\"jsonrpc\":\"2.0\",\"id\":2,\"error\":{\"code\":-1,\"message\":\"nope\"}}";
        assert_eq!(parse_mcp_reply(json).unwrap()["error"]["message"], "nope");
        assert!(parse_mcp_reply("event: ping\n\n").is_err());
    }

    /// Live check against Exa's keyless endpoint. Needs the network:
    /// `cargo test --lib live_exa_search -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_exa_search() {
        let rows = exa_search(EXA_MCP_URL, "Tauri 2 release notes", None)
            .await
            .expect("keyless Exa search");
        assert!(!rows.is_empty());
        assert!(rows[0]["url"].as_str().unwrap().starts_with("http"));
        eprintln!("{}", serde_json::to_string_pretty(&rows[0]).unwrap());
    }

    #[test]
    fn exa_is_the_default_backend() {
        assert_eq!(LocalSearchBackend::default(), LocalSearchBackend::Exa);
    }
}
