// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! Starting and stopping the browser agents use. One process for the whole
//! app, started on first use with its own profile folder, shared by every run,
//! and closed when the last run using it ends (and when the app quits).
//!
//! The launch is deliberately an ordinary one: the user's browser with a
//! separate profile, plus the DevTools protocol on an inherited pipe (fd 3 in,
//! fd 4 out). There is no listening port, so no other program can attach. No
//! automation switches, no headless mode, no changed user agent.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::sync::broadcast::error::RecvError;

use super::cdp::{Cdp, CdpError, Event};
use super::detect::Browser;
use super::guard::{Decision, Guard};

/// The profile folder's name inside the app's data folder.
pub const PROFILE_FOLDER: &str = "browser-profile";

/// How long a starting browser has to answer its first call on the pipe.
const START_WAIT: Duration = Duration::from_secs(10);

/// How long a browser that stopped answering has to show it exited.
const EXIT_CHECK: Duration = Duration::from_secs(2);

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

/// The command line: the profile, the debugging pipe, and the quiet-start
/// switches. Nothing that marks it as automated.
pub fn launch_args(profile: &Path) -> Vec<String> {
    vec![
        format!("--user-data-dir={}", profile.display()),
        "--remote-debugging-pipe".to_string(),
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
///
/// Download and permission settings are not choices: they are set every
/// launch, whatever the file says. `downloads_dir` is a folder inside the
/// profile that nothing ever lands in.
pub fn merge_preferences(existing: Option<&str>, downloads_dir: &Path) -> String {
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
    fn set_always(root: &mut Value, path: &[&str], value: Value) {
        let mut at = root;
        for key in &path[..path.len() - 1] {
            if !at.get(*key).is_some_and(Value::is_object) {
                at[*key] = Value::Object(Map::new());
            }
            at = &mut at[*key];
        }
        at[path[path.len() - 1]] = value;
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
    // Downloads are refused over CDP at launch. These keep it that way even
    // if that call is ever lost: no "where to save" prompt, and never the
    // user's own Downloads folder.
    set_always(
        &mut root,
        &["download", "prompt_for_download"],
        json!(false),
    );
    set_always(
        &mut root,
        &["download", "default_directory"],
        json!(downloads_dir.to_string_lossy()),
    );
    // 2 = block: no permission prompts in a window nobody may be watching.
    for setting in [
        "notifications",
        "geolocation",
        "media_stream_camera",
        "media_stream_mic",
        "clipboard",
        "midi_sysex",
    ] {
        set_always(
            &mut root,
            &["profile", "default_content_setting_values", setting],
            json!(2),
        );
    }
    serde_json::to_string(&root).unwrap_or_default()
}

/// The profile's download folder. Downloads are refused, so it stays empty;
/// it exists only so the profile never points at the user's own Downloads.
pub const REFUSED_DOWNLOADS_DIR: &str = "downloads-refused";

/// Write `Default/Preferences` (before the browser runs: it rewrites the file
/// itself while open).
pub fn prepare_profile(profile: &Path) -> std::io::Result<()> {
    let folder = profile.join("Default");
    std::fs::create_dir_all(&folder)?;
    let file = folder.join("Preferences");
    let existing = std::fs::read_to_string(&file).ok();
    let downloads = profile.join(REFUSED_DOWNLOADS_DIR);
    std::fs::write(&file, merge_preferences(existing.as_deref(), &downloads))
}

/// The browser process. Dropping it ends the browser: on Windows its job
/// closes (KILL_ON_JOB_CLOSE), elsewhere `kill_on_drop`.
struct Child {
    #[cfg(windows)]
    process: super::spawn_windows::Process,
    #[cfg(unix)]
    process: tokio::process::Child,
}

impl Child {
    fn id(&self) -> Option<u32> {
        #[cfg(windows)]
        return Some(self.process.id());
        #[cfg(unix)]
        return self.process.id();
    }

    /// How it exited, once it has.
    fn exited(&mut self) -> Option<String> {
        #[cfg(windows)]
        return self.process.exit_code().map(|c| format!("exit code: {c}"));
        #[cfg(unix)]
        return match self.process.try_wait() {
            Ok(Some(status)) => Some(status.to_string()),
            _ => None,
        };
    }

    /// Start ending it (with everything it started, on Windows).
    fn start_kill(&mut self) {
        #[cfg(windows)]
        self.process.kill();
        #[cfg(unix)]
        let _ = self.process.start_kill();
    }

    /// Whether it exits within `timeout`.
    async fn wait_exit(&mut self, timeout: Duration) -> bool {
        let began = tokio::time::Instant::now();
        loop {
            if self.exited().is_some() {
                return true;
            }
            if began.elapsed() >= timeout {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

/// Start `exe args` with the DevTools pipe on its fds 3 and 4.
#[cfg(windows)]
fn spawn(exe: &Path, args: &[String]) -> std::io::Result<(Child, Arc<Cdp>)> {
    let spawned = super::spawn_windows::spawn(exe, args)?;
    let cdp = Cdp::start((spawned.from_browser, spawned.to_browser));
    Ok((
        Child {
            process: spawned.process,
        },
        cdp,
    ))
}

/// Start `exe args` with the DevTools pipe on its fds 3 and 4.
#[cfg(unix)]
fn spawn(exe: &Path, args: &[String]) -> std::io::Result<(Child, Arc<Cdp>)> {
    use std::os::fd::AsRawFd;
    // Pipe A: we write, the browser reads (fd 3). Pipe B: the browser writes
    // (fd 4), we read. All four ends are close-on-exec.
    let (child_in, to_browser) = std::io::pipe()?;
    let (from_browser, child_out) = std::io::pipe()?;
    let (read_fd, write_fd) = (child_in.as_raw_fd(), child_out.as_raw_fd());
    let mut command = tokio::process::Command::new(exe);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    // SAFETY: the closure runs in the forked child before exec and calls only
    // async-signal-safe functions (fcntl, dup2). Both ends are first copied
    // above 9 so that neither dup2 overwrites the other; those copies are
    // close-on-exec, while dup2's 3 and 4 are not, so only 3 and 4 reach the
    // browser.
    unsafe {
        command.pre_exec(move || {
            let read = libc::fcntl(read_fd, libc::F_DUPFD_CLOEXEC, 10);
            let write = libc::fcntl(write_fd, libc::F_DUPFD_CLOEXEC, 10);
            if read < 0 || write < 0 || libc::dup2(read, 3) < 0 || libc::dup2(write, 4) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let process = command.spawn()?;
    // The child has its own copies; ours must go, or reading would never see
    // the browser's end close.
    drop(child_in);
    drop(child_out);
    let cdp = Cdp::start((from_browser, to_browser));
    Ok((Child { process }, cdp))
}

struct Running {
    child: Child,
    cdp: Arc<Cdp>,
    guard: Arc<Guard>,
    browser: Browser,
    /// Guards the browser's service workers for as long as it runs.
    workers: tokio::task::JoinHandle<()>,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.workers.abort();
    }
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
            let alive = running.child.exited().is_none() && !running.cdp.is_closed();
            if alive {
                state.users += 1;
                return Ok(Lease {
                    cdp: running.cdp.clone(),
                    guard: running.guard.clone(),
                    browser: running.browser,
                });
            }
            running.child.start_kill();
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
                running.child.start_kill();
            }
            state.running = None;
            state.users = 0;
        }
    }
}

async fn start(browser: Browser, exe: &Path, profile: &Path) -> Result<Running, LaunchError> {
    let profile_dir = profile.to_path_buf();
    tokio::task::spawn_blocking(move || prepare_profile(&profile_dir))
        .await
        .map_err(|e| LaunchError::LaunchFailed(e.to_string()))?
        .map_err(|e| LaunchError::LaunchFailed(e.to_string()))?;

    let (mut child, cdp) =
        spawn(exe, &launch_args(profile)).map_err(|e| LaunchError::LaunchFailed(e.to_string()))?;

    // The first answer on the pipe says the browser is ours and running.
    if let Err(error) = cdp
        .call_within("Browser.getVersion", json!({}), None, START_WAIT)
        .await
    {
        if child.wait_exit(EXIT_CHECK).await {
            // Another process already runs on this profile and took over (or
            // the browser is too old for the pipe).
            let status = child.exited().unwrap_or_default();
            return Err(LaunchError::LaunchFailed(format!(
                "it exited at once ({status}); close any browser window using {}'s browser profile",
                crate::brand::app_name()
            )));
        }
        child.start_kill();
        return Err(LaunchError::LaunchFailed(match error {
            CdpError::Timeout => "it did not answer on its debugging pipe in time".to_string(),
            other => other.to_string(),
        }));
    }

    if let Err(error) = refuse_downloads_and_prompts(&cdp).await {
        child.start_kill();
        return Err(LaunchError::LaunchFailed(format!(
            "its downloads could not be turned off ({error})"
        )));
    }

    let guard = Arc::new(Guard::default());
    let workers = match guard_service_workers(&cdp, guard.clone()).await {
        Ok(task) => task,
        Err(error) => {
            child.start_kill();
            return Err(LaunchError::LaunchFailed(format!(
                "its service workers could not be guarded ({error})"
            )));
        }
    };
    Ok(Running {
        child,
        cdp,
        guard,
        browser,
        workers,
    })
}

/// Site permissions the agent's pages are refused without a prompt.
pub const DENIED_PERMISSIONS: [&str; 6] = [
    "notifications",
    "geolocation",
    "camera",
    "microphone",
    "clipboard-read",
    "midi",
];

/// No download is ever saved: the browser refuses them all (and reports
/// each one, so the tab can tell the agent). Permission prompts are refused
/// too, for every site, so nothing waits on a prompt nobody sees. A browser
/// that won't refuse downloads is not used.
async fn refuse_downloads_and_prompts(cdp: &Cdp) -> Result<(), CdpError> {
    cdp.call(
        "Browser.setDownloadBehavior",
        json!({ "behavior": "deny", "eventsEnabled": true }),
        None,
    )
    .await?;
    for name in DENIED_PERMISSIONS {
        // A name this browser version doesn't know is skipped; the profile's
        // own settings (see `merge_preferences`) block them as well.
        let _ = cdp
            .call(
                "Browser.setPermission",
                json!({ "permission": { "name": name }, "setting": "denied" }),
                None,
            )
            .await;
    }
    Ok(())
}

/// Service workers are targets of their own, not children of a page, so the
/// tab's guard never sees them. Attach to every one as it starts (it waits,
/// paused, until we let it run), hold its requests for the same guard, then
/// let it run.
async fn guard_service_workers(
    cdp: &Arc<Cdp>,
    guard: Arc<Guard>,
) -> Result<tokio::task::JoinHandle<()>, CdpError> {
    // Listen before anything can attach.
    let events = cdp.subscribe();
    let task = tokio::spawn(guard_worker_events(Arc::downgrade(cdp), guard, events));
    let attached = cdp
        .call(
            "Target.setAutoAttach",
            json!({
                "autoAttach": true,
                "waitForDebuggerOnStart": true,
                "flatten": true,
                "filter": [{ "type": "service_worker", "exclude": false }],
            }),
            None,
        )
        .await;
    if let Err(error) = attached {
        task.abort();
        return Err(error);
    }
    Ok(task)
}

/// The service workers' guard loop. Holds the browser only weakly, so it
/// ends with the connection.
async fn guard_worker_events(
    cdp: Weak<Cdp>,
    guard: Arc<Guard>,
    mut events: tokio::sync::broadcast::Receiver<Event>,
) {
    let mut workers: HashSet<String> = HashSet::new();
    loop {
        let event = match events.recv().await {
            Ok(event) => event,
            Err(RecvError::Lagged(_)) => continue,
            Err(RecvError::Closed) => return,
        };
        let Some(cdp) = cdp.upgrade() else {
            return;
        };
        match (event.method.as_str(), event.session_id.as_deref()) {
            // Browser-level attaches have no session of their own.
            ("Target.attachedToTarget", None)
                if event.params["targetInfo"]["type"] == "service_worker" =>
            {
                let Some(child) = event.params["sessionId"].as_str().map(str::to_string) else {
                    continue;
                };
                workers.insert(child.clone());
                tokio::spawn(async move {
                    let fetch = cdp
                        .call(
                            "Fetch.enable",
                            json!({ "patterns": [{ "urlPattern": "*" }] }),
                            Some(&child),
                        )
                        .await;
                    match fetch {
                        // Guarded: it may run now.
                        Ok(_) => {
                            let _ = cdp
                                .call("Runtime.runIfWaitingForDebugger", json!({}), Some(&child))
                                .await;
                        }
                        // Not guarded: it stays paused.
                        Err(error) => tracing::warn!(
                            %error,
                            "a service worker could not be guarded; it stays paused"
                        ),
                    }
                });
            }
            ("Target.detachedFromTarget", None) => {
                if let Some(gone) = event.params["sessionId"].as_str() {
                    workers.remove(gone);
                }
            }
            ("Fetch.requestPaused", Some(session)) if workers.contains(session) => {
                let (guard, session) = (guard.clone(), session.to_string());
                tokio::spawn(async move {
                    decide_paused(&cdp, &guard, &session, &event.params).await;
                });
            }
            _ => {}
        }
    }
}

/// Let a paused worker request go on, or fail it, as the guard says.
async fn decide_paused(cdp: &Cdp, guard: &Guard, session: &str, params: &Value) {
    let Some(request_id) = params["requestId"].as_str() else {
        return;
    };
    let url = params["request"]["url"].as_str().unwrap_or_default();
    let (method, params) = match guard.check(url).await {
        Decision::Allow => ("Fetch.continueRequest", json!({ "requestId": request_id })),
        Decision::Block(why) => {
            tracing::info!(%url, %why, "a service worker request was refused");
            (
                "Fetch.failRequest",
                json!({ "requestId": request_id, "errorReason": "BlockedByClient" }),
            )
        }
    };
    let _ = cdp.call(method, params, Some(session)).await;
}

/// Ask the browser to close, then make sure it did: this child, by its handle.
async fn close(running: &mut Running) {
    let _ = running
        .cdp
        .call_within("Browser.close", json!({}), None, Duration::from_secs(3))
        .await;
    if !running.child.wait_exit(EXIT_WAIT).await {
        running.child.start_kill();
        let _ = running.child.wait_exit(EXIT_WAIT).await;
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
            "--remote-debugging-pipe",
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
    fn args_carry_no_automation_switches_and_no_port() {
        let args = launch_args(Path::new("/p")).join(" ");
        for banned in [
            "--enable-automation",
            "--headless",
            "--disable-blink-features",
            "--disable-extensions",
            "--user-agent",
            "--remote-debugging-port",
            "--remote-debugging-address",
            "--no-sandbox",
        ] {
            assert!(!args.contains(banned), "{banned}");
        }
    }

    #[test]
    fn preferences_for_a_fresh_profile() {
        let value: Value = serde_json::from_str(&merge_preferences(None, Path::new("dl"))).unwrap();
        assert_eq!(value["credentials_enable_service"], false);
        assert_eq!(value["profile"]["password_manager_enabled"], false);
        assert_eq!(value["autofill"]["profile_enabled"], false);
        assert_eq!(value["autofill"]["credit_card_enabled"], false);
    }

    #[test]
    fn preferences_merge_keeps_what_is_there() {
        let existing = r#"{"profile":{"name":"Mine","password_manager_enabled":true},
            "autofill":{"profile_enabled":true},"homepage":"https://x.test"}"#;
        let value: Value =
            serde_json::from_str(&merge_preferences(Some(existing), Path::new("dl"))).unwrap();
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
    fn downloads_and_prompts_are_set_whatever_the_file_says() {
        let existing = r#"{"download":{"prompt_for_download":true,
            "default_directory":"C:\\Users\\me\\Downloads","directory_upgrade":true},
            "profile":{"default_content_setting_values":{"notifications":1,"popups":1}}}"#;
        let dir = Path::new("C:/data/browser-profile/downloads-refused");
        let value: Value = serde_json::from_str(&merge_preferences(Some(existing), dir)).unwrap();
        assert_eq!(value["download"]["prompt_for_download"], false);
        assert_eq!(
            value["download"]["default_directory"],
            dir.to_string_lossy().as_ref()
        );
        // Unrelated keys under the same objects are kept.
        assert_eq!(value["download"]["directory_upgrade"], true);
        let settings = &value["profile"]["default_content_setting_values"];
        assert_eq!(settings["popups"], 1);
        for blocked in [
            "notifications",
            "geolocation",
            "media_stream_camera",
            "media_stream_mic",
        ] {
            assert_eq!(settings[blocked], 2, "{blocked}");
        }
        // A non-object where an object belongs is replaced, not a reason to skip.
        let value: Value =
            serde_json::from_str(&merge_preferences(Some(r#"{"download":"x"}"#), dir)).unwrap();
        assert_eq!(value["download"]["prompt_for_download"], false);
    }

    #[test]
    fn unreadable_preferences_start_over() {
        let value: Value =
            serde_json::from_str(&merge_preferences(Some("{ not json"), Path::new("dl"))).unwrap();
        assert_eq!(value["credentials_enable_service"], false);
        let value: Value =
            serde_json::from_str(&merge_preferences(Some("[1]"), Path::new("dl"))).unwrap();
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
