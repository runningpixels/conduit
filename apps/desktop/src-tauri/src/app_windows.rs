//! Saved apps in windows of their own (`app-<id>`, page `index.html?app=<id>`):
//! just the app, its Conduit-drawn header and status strip, no rail.
//!
//! Opened from the app's ⋯ menu, or from an installed app's launcher
//! (`app_install`), which starts Conduit with `--open-app <id>`:
//! - Conduit running: the single-instance plugin hands the arguments over
//!   ([`handle_second_launch`]) and only the app window comes forward.
//! - Not running: Conduit starts with its main window hidden
//!   ([`launch_request`]) and opens the app.
//!
//! When the last app window closes and the main window is hidden, Conduit
//! quits unless it keeps running in the tray ([`after_app_window_closed`]),
//! so a launcher never leaves an invisible Conduit behind.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow};

use crate::{app_install::Installer, db::repository::apps, state::AppState, tray};

pub const APP_WINDOW_PREFIX: &str = "app-";
pub const OPEN_APP_ARG: &str = "--open-app";
/// An app was edited, updated, installed, removed or deleted. Payload [`AppChanged`].
pub const APP_CHANGED_EVENT: &str = "app-changed";
/// "Open in Conduit" from an app window: the main page opens this app id.
pub const OPEN_APP_IN_MAIN_EVENT: &str = "open-app-in-main";

const DEFAULT_WIDTH: f64 = 1040.0;
const DEFAULT_HEIGHT: f64 = 760.0;

/// App ids are UUIDs; accept that shape loosely, refuse anything that could
/// be a path or an option.
pub fn is_valid_app_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('-')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn window_label(app_id: &str) -> String {
    format!("{APP_WINDOW_PREFIX}{app_id}")
}

pub fn is_app_window(label: &str) -> bool {
    label.starts_with(APP_WINDOW_PREFIX)
}

/// The app a launch asks for: `--open-app <id>` or `--open-app=<id>`.
pub fn launch_request(args: impl IntoIterator<Item = String>) -> Option<String> {
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let id = if arg == OPEN_APP_ARG {
            args.next()
        } else {
            arg.strip_prefix(OPEN_APP_ARG)
                .and_then(|rest| rest.strip_prefix('='))
                .map(str::to_string)
        };
        if let Some(id) = id {
            return is_valid_app_id(&id).then_some(id);
        }
    }
    None
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AppChangeKind {
    Updated,
    /// Installed on or removed from this computer: the app itself is unchanged.
    Installed,
    Deleted,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppChanged {
    pub id: String,
    pub kind: AppChangeKind,
}

pub fn emit_app_changed<R: Runtime>(app: &AppHandle<R>, id: &str, kind: AppChangeKind) {
    let _ = app.emit(
        APP_CHANGED_EVENT,
        AppChanged {
            id: id.to_string(),
            kind,
        },
    );
}

/// The installer for this system, if it has the folders installs need.
pub fn installer<R: Runtime>(app: &AppHandle<R>) -> Option<Installer> {
    let state = app.try_state::<AppState>()?;
    let roots = crate::app_install::Roots::system()?;
    let exe = std::env::var_os("APPIMAGE")
        .filter(|_| cfg!(target_os = "linux"))
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::current_exe().ok())?;
    let identifier = app.config().identifier.clone();
    let index_file = if cfg!(windows) {
        app.path()
            .app_local_data_dir()
            .ok()
            .map(|d| d.join("app-shortcuts.txt"))
    } else {
        None
    };
    Some(Installer {
        data_dir: state.paths.root.join("installed-apps"),
        roots,
        brand: crate::brand::app_name().to_string(),
        identifier,
        exe,
        index_file,
    })
}

/// A second launch (`conduit-desktop --open-app <id>` while running): open
/// that app. Returns false if the arguments ask for no app.
pub fn handle_second_launch<R: Runtime>(app: &AppHandle<R>, args: &[String]) -> bool {
    let Some(id) = launch_request(args.iter().cloned()) else {
        return false;
    };
    spawn_open(app, id);
    true
}

/// Open the app window from a context that can't wait for it.
pub fn spawn_open<R: Runtime>(app: &AppHandle<R>, id: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = open_app_window(&app, &id).await {
            tracing::warn!(%error, app_id = %id, "could not open the app window");
        }
    });
}

/// Show the app's window, building it the first time.
pub async fn open_app_window<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    if !is_valid_app_id(id) {
        return Err("invalid app id".into());
    }
    let label = window_label(id);
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.show();
        let _ = window.unminimize();
        return window.set_focus().map_err(|e| e.to_string());
    }
    let state = app.state::<AppState>();
    let summary = apps::get_summary(&state.db, &state.encryption, id)
        .await
        .map_err(|e| e.to_string())?;
    let Some(summary) = summary else {
        app_gone(app, id);
        return Err("That app no longer exists.".into());
    };
    let args = app
        .try_state::<crate::webview_args::MainWebviewArgs>()
        .ok_or("the main window isn't ready yet")?;
    let url = WebviewUrl::App(format!("index.html?app={id}").into());
    let window = tauri::WebviewWindowBuilder::new(app, &label, url)
        .title(&summary.name)
        .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
        .min_inner_size(360.0, 320.0)
        .center()
        .focused(true)
        .additional_browser_args(&args.0)
        .build()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    crate::webview_args::disable_webrtc(&window).map_err(|e| e.to_string())?;
    let installer = installer(app);
    if let Some(png) = installer.as_ref().and_then(|i| i.window_icon_png(id)) {
        match tauri::image::Image::from_bytes(&png) {
            Ok(icon) => {
                let _ = window.set_icon(icon);
            }
            Err(error) => tracing::debug!(%error, "app icon not usable as a window icon"),
        }
    }
    #[cfg(windows)]
    set_window_identity(app, &window, id, &summary.name, installer.as_ref());
    #[cfg(not(windows))]
    let _ = (&window, installer);
    Ok(())
}

#[cfg(windows)]
fn set_window_identity<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    id: &str,
    name: &str,
    installer: Option<&Installer>,
) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let exe = installer
        .map(|i| i.exe.clone())
        .or_else(|| std::env::current_exe().ok());
    let Some(exe) = exe else {
        return;
    };
    let identity = taskbar::WindowIdentity {
        app_user_model_id: taskbar::app_user_model_id(&app.config().identifier, id),
        relaunch_command: format!("\"{}\" {OPEN_APP_ARG} {id}", exe.display()),
        display_name: name.to_string(),
        icon: installer.and_then(|i| i.ico_path(id)),
    };
    if let Err(error) = taskbar::set_for_window(hwnd.0 as isize, &identity) {
        tracing::debug!(%error, "could not give the app window its own taskbar button");
    }
}

/// The app was deleted but a launcher still points at it: remove the
/// launcher, show the main window and say so.
fn app_gone<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Some(installer) = installer(app) {
        let _ = installer.uninstall(id);
    }
    tray::show_main_window(app);
    let name = crate::brand::app_name().to_string();
    std::thread::spawn(move || {
        let _ = rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Info)
            .set_title(&name)
            .set_description(format!(
                "That app is no longer in {name}, so its shortcut was removed."
            ))
            .set_buttons(rfd::MessageButtons::Ok)
            .show();
    });
}

/// Open app windows other than `except`.
pub fn open_app_windows<R: Runtime>(app: &AppHandle<R>, except: Option<&str>) -> usize {
    app.webview_windows()
        .keys()
        .filter(|label| is_app_window(label) && Some(label.as_str()) != except)
        .count()
}

/// Whether a closing main window should only hide: app windows are open and
/// there is no tray to bring it back from (closing would leave nothing to
/// reopen it with, as a second launch only shows the main window).
pub fn main_should_hide_for_apps<R: Runtime>(app: &AppHandle<R>) -> bool {
    open_app_windows(app, None) > 0
}

/// An app window closed. With the main window hidden, no other app window
/// and no tray, nothing visible is left: quit (asking first if workflows
/// are running, as closing the main window does).
pub fn after_app_window_closed<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if open_app_windows(app, Some(label)) > 0 {
        return;
    }
    let main_visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if main_visible {
        return;
    }
    let keeps_tray = app
        .try_state::<AppState>()
        .and_then(|s| s.settings().ok())
        .is_some_and(|s| s.close_to_tray)
        && app.tray_by_id(tray::TRAY_ID).is_some();
    if keeps_tray {
        return;
    }
    if app
        .try_state::<Arc<crate::workflows::scheduler::RunningWorkflows>>()
        .is_some_and(|r| r.count() > 0)
    {
        tray::show_main_window(app);
    }
    tray::request_quit(app);
}

/// Windows taskbar identity for app windows and their shortcuts.
#[cfg(windows)]
pub mod taskbar {
    use std::path::PathBuf;

    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::{
            Foundation::HWND,
            Storage::EnhancedStorage::{
                PKEY_AppUserModel_ID, PKEY_AppUserModel_RelaunchCommand,
                PKEY_AppUserModel_RelaunchDisplayNameResource,
                PKEY_AppUserModel_RelaunchIconResource,
            },
            System::{
                Com::StructuredStorage::{PropVariantClear, PROPVARIANT},
                Variant::VT_LPWSTR,
            },
            UI::Shell::{
                PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow},
                SHStrDupW,
            },
        },
    };

    /// `<identifier>.app.<id>`, under the 128-character limit.
    pub fn app_user_model_id(identifier: &str, app_id: &str) -> String {
        format!("{identifier}.app.{app_id}")
            .chars()
            .take(128)
            .collect()
    }

    /// A string PROPVARIANT, cleared on drop.
    pub struct OwnedPropVariant(pub PROPVARIANT);

    impl Drop for OwnedPropVariant {
        fn drop(&mut self) {
            unsafe {
                let _ = PropVariantClear(&mut self.0);
            }
        }
    }

    pub fn string_propvariant(text: &str) -> windows::core::Result<OwnedPropVariant> {
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let dup: PWSTR = SHStrDupW(PCWSTR(wide.as_ptr()))?;
            let mut value = PROPVARIANT::default();
            let inner = &mut *value.Anonymous.Anonymous;
            inner.vt = VT_LPWSTR;
            inner.Anonymous.pwszVal = dup;
            Ok(OwnedPropVariant(value))
        }
    }

    pub struct WindowIdentity {
        pub app_user_model_id: String,
        pub relaunch_command: String,
        pub display_name: String,
        pub icon: Option<PathBuf>,
    }

    /// Give a window its own taskbar button. The relaunch properties make
    /// "Pin to taskbar" pin the app, not Conduit; they go before the id.
    pub fn set_for_window(hwnd: isize, identity: &WindowIdentity) -> windows::core::Result<()> {
        unsafe {
            let store: IPropertyStore = SHGetPropertyStoreForWindow(HWND(hwnd as *mut _))?;
            let command = string_propvariant(&identity.relaunch_command)?;
            store.SetValue(&PKEY_AppUserModel_RelaunchCommand, &command.0)?;
            let name = string_propvariant(&identity.display_name)?;
            store.SetValue(&PKEY_AppUserModel_RelaunchDisplayNameResource, &name.0)?;
            if let Some(icon) = &identity.icon {
                let icon = string_propvariant(&format!("{},0", icon.display()))?;
                store.SetValue(&PKEY_AppUserModel_RelaunchIconResource, &icon.0)?;
            }
            let id = string_propvariant(&identity.app_user_model_id)?;
            store.SetValue(&PKEY_AppUserModel_ID, &id.0)?;
            store.Commit()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reads_the_app_a_launch_asks_for() {
        let id = "0b7c6a8e-1d2f-4a3b-9c4d-5e6f7a8b9c0d";
        assert_eq!(
            launch_request(args(&["conduit.exe", "--open-app", id])),
            Some(id.into())
        );
        assert_eq!(
            launch_request(args(&["conduit.exe", &format!("--open-app={id}")])),
            Some(id.into())
        );
        assert_eq!(
            launch_request(args(&["conduit", "-psn_0_123", "--open-app", id])),
            Some(id.into())
        );
        assert_eq!(launch_request(args(&["conduit.exe"])), None);
        assert_eq!(launch_request(args(&["conduit.exe", "--background"])), None);
        assert_eq!(launch_request(args(&["conduit.exe", "--open-app"])), None);
    }

    #[test]
    fn refuses_ids_that_could_be_paths_or_options() {
        for bad in [
            "../x",
            "a/b",
            "a\\b",
            "--background",
            "",
            "a b",
            "é",
            &"a".repeat(65),
        ] {
            assert!(!is_valid_app_id(bad), "{bad:?}");
            assert_eq!(
                launch_request(args(&["c", "--open-app", bad])),
                None,
                "{bad:?}"
            );
        }
        assert!(is_valid_app_id("0b7c6a8e-1d2f-4a3b-9c4d-5e6f7a8b9c0d"));
    }

    #[test]
    fn app_windows_are_told_apart_by_label() {
        assert_eq!(window_label("abc"), "app-abc");
        assert!(is_app_window("app-abc"));
        assert!(!is_app_window("main"));
        assert!(!is_app_window("ask"));
    }

    #[cfg(windows)]
    #[test]
    fn taskbar_ids_stay_under_the_limit() {
        let id =
            taskbar::app_user_model_id(&"x".repeat(120), "0b7c6a8e-1d2f-4a3b-9c4d-5e6f7a8b9c0d");
        assert_eq!(id.chars().count(), 128);
    }
}
