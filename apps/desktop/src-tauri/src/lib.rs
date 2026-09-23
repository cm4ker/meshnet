//! The desktop shell: a window around the client, with the links a browser
//! cannot offer (BLE, the cable, a socket to a radio on Wi-Fi) and the
//! system's credential store for the node passwords it keeps. Everything else — the protocol, the state, the
//! screens — is the client's, and the same on every platform.

mod announce;
mod secrets;
mod tcp;
mod tray;
mod updates;
#[cfg(windows)]
mod winble;

use tauri::Manager;

/// What the system passes when it starts the app at login: the window opens minimised.
const MINIMIZED: &str = "--minimized";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `RUST_LOG=debug` from a terminal shows what the plugins do with the link.
    let _ = env_logger::try_init();
    let builder = tauri::Builder::default()
        // The app lives in the tray with its window closed, so starting it
        // again, from the Start menu say, brings that window back rather
        // than a second app fighting the first for the radio. Registered first, as the plugin asks.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::bring_back(app)))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![MINIMIZED]),
        ))
        .setup(|app| {
            tray::install(app);
            if std::env::args().any(|arg| arg == MINIMIZED) {
                if let Some(window) = app.get_webview_window("main") {
                    if tray::available() {
                        tray::stow(&window);
                    } else {
                        let _ = window.minimize();
                    }
                }
            }
            Ok(())
        })
        .on_window_event(tray::on_window_event)
        .plugin(tauri_plugin_blec::init())
        .plugin(tauri_plugin_serialplugin::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(tcp::Tcp::default());

    #[cfg(windows)]
    let builder = builder.manage(winble::WinBle::default()).invoke_handler(tauri::generate_handler![
        updates::desktop_update_info,
        updates::desktop_check_update,
        winble::winble_scan,
        winble::winble_stop_scan,
        winble::winble_pair,
        winble::winble_connect,
        winble::winble_send,
        winble::winble_disconnect,
        tcp::tcp_open,
        tcp::tcp_write,
        tcp::tcp_close,
        announce::announce,
        announce::withdraw,
        tray::tray_unread,
        secrets::secret_get,
        secrets::secret_set,
        secrets::secret_delete,
    ]);
    #[cfg(not(windows))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        updates::desktop_update_info,
        updates::desktop_check_update,
        tcp::tcp_open,
        tcp::tcp_write,
        tcp::tcp_close,
        announce::announce,
        announce::withdraw,
        tray::tray_unread,
        secrets::secret_get,
        secrets::secret_set,
        secrets::secret_delete,
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running the desktop shell");
}
