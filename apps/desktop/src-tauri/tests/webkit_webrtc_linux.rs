//! Linux: what `webview_args::disable_webrtc` relies on, checked against the
//! WebKitGTK the build links. With `enable-webrtc` off, a page has no
//! `RTCPeerConnection` to open a STUN/TURN connection with, in any frame.
//!
//! It needs a display, so it is `#[ignore]`d; CI's verify job runs it under
//! `xvfb-run` (step "WebKitGTK WebRTC switch (Linux)"). The output also says
//! whether this WebKitGTK exposes WebRTC at all when the setting is on.
#![cfg(target_os = "linux")]

use javascriptcore::ValueExt;
use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};
use webkit2gtk::{glib, LoadEvent, SettingsExt, WebView, WebViewExt};

/// Run the default main context until `done`, or fail after 30 seconds.
fn pump(done: impl Fn() -> bool) {
    let ctx = glib::MainContext::default();
    let start = Instant::now();
    while !done() {
        assert!(
            start.elapsed() < Duration::from_secs(30),
            "timed out waiting for WebKitGTK"
        );
        if !ctx.iteration(false) {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

/// `typeof RTCPeerConnection` in a page (and in a child frame, which is how a
/// page would try to get a fresh copy) with WebRTC on or off.
fn rtc_types(webrtc: bool) -> String {
    let view = WebView::new();
    let settings = WebViewExt::settings(&view).expect("a WebView has settings");
    settings.set_enable_webrtc(webrtc);

    let loaded = Rc::new(RefCell::new(false));
    let flag = loaded.clone();
    view.connect_load_changed(move |_, event| {
        if event == LoadEvent::Finished {
            *flag.borrow_mut() = true;
        }
    });
    view.load_html(
        "<!doctype html><iframe srcdoc='<p>child</p>'></iframe>",
        Some("https://webrtc-check.invalid/"),
    );
    pump(|| *loaded.borrow());

    let out: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));
    let slot = out.clone();
    let script = "typeof RTCPeerConnection + ' / ' + \
                  typeof document.querySelector('iframe').contentWindow.RTCPeerConnection";
    #[allow(deprecated)] // evaluate_javascript needs WebKitGTK 2.40; this runs on any.
    view.run_javascript(
        script,
        None::<&webkit2gtk::gio::Cancellable>,
        move |result| {
            let text = match result {
                Ok(r) => r
                    .js_value()
                    .map(|v| v.to_str().to_string())
                    .unwrap_or_default(),
                Err(e) => format!("error: {e}"),
            };
            *slot.borrow_mut() = Some(text);
        },
    );
    pump(|| out.borrow().is_some());
    out.take().unwrap_or_default()
}

#[test]
#[ignore = "needs a display; CI runs it under xvfb-run"]
fn turning_webrtc_off_removes_rtc_peer_connection_from_every_frame() {
    gtk::init().expect("GTK initialises (is DISPLAY set?)");
    let on = rtc_types(true);
    let off = rtc_types(false);
    println!("WebKitGTK typeof RTCPeerConnection (page / child frame): on = {on}; off = {off}");
    assert_eq!(off, "undefined / undefined");
}
