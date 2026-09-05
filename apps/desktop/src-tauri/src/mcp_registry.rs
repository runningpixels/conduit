//! Official MCP registry client (`registry.modelcontextprotocol.io`).
//!
//! Read-only. Search results are filtered to remote servers; a server is
//! installable when it publishes at least one `streamable-http` remote.
//! SSE-only remotes are returned with a clear "needs streamable HTTP" reason
//! so the UI can refuse one-click install instead of silently failing later.

use serde::{Deserialize, Serialize};

pub const REGISTRY_BASE: &str = "https://registry.modelcontextprotocol.io";

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
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Conduit-MCP/0.1")
        .build()
        .map_err(|e| format!("http client error: {e}"))?;
    let mut url = url::Url::parse(&format!("{REGISTRY_BASE}/v0.1/servers"))
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
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("registry request failed: {e}"))?;
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
