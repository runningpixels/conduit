//! Quick ask IPC: the ask box sends or hides itself, the main page takes the
//! waiting question, and Settings reads whether the shortcut works. The
//! shortcut itself is an ordinary setting (`update_settings` with
//! `quick_ask_shortcut`). See `crate::quick_ask`.

use tauri::{AppHandle, State};

use crate::quick_ask::{self, QuickAsk, QuickAskStatus};

/// Send the ask box's text: hides the box, brings the main window forward and
/// tells the page a question is waiting. Empty text does nothing (`false`).
#[tauri::command]
pub fn submit_quick_ask(app: AppHandle, text: String) -> bool {
    quick_ask::submit(&app, &text)
}

/// Hide the ask box (Esc).
#[tauri::command]
pub fn hide_quick_ask(app: AppHandle) {
    quick_ask::hide_ask_window(&app);
}

/// Show the ask box — what the shortcut does when the box is hidden. Also
/// lets the box be tried without pressing a global key.
#[tauri::command]
pub async fn open_quick_ask(app: AppHandle) -> Result<(), String> {
    quick_ask::open_ask_window(&app)
}

/// The question sent from the ask box, if one is waiting (taken once).
#[tauri::command]
pub fn take_pending_quick_ask(state: State<'_, QuickAsk>) -> Option<String> {
    state.take()
}

/// Whether the shortcut can work here, and why the saved one isn't, if it isn't.
#[tauri::command]
pub fn get_quick_ask_status(state: State<'_, QuickAsk>) -> QuickAskStatus {
    QuickAskStatus {
        supported: quick_ask::supported(),
        error: state.error(),
    }
}
