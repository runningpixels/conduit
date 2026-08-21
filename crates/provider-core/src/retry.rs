//! Connection-phase retry for provider HTTP calls.
//!
//! Only the *connection establishment* of a request is retried — the `send()`
//! future plus the status check. Once a streaming response starts producing
//! bytes, the turn is committed and mid-stream errors are surfaced as
//! `ProviderEvent::Error` (not retried), because retrying would re-submit the
//! request body and duplicate server-side work. This invariant is enforced by
//! the call sites in `transport.rs`: `post_sse`/`get_json` retry only up to the
//! point of obtaining a `reqwest::Response`, then hand the byte stream / body
//! off without further retries.

use crate::error::fatal;
use crate::schema::ProviderError;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// Maximum connection attempts per request (1 initial + retries).
pub const MAX_ATTEMPTS: u32 = 3;

/// Exponential backoff with jitter for attempt `n` (0-indexed): 200ms, 400ms,
/// 800ms, … plus up to 100ms of jitter to de-correlate concurrent retries.
pub fn backoff(attempt: u32) -> Duration {
    let base = 200u64 * 2u64.pow(attempt);
    Duration::from_millis(base + jitter_millis())
}

fn jitter_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64 % 100)
        .unwrap_or(0)
}

/// Runs `op`, retrying it on `retryable` errors (per `ProviderError.retryable`)
/// with exponential backoff, until it succeeds, fails fatally, exhausts
/// `MAX_ATTEMPTS`, or `cancel` fires. Honors cancellation between attempts and
/// during backoff sleeps.
pub async fn with_retry<F, Fut, T>(cancel: CancellationToken, mut op: F) -> Result<T, ProviderError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, ProviderError>>,
{
    let mut attempt = 0u32;
    loop {
        let result = tokio::select! {
          r = op() => r,
          _ = cancel.cancelled() => return Err(fatal("cancelled")),
        };
        match result {
            Ok(value) => return Ok(value),
            Err(e) if e.retryable && attempt + 1 < MAX_ATTEMPTS => {
                let delay = backoff(attempt);
                tokio::select! {
                  _ = tokio::time::sleep(delay) => {}
                  _ = cancel.cancelled() => return Err(fatal("cancelled")),
                }
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    #[test]
    fn backoff_is_nondecreasing_in_base() {
        // Jitter can add up to 99ms; the exponential base must still dominate the
        // step from one attempt to the next (200ms apart), so each step is larger.
        let b0 = backoff(0).as_millis();
        let b1 = backoff(1).as_millis();
        let b2 = backoff(2).as_millis();
        // Base grows by >= 200ms per step; jitter < 100ms can't reverse the order.
        assert!(b1 > b0, "expected b1 > b0: {b0} {b1}");
        assert!(b2 > b1, "expected b2 > b1: {b1} {b2}");
    }

    #[tokio::test]
    async fn with_retry_succeeds_on_second_attempt() {
        let calls = Arc::new(AtomicU32::new(0));
        let calls_clone = calls.clone();
        let result = with_retry(CancellationToken::new(), move || {
            let calls = calls_clone.clone();
            async move {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                if n == 0 {
                    Err(crate::error::retryable("transient"))
                } else {
                    Ok(42)
                }
            }
        })
        .await;
        assert_eq!(result.unwrap(), 42);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn with_retry_exhausts_on_persistent_retryable_error() {
        let calls = Arc::new(AtomicU32::new(0));
        let calls_clone = calls.clone();
        let result = with_retry(CancellationToken::new(), move || {
            let calls = calls_clone.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                Err::<(), _>(crate::error::retryable("always fails"))
            }
        })
        .await;
        assert!(result.is_err(), "expected exhaustion");
        assert_eq!(calls.load(Ordering::SeqCst), MAX_ATTEMPTS);
    }

    #[tokio::test]
    async fn with_retry_does_not_retry_fatal_error() {
        let calls = Arc::new(AtomicU32::new(0));
        let calls_clone = calls.clone();
        let result = with_retry(CancellationToken::new(), move || {
            let calls = calls_clone.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                Err::<(), _>(crate::error::fatal("not retryable"))
            }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "fatal error must not retry"
        );
    }
}
