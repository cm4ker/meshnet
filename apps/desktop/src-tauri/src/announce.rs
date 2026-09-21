//! A system notification for a message or a new node, while the window is
//! elsewhere. WebView2 has no notification of its own to draw, so the page
//! asks the shell for one.
//!
//! Every desktop can draw the notice; what the notification plugin cannot do
//! is say *who* is speaking on Windows. A toast is drawn on behalf of an
//! AppUserModelID, and the plugin sets none outside an installed build, so the
//! notice would arrive as "Windows PowerShell". So the ID is set here, always,
//! and named in the registry here, always. (The same code as Sovabox's shell.)

use tauri::AppHandle;

/// The event the page listens for, carrying the tag of the notice that was
/// clicked. The page remembers what the tag was about; the shell does not.
#[cfg(windows)]
const OPENED: &str = "notification-opened";

/// Draws one. A click on it, on Windows, brings the window forward and hands
/// the page the tag; elsewhere the plugin has no click to report, and the
/// notice is only a notice.
#[tauri::command]
pub fn announce(app: AppHandle, title: String, body: String, tag: Option<String>) -> Result<(), String> {
    show(&app, &title, &body, tag)
}

#[cfg(windows)]
fn show(app: &AppHandle, title: &str, body: &str, tag: Option<String>) -> Result<(), String> {
    let app_id = app.config().identifier.clone();
    register(app, &app_id, &app.package_info().name);

    let clicked = app.clone();
    tauri_winrt_notification::Toast::new(&app_id)
        .title(title)
        .text1(body)
        // Fired on a thread of the notification platform's, while this
        // process runs. A toast clicked after the window has closed launches
        // nothing: that takes a COM activator an installer registers.
        .on_activated(move |_| {
            opened(&clicked, tag.clone());
            Ok(())
        })
        .show()
        .map_err(|error| error.to_string())
}

/// macOS notifies on behalf of a bundle and the plugin names it; Linux names
/// the sender in the notice. The plugin is right there as it is.
#[cfg(not(windows))]
fn show(app: &AppHandle, title: &str, body: &str, _tag: Option<String>) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn opened(app: &AppHandle, tag: Option<String>) {
    use tauri::{Emitter, Manager};

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit_to("main", OPENED, serde_json::json!({ "tag": tag }));
}

/// Says what this AppUserModelID is called, once per run, installed or not:
/// a name and an icon under `HKCU\Software\Classes\AppUserModelId\<id>`,
/// which is where the notification centre looks for both. Where the key
/// exists it wins over the installer's shortcut, and it outlives the build
/// that wrote it, so every build writes the name it has now and an icon kept
/// in the application's own data, never a path into a checkout.
///
/// Failure is silent: a notice that a message arrived should not come with
/// one that a registry key could not be written.
#[cfg(windows)]
fn register(app: &AppHandle, app_id: &str, name: &str) {
    use std::sync::Once;

    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let Some(icon) = icon_file(app) else {
            return;
        };
        // The per-user notification service (`WpnUserService`) keeps the name
        // and icon it found the first time, so a change shows after that
        // service restarts, which a sign-out does.
        let _ = describe(app_id, name, &icon.to_string_lossy());
    });
}

/// The window's icon, written where the notification platform can read it.
/// Joined one segment at a time: a path with both kinds of separator in it
/// draws no icon at all.
#[cfg(windows)]
fn icon_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;

    const ICON: &[u8] = include_bytes!("../icons/128x128.png");

    let directory = app.path().app_local_data_dir().ok()?;
    let path = directory.join("notification.png");
    if std::fs::read(&path).ok().as_deref() != Some(ICON) {
        std::fs::create_dir_all(&directory).ok()?;
        std::fs::write(&path, ICON).ok()?;
    }
    Some(path)
}

#[cfg(windows)]
fn describe(app_id: &str, name: &str, icon: &str) -> Result<(), u32> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    /// UTF-16 with a terminating null, which the registry counts in the length.
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let path = wide(&format!(r"Software\Classes\AppUserModelId\{app_id}"));
    let mut key: HKEY = std::ptr::null_mut();
    let opened = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            path.as_ptr(),
            0,
            std::ptr::null_mut(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            std::ptr::null(),
            &mut key,
            std::ptr::null_mut(),
        )
    };
    if opened != ERROR_SUCCESS {
        return Err(opened);
    }

    let set = |value: &str, content: &str| {
        let value = wide(value);
        let content = wide(content);
        unsafe { RegSetValueExW(key, value.as_ptr(), 0, REG_SZ, content.as_ptr() as *const u8, (content.len() * 2) as u32) }
    };
    let named = set("DisplayName", name);
    let pictured = set("IconUri", icon);
    unsafe { RegCloseKey(key) };

    match (named, pictured) {
        (ERROR_SUCCESS, ERROR_SUCCESS) => Ok(()),
        (ERROR_SUCCESS, failed) | (failed, _) => Err(failed),
    }
}
