//! The desktop shell: a window around the client, with the links a browser
//! cannot offer (BLE, the cable, a socket to a radio on Wi-Fi) and the
//! system's credential store for the node passwords it keeps. Everything else — the protocol, the state, the
//! screens — is the client's, and the same on every platform.

mod announce;
mod secrets;
mod tcp;
mod updates;
#[cfg(windows)]
mod winble;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `RUST_LOG=debug` from a terminal shows what the plugins do with the link.
    let _ = env_logger::try_init();
    let builder = tauri::Builder::default()
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
        secrets::secret_get,
        secrets::secret_set,
        secrets::secret_delete,
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running the desktop shell");
}
