//! Startup check: did the main window's interface actually appear? (#310)
//!
//! A window can open, stay up and still show nothing: on macOS Monterey the
//! rc.22 window stayed black while the process ran fine, and the launch smoke
//! in CI (which only checks the process stays up) could not see it. Release
//! builds have no developer tools, so the person hitting it had no way to tell
//! us why.
//!
//! So the app checks itself, once per launch. An initialization script
//! (outside the page's CSP and its own bundle) records script errors, failed
//! loads and CSP violations from the first moment. A few seconds after the
//! page finishes loading, Rust evaluates a probe in the page and reads the
//! answer through the native callback, not IPC, so it works even when the
//! page's own scripts never ran. On macOS it also asks AppKit where the
//! webview is: in which window, how big, hidden or not.
//!
//! A rendered interface logs one line. A blank one, or a page that never
//! finishes loading, logs the details, writes them to `boot-check.txt` in the
//! app's log folder and shows a native dialog pointing at that file.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use tauri::{Manager, Runtime, WebviewWindow};

/// Runs in every page load of the main frame, before any page script. Kept to
/// plain ES5 so it can't itself be what an old engine rejects.
pub const INIT_SCRIPT: &str = r#"(function () {
  if (window.__conduitBootCheck) return;
  var log = { problems: [] };
  window.__conduitBootCheck = log;
  function note(text) {
    if (log.problems.length < 20) log.problems.push(String(text).slice(0, 400));
  }
  window.addEventListener('error', function (event) {
    var target = event.target;
    if (target && target !== window && (target.src || target.href)) {
      note('failed to load ' + (target.tagName || '').toLowerCase() + ' ' + (target.src || target.href));
    } else {
      note('error: ' + (event.message || 'unknown') + ' at ' + (event.filename || '?') + ':' + (event.lineno || 0));
    }
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    note('unhandled rejection: ' + (reason && reason.message ? reason.message : reason));
  });
  document.addEventListener('securitypolicyviolation', function (event) {
    // Tauri's IPC tries a fetch to its own endpoint first and falls back to
    // postMessage when the CSP refuses it; one refusal per call would fill
    // the list and push out whatever actually went wrong.
    var uri = String(event.blockedURI || '');
    if (uri.indexOf('ipc:') === 0 || uri.indexOf('http://ipc.localhost') === 0) return;
    note('blocked by CSP (' + event.violatedDirective + '): ' + uri);
  });
})();"#;

/// Evaluated in the page; returns a JSON string (both engines hand a string
/// result back JSON-encoded, so the Rust side decodes twice).
const PROBE: &str = r#"(function () {
  var root = document.getElementById('root');
  var log = window.__conduitBootCheck;
  return JSON.stringify({
    readyState: document.readyState,
    hasRoot: !!root,
    rootChildren: root ? root.childElementCount : 0,
    viewport: window.innerWidth + 'x' + window.innerHeight,
    href: String(location.href),
    userAgent: navigator.userAgent,
    initScriptRan: !!log,
    problems: log ? log.problems : []
  });
})()"#;

/// The first probe, after the page reports it finished loading. Rendering
/// takes well under a second after that; the second probe gives a slow
/// machine plenty more before it counts as blank.
const FIRST_PROBE_AFTER: Duration = Duration::from_secs(5);
const SECOND_PROBE_AFTER: Duration = Duration::from_secs(20);
/// How long one probe may take to answer.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// A page that never reports finishing is a failure of its own.
const PAGE_LOAD_DEADLINE: Duration = Duration::from_secs(60);

/// Test switch: report a blank window whatever the probe says, to see the
/// report and the dialog without a broken build.
const SIMULATE_ENV: &str = "CONDUIT_BOOT_CHECK_SIMULATE_BLANK";

pub const REPORT_FILE: &str = "boot-check.txt";

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Probe {
    pub ready_state: String,
    pub has_root: bool,
    pub root_children: u32,
    pub viewport: String,
    pub href: String,
    pub user_agent: String,
    pub init_script_ran: bool,
    pub problems: Vec<String>,
}

impl Probe {
    pub fn rendered(&self) -> bool {
        self.has_root && self.root_children > 0
    }
}

/// Decodes the probe's answer. The engines return the JSON string the probe
/// built, JSON-encoded once more; an object is accepted too.
pub fn parse_probe(raw: &str) -> Result<Probe, String> {
    let value: serde_json::Value = serde_json::from_str(raw.trim())
        .map_err(|error| format!("unreadable answer ({error}): {raw:.200}"))?;
    let value = match value {
        serde_json::Value::String(inner) => serde_json::from_str(&inner)
            .map_err(|error| format!("unreadable answer ({error}): {inner:.200}"))?,
        other => other,
    };
    serde_json::from_value(value).map_err(|error| format!("unexpected answer: {error}"))
}

/// What the check found, for the log and the report.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Rendered,
    /// The page loaded but nothing rendered.
    Blank(Probe),
    /// The probe got no usable answer.
    NoAnswer(String),
    /// The page never reported finishing its load.
    NeverLoaded,
}

/// The plain-text report written to `boot-check.txt`.
pub fn report_text(outcome: &Outcome, native: Option<&str>, version: &str) -> String {
    let mut lines = vec![
        format!("Conduit {version} startup check"),
        format!("OS: {} {}", std::env::consts::OS, std::env::consts::ARCH),
    ];
    match outcome {
        Outcome::Rendered => lines.push("Result: the interface rendered.".into()),
        Outcome::NeverLoaded => lines.push(format!(
            "Result: the page did not finish loading within {} s.",
            PAGE_LOAD_DEADLINE.as_secs()
        )),
        Outcome::NoAnswer(why) => {
            lines.push("Result: the page did not answer the check.".into());
            lines.push(format!("Detail: {why}"));
        }
        Outcome::Blank(probe) => {
            lines.push("Result: the page loaded but the interface did not render.".into());
            lines.push(format!("Ready state: {}", probe.ready_state));
            lines.push(format!(
                "Root element: {}",
                if probe.has_root {
                    format!("present, {} children", probe.root_children)
                } else {
                    "missing".into()
                }
            ));
            lines.push(format!("Viewport: {}", probe.viewport));
            lines.push(format!("Address: {}", probe.href));
            lines.push(format!("Engine: {}", probe.user_agent));
            lines.push(format!("Error recorder ran: {}", probe.init_script_ran));
            if probe.problems.is_empty() {
                lines.push("Problems recorded: none".into());
            } else {
                lines.push("Problems recorded:".into());
                lines.extend(probe.problems.iter().map(|p| format!("  - {p}")));
            }
        }
    }
    if let Some(native) = native {
        lines.push(format!("Native view: {native}"));
    }
    lines.join("\n") + "\n"
}

/// Starts the check for the main window. Call once, right after building it;
/// `page_loaded` must be fired by the window's `on_page_load` handler.
pub fn spawn<R: Runtime>(
    window: WebviewWindow<R>,
    page_loaded: tokio::sync::watch::Receiver<bool>,
) {
    tauri::async_runtime::spawn(async move {
        let outcome = run(&window, page_loaded).await;
        let native = native_view_facts(&window).await;
        match &outcome {
            Outcome::Rendered => {
                tracing::info!(
                    native = native.as_deref().unwrap_or("-"),
                    "startup check: the interface rendered"
                );
            }
            failed => {
                let version = window.app_handle().package_info().version.to_string();
                let report = report_text(failed, native.as_deref(), &version);
                tracing::error!("startup check: the window is blank\n{report}");
                let saved = save_report(&window, &report);
                show_dialog(&window, saved.as_deref());
            }
        }
    });
}

/// The page-load hook to put on the main window's builder.
pub fn page_load_flag() -> (
    tokio::sync::watch::Sender<bool>,
    tokio::sync::watch::Receiver<bool>,
) {
    tokio::sync::watch::channel(false)
}

async fn run<R: Runtime>(
    window: &WebviewWindow<R>,
    mut page_loaded: tokio::sync::watch::Receiver<bool>,
) -> Outcome {
    // `wait_for` hands back a guard that is not `Send`; keep only whether it came.
    let loaded = tokio::time::timeout(PAGE_LOAD_DEADLINE, page_loaded.wait_for(|done| *done))
        .await
        .is_ok_and(|seen| seen.is_ok());
    if !loaded {
        return Outcome::NeverLoaded;
    }
    let simulate = std::env::var_os(SIMULATE_ENV).is_some();

    tokio::time::sleep(FIRST_PROBE_AFTER).await;
    match probe(window).await {
        Ok(found) if found.rendered() && !simulate => return Outcome::Rendered,
        _ => {}
    }
    tokio::time::sleep(SECOND_PROBE_AFTER - FIRST_PROBE_AFTER).await;
    match probe(window).await {
        Ok(found) if found.rendered() && !simulate => Outcome::Rendered,
        Ok(mut found) => {
            if simulate {
                found
                    .problems
                    .push(format!("(simulated by {SIMULATE_ENV})"));
            }
            Outcome::Blank(found)
        }
        Err(why) => Outcome::NoAnswer(why),
    }
}

async fn probe<R: Runtime>(window: &WebviewWindow<R>) -> Result<Probe, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    // The callback is `Fn`, the sender is used once.
    let tx = Arc::new(Mutex::new(Some(tx)));
    window
        .eval_with_callback(PROBE, move |answer| {
            if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = tx.send(answer);
            }
        })
        .map_err(|error| format!("couldn't run the check: {error}"))?;
    match tokio::time::timeout(PROBE_TIMEOUT, rx).await {
        Ok(Ok(answer)) if answer.trim().is_empty() => {
            Err("the check returned nothing (a script error, or scripts not running)".into())
        }
        Ok(Ok(answer)) => parse_probe(&answer),
        Ok(Err(_)) => Err("the check's answer was dropped".into()),
        Err(_) => Err(format!("no answer within {} s", PROBE_TIMEOUT.as_secs())),
    }
}

fn save_report<R: Runtime>(window: &WebviewWindow<R>, report: &str) -> Option<std::path::PathBuf> {
    let dir = window.app_handle().path().app_log_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(REPORT_FILE);
    match std::fs::write(&path, report) {
        Ok(()) => Some(path),
        Err(error) => {
            tracing::warn!(%error, "startup check: couldn't save the report");
            None
        }
    }
}

fn show_dialog<R: Runtime>(window: &WebviewWindow<R>, saved: Option<&std::path::Path>) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

    let mut text = String::from(
        "Conduit started, but its window didn't load, so it may stay blank.\n\n\
         Please report this at github.com/runningpixels/conduit/issues",
    );
    match saved {
        Some(path) => {
            text.push_str(
                " and paste in the contents of this file (it holds no chats or keys):\n\n",
            );
            text.push_str(&path.display().to_string());
        }
        None => text.push('.'),
    }
    window
        .app_handle()
        .dialog()
        .message(text)
        .title("Conduit's window didn't load")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

/// Where AppKit has the webview: its window, size and visibility. That is the
/// part a page probe cannot see (#310's log said the view focus kept landing
/// outside any window).
#[cfg(target_os = "macos")]
async fn native_view_facts<R: Runtime>(window: &WebviewWindow<R>) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |webview| {
            let view_ptr = webview.inner() as *const objc2_app_kit::NSView;
            let window_ptr = webview.ns_window() as *const objc2_app_kit::NSWindow;
            // Safety: wry hands out its live WKWebView (an NSView) and the
            // NSWindow it was built for; this closure runs on the main thread.
            let facts = unsafe {
                match view_ptr.as_ref() {
                    None => "no webview".to_string(),
                    Some(view) => {
                        let frame = view.frame();
                        let in_window = match view.window() {
                            None => "in no window".to_string(),
                            Some(w) if std::ptr::eq(&*w, window_ptr) => {
                                "in the main window".to_string()
                            }
                            Some(_) => "in a different window".to_string(),
                        };
                        format!(
                            "{in_window}, {}x{}, hidden {}, has superview {}",
                            frame.size.width,
                            frame.size.height,
                            view.isHidden(),
                            view.superview().is_some()
                        )
                    }
                }
            };
            let _ = tx.send(facts);
        })
        .ok()?;
    tokio::time::timeout(PROBE_TIMEOUT, rx).await.ok()?.ok()
}

#[cfg(not(target_os = "macos"))]
async fn native_view_facts<R: Runtime>(_window: &WebviewWindow<R>) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rendered_probe() -> Probe {
        Probe {
            ready_state: "complete".into(),
            has_root: true,
            root_children: 1,
            viewport: "1360x900".into(),
            href: "tauri://localhost/".into(),
            user_agent: "AppleWebKit/605.1.15".into(),
            init_script_ran: true,
            problems: vec![],
        }
    }

    #[test]
    fn parses_the_double_encoded_answer_both_engines_return() {
        let inner = r#"{"readyState":"complete","hasRoot":true,"rootChildren":1,"viewport":"1360x900","href":"tauri://localhost/","userAgent":"AppleWebKit/605.1.15","initScriptRan":true,"problems":[]}"#;
        let raw = serde_json::to_string(inner).unwrap();
        assert_eq!(parse_probe(&raw).unwrap(), rendered_probe());
        // A bare object (should an engine ever return one) reads the same.
        assert_eq!(parse_probe(inner).unwrap(), rendered_probe());
    }

    #[test]
    fn an_empty_root_is_not_rendered() {
        let mut probe = rendered_probe();
        assert!(probe.rendered());
        probe.root_children = 0;
        assert!(!probe.rendered());
        probe.root_children = 3;
        probe.has_root = false;
        assert!(!probe.rendered());
    }

    #[test]
    fn garbage_is_an_error_not_a_panic() {
        assert!(parse_probe("").is_err());
        assert!(parse_probe("not json").is_err());
        assert!(parse_probe("\"not json either\"").is_err());
    }

    #[test]
    fn the_report_lists_what_was_recorded() {
        let mut probe = rendered_probe();
        probe.root_children = 0;
        probe.problems =
            vec!["blocked by CSP (script-src): tauri://localhost/assets/index.js".into()];
        let report = report_text(
            &Outcome::Blank(probe),
            Some("in no window, 1360x900, hidden false, has superview true"),
            "1.0.0-rc.24",
        );
        assert!(report.starts_with("Conduit 1.0.0-rc.24 startup check\n"));
        assert!(report.contains("the interface did not render"));
        assert!(report.contains("Root element: present, 0 children"));
        assert!(report.contains("  - blocked by CSP (script-src)"));
        assert!(report.contains("Native view: in no window"));
    }

    #[test]
    fn init_script_and_probe_avoid_newer_syntax() {
        // Both run on whatever engine the OS ships; keep them ES5.
        for script in [INIT_SCRIPT, PROBE] {
            for newer in ["=>", "let ", "const ", "`", "?.", "??"] {
                assert!(!script.contains(newer), "{newer:?} in a boot-check script");
            }
        }
    }
}
