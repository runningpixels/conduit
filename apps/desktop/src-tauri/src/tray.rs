//! Keep running with the window closed: the tray icon, close-to-tray, start at
//! sign-in, and the "open the one that's already running" path.
//!
//! All of it is opt-in (`AppSettings.close_to_tray`, off by default): without
//! it, closing the window quits exactly as before and there is no tray icon.
//! With it, closing the main window hides it, the scheduler keeps running, and
//! the tray icon opens the window again or quits.
//!
//! While workflows run, the menu says how many and offers "Stop all", and
//! quitting (from the tray, or closing the window with the tray off) asks
//! first, then stops them so no run is left half-recorded.
//!
//! The text is the renderer's translation (`set_tray_labels`), since Rust has
//! no locale. The counted strings arrive formatted for one count; when the
//! count has moved on since, English is used until the renderer catches up.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::workflows::scheduler::RunningWorkflows;

/// The one tray icon's id.
pub const TRAY_ID: &str = "main";
/// Argument the start-at-sign-in entry launches with: start in the tray.
pub const BACKGROUND_ARG: &str = "--background";
const MAX_LABEL_CHARS: usize = 80;
const MAX_BODY_CHARS: usize = 300;
/// How long quitting waits for stopped runs to record that they stopped.
const STOP_GRACE: Duration = Duration::from_secs(5);

/// Everything the tray and the quit prompt say, as the renderer sends it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayLabels {
    pub open: String,
    pub quit: String,
    pub tooltip: String,
    /// The run count `running` and `confirm_body` were formatted for.
    pub count: usize,
    /// "2 workflows running".
    pub running: String,
    pub stop_all: String,
    pub confirm_title: String,
    /// "Quitting stops 2 running workflows."
    pub confirm_body: String,
    pub confirm_quit: String,
    pub confirm_cancel: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            open: "Open".into(),
            quit: "Quit".into(),
            tooltip: crate::brand::app_name().into(),
            count: 0,
            running: String::new(),
            stop_all: "Stop all workflows".into(),
            confirm_title: "Workflows are running".into(),
            confirm_body: String::new(),
            confirm_quit: "Stop and quit".into(),
            confirm_cancel: "Cancel".into(),
        }
    }
}

fn clip(text: &str, max: usize) -> String {
    text.trim().chars().take(max).collect()
}

impl TrayLabels {
    /// Labels from the renderer, trimmed and length-capped; an empty one keeps
    /// its current text.
    pub fn merged(&self, new: &TrayLabels) -> Self {
        let pick = |new: &str, old: &str, max: usize| {
            let new = clip(new, max);
            if new.is_empty() {
                old.to_string()
            } else {
                new
            }
        };
        Self {
            open: pick(&new.open, &self.open, MAX_LABEL_CHARS),
            quit: pick(&new.quit, &self.quit, MAX_LABEL_CHARS),
            tooltip: pick(&new.tooltip, &self.tooltip, MAX_LABEL_CHARS),
            count: new.count,
            running: clip(&new.running, MAX_LABEL_CHARS),
            stop_all: pick(&new.stop_all, &self.stop_all, MAX_LABEL_CHARS),
            confirm_title: pick(&new.confirm_title, &self.confirm_title, MAX_LABEL_CHARS),
            confirm_body: clip(&new.confirm_body, MAX_BODY_CHARS),
            confirm_quit: pick(&new.confirm_quit, &self.confirm_quit, MAX_LABEL_CHARS),
            confirm_cancel: pick(&new.confirm_cancel, &self.confirm_cancel, MAX_LABEL_CHARS),
        }
    }

    /// "N running" for the menu, translated when formatted for `count`.
    pub fn running_for(&self, count: usize) -> String {
        if self.count == count && !self.running.is_empty() {
            return self.running.clone();
        }
        match count {
            1 => "1 workflow running".into(),
            n => format!("{n} workflows running"),
        }
    }

    /// The quit prompt's body, translated when formatted for `count`.
    pub fn confirm_body_for(&self, count: usize) -> String {
        if self.count == count && !self.confirm_body.is_empty() {
            return self.confirm_body.clone();
        }
        match count {
            1 => "Quitting stops 1 running workflow.".into(),
            n => format!("Quitting stops {n} running workflows."),
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

fn running_count<R: Runtime>(app: &AppHandle<R>) -> usize {
    app.try_state::<Arc<RunningWorkflows>>()
        .map(|r| r.count())
        .unwrap_or(0)
}

fn menu<R: Runtime>(
    app: &AppHandle<R>,
    labels: &TrayLabels,
    count: usize,
) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    if count > 0 {
        let running = MenuItem::with_id(
            app,
            "running",
            labels.running_for(count),
            false,
            None::<&str>,
        )?;
        let stop = MenuItem::with_id(app, "stop_all", &labels.stop_all, true, None::<&str>)?;
        menu.append_items(&[&running, &stop, &PredefinedMenuItem::separator(app)?])?;
    }
    let open = MenuItem::with_id(app, "open", &labels.open, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", &labels.quit, true, None::<&str>)?;
    menu.append_items(&[&open, &quit])?;
    Ok(menu)
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
        .menu(&menu(app, &labels, running_count(app))?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "stop_all" => {
                if let Some(running) = app.try_state::<Arc<RunningWorkflows>>() {
                    running.stop_all();
                }
            }
            "quit" => request_quit(app),
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

/// Rebuild the menu from the current labels and run count.
pub fn refresh<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let labels = labels(app);
        tray.set_menu(Some(menu(app, &labels, running_count(app))?))?;
        tray.set_tooltip(Some(&labels.tooltip))?;
    }
    Ok(())
}

/// Quit, asking first while workflows are running. Confirmed, the runs are
/// stopped and given a moment to record it before the app exits.
pub fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    let count = running_count(app);
    if count == 0 {
        app.exit(0);
        return;
    }
    let labels = labels(app);
    let handle = app.clone();
    let mut dialog = app
        .dialog()
        .message(labels.confirm_body_for(count))
        .title(&labels.confirm_title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            labels.confirm_quit.clone(),
            labels.confirm_cancel.clone(),
        ));
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            dialog = dialog.parent(&window);
        }
    }
    dialog.show(move |confirmed| {
        if confirmed {
            stop_all_and_exit(handle);
        }
    });
}

fn stop_all_and_exit<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        if let Some(running) = app.try_state::<Arc<RunningWorkflows>>() {
            running.stop_all();
            let deadline = Instant::now() + STOP_GRACE;
            while running.count() > 0 && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        app.exit(0);
    });
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
        let merged = base.merged(&TrayLabels {
            open: "  Öffnen ".into(),
            quit: String::new(),
            tooltip: "x".repeat(200),
            ..TrayLabels::default()
        });
        assert_eq!(merged.open, "Öffnen");
        assert_eq!(merged.quit, "Quit");
        assert_eq!(merged.tooltip.chars().count(), MAX_LABEL_CHARS);
    }

    #[test]
    fn counted_text_is_used_only_for_the_count_it_was_formatted_for() {
        let labels = TrayLabels::default().merged(&TrayLabels {
            count: 2,
            running: "2 Workflows laufen".into(),
            confirm_body: "Beenden stoppt 2 laufende Workflows.".into(),
            ..TrayLabels::default()
        });
        assert_eq!(labels.running_for(2), "2 Workflows laufen");
        assert_eq!(
            labels.confirm_body_for(2),
            "Beenden stoppt 2 laufende Workflows."
        );
        // The count moved on before the renderer re-sent: English, but right.
        assert_eq!(labels.running_for(3), "3 workflows running");
        assert_eq!(labels.running_for(1), "1 workflow running");
        assert_eq!(
            labels.confirm_body_for(1),
            "Quitting stops 1 running workflow."
        );
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
