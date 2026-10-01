//! Browser arguments for the main WebView2 (Windows only; ignored elsewhere).
//!
//! Chromium does not apply CSP to WebRTC. With `connect-src 'none'`, an HTML
//! artifact could still open an `RTCPeerConnection` and send data it chose to
//! any host through STUN/TURN (verified live 2026-09-28, UDP and TCP). Two
//! switches close that at the network layer:
//!
//! - `--webrtc-ip-handling-policy=disable_non_proxied_udp`: WebRTC may not use
//!   UDP unless it goes through a proxy. On its own this still leaves TURN
//!   over TCP.
//! - `--proxy-server=http://127.0.0.1:9`: a proxy that accepts nothing, so the
//!   TCP path fails too. Loopback always bypasses the proxy, and Tauri's own
//!   schemes are served before the network, so the app is unaffected.
//!
//! The webview itself loads nothing remote except artifact resources from
//! origins the user put on the remote allowlist; those go on the bypass list.
//! WebRTC to such a host is possible again, but that adds nothing: an image URL
//! to that host can already carry data out. The list is read once at startup,
//! so allowlist edits apply after a restart (the Settings hint says so).
//!
//! Passing browser arguments replaces wry's defaults, so they are repeated in
//! [`BASE_ARGS`].
//!
//! Linux (WebKitGTK) has no browser arguments; [`disable_webrtc`] turns the
//! engine's `enable-webrtc` setting off instead, which removes
//! `RTCPeerConnection` from every frame of the webview. macOS (WKWebView) has
//! no public switch: there, a page's own `RTCPeerConnection` is only removed
//! by the script in its frame (`artifacts/webrtcBlock.ts`), which is not a
//! boundary on its own.

/// What wry passes by default (see `wry::WebViewBuilderExtWindows`), which
/// setting our own arguments would otherwise drop.
pub const BASE_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// Closes WebRTC egress; see the module docs.
pub const WEBRTC_ARGS: &str =
    "--webrtc-ip-handling-policy=disable_non_proxied_udp --proxy-server=http://127.0.0.1:9";

/// Full argument string for the main webview.
pub fn main_webview_browser_args(remote_allowlist: &[String]) -> String {
    let mut args = format!("{BASE_ARGS} {WEBRTC_ARGS}");
    let bypass: Vec<String> = remote_allowlist
        .iter()
        .filter_map(|entry| bypass_rule(entry))
        .collect();
    if !bypass.is_empty() {
        args.push_str(" --proxy-bypass-list=");
        args.push_str(&bypass.join(";"));
    }
    args
}

/// One bypass rule (`scheme://host[:port]`) for an allowlist entry, or `None`
/// if it isn't a plain http(s) origin. The entry comes from `settings.json`,
/// which can be edited by hand, so it is re-validated here and the host is
/// limited to characters that can't split or extend the argument string.
fn bypass_rule(entry: &str) -> Option<String> {
    let origin = crate::validation::validate_artifact_origin(entry)?;
    let parsed = url::Url::parse(&origin).ok()?;
    let host = parsed.host_str()?;
    let host_ok = !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    host_ok.then_some(origin)
}

/// Linux: WebKitGTK's `enable-webrtc` (2.38+) off for the main webview, which
/// hosts every artifact frame. Nothing in the app itself uses WebRTC. Media
/// capture (`enable-media-stream`) is a separate setting and isn't touched.
#[cfg(target_os = "linux")]
pub fn disable_webrtc(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|webview| {
        use webkit2gtk::{SettingsExt, WebViewExt};
        if let Some(settings) = webview.inner().settings() {
            settings.set_enable_webrtc(false);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_allowlist_gives_base_and_webrtc_args_only() {
        let args = main_webview_browser_args(&[]);
        assert_eq!(args, format!("{BASE_ARGS} {WEBRTC_ARGS}"));
        assert!(!args.contains("--proxy-bypass-list"));
    }

    #[test]
    fn keeps_wry_defaults() {
        let args = main_webview_browser_args(&[]);
        assert!(args.contains("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"));
        assert!(args.contains("--autoplay-policy=no-user-gesture-required"));
    }

    #[test]
    fn allowlisted_origins_become_bypass_rules() {
        let args = main_webview_browser_args(&[
            "https://images.example.com".into(),
            "http://cdn.example.org:8080".into(),
        ]);
        assert!(args.ends_with(
            " --proxy-bypass-list=https://images.example.com;http://cdn.example.org:8080"
        ));
    }

    #[test]
    fn rejects_entries_that_could_inject_arguments() {
        let args = main_webview_browser_args(&[
            "https://ok.example.com".into(),
            "https://a.example.com --remote-debugging-port=9222".into(),
            "https://b.example.com;*".into(),
            "ftp://files.example.com".into(),
            "https://user:pw@c.example.com".into(),
            "not a url".into(),
        ]);
        assert_eq!(
            args,
            format!("{BASE_ARGS} {WEBRTC_ARGS} --proxy-bypass-list=https://ok.example.com")
        );
    }
}
