//! MCP OAuth 2.1 for remote streamable-HTTP connectors.
//!
//! Discovery follows RFC 9728 Protected Resource Metadata, then RFC 8414 /
//! OIDC discovery for the authorization server. Client registration is CIMD
//! (`https://conduitllm.com/oauth/client-metadata.json`) — DCR is not used.
//!
//! The authorization code lands on a loopback HTTP server (`127.0.0.1` only).
//! Tokens are stored in the OS keychain (or the file backend) and never
//! cross into the renderer. Refresh happens here, on the next start.

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::timeout;

use crate::credentials::CredentialStore;
use crate::db::repository::connectors::ConnectorGrant;
use crate::state::AppState;

/// Hosted Client ID Metadata Document. Authorization servers fetch this URL
/// when they see it as `client_id`.
pub const CIMD_CLIENT_ID: &str = "https://conduitllm.com/oauth/client-metadata.json";

/// Loopback ports listed in the CIMD `redirect_uris` array. We bind the first
/// free port in this range so the redirect_uri is an exact match.
pub const LOOPBACK_PORTS: [u16; 10] = [
    19876, 19877, 19878, 19879, 19880, 19881, 19882, 19883, 19884, 19885,
];

const CALLBACK_PATH: &str = "/oauth/callback";
const AUTH_WAIT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredToken {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
}

impl StoredToken {
    fn expired(&self) -> bool {
        let Some(exp) = self.expires_at else {
            return false;
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        now + 30 >= exp
    }
}

pub fn keychain_account(connector_version_id: &str) -> String {
    format!("mcp:{connector_version_id}")
}

/// Load (and refresh if needed) a bearer token for the active grant.
pub async fn access_token_for_grants(
    state: &AppState,
    grants: &[ConnectorGrant],
    connector_version_id: &str,
) -> Result<Option<String>, String> {
    let grant = grants.iter().find(|g| g.status == "active");
    let Some(grant) = grant else {
        return Ok(None);
    };
    let Some(cred_ref) = grant.credential_ref.as_deref() else {
        return Ok(None);
    };
    if cred_ref.is_empty() {
        return Ok(None);
    }
    let store = state.credential_store();
    let account = keychain_account(connector_version_id);
    load_or_refresh_token(&store, &account).await
}

async fn load_or_refresh_token(
    store: &CredentialStore,
    account: &str,
) -> Result<Option<String>, String> {
    let Ok(raw) = store.get_secret(account) else {
        return Ok(None);
    };
    let mut token = parse_stored_token(&raw)?;
    if token.expired() {
        if token.refresh_token.is_some() {
            token = refresh_token(&token).await?;
            save_token(store, account, &token)?;
        } else {
            return Err("MCP connector token expired; sign in again".to_string());
        }
    }
    if token.access_token.is_empty() {
        return Ok(None);
    }
    Ok(Some(token.access_token))
}

fn parse_stored_token(raw: &str) -> Result<StoredToken, String> {
    let trimmed = raw.trim();
    if trimmed.starts_with('{') {
        serde_json::from_str(trimmed).map_err(|e| format!("invalid MCP token blob: {e}"))
    } else {
        Ok(StoredToken {
            access_token: trimmed.to_string(),
            refresh_token: None,
            expires_at: None,
            token_endpoint: None,
            client_id: None,
            resource: None,
        })
    }
}

fn save_token(
    store: &CredentialStore,
    account: &str,
    token: &StoredToken,
) -> Result<String, String> {
    let blob = serde_json::to_string(token).map_err(|e| e.to_string())?;
    let summary = store.save_provider_secret(account, &blob)?;
    Ok(summary.credential_ref)
}

pub fn persist_token(
    state: &AppState,
    connector_version_id: &str,
    token: &StoredToken,
) -> Result<String, String> {
    save_token(
        &state.credential_store(),
        &keychain_account(connector_version_id),
        token,
    )
}

/// Run CIMD + PKCE against the MCP server's authorization server.
pub async fn authorize_connector(
    mcp_url: &str,
    www_authenticate: Option<&str>,
    open_browser: impl FnOnce(&str) -> Result<(), String>,
) -> Result<StoredToken, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client error: {e}"))?;
    let prm = discover_protected_resource(&client, mcp_url, www_authenticate).await?;
    let issuer = prm
        .authorization_servers
        .first()
        .cloned()
        .ok_or_else(|| "MCP server metadata listed no authorization servers".to_string())?;
    let as_meta = discover_authorization_server(&client, &issuer).await?;
    let scopes = challenge_scopes(www_authenticate)
        .or_else(|| prm.scopes_supported.as_ref().map(|s| s.join(" ")))
        .unwrap_or_default();

    let (listener, redirect_uri) = bind_loopback().await?;
    let pkce = Pkce::new();
    let state = random_urlsafe(16);
    let resource = prm.resource.unwrap_or_else(|| mcp_url.to_string());

    let mut auth = url::Url::parse(&as_meta.authorization_endpoint)
        .map_err(|e| format!("invalid authorization_endpoint: {e}"))?;
    {
        let mut q = auth.query_pairs_mut();
        q.append_pair("response_type", "code");
        q.append_pair("client_id", CIMD_CLIENT_ID);
        q.append_pair("redirect_uri", &redirect_uri);
        q.append_pair("state", &state);
        q.append_pair("code_challenge", &pkce.challenge);
        q.append_pair("code_challenge_method", "S256");
        q.append_pair("resource", &resource);
        if !scopes.is_empty() {
            q.append_pair("scope", &scopes);
        }
    }
    open_browser(auth.as_str())?;
    let code = wait_for_callback(listener, &state).await?;
    exchange_code(
        &client,
        &as_meta.token_endpoint,
        &code,
        &redirect_uri,
        &pkce.verifier,
        &resource,
    )
    .await
}

async fn bind_loopback() -> Result<(TcpListener, String), String> {
    for port in LOOPBACK_PORTS {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)).await {
            let redirect = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
            return Ok((listener, redirect));
        }
    }
    Err("could not bind a loopback OAuth callback port (19876–19885 are busy)".to_string())
}

async fn wait_for_callback(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    let accepted = timeout(AUTH_WAIT, listener.accept())
        .await
        .map_err(|_| "timed out waiting for the OAuth sign-in to finish".to_string())?
        .map_err(|e| format!("OAuth callback accept failed: {e}"))?;
    let (mut stream, _) = accepted;
    let mut buf = vec![0u8; 4096];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("OAuth callback read failed: {e}"))?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let first = req.lines().next().unwrap_or("");
    let path = first.split_whitespace().nth(1).unwrap_or("");
    let url = format!("http://127.0.0.1{path}");
    let parsed = url::Url::parse(&url).map_err(|e| format!("invalid OAuth callback: {e}"))?;
    let pairs: HashMap<String, String> = parsed
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let body = if pairs.contains_key("error") {
        format!(
            "Sign-in failed: {}",
            pairs
                .get("error_description")
                .or_else(|| pairs.get("error"))
                .map(|s| s.as_str())
                .unwrap_or("authorization error")
        )
    } else {
        "Signed in. You can close this window and return to Conduit.".to_string()
    };
    let html = format!("<!doctype html><html><body><p>{body}</p></body></html>");
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    );
    let _ = stream.write_all(resp.as_bytes()).await;

    if let Some(err) = pairs.get("error") {
        return Err(format!(
            "authorization server returned {err}: {}",
            pairs.get("error_description").cloned().unwrap_or_default()
        ));
    }
    let got_state = pairs.get("state").cloned().unwrap_or_default();
    if got_state != expected_state {
        return Err("OAuth state mismatch; refusing the callback".to_string());
    }
    pairs
        .get("code")
        .cloned()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "OAuth callback did not include an authorization code".to_string())
}

async fn exchange_code(
    client: &reqwest::Client,
    token_endpoint: &str,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
    resource: &str,
) -> Result<StoredToken, String> {
    let resp = client
        .post(token_endpoint)
        .header("Accept", "application/json")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", CIMD_CLIENT_ID),
            ("code_verifier", verifier),
            ("resource", resource),
        ])
        .send()
        .await
        .map_err(|e| format!("token request failed: {e}"))?;
    parse_token_response(resp, token_endpoint, resource).await
}

async fn refresh_token(token: &StoredToken) -> Result<StoredToken, String> {
    let endpoint = token
        .token_endpoint
        .as_deref()
        .ok_or_else(|| "MCP token has no token_endpoint to refresh".to_string())?;
    let refresh = token
        .refresh_token
        .as_deref()
        .ok_or_else(|| "MCP token has no refresh_token".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client error: {e}"))?;
    let client_id = token.client_id.as_deref().unwrap_or(CIMD_CLIENT_ID);
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
        ("client_id", client_id),
    ];
    if let Some(resource) = token.resource.as_deref() {
        form.push(("resource", resource));
    }
    let resp = client
        .post(endpoint)
        .header("Accept", "application/json")
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("token refresh failed: {e}"))?;
    let mut next =
        parse_token_response(resp, endpoint, token.resource.as_deref().unwrap_or("")).await?;
    if next.refresh_token.is_none() {
        next.refresh_token = token.refresh_token.clone();
    }
    if next.client_id.is_none() {
        next.client_id = token.client_id.clone();
    }
    Ok(next)
}

async fn parse_token_response(
    resp: reqwest::Response,
    token_endpoint: &str,
    resource: &str,
) -> Result<StoredToken, String> {
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("token response was not JSON: {e}"))?;
    if !status.is_success() {
        let desc = body
            .get("error_description")
            .or_else(|| body.get("error"))
            .and_then(|v| v.as_str())
            .unwrap_or("token request failed");
        return Err(format!("token endpoint HTTP {status}: {desc}"));
    }
    let access = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "token response missing access_token".to_string())?;
    let expires_in = body.get("expires_in").and_then(|v| v.as_u64());
    let expires_at = expires_in.map(|secs| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() + secs)
            .unwrap_or(secs)
    });
    Ok(StoredToken {
        access_token: access.to_string(),
        refresh_token: body
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        expires_at,
        token_endpoint: Some(token_endpoint.to_string()),
        client_id: Some(CIMD_CLIENT_ID.to_string()),
        resource: if resource.is_empty() {
            None
        } else {
            Some(resource.to_string())
        },
    })
}

#[derive(Debug, Deserialize)]
struct ProtectedResourceMetadata {
    #[serde(default)]
    resource: Option<String>,
    #[serde(default)]
    authorization_servers: Vec<String>,
    #[serde(default)]
    scopes_supported: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct AuthorizationServerMetadata {
    authorization_endpoint: String,
    token_endpoint: String,
}

async fn discover_protected_resource(
    client: &reqwest::Client,
    mcp_url: &str,
    www_authenticate: Option<&str>,
) -> Result<ProtectedResourceMetadata, String> {
    let mut urls = Vec::new();
    if let Some(from_header) = parse_resource_metadata(www_authenticate.unwrap_or("")) {
        urls.push(from_header);
    }
    urls.extend(well_known_resource_urls(mcp_url));
    let mut last = "no protected-resource metadata URL to try".to_string();
    for url in urls {
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                return resp
                    .json()
                    .await
                    .map_err(|e| format!("protected resource metadata was not JSON: {e}"));
            }
            Ok(resp) => last = format!("{url} returned HTTP {}", resp.status()),
            Err(e) => last = format!("{url}: {e}"),
        }
    }
    Err(format!(
        "could not discover OAuth metadata for this MCP server ({last})"
    ))
}

async fn discover_authorization_server(
    client: &reqwest::Client,
    issuer: &str,
) -> Result<AuthorizationServerMetadata, String> {
    let mut last = "no authorization-server metadata URL to try".to_string();
    for url in well_known_as_urls(issuer) {
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                return resp
                    .json()
                    .await
                    .map_err(|e| format!("authorization server metadata was not JSON: {e}"));
            }
            Ok(resp) => last = format!("{url} returned HTTP {}", resp.status()),
            Err(e) => last = format!("{url}: {e}"),
        }
    }
    Err(format!(
        "could not discover the authorization server ({last})"
    ))
}

pub fn well_known_resource_urls(mcp_url: &str) -> Vec<String> {
    let Ok(parsed) = url::Url::parse(mcp_url) else {
        return Vec::new();
    };
    let origin = format!(
        "{}://{}",
        parsed.scheme(),
        parsed.host_str().unwrap_or_default()
    );
    let origin = if let Some(port) = parsed.port() {
        format!("{origin}:{port}")
    } else {
        origin
    };
    let path = parsed.path().trim_end_matches('/');
    let mut urls = Vec::new();
    if !path.is_empty() && path != "/" {
        urls.push(format!(
            "{origin}/.well-known/oauth-protected-resource{path}"
        ));
    }
    urls.push(format!("{origin}/.well-known/oauth-protected-resource"));
    urls
}

pub fn well_known_as_urls(issuer: &str) -> Vec<String> {
    let Ok(parsed) = url::Url::parse(issuer) else {
        return Vec::new();
    };
    let origin = format!(
        "{}://{}",
        parsed.scheme(),
        parsed.host_str().unwrap_or_default()
    );
    let origin = if let Some(port) = parsed.port() {
        format!("{origin}:{port}")
    } else {
        origin
    };
    let path = parsed.path().trim_end_matches('/');
    let mut urls = Vec::new();
    if path.is_empty() || path == "/" {
        urls.push(format!("{origin}/.well-known/oauth-authorization-server"));
        urls.push(format!("{origin}/.well-known/openid-configuration"));
    } else {
        urls.push(format!(
            "{origin}/.well-known/oauth-authorization-server{path}"
        ));
        urls.push(format!("{origin}/.well-known/openid-configuration{path}"));
        urls.push(format!("{origin}{path}/.well-known/openid-configuration"));
    }
    urls
}

/// Extract `resource_metadata` from a RFC 9728 WWW-Authenticate challenge.
pub fn parse_resource_metadata(header: &str) -> Option<String> {
    parse_auth_params(header).remove("resource_metadata")
}

pub fn challenge_scopes(header: Option<&str>) -> Option<String> {
    parse_auth_params(header.unwrap_or("")).remove("scope")
}

fn parse_auth_params(header: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let rest = header.split_once(' ').map(|(_, r)| r).unwrap_or(header);
    for part in rest.split(',') {
        let part = part.trim();
        let Some((k, v)) = part.split_once('=') else {
            continue;
        };
        let v = v.trim().trim_matches('"');
        if !k.trim().is_empty() && !v.is_empty() {
            out.insert(k.trim().to_ascii_lowercase(), v.to_string());
        }
    }
    out
}

struct Pkce {
    verifier: String,
    challenge: String,
}

impl Pkce {
    fn new() -> Self {
        let verifier = random_urlsafe(32);
        let digest = Sha256::digest(verifier.as_bytes());
        let challenge = URL_SAFE_NO_PAD.encode(digest);
        Self {
            verifier,
            challenge,
        }
    }
}

fn random_urlsafe(nbytes: usize) -> String {
    let mut buf = vec![0u8; nbytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rfc9728_challenge() {
        let header = r#"Bearer realm="mcp", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="files:read""#;
        assert_eq!(
            parse_resource_metadata(header).as_deref(),
            Some("https://mcp.example.com/.well-known/oauth-protected-resource")
        );
        assert_eq!(
            challenge_scopes(Some(header)).as_deref(),
            Some("files:read")
        );
    }

    #[test]
    fn well_known_urls_insert_path() {
        let urls = well_known_resource_urls("https://example.com/public/mcp");
        assert_eq!(
            urls[0],
            "https://example.com/.well-known/oauth-protected-resource/public/mcp"
        );
        assert_eq!(
            urls[1],
            "https://example.com/.well-known/oauth-protected-resource"
        );
    }

    #[test]
    fn as_urls_for_path_issuer() {
        let urls = well_known_as_urls("https://auth.example.com/tenant1");
        assert!(urls[0].ends_with("/.well-known/oauth-authorization-server/tenant1"));
        assert!(urls[2].ends_with("/tenant1/.well-known/openid-configuration"));
    }

    #[test]
    fn pkce_is_s256_urlsafe() {
        let p = Pkce::new();
        assert!(p.verifier.len() >= 43);
        let digest = Sha256::digest(p.verifier.as_bytes());
        assert_eq!(p.challenge, URL_SAFE_NO_PAD.encode(digest));
        assert!(!p.challenge.contains('+') && !p.challenge.contains('/'));
    }

    #[test]
    fn stored_token_parses_raw_bearer() {
        let t = parse_stored_token("raw-token").unwrap();
        assert_eq!(t.access_token, "raw-token");
    }
}
