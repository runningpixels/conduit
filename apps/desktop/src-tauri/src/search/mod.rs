//! Pluggable local `web_search` backends (t0-7).
//!
//! Hosted search (OpenAI / Gemini / Anthropic) is adapter-owned. This module
//! only runs when the turn resolved to the local builtin. Result rows keep the
//! `{title, snippet, url}` contract the model already sees.

use provider_core::schema::LocalSearchBackend;
use serde_json::{json, Value};

pub const SEARCH_TAVILY_CREDENTIAL_ID: &str = "search/tavily";
pub const SEARCH_BRAVE_CREDENTIAL_ID: &str = "search/brave";
pub const SEARCH_SEARXNG_CREDENTIAL_ID: &str = "search/searxng";

const MAX_RESULTS: usize = 10;
const REQUEST_TIMEOUT_SECS: u64 = 15;
const USER_AGENT: &str = "Conduit/1.0";

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
        LocalSearchBackend::Tavily => Some(SEARCH_TAVILY_CREDENTIAL_ID),
        LocalSearchBackend::Brave => Some(SEARCH_BRAVE_CREDENTIAL_ID),
        LocalSearchBackend::Searxng => Some(SEARCH_SEARXNG_CREDENTIAL_ID),
    }
}

pub fn empty_note(backend: LocalSearchBackend) -> &'static str {
    match backend {
        LocalSearchBackend::Duckduckgo => EMPTY_INSTANT_ANSWER_NOTE,
        LocalSearchBackend::Tavily | LocalSearchBackend::Brave | LocalSearchBackend::Searxng => {
            EMPTY_LIVE_SEARCH_NOTE
        }
    }
}

pub async fn search(config: &LocalSearchConfig, query: &str) -> Result<Vec<Value>, String> {
    match config.backend {
        LocalSearchBackend::Duckduckgo => duckduckgo_search(query).await,
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
            "{label} API key is not set. Add it in Settings → Web search, or switch the local backend to DuckDuckGo."
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
        .header("User-Agent", USER_AGENT)
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

async fn tavily_search(query: &str, api_key: &str) -> Result<Vec<Value>, String> {
    let resp = http_client()?
        .post("https://api.tavily.com/search")
        .header("User-Agent", USER_AGENT)
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
        .header("User-Agent", USER_AGENT)
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
        .header("User-Agent", USER_AGENT)
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
        assert!(err.contains("DuckDuckGo"));
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
    }
}
