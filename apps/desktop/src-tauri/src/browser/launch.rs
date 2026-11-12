// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! Starting and stopping the browser agents use. One process for the whole
//! app, started on first use with its own profile folder, shared by every run,
//! and closed when the last run using it ends (and when the app quits).
//!
//! The launch is deliberately an ordinary one: the user's browser with a
//! separate profile, plus a debugging port on loopback. No automation
//! switches, no headless mode, no changed user agent.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Map, Value};

use super::cdp::Cdp;
use super::detect::Browser;
use super::guard::Guard;

/// The profile folder's name inside the app's data folder.
pub const PROFILE_FOLDER: &str = "browser-profile";

/// How long a starting browser has to write its debugging port.
const PORT_WAIT: Duration = Duration::from_secs(10);

/// How long a closing browser has to exit before it is killed.
const EXIT_WAIT: Duration = Duration::from_secs(5);

/// What can go wrong starting or reaching the browser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchError {
    NotInstalled,
    LaunchFailed(String),
    InUse,
}

impl std::fmt::Display for LaunchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LaunchError::NotInstalled => f.write_str(
                "no supported browser is installed; install Microsoft Edge or Google Chrome",
            ),
            LaunchError::LaunchFailed(why) => write!(f, "the browser could not be started ({why})"),
            LaunchError::InUse => f.write_str("the browser profile is in use"),
        }
    }
}

/// The command line: the profile, a debugging port the browser picks, and
/// the quiet-start switches. Nothing that marks it as automated.
pub fn launch_args(profile: &Path) -> Vec<String> {
    vec![
        format!("--user-data-dir={}", profile.display()),
        "--remote-debugging-port=0".to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-sync".to_string(),
        "--autoplay-policy=user-gesture-required".to_string(),
        "about:blank".to_string(),
    ]
}

/// The settings a fresh profile starts with: no password manager, no
/// autofill. Keys already in `existing` (the browser's own file, or a choice
/// the user made in this profile) are kept as they are.
pub fn merge_preferences(existing: Option<&str>) -> String {
    let mut root: Value = existing
        .and_then(|raw| serde_json::from_str(raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    fn set_default(root: &mut Value, path: &[&str], value: Value) {
        let mut at = root;
        for key in &path[..path.len() - 1] {
            if !at.get(*key).is_some_and(Value::is_object) {
                if at.get(*key).is_some() {
                    return;
                }
                at[*key] = Value::Object(Map::new());
            }
            at = &mut at[*key];
        }
        let last = path[path.len() - 1];
        if at.get(last).is_none() {
            at[last] = value;
        }
    }
    set_default(&mut root, &["credentials_enable_service"], json!(false));
    set_default(
        &mut root,
        &["profile", "password_manager_enabled"],
        json!(false),
    );
    set_default(&mut root, &["autofill", "profile_enabled"], json!(false));
    set_default(
        &mut root,
        &["autofill", "credit_card_enabled"],
        json!(false),
    );
    serde_json::to_string(&root).unwrap_or_default()
}

/// Write `Default/Preferences` (before the browser runs: it rewrites the file
/// itself while open).
pub fn prepare_profile(profile: &Path) -> std::io::Result<()> {
    let folder = profile.join("Default");
    std::fs::create_dir_all(&folder)?;
    let file = folder.join("Preferences");
    let existing = std::fs::read_to_string(&file).ok();
    std::fs::write(&file, merge_preferences(existing.as_deref()))
}

/// The port and websocket path in a `DevToolsActivePort` file: the port on
/// the first line, the browser's path on the second.
pub fn parse_active_port(contents: &str) -> Option<(u16, String)> {
    let mut lines = contents.lines();
    let port: u16 = lines.next()?.trim().parse().ok()?;
    let path = lines.next()?.trim().to_string();
    (port != 0 && path.starts_with('/')).then_some((port, path))
}

pub fn websocket_url(port: u16, path: &str) -> String {
    format!("ws://127.0.0.1:{port}{path}")
}

struct Running {
    child: tokio::process::Child,
    cdp: Arc<Cdp>,
    guard: Arc<Guard>,
    browser: Browser,
}

#[derive(Default)]
struct State {
    running: Option<Running>,
    users: usize,
}

/// What a run holds while it uses the browser.
pub struct Lease {
    pub cdp: Arc<Cdp>,
    pub guard: Arc<Guard>,
    pub browser: Browser,
}

/// The one browser of the app.
#[derive(Default)]
pub struct BrowserHost {
    state: tokio::sync::Mutex<State>,
}

/// The app's browser host.
pub fn host() -> &'static BrowserHost {
    static HOST: std::sync::OnceLock<BrowserHost> = std::sync::OnceLock::new();
    HOST.get_or_init(BrowserHost::default)
}

/// Close the browser when the app quits (it would otherwise outlive it).
pub fn shutdown() {
    host().kill_now();
}

impl BrowserHost {
    /// Join the running browser, starting `exe` first when none is running.
    /// A browser already running is used whichever was asked for.
    pub async fn acquire(
        &self,
        browser: Browser,
        exe: &Path,
        profile: &Path,
    ) -> Result<Lease, LaunchError> {
        let mut guard = self.state.lock().await;
        let state = &mut *guard;
        if let Some(running) = &mut state.running {
            let alive = matches!(running.child.try_wait(), Ok(None)) && !running.cdp.is_closed();
            if alive {
                state.users += 1;
                return Ok(Lease {
                    cdp: running.cdp.clone(),
                    guard: running.guard.clone(),
                    browser: running.browser,
                });
            }
            let _ = running.child.start_kill();
            state.running = None;
        }
        let running = start(browser, exe, profile).await?;
        let lease = Lease {
            cdp: running.cdp.clone(),
            guard: running.guard.clone(),
            browser,
        };
        state.running = Some(running);
        state.users = 1;
        Ok(lease)
    }

    /// A run is done with the browser; the last one out closes it.
    pub async fn release(&self) {
        let mut state = self.state.lock().await;
        state.users = state.users.saturating_sub(1);
        if state.users == 0 {
            if let Some(mut running) = state.running.take() {
                close(&mut running).await;
            }
        }
    }

    /// Delete the profile folder. Not while the browser runs, or while
    /// something else still holds files in it.
    pub async fn reset_profile(&self, profile: &Path) -> Result<(), LaunchError> {
        let state = self.state.lock().await;
        if state.running.is_some() {
            return Err(LaunchError::InUse);
        }
        if !profile.exists() {
            return Ok(());
        }
        let profile = profile.to_path_buf();
        let removed = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&profile))
            .await
            .map_err(|e| LaunchError::LaunchFailed(e.to_string()))?;
        removed.map_err(|_| LaunchError::InUse)
    }

    /// Whether a browser is running for a run now.
    pub async fn is_running(&self) -> bool {
        self.state.lock().await.running.is_some()
    }

    /// The running browser's process id (for logs and the integration test).
    pub async fn pid(&self) -> Option<u32> {
        self.state
            .lock()
            .await
            .running
            .as_ref()
            .and_then(|r| r.child.id())
    }

    fn kill_now(&self) {
        if let Ok(mut state) = self.state.try_lock() {
            if let Some(running) = &mut state.running {
                let _ = running.child.start_kill();
            }
            state.running = None;
            state.users = 0;
        }
    }
}

async fn start(browser: Browser, exe: &Path, profile: &Path) -> Result<Running, LaunchError> {
    let profile_dir = profile.to_path_buf();
    tokio::task::spawn_blocking(move || {
        prepare_profile(&profile_dir)?;
        // A file left by an earlier run would be read as this launch's port.
        let _ = std::fs::remove_file(profile_dir.join("DevToolsActivePort"));
        Ok::<_, std::io::Error>(())
    })
    .await
    .map_err(|e| LaunchError::LaunchFailed(e.to_string()))?
    .map_err(|e| LaunchError::LaunchFailed(e.to_string()))?;

    let mut command = tokio::process::Command::new(exe);
    command
        .args(launch_args(profile))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| LaunchError::LaunchFailed(e.to_string()))?;

    let port_file = profile.join("DevToolsActivePort");
    let waited = tokio::time::Instant::now();
    let ws_url = loop {
        if let Some((port, path)) = std::fs::read_to_string(&port_file)
            .ok()
            .and_then(|c| parse_active_port(&c))
        {
            break websocket_url(port, &path);
        }
        if let Ok(Some(status)) = child.try_wait() {
            // Another process already runs on this profile and took over.
            return Err(LaunchError::LaunchFailed(format!(
                "it exited at once ({status}); close any browser window using {}'s browser profile",
                crate::brand::app_name()
            )));
        }
        if waited.elapsed() > PORT_WAIT {
            let _ = child.start_kill();
            return Err(LaunchError::LaunchFailed(
                "it did not open its debugging port in time".to_string(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let cdp = match Cdp::connect(&ws_url).await {
        Ok(cdp) => cdp,
        Err(e) => {
            let _ = child.start_kill();
            return Err(LaunchError::LaunchFailed(e.to_string()));
        }
    };
    Ok(Running {
        child,
        cdp,
        guard: Arc::new(Guard::default()),
        browser,
    })
}

/// Ask the browser to close, then make sure it did: this child, by its handle.
async fn close(running: &mut Running) {
    let _ = running
        .cdp
        .call_within("Browser.close", json!({}), None, Duration::from_secs(3))
        .await;
    if tokio::time::timeout(EXIT_WAIT, running.child.wait())
        .await
        .is_err()
    {
        let _ = running.child.kill().await;
    }
}

/// The profile folder inside the app's data folder.
pub fn profile_dir(app_data: &Path) -> PathBuf {
    app_data.join(PROFILE_FOLDER)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_are_the_quiet_ordinary_launch() {
        let args = launch_args(Path::new("C:/data/browser-profile"));
        assert_eq!(args[0], "--user-data-dir=C:/data/browser-profile");
        for expected in [
            "--remote-debugging-port=0",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-sync",
            "--autoplay-policy=user-gesture-required",
        ] {
            assert!(args.iter().any(|a| a == expected), "{expected}");
        }
        assert_eq!(args.last().unwrap(), "about:blank");
    }

    #[test]
    fn args_carry_no_automation_switches() {
        let args = launch_args(Path::new("/p")).join(" ");
        for banned in [
            "--enable-automation",
            "--headless",
            "--disable-blink-features",
            "--disable-extensions",
            "--user-agent",
            "--remote-debugging-pipe",
            "--no-sandbox",
        ] {
            assert!(!args.contains(banned), "{banned}");
        }
    }

    #[test]
    fn preferences_for_a_fresh_profile() {
        let value: Value = serde_json::from_str(&merge_preferences(None)).unwrap();
        assert_eq!(value["credentials_enable_service"], false);
        assert_eq!(value["profile"]["password_manager_enabled"], false);
        assert_eq!(value["autofill"]["profile_enabled"], false);
        assert_eq!(value["autofill"]["credit_card_enabled"], false);
    }

    #[test]
    fn preferences_merge_keeps_what_is_there() {
        let existing = r#"{"profile":{"name":"Mine","password_manager_enabled":true},
            "autofill":{"profile_enabled":true},"homepage":"https://x.test"}"#;
        let value: Value = serde_json::from_str(&merge_preferences(Some(existing))).unwrap();
        assert_eq!(value["homepage"], "https://x.test");
        assert_eq!(value["profile"]["name"], "Mine");
        // A choice already made in the profile is not overridden.
        assert_eq!(value["profile"]["password_manager_enabled"], true);
        assert_eq!(value["autofill"]["profile_enabled"], true);
        // What was missing is filled in.
        assert_eq!(value["autofill"]["credit_card_enabled"], false);
        assert_eq!(value["credentials_enable_service"], false);
    }

    #[test]
    fn unreadable_preferences_start_over() {
        let value: Value = serde_json::from_str(&merge_preferences(Some("{ not json"))).unwrap();
        assert_eq!(value["credentials_enable_service"], false);
        let value: Value = serde_json::from_str(&merge_preferences(Some("[1]"))).unwrap();
        assert_eq!(value["profile"]["password_manager_enabled"], false);
    }

    #[test]
    fn prepare_profile_writes_and_then_merges() {
        let dir = tempfile::tempdir().unwrap();
        prepare_profile(dir.path()).unwrap();
        let file = dir.path().join("Default").join("Preferences");
        let first: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(first["credentials_enable_service"], false);
        let mut edited = first.clone();
        edited["homepage"] = json!("https://kept.test");
        std::fs::write(&file, edited.to_string()).unwrap();
        prepare_profile(dir.path()).unwrap();
        let again: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(again["homepage"], "https://kept.test");
    }

    #[test]
    fn the_active_port_file_is_read() {
        assert_eq!(
            parse_active_port("51234\n/devtools/browser/abc-def\n"),
            Some((51234, "/devtools/browser/abc-def".to_string()))
        );
        assert_eq!(
            parse_active_port("51234\r\n/devtools/browser/abc\r\n"),
            Some((51234, "/devtools/browser/abc".to_string()))
        );
        assert_eq!(parse_active_port("51234\n"), None);
        assert_eq!(parse_active_port(""), None);
        assert_eq!(parse_active_port("abc\n/x\n"), None);
        assert_eq!(parse_active_port("0\n/devtools/browser/x\n"), None);
        assert_eq!(
            websocket_url(51234, "/devtools/browser/abc"),
            "ws://127.0.0.1:51234/devtools/browser/abc"
        );
    }

    #[tokio::test]
    async fn reset_removes_the_profile_when_nothing_runs() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join(PROFILE_FOLDER);
        prepare_profile(&profile).unwrap();
        let host = BrowserHost::default();
        host.reset_profile(&profile).await.unwrap();
        assert!(!profile.exists());
        // Nothing to delete is fine.
        host.reset_profile(&profile).await.unwrap();
    }
}
