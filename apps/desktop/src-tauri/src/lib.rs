//! The desktop shell: a window around the client, with the two links a
//! browser cannot offer. Everything else — the protocol, the state, the
//! screens — is the client's, and the same on every platform.

#[cfg(windows)]
mod winble;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `RUST_LOG=debug` from a terminal shows what the plugins do with the link.
    let _ = env_logger::try_init();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_blec::init())
        .plugin(tauri_plugin_serialplugin::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(windows)]
    let builder = builder.manage(winble::WinBle::default()).invoke_handler(tauri::generate_handler![
        winble::winble_scan,
        winble::winble_stop_scan,
        winble::winble_pair,
        winble::winble_connect,
        winble::winble_send,
        winble::winble_disconnect,
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running the desktop shell");
}
