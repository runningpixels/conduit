//! Slides export: the file-system half of saving a deck as an HTML file or a
//! PDF. The renderer builds the documents (`src/slides/deckExport.ts`) and
//! never supplies a path; the save dialog is opened by the command (ADR-008).
//!
//! The PDF is printed by the platform's own engine. On Windows a hidden
//! webview loads the document from the artifact origin (never the app origin)
//! and WebView2's `PrintToPdf` writes the file. Other platforms report that
//! PDF export is not available yet.

use std::path::Path;

/// Largest document accepted from the renderer.
pub const MAX_EXPORT_BYTES: usize = 50 * 1024 * 1024;

const FILENAME_MAX_CHARS: usize = 120;

/// Windows device names that cannot be used as a file name.
const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// `<deck title>.<ext>` made safe for any file system.
pub fn suggested_file_name(title: &str, ext: &str) -> String {
    let cleaned: String = title
        .trim()
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 32 => '_',
            c => c,
        })
        .take(FILENAME_MAX_CHARS)
        .collect();
    let cleaned = cleaned.trim_matches(|c| c == '.' || c == ' ');
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_lowercase();
    let base = if cleaned.is_empty() {
        "deck".to_string()
    } else if RESERVED.contains(&stem.as_str()) {
        format!("_{cleaned}")
    } else {
        cleaned.to_string()
    };
    format!("{base}.{ext}")
}

/// Refuse a document past the cap, before any dialog opens.
pub fn check_size(html: &str) -> Result<(), String> {
    if html.len() > MAX_EXPORT_BYTES {
        return Err("This deck is too large to export.".to_string());
    }
    Ok(())
}

/// Write the HTML export to the path the user picked.
pub fn write_html(path: &Path, html: &str) -> Result<(), String> {
    check_size(html)?;
    std::fs::write(path, html.as_bytes()).map_err(|e| format!("Couldn't save the file: {e}"))
}

#[cfg(not(windows))]
pub const PDF_UNAVAILABLE: &str = "PDF export is available on Windows for now.";

/// Print `html` to a PDF at `path`, one 1920x1080 page per slide.
#[cfg(windows)]
pub async fn print_pdf(
    app: &tauri::AppHandle,
    browser_args: &str,
    html: String,
    path: &Path,
) -> Result<(), String> {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    use crate::artifact_frames::{ArtifactFrames, SCHEME};

    /// The window waits this long, in total, for load plus print.
    const TIMEOUT: Duration = Duration::from_secs(60);
    /// Fonts and layout settle after the load event.
    const SETTLE: Duration = Duration::from_millis(400);

    let frames = app.state::<ArtifactFrames>();
    let token = frames.put(html)?;
    // The Windows form of the artifact scheme (see `artifact_frames`): the
    // document runs on the artifact origin with its own CSP, never the app's.
    let url: tauri::Url = format!("http://{SCHEME}.localhost/{token}")
        .parse()
        .map_err(|_| "couldn't address the export document".to_string())?;

    let (loaded_tx, loaded_rx) = tokio::sync::oneshot::channel::<()>();
    let loaded_tx = Arc::new(Mutex::new(Some(loaded_tx)));
    let label = format!("pdf-{}", uuid::Uuid::new_v4().simple());
    // Built with the main webview's browser arguments: WebView2 shares one
    // environment per user data folder and refuses a webview whose arguments
    // differ (0x8007139F).
    let window = match WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .inner_size(1280.0, 720.0)
        .additional_browser_args(browser_args)
        .on_page_load(move |_window, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                if let Some(tx) = loaded_tx.lock().ok().and_then(|mut slot| slot.take()) {
                    let _ = tx.send(());
                }
            }
        })
        .build()
    {
        Ok(window) => window,
        Err(error) => {
            frames.drop_token(&token);
            return Err(format!("Couldn't start the PDF export: {error}"));
        }
    };

    let result = tokio::time::timeout(TIMEOUT, async {
        loaded_rx
            .await
            .map_err(|_| "the export page didn't load".to_string())?;
        tokio::time::sleep(SETTLE).await;
        windows_print::print_to_pdf(&window, path).await
    })
    .await
    .unwrap_or_else(|_| Err("The PDF export timed out.".to_string()));

    // Every path ends here: success, failure and timeout.
    let _ = window.destroy();
    frames.drop_token(&token);
    result
}

#[cfg(windows)]
mod windows_print {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::sync::{Arc, Mutex};

    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller, ICoreWebView2Environment6, ICoreWebView2_2, ICoreWebView2_7,
        COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, PCWSTR};

    type Done = Arc<Mutex<Option<tokio::sync::oneshot::Sender<Result<(), String>>>>>;

    fn finish(done: &Done, result: Result<(), String>) {
        if let Some(tx) = done.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = tx.send(result);
        }
    }

    /// Page size in inches: 1920 x 1080 CSS px at 96 dpi.
    const PAGE_WIDTH_IN: f64 = 1920.0 / 96.0;
    const PAGE_HEIGHT_IN: f64 = 1080.0 / 96.0;

    /// Starts `PrintToPdf` on the UI thread; the completion handler (also run
    /// there) reports through `done`.
    ///
    /// # Safety
    /// COM calls; must run on the webview's UI thread.
    unsafe fn begin(
        controller: &ICoreWebView2Controller,
        path: &[u16],
        done: &Done,
    ) -> windows::core::Result<()> {
        let core = controller.CoreWebView2()?;
        let core7: ICoreWebView2_7 = core.cast()?;
        let env = core.cast::<ICoreWebView2_2>()?.Environment()?;
        let settings = env
            .cast::<ICoreWebView2Environment6>()?
            .CreatePrintSettings()?;
        settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)?;
        settings.SetScaleFactor(1.0)?;
        settings.SetPageWidth(PAGE_WIDTH_IN)?;
        settings.SetPageHeight(PAGE_HEIGHT_IN)?;
        settings.SetMarginTop(0.0)?;
        settings.SetMarginBottom(0.0)?;
        settings.SetMarginLeft(0.0)?;
        settings.SetMarginRight(0.0)?;
        settings.SetShouldPrintBackgrounds(true)?;
        settings.SetShouldPrintSelectionOnly(false)?;
        settings.SetShouldPrintHeaderAndFooter(false)?;

        let done_cb = done.clone();
        let handler = PrintToPdfCompletedHandler::create(Box::new(move |status, success| {
            let outcome = match status {
                Ok(()) if success => Ok(()),
                Ok(()) => Err("The PDF couldn't be written.".to_string()),
                Err(error) => Err(format!("The PDF couldn't be written: {error}")),
            };
            finish(&done_cb, outcome);
            Ok(())
        }));
        core7.PrintToPdf(PCWSTR(path.as_ptr()), &settings, &handler)
    }

    /// Print the page in `window` to `path` and wait for the completion callback.
    pub async fn print_to_pdf(window: &tauri::WebviewWindow, path: &Path) -> Result<(), String> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let done: Done = Arc::new(Mutex::new(Some(tx)));
        let done_ui = done.clone();
        window
            .with_webview(move |webview| {
                if let Err(error) = unsafe { begin(&webview.controller(), &wide, &done_ui) } {
                    finish(&done_ui, Err(format!("Couldn't start printing: {error}")));
                }
            })
            .map_err(|e| format!("Couldn't start printing: {e}"))?;
        rx.await
            .map_err(|_| "The PDF export was interrupted.".to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_safe_on_every_file_system() {
        assert_eq!(
            suggested_file_name("Q3 platform migration", "pdf"),
            "Q3 platform migration.pdf"
        );
        assert_eq!(
            suggested_file_name("a/b\\c:d*e?", "html"),
            "a_b_c_d_e_.html"
        );
        assert_eq!(suggested_file_name("  ..hidden.. ", "pdf"), "hidden.pdf");
        assert_eq!(suggested_file_name("", "pdf"), "deck.pdf");
        assert_eq!(suggested_file_name("///", "pdf"), "___.pdf");
        assert_eq!(suggested_file_name("CON", "pdf"), "_CON.pdf");
        assert_eq!(suggested_file_name("nul.txt", "pdf"), "_nul.txt.pdf");
        let long = suggested_file_name(&"x".repeat(400), "pdf");
        assert_eq!(long.chars().count(), FILENAME_MAX_CHARS + ".pdf".len());
    }

    #[test]
    fn html_is_written_to_the_picked_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deck.html");
        write_html(&path, "<!doctype html><p>héllo</p>").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "<!doctype html><p>héllo</p>"
        );
    }

    #[test]
    fn documents_past_the_cap_are_refused_and_nothing_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.html");
        let big = "x".repeat(MAX_EXPORT_BYTES + 1);
        assert!(check_size(&big).is_err());
        assert!(write_html(&path, &big).is_err());
        assert!(!path.exists());
        assert!(check_size(&"x".repeat(MAX_EXPORT_BYTES)).is_ok());
    }
}
