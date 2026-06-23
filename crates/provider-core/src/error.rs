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
