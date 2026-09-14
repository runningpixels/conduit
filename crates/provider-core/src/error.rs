use crate::schema::ProviderError;

pub fn retryable(message: impl Into<String>) -> ProviderError {
    ProviderError {
        provider_code: None,
        retryable: true,
        message: message.into(),
    }
}

pub fn fatal(message: impl Into<String>) -> ProviderError {
    ProviderError {
        provider_code: None,
        retryable: false,
        message: message.into(),
    }
}

pub fn from_http_status(status: u16, body: &str) -> ProviderError {
    let retryable = status == 429 || status >= 500;
    ProviderError {
        provider_code: Some(status.to_string()),
        retryable,
        message: if body.is_empty() {
            format!("HTTP {status}")
        } else {
            body.to_string()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_http_status_preserves_ollama_tool_unsupported_body() {
        // Ollama returns HTTP 400 with a JSON body naming the model when it
        // doesn't support tools. The raw body is passed through verbatim so
        // the user sees "does not support tools", not a generic "HTTP 400".
        let body = r#"{"error":"registry.ollama.ai/library/gemma:2b does not support tools"}"#;
        let err = from_http_status(400, body);
        assert!(
            err.message.contains("does not support tools"),
            "expected the provider's error text in the message, got: {}",
            err.message
        );
        assert_eq!(err.provider_code.as_deref(), Some("400"));
        assert!(!err.retryable, "a 400 is a client error, not retryable");
    }
}
