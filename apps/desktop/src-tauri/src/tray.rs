//! Keep running with the window closed: the tray icon, close-to-tray, start at
//! sign-in, and the "open the one that's already running" path.
//!
//! All of it is opt-in (`AppSettings.close_to_tray`, off by default): without
//! it, closing the window quits exactly as before and there is no tray icon.
//! With it, closing the main window hides it, the scheduler keeps running, and
//! the tray icon opens the window again or quits.
//!
//! The menu labels are the renderer's translations (`set_tray_labels`), since
//! Rust has no locale; English is used until the renderer sends them.

use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

/// The one tray icon's id.
pub const TRAY_ID: &str = "main";
/// Argument the start-at-sign-in entry launches with: start in the tray.
pub const BACKGROUND_ARG: &str = "--background";
const MAX_LABEL_CHARS: usize = 80;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayLabels {
    pub open: String,
    pub quit: String,
    pub tooltip: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            open: "Open".to_string(),
            quit: "Quit".to_string(),
            tooltip: crate::brand::app_name().to_string(),
        }
    }
}

impl TrayLabels {
    /// Labels from the renderer, trimmed and length-capped; an empty one keeps
    /// its current text.
    pub fn merged(&self, open: &str, quit: &str, tooltip: &str) -> Self {
        let pick = |new: &str, old: &str| {
            let new: String = new.trim().chars().take(MAX_LABEL_CHARS).collect();
            if new.is_empty() {
                old.to_string()
            } else {
                new
            }
        };
        Self {
            open: pick(open, &self.open),
            quit: pick(quit, &self.quit),
            tooltip: pick(tooltip, &self.tooltip),
        }
    }
}

#[derive(Default)]
pub struct TrayState {
    pub labels: Mutex<TrayLabels>,
}

/// Show, restore and focus the main window.
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn menu<R: Runtime>(app: &AppHandle<R>, labels: &TrayLabels) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(app, "open", &labels.open, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", &labels.quit, true, None::<&str>)?;
    Menu::with_items(app, &[&open, &quit])
}

fn labels<R: Runtime>(app: &AppHandle<R>) -> TrayLabels {
    app.try_state::<TrayState>()
        .and_then(|s| s.labels.lock().ok().map(|l| l.clone()))
        .unwrap_or_default()
}

/// Add the tray icon when `enabled`, remove it when not. Idempotent.
pub fn ensure_tray<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> tauri::Result<()> {
    let exists = app.tray_by_id(TRAY_ID).is_some();
    if !enabled {
        if exists {
            app.remove_tray_by_id(TRAY_ID);
        }
        return Ok(());
    }
    if exists {
        return Ok(());
    }
    let labels = labels(app);
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(&labels.tooltip)
        .menu(&menu(app, &labels)?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Re-apply the current labels to an existing tray icon.
pub fn refresh_labels<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let labels = labels(app);
        tray.set_menu(Some(menu(app, &labels)?))?;
        tray.set_tooltip(Some(&labels.tooltip))?;
    }
    Ok(())
}

/// Whether this launch should start hidden in the tray: started at sign-in
/// (`--background`) and the user keeps Conduit running in the tray.
pub fn start_hidden(args: impl IntoIterator<Item = String>, close_to_tray: bool) -> bool {
    close_to_tray && args.into_iter().any(|a| a == BACKGROUND_ARG)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_from_the_renderer_are_trimmed_capped_and_never_emptied() {
        let base = TrayLabels::default();
        let merged = base.merged("  Öffnen ", "", &"x".repeat(200));
        assert_eq!(merged.open, "Öffnen");
        assert_eq!(merged.quit, "Quit");
        assert_eq!(merged.tooltip.chars().count(), MAX_LABEL_CHARS);
    }

    #[test]
    fn starts_hidden_only_from_sign_in_with_the_tray_on() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(start_hidden(args(&["conduit.exe", "--background"]), true));
        assert!(
            !start_hidden(args(&["conduit.exe", "--background"]), false),
            "no tray: show the window"
        );
        assert!(
            !start_hidden(args(&["conduit.exe"]), true),
            "opened by hand: show the window"
        );
    }
}
