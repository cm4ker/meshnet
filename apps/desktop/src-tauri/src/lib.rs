//! The desktop shell: a window around the client, with the two links a
//! browser cannot offer. Everything else — the protocol, the state, the
//! screens — is the client's, and the same on every platform.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_blec::init())
        .plugin(tauri_plugin_serialplugin::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running the desktop shell");
}
