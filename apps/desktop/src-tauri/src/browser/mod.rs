// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! The browser workflow agents read the web with: the user's installed
//! Chromium browser, started with its own profile and driven over the
//! DevTools protocol. Read only for now (`open_page`, `read_page`).

pub mod cdp;
pub mod detect;
pub mod elements;
pub mod guard;
pub mod launch;
pub mod rules;
#[cfg(windows)]
mod spawn_windows;
pub mod tools;

use provider_core::schema::AppError;

pub use detect::BrowserInfo;

/// The marker in an agent's `tools` that gives it the browser tools.
pub const BROWSER_TOOL: &str = "browser";

/// The marker, next to [`BROWSER_TOOL`], that also lets the agent click,
/// type and choose (design B2).
pub const BROWSER_ACT_TOOL: &str = "browser_act";

/// Why a browser call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserError {
    NotInstalled,
    InUse,
    LaunchFailed(String),
    Blocked { url: String, why: String },
    Timeout,
    Other(String),
}

impl std::fmt::Display for BrowserError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BrowserError::NotInstalled => f.write_str(
                "no supported browser is installed; install Microsoft Edge or Google Chrome",
            ),
            BrowserError::InUse => f.write_str("the browser is in use"),
            BrowserError::LaunchFailed(why) => {
                write!(f, "the browser could not be started ({why})")
            }
            BrowserError::Blocked { url, why } => write!(f, "{url} is not allowed: {why}"),
            BrowserError::Timeout => f.write_str("the browser did not answer in time"),
            BrowserError::Other(why) => f.write_str(why),
        }
    }
}

impl BrowserError {
    /// The coded error the renderer shows.
    pub fn to_app_error(&self) -> AppError {
        match self {
            BrowserError::NotInstalled => {
                AppError::new("error.browser.notInstalled", self.to_string())
            }
            BrowserError::InUse => AppError::new(
                "error.browser.inUse",
                "The browser is in use. Wait for the runs using it to finish, then try again.",
            ),
            BrowserError::LaunchFailed(why) => {
                AppError::new("error.browser.launchFailed", self.to_string())
                    .with("reason", why.clone())
            }
            BrowserError::Blocked { url, .. } => {
                AppError::new("error.browser.blocked", self.to_string()).with("url", url.clone())
            }
            BrowserError::Timeout => AppError::new("error.browser.timeout", self.to_string()),
            BrowserError::Other(why) => AppError::from(why.clone()),
        }
    }

    /// What a tool call tells the model.
    pub fn for_model(&self) -> String {
        format!("browser error: {self}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_carry_their_codes_and_params() {
        assert_eq!(
            BrowserError::NotInstalled.to_app_error().code,
            "error.browser.notInstalled"
        );
        assert_eq!(
            BrowserError::InUse.to_app_error().code,
            "error.browser.inUse"
        );
        assert_eq!(
            BrowserError::LaunchFailed("x".into()).to_app_error().code,
            "error.browser.launchFailed"
        );
        let blocked = BrowserError::Blocked {
            url: "http://10.0.0.1/".into(),
            why: "private".into(),
        }
        .to_app_error();
        assert_eq!(blocked.code, "error.browser.blocked");
        assert_eq!(blocked.params["url"], "http://10.0.0.1/");
        assert_eq!(
            BrowserError::Timeout.to_app_error().code,
            "error.browser.timeout"
        );
        assert!(BrowserError::Timeout
            .for_model()
            .starts_with("browser error: "));
    }
}
