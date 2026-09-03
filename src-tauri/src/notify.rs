//! A notification you can click.
//!
//! `tauri-plugin-notification`'s desktop path is one line — `show()` — with no
//! activation callback, so on Windows a click lands nowhere. That is most of
//! the value of a toast that says *a pane is waiting for you*: you are in
//! another window, and the whole point is to get back to the right pane.
//!
//! So Windows goes straight to `tauri-winrt-notification`, which exposes
//! `on_activated`. Everything else keeps the plugin — `show` returns false
//! there and the caller falls back.
//!
//! The AppUserModelID is the bundle identifier, the same one the plugin uses
//! and the one the installer stamps on the Start Menu shortcut. Windows drops
//! toasts from an unregistered AUMID silently, so this must not drift.

/// Show a toast whose click raises the window and reports `pane` to the UI.
/// Returns false when the platform has no such path, so the caller can fall
/// back to the plugin rather than showing nothing.
#[cfg(windows)]
pub fn show(app: &tauri::AppHandle, title: &str, body: &str, pane: &str) -> bool {
    use tauri::{Emitter, Manager};
    use tauri_winrt_notification::Toast;

    let handle = app.clone();
    let pane = pane.to_string();
    let result = Toast::new(&app.config().identifier)
        .title(title)
        .text1(body)
        .on_activated(move |_action| {
            // Raise first, then tell the UI which pane to select: the window
            // has to exist and be visible for the jump to be worth anything.
            if let Some(w) = handle.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            let _ = handle.emit("notify-click", pane.clone());
            Ok(())
        })
        .show();

    if let Err(e) = &result {
        eprintln!("agentspace: không hiện được toast: {e}");
    }
    result.is_ok()
}

#[cfg(not(windows))]
pub fn show(_app: &tauri::AppHandle, _title: &str, _body: &str, _pane: &str) -> bool {
    false
}
