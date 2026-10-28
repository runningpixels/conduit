//! Quick ask: an optional system-wide shortcut that opens a small ask box.
//!
//! Off by default (`AppSettings.quick_ask_shortcut` is `None`): nothing is
//! registered with the OS. With a shortcut set, pressing it anywhere shows the
//! `ask` window, a borderless always-on-top box with one textarea. Sending
//! hides it, brings the main window to the front (even from the tray) and
//! hands the text to the page, which asks it exactly as Home's ask box does.
//!
//! The text goes through a pending slot rather than the event payload: the
//! main page may not be listening yet (it is still booting, or onboarding),
//! so `quick-ask` only says "there is one", and the page takes it with
//! `take_pending_quick_ask` — on that event, and once on mount. Whichever
//! comes first gets it; it is never asked twice.
//!
//! The global-shortcut plugin is added from Rust only, at setup, and a failure
//! there (no X server, Wayland) is logged, never fatal. The webview gets no
//! `global-shortcut:*` permission.

use std::str::FromStr;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcut, Modifiers, Shortcut, ShortcutState};

/// The ask window's label (also listed in capabilities/default.json).
pub const ASK_WINDOW: &str = "ask";
/// Emitted to the main window when a question is waiting in the pending slot.
pub const QUICK_ASK_EVENT: &str = "quick-ask";
/// Longest shortcut string accepted (the longest real one is ~40 characters).
const MAX_SHORTCUT_CHARS: usize = 64;
/// Longest question kept; the box is for a quick question, not a document.
const MAX_QUESTION_CHARS: usize = 20_000;
const WIDTH: f64 = 640.0;
const HEIGHT: f64 = 120.0;

/// Managed state: the question waiting for the main page, and why the saved
/// shortcut isn't working (registration failed at startup), if it isn't.
#[derive(Default)]
pub struct QuickAsk {
    pending: Mutex<Option<String>>,
    error: Mutex<Option<String>>,
}

impl QuickAsk {
    /// Leave a question for the main page; a newer one replaces an older one.
    pub fn put(&self, text: String) {
        if let Ok(mut slot) = self.pending.lock() {
            *slot = Some(text);
        }
    }

    /// Take the waiting question, leaving the slot empty.
    pub fn take(&self) -> Option<String> {
        self.pending.lock().ok().and_then(|mut slot| slot.take())
    }

    fn set_error(&self, error: Option<String>) {
        if let Ok(mut slot) = self.error.lock() {
            *slot = error;
        }
    }

    pub fn error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|slot| slot.clone())
    }
}

/// What Settings shows next to the shortcut control.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickAskStatus {
    /// False where global shortcuts can't work (a Wayland session): the
    /// control is hidden with a note.
    pub supported: bool,
    /// Why the saved shortcut isn't registered, when it isn't.
    pub error: Option<String>,
}

/// Check a shortcut from a settings patch: it must parse with the plugin's
/// parser and have at least one modifier plus one other key. Returns it
/// trimmed.
pub fn validate_shortcut(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("The quick ask shortcut is empty.".to_string());
    }
    if trimmed.chars().count() > MAX_SHORTCUT_CHARS {
        return Err("The quick ask shortcut is too long.".to_string());
    }
    let parsed = Shortcut::from_str(trimmed)
        .map_err(|e| format!("\u{201c}{trimmed}\u{201d} isn't a shortcut: {e}"))?;
    let modifiers = Modifiers::SHIFT | Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER;
    if !parsed.mods.intersects(modifiers) {
        return Err(format!(
            "\u{201c}{trimmed}\u{201d} needs Ctrl, Alt, Shift or Super plus one other key."
        ));
    }
    Ok(trimmed.to_string())
}

/// Whether this is a Wayland session, where global shortcuts generally don't
/// work. Either variable is enough.
pub fn wayland_session(xdg_session_type: Option<&str>, wayland_display: Option<&str>) -> bool {
    xdg_session_type.is_some_and(|t| t.eq_ignore_ascii_case("wayland"))
        || wayland_display.is_some_and(|d| !d.is_empty())
}

/// Whether global shortcuts can work here.
pub fn supported() -> bool {
    if cfg!(target_os = "linux") {
        !wayland_session(
            std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
            std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
        )
    } else {
        true
    }
}

/// Add the global-shortcut plugin, with the handler that toggles the ask box.
/// Called once from setup, on the main thread (on Windows the hotkey window
/// must live on the thread that runs the event loop). Registers nothing.
pub fn init_plugin<R: Runtime>(app: &AppHandle<R>) {
    if !supported() {
        return;
    }
    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let app = app.clone();
                // Not inline: building a webview from an event handler can
                // deadlock on Windows.
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = toggle_ask_window(&app) {
                        tracing::warn!(%error, "quick ask window did not open");
                    }
                });
            }
        })
        .build();
    if let Err(error) = app.plugin(plugin) {
        tracing::warn!(%error, "global shortcuts are unavailable; quick ask is off");
    }
}

/// Register the saved shortcut at startup. A failure is kept for Settings to
/// show and logged; the app starts normally either way.
pub fn register_at_boot<R: Runtime>(app: &AppHandle<R>, shortcut: Option<&str>) {
    let Some(shortcut) = shortcut else { return };
    let result = apply_shortcut(app, None, Some(shortcut));
    if let Err(error) = &result {
        tracing::warn!(%error, "the quick ask shortcut was not registered");
    }
    if let Some(state) = app.try_state::<QuickAsk>() {
        state.set_error(result.err());
    }
}

/// Replace the registered shortcut (`current`) with `next` (`None` = off).
/// On failure the old one is put back and the reason returned.
pub fn apply_shortcut<R: Runtime>(
    app: &AppHandle<R>,
    current: Option<&str>,
    next: Option<&str>,
) -> Result<(), String> {
    let Some(manager) = app.try_state::<GlobalShortcut<R>>() else {
        return match next {
            None => Ok(()),
            Some(_) if !supported() => {
                Err("Global shortcuts don't work in a Wayland session.".to_string())
            }
            Some(_) => Err("Global shortcuts aren't available on this system.".to_string()),
        };
    };
    manager
        .unregister_all()
        .map_err(|e| format!("couldn't release the old shortcut: {e}"))?;
    let Some(next) = next else {
        if let Some(state) = app.try_state::<QuickAsk>() {
            state.set_error(None);
        }
        return Ok(());
    };
    match manager.register(next) {
        Ok(()) => {
            if let Some(state) = app.try_state::<QuickAsk>() {
                state.set_error(None);
            }
            Ok(())
        }
        Err(error) => {
            if let Some(current) = current {
                let _ = manager.register(current);
            }
            Err(format!(
                "\u{201c}{next}\u{201d} couldn't be set; another app may be using it ({error})."
            ))
        }
    }
}

/// The shortcut's action: show the ask box, or hide it when it is showing.
pub fn toggle_ask_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(ASK_WINDOW) {
        let showing = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        if showing && focused {
            return window.hide().map_err(|e| e.to_string());
        }
    }
    open_ask_window(app)
}

/// Show and focus the ask box, building it the first time. Built here rather
/// than from the page so it gets the main webview's browser arguments (see
/// `webview_args::MainWebviewArgs`), as the presenter view is.
pub fn open_ask_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(ASK_WINDOW) {
        let _ = window.center();
        window.show().map_err(|e| e.to_string())?;
        let _ = window.unminimize();
        return window.set_focus().map_err(|e| e.to_string());
    }
    let args = app
        .try_state::<crate::webview_args::MainWebviewArgs>()
        .ok_or("the main window isn't ready yet")?;
    let url = tauri::WebviewUrl::App("index.html?ask=1".into());
    let _window = tauri::WebviewWindowBuilder::new(app, ASK_WINDOW, url)
        .title(crate::brand::app_name())
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .center()
        .focused(true)
        .additional_browser_args(&args.0)
        .build()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    crate::webview_args::disable_webrtc(&_window).map_err(|e| e.to_string())?;
    Ok(())
}

/// Hide the ask box (Esc, focus lost, or after sending).
pub fn hide_ask_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(ASK_WINDOW) {
        let _ = window.hide();
    }
}

/// Send a question from the ask box: hide it, bring the main window forward
/// and leave the text for the main page. Empty text does nothing. Returns
/// whether anything was sent.
pub fn submit<R: Runtime>(app: &AppHandle<R>, text: &str) -> bool {
    let text = text.trim();
    if text.is_empty() {
        return false;
    }
    let text: String = text.chars().take(MAX_QUESTION_CHARS).collect();
    hide_ask_window(app);
    if let Some(state) = app.try_state::<QuickAsk>() {
        state.put(text);
    }
    crate::tray::show_main_window(app);
    let _ = app.emit_to("main", QUICK_ASK_EVENT, ());
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_modifier_plus_a_key() {
        assert_eq!(
            validate_shortcut("Ctrl+Shift+Space"),
            Ok("Ctrl+Shift+Space".to_string())
        );
        assert_eq!(validate_shortcut(" Alt+Q "), Ok("Alt+Q".to_string()));
        assert!(validate_shortcut("Super+K").is_ok());
        assert!(validate_shortcut("CmdOrCtrl+Shift+1").is_ok());
    }

    #[test]
    fn rejects_empty_modifier_only_and_bare_keys() {
        for bad in [
            "",
            "   ",
            "Ctrl",
            "Ctrl+Shift",
            "Q",
            "Space",
            "Ctrl+Nope",
            "Ctrl++Q",
            "Ctrl+Q+W",
        ] {
            assert!(validate_shortcut(bad).is_err(), "{bad:?} must be rejected");
        }
        assert!(validate_shortcut(&format!("Ctrl+{}", "A".repeat(80))).is_err());
    }

    #[test]
    fn the_pending_question_is_taken_once() {
        let state = QuickAsk::default();
        assert_eq!(state.take(), None);
        state.put("first".into());
        state.put("second".into());
        assert_eq!(state.take(), Some("second".to_string()));
        assert_eq!(state.take(), None);
    }

    #[test]
    fn detects_a_wayland_session() {
        assert!(wayland_session(Some("wayland"), None));
        assert!(wayland_session(Some("Wayland"), None));
        assert!(wayland_session(None, Some("wayland-0")));
        assert!(wayland_session(Some("x11"), Some("wayland-0")));
        assert!(!wayland_session(Some("x11"), None));
        assert!(!wayland_session(None, Some("")));
        assert!(!wayland_session(None, None));
    }
}
