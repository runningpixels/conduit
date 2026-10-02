//! Official MCP registry client (`registry.modelcontextprotocol.io`).
//!
//! Read-only. Search results are filtered to remote servers; a server is
//! installable when it publishes at least one `streamable-http` remote.
//! SSE-only remotes are returned with a clear "needs streamable HTTP" reason
//! so the UI can refuse one-click install instead of silently failing later.

use serde::{Deserialize, Serialize};

pub const REGISTRY_BASE: &str = "https://registry.modelcontextprotocol.io";

/// A search is tried this many times before the error reaches the reader.
const REGISTRY_ATTEMPTS: u32 = 2;
const REGISTRY_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(600);

/// Statuses worth one more try: the registry is busy or briefly down.
fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryServer {
    pub name: String,
    pub title: Option<String>,
    pub description: String,
    pub version: String,
    pub remote_url: Option<String>,
    pub remote_type: Option<String>,
    pub installable: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RegistryList {
    #[serde(default)]
    servers: Vec<RegistryListItem>,
}

#[derive(Debug, Deserialize)]
struct RegistryListItem {
    server: RegistryServerJson,
}

#[derive(Debug, Deserialize)]
struct RegistryServerJson {
    name: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    remotes: Vec<RegistryRemote>,
}

#[derive(Debug, Deserialize)]
struct RegistryRemote {
    #[serde(rename = "type")]
    transport: String,
    url: String,
}

pub async fn search_official_registry(query: &str) -> Result<Vec<RegistryServer>, String> {
    search_registry_at(REGISTRY_BASE, query).await
}

async fn search_registry_at(base: &str, query: &str) -> Result<Vec<RegistryServer>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Conduit-MCP/0.1")
        .build()
        .map_err(|e| format!("http client error: {e}"))?;
    let mut url = url::Url::parse(&format!("{base}/v0.1/servers"))
        .map_err(|e| format!("invalid registry URL: {e}"))?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("version", "latest");
        q.append_pair("limit", "30");
        let trimmed = query.trim();
        if !trimmed.is_empty() {
            q.append_pair("search", trimmed);
        }
    }
    // The first request of a session can fail on a cold connection (seen live:
    // the search failed once and worked when repeated), so a network error,
    // a timeout, 429 or a 5xx gets one more try before the reader sees it.
    let mut attempt = 0;
    let resp = loop {
        attempt += 1;
        let last = attempt >= REGISTRY_ATTEMPTS;
        match client.get(url.clone()).send().await {
            Ok(resp) if is_retryable_status(resp.status()) && !last => {}
            Ok(resp) => break resp,
            Err(e) if !last && (e.is_connect() || e.is_timeout() || e.is_request()) => {}
            Err(e) => return Err(format!("registry request failed: {e}")),
        }
        tokio::time::sleep(REGISTRY_RETRY_DELAY).await;
    };
    if !resp.status().is_success() {
        return Err(format!("registry returned HTTP {}", resp.status()));
    }
    let list: RegistryList = resp
        .json()
        .await
        .map_err(|e| format!("registry response was not JSON: {e}"))?;
    Ok(list
        .servers
        .into_iter()
        .map(|item| summarize_server(item.server))
        .filter(|s| s.remote_type.is_some())
        .collect())
}

pub fn summarize_server(server: impl Into<SummarizeInput>) -> RegistryServer {
    let server = server.into();
    summarize(server)
}

/// Test-friendly input that mirrors the registry `server` object.
pub struct SummarizeInput {
    pub name: String,
    pub title: Option<String>,
    pub description: String,
    pub version: String,
    pub remotes: Vec<(String, String)>,
}

impl From<RegistryServerJson> for SummarizeInput {
    fn from(s: RegistryServerJson) -> Self {
        Self {
            name: s.name,
            title: s.title,
            description: s.description,
            version: s.version,
            remotes: s
                .remotes
                .into_iter()
                .map(|r| (r.transport, r.url))
                .collect(),
        }
    }
}

fn summarize(server: SummarizeInput) -> RegistryServer {
    let http = server
        .remotes
        .iter()
        .find(|(kind, _)| kind.eq_ignore_ascii_case("streamable-http"));
    let sse_only = http.is_none()
        && server
            .remotes
            .iter()
            .any(|(kind, _)| kind.eq_ignore_ascii_case("sse"));
    if let Some((_, url)) = http {
        RegistryServer {
            name: server.name,
            title: server.title,
            description: server.description,
            version: server.version,
            remote_url: Some(url.clone()),
            remote_type: Some("streamable-http".into()),
            installable: true,
            reason: None,
        }
    } else if sse_only {
        RegistryServer {
            name: server.name,
            title: server.title,
            description: server.description,
            version: server.version,
            remote_url: server.remotes.first().map(|(_, u)| u.clone()),
            remote_type: Some("sse".into()),
            installable: false,
            reason: Some("server needs streamable HTTP (legacy HTTP+SSE is not supported)".into()),
        }
    } else {
        RegistryServer {
            name: server.name,
            title: server.title,
            description: server.description,
            version: server.version,
            remote_url: None,
            remote_type: None,
            installable: false,
            reason: Some("no remote streamable-HTTP endpoint in the registry entry".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A local registry that answers each request with the next status in
    /// `statuses` (a 200 carries one installable server).
    async fn registry_with(
        statuses: Vec<u16>,
    ) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            for status in statuses {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let body = if status == 200 {
                    r#"{"servers":[{"server":{"name":"io.example/demo","description":"d","version":"1","remotes":[{"type":"streamable-http","url":"https://example.com/mcp"}]}}]}"#
                } else {
                    "busy"
                };
                let reply = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(reply.as_bytes()).await;
            }
        });
        (base, hits)
    }

    #[tokio::test]
    async fn search_retries_once_after_a_server_error() {
        let (base, hits) = registry_with(vec![503, 200]).await;
        let rows = search_registry_at(&base, "demo")
            .await
            .expect("second try succeeds");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "io.example/demo");
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn search_gives_up_after_the_second_failure() {
        let (base, hits) = registry_with(vec![503, 503, 200]).await;
        let err = search_registry_at(&base, "demo")
            .await
            .expect_err("both tries fail");
        assert!(err.contains("503"), "got {err}");
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn search_does_not_retry_a_client_error() {
        let (base, hits) = registry_with(vec![404, 200]).await;
        let err = search_registry_at(&base, "demo")
            .await
            .expect_err("404 is final");
        assert!(err.contains("404"), "got {err}");
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn prefers_streamable_http_remote() {
        let row = summarize(SummarizeInput {
            name: "com.example/acme".into(),
            title: Some("ACME".into()),
            description: "demo".into(),
            version: "1.0.0".into(),
            remotes: vec![
                ("sse".into(), "https://example.com/sse".into()),
                ("streamable-http".into(), "https://example.com/mcp".into()),
            ],
        });
        assert!(row.installable);
        assert_eq!(row.remote_url.as_deref(), Some("https://example.com/mcp"));
    }

    #[test]
    fn sse_only_is_not_installable() {
        let row = summarize(SummarizeInput {
            name: "com.example/old".into(),
            title: None,
            description: "legacy".into(),
            version: "0.1.0".into(),
            remotes: vec![("sse".into(), "https://example.com/sse".into())],
        });
        assert!(!row.installable);
        assert!(row.reason.unwrap().contains("needs streamable HTTP"));
    }
}
