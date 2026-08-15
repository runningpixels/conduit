use crate::error::{fatal, from_http_status, retryable};
use crate::schema::ProviderError;
use bytes::Bytes;
use futures::stream::{Stream, StreamExt};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use std::pin::Pin;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// How long an opened SSE stream may go without producing a byte before it is
/// treated as dead. Generous on purpose — it has to clear the slowest plausible
/// wait for a first token, including a reasoning model thinking before it
/// speaks — but bounded, because "forever" is not a latency.
const SSE_IDLE_TIMEOUT: Duration = Duration::from_secs(120);

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
    bearer_header_with_extras(token, &[])
}

pub fn bearer_header_with_extras(
    token: &str,
    extras: &[(&str, &str)],
) -> Result<HeaderMap, ProviderError> {
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|e| crate::error::fatal(e.to_string()))?,
    );
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    for (name, value) in extras {
        headers.insert(
            HeaderName::from_bytes(name.as_bytes())
                .map_err(|e| crate::error::fatal(e.to_string()))?,
            HeaderValue::from_str(value).map_err(|e| crate::error::fatal(e.to_string()))?,
        );
    }
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

pub fn gemini_api_key_header(key: &str) -> Result<HeaderMap, ProviderError> {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-goog-api-key",
        HeaderValue::from_str(key).map_err(|e| crate::error::fatal(e.to_string()))?,
    );
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

    // Idle timeout, not a total one: a long answer is fine, a silent socket is
    // not. `HttpClient` sets only `connect_timeout`, so a provider that accepts
    // the connection and then sends nothing leaves the consumer parked in
    // `next().await` with no way out — and the agent loop's wall-clock budget
    // cannot help, because it is only checked between rounds.
    //
    // The error is *yielded*, then the stream ends. Simply ending it would be
    // the same bug in a new place: the round would finish with neither a
    // completion nor an error, and the turn would end having told the UI
    // nothing.
    let guarded = futures::stream::unfold(
        (Box::pin(byte_stream), false),
        |(mut stream, finished)| async move {
            if finished {
                return None;
            }
            match tokio::time::timeout(SSE_IDLE_TIMEOUT, stream.next()).await {
                Ok(Some(item)) => Some((item, (stream, false))),
                Ok(None) => None,
                Err(_) => {
                    let err = retryable(format!(
                        "the provider sent nothing for {}s and the connection was still open",
                        SSE_IDLE_TIMEOUT.as_secs()
                    ));
                    Some((Err(err), (stream, true)))
                }
            }
        },
    );

    Ok(Box::pin(guarded))
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
