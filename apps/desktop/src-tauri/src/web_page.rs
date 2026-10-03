//! Fetch one web page and turn it into readable text.
//!
//! Shared by the chat `web_fetch` tool and the workflow "Fetch page" step so
//! both go through the same network path: [`artifact_network::perform`] —
//! https to public addresses only (a name that resolves to a private or local
//! address is refused, and each redirect hop is checked again), pinned DNS,
//! and the response size and time caps. A page the model reads may tell it to
//! fetch `http://192.168.1.1/...`; this is what stops that request.

use base64::{engine::general_purpose::STANDARD as B64, Engine};

use crate::artifact_network::{self, AddressPolicy, ArtifactFetchRequest};
use crate::workflows::extract;

/// A fetched page, reduced to what a model needs.
#[derive(Debug, Clone)]
pub struct Page {
    /// The URL that finally answered, after redirects.
    pub url: String,
    pub title: Option<String>,
    /// Readable text, at most the `max_chars` asked for.
    pub text: String,
    /// Absolute links found on an HTML page (empty for plain text).
    pub links: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// The request did not complete: refused address, DNS, timeout, size cap.
    Network(String),
    /// The site answered with an error status.
    Status { status: u16, text: String },
    /// The body was not valid base64 from the network layer.
    Unreadable,
    /// The response is not text (an image, a PDF, a download).
    NotAPage(String),
}

impl FetchError {
    /// Worth retrying: a network failure, a server error, or "slow down".
    pub fn is_transient(&self) -> bool {
        match self {
            FetchError::Network(_) => true,
            FetchError::Status { status, .. } => *status >= 500 || *status == 429,
            FetchError::Unreadable | FetchError::NotAPage(_) => false,
        }
    }
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::Network(message) => f.write_str(message),
            FetchError::Status { status, text } => write!(f, "the site answered {status} {text}"),
            FetchError::Unreadable => f.write_str("the page could not be read"),
            FetchError::NotAPage(content_type) => {
                write!(f, "it is not a web page ({content_type})")
            }
        }
    }
}

/// `http://` becomes `https://`: the network path only speaks https, and most
/// sites a model names with `http://` serve the same page over https.
pub fn upgrade_to_https(url: &str) -> String {
    match url.get(..7) {
        Some(scheme) if scheme.eq_ignore_ascii_case("http://") => format!("https://{}", &url[7..]),
        _ => url.to_string(),
    }
}

/// Fetch `url` and return its readable text. `principal` names the reader for
/// the network layer's per-reader rate limit (`workflow-run:<id>`, `chat`).
pub async fn fetch(
    url: &str,
    principal: &str,
    policy: AddressPolicy,
    max_chars: usize,
) -> Result<Page, FetchError> {
    let request = ArtifactFetchRequest {
        principal: principal.to_string(),
        url: url.to_string(),
        method: "GET".to_string(),
        headers: vec![(
            "Accept".to_string(),
            "text/html,text/plain;q=0.9,*/*;q=0.5".to_string(),
        )],
        body: None,
    };
    let response = artifact_network::perform(&request, policy, &|_| true)
        .await
        .map_err(FetchError::Network)?;
    if response.status >= 400 {
        return Err(FetchError::Status {
            status: response.status,
            text: response.status_text,
        });
    }
    let bytes = B64
        .decode(&response.body)
        .map_err(|_| FetchError::Unreadable)?;
    let body = String::from_utf8_lossy(&bytes);
    let content_type = response
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.to_ascii_lowercase())
        .unwrap_or_default();
    let is_html = content_type.contains("html") || body.trim_start().starts_with('<');
    let (title, text, links) = if is_html {
        let page = extract::extract_readable(&body, &response.url);
        (page.title, page.text, page.links)
    } else if content_type.is_empty()
        || content_type.starts_with("text/")
        || content_type.contains("json")
    {
        (None, body.trim().to_string(), Vec::new())
    } else {
        return Err(FetchError::NotAPage(content_type));
    };
    Ok(Page {
        url: response.url,
        title,
        text: text.chars().take(max_chars).collect(),
        links,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrades_only_plain_http() {
        assert_eq!(
            upgrade_to_https("http://example.com/a"),
            "https://example.com/a"
        );
        assert_eq!(
            upgrade_to_https("HTTP://example.com"),
            "https://example.com"
        );
        assert_eq!(
            upgrade_to_https("https://example.com"),
            "https://example.com"
        );
        assert_eq!(upgrade_to_https("ftp://example.com"), "ftp://example.com");
        assert_eq!(upgrade_to_https("http"), "http");
    }

    #[test]
    fn transient_errors_are_network_server_and_rate_limit() {
        assert!(FetchError::Network("timeout".into()).is_transient());
        let status = |status| FetchError::Status {
            status,
            text: String::new(),
        };
        assert!(status(503).is_transient());
        assert!(status(429).is_transient());
        assert!(!status(404).is_transient());
        assert!(!FetchError::NotAPage("image/png".into()).is_transient());
    }

    #[tokio::test]
    async fn refuses_loopback_and_private_addresses() {
        for url in [
            "https://127.0.0.1/",
            "https://localhost/admin",
            "https://10.0.0.1/",
            "https://192.168.1.1/",
            "https://169.254.169.254/latest/meta-data/",
            "https://[::1]/",
        ] {
            let result = fetch(url, "test", AddressPolicy::APP, 1000).await;
            assert!(
                matches!(result, Err(FetchError::Network(_))),
                "{url} should be refused, got {result:?}"
            );
        }
    }

    #[tokio::test]
    async fn refuses_plain_http() {
        let result = fetch("http://example.com/", "test", AddressPolicy::APP, 1000).await;
        assert!(matches!(result, Err(FetchError::Network(_))), "{result:?}");
    }
}
