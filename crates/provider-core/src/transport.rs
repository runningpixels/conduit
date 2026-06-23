use crate::error::{fatal, from_http_status, retryable};
use crate::schema::ProviderError;
use bytes::Bytes;
use futures::stream::{Stream, StreamExt};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use std::pin::Pin;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub struct SseRequest {
    pub url: String,
    pub headers: HeaderMap,
    pub body: serde_json::Value,
}

/// A long-lived, shared HTTP client. `reqwest::Client` owns a connection pool
/// and TLS state; reusing one avoids a fresh TLS handshake per request (H5) and
/// centralizes timeout configuration (H3). Cheap to clone (internal `Arc`).
#[derive(Debug, Clone)]
pub struct HttpClient {
    client: reqwest::Client,
}

impl HttpClient {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .expect("reqwest client build");
        Self { client }
    }
}

impl Default for HttpClient {
    fn default() -> Self {
        Self::new()
    }
}

pub fn bearer_header(token: &str) -> Result<HeaderMap, ProviderError> {
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|e| crate::error::fatal(e.to_string()))?,
    );
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    Ok(headers)
}

pub fn api_key_header(key: &str) -> Result<HeaderMap, ProviderError> {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-api-key",
        HeaderValue::from_str(key).map_err(|e| crate::error::fatal(e.to_string()))?,
    );
    headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    Ok(headers)
}

/// Classifies a reqwest send error as retryable (connect/timeout/request) or
/// fatal (everything else).
fn classify_send_error(e: reqwest::Error) -> ProviderError {
    if e.is_timeout() || e.is_connect() || e.is_request() {
        retryable(e.to_string())
    } else {
        fatal(e.to_string())
    }
}

/// POSTs a JSON body and returns the SSE byte stream. Only the connection
/// phase (send + status) is retried (H4); once `bytes_stream()` is obtained the
/// turn is committed and mid-stream errors surface as `ProviderEvent::Error`.
pub async fn post_sse(
    http: &HttpClient,
    request: SseRequest,
    cancel: CancellationToken,
) -> Result<Pin<Box<dyn Stream<Item = Result<Bytes, ProviderError>> + Send>>, ProviderError> {
    let response = crate::retry::with_retry(cancel.clone(), || {
        let client = http.client.clone();
        let url = request.url.clone();
        let headers = request.headers.clone();
        let body = request.body.clone();
        async move {
            let req = client.post(&url).headers(headers).json(&body);
            let resp = req.send().await.map_err(classify_send_error)?;
            let status = resp.status().as_u16();
            if status >= 400 {
                let body = resp.text().await.unwrap_or_default();
                return Err(from_http_status(status, &body));
            }
            Ok(resp)
        }
    })
    .await?;

    let byte_stream = response
        .bytes_stream()
        .map(|result| result.map_err(|e| retryable(e.to_string())));

    Ok(Box::pin(byte_stream))
}

/// GETs a URL and decodes JSON. The whole request is retried on retryable
/// errors (H4) — it is a one-shot call, so there is no "mid-stream" commitment.
/// A per-request 30s timeout (H3) bounds the overall call; JSON decode
/// failures are fatal and not retried.
pub async fn get_json(
    http: &HttpClient,
    url: &str,
    headers: HeaderMap,
    cancel: CancellationToken,
) -> Result<serde_json::Value, ProviderError> {
    let url_owned = url.to_string();
    let response = crate::retry::with_retry(cancel.clone(), || {
        let client = http.client.clone();
        let url = url_owned.clone();
        let headers = headers.clone();
        async move {
            let resp = client
                .get(&url)
                .headers(headers)
                .timeout(Duration::from_secs(30))
                .send()
                .await
                .map_err(classify_send_error)?;
            let status = resp.status().as_u16();
            if status >= 400 {
                let body = resp.text().await.unwrap_or_default();
                return Err(from_http_status(status, &body));
            }
            Ok(resp)
        }
    })
    .await?;

    response.json().await.map_err(|e| fatal(e.to_string()))
}
