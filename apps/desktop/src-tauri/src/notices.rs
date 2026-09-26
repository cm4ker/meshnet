//! The app's own notices on a computer (the page's `shownBy: "app"`), drawn
//! the way Telegram Desktop draws its own: cards stacked in a corner of the
//! screen, in the app's theme, with the sender's circle and a field to reply
//! in, whether the main window is open or in the tray.
//!
//! They live in a window of their own, `notices.html` from the client's
//! build: borderless, clear, above every other window, off the taskbar, and
//! shown without taking the focus from whatever the reader is typing into.
//! The page in it keeps the cards and their timers and says how tall the
//! stack is; this places the window in the corner of the work area of the
//! screen the main window is on. The main page hands cards over through here
//! (`notice_card`), and what is done on a card comes back the same way.
//!
//! Also the app's signal (`chime`), which this plays itself with every
//! notice, its own cards and Windows' toasts alike: a toast from an app
//! without a package can only take one of the system's own sounds. So the
//! toast goes silent and the signal plays here, unless Windows is keeping
//! quiet, as Telegram Desktop does.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "notices";

/// The window's width in logical pixels: a card of 352 and room for its shadow either side.
const WIDTH: f64 = 376.0;

/// Cards handed over before the window's page was listening, and whether it listens now.
#[derive(Default)]
pub struct Notices {
    state: Mutex<Queue>,
}

#[derive(Default)]
struct Queue {
    ready: bool,
    waiting: Vec<serde_json::Value>,
    corner: String,
}

/// A card to show, in place of the one out with its tag, and the signal for it.
/// Async, because it may make the window, and a window made from a
/// synchronous command deadlocks on Windows.
#[tauri::command]
pub async fn notice_card(app: AppHandle, notices: State<'_, Notices>, card: serde_json::Value, corner: String, signal: String) -> Result<(), String> {
    // Windows is keeping quiet: no card and no sound; the tray's dot still says what is unread.
    if quiet() {
        return Ok(());
    }
    let payload = serde_json::json!({ "card": card, "corner": corner });
    let ready = {
        let mut queue = notices.state.lock().map_err(|e| e.to_string())?;
        queue.corner = corner;
        if !queue.ready {
            queue.waiting.push(payload.clone());
        }
        queue.ready
    };
    window(&app)?;
    if ready {
        app.emit_to(LABEL, "notice-card", payload).map_err(|e| e.to_string())?;
    }
    play(&signal);
    Ok(())
}

/// What the card with this tag said has been read.
#[tauri::command]
pub fn notice_withdraw(app: AppHandle, notices: State<Notices>, tag: String) -> Result<(), String> {
    let ready = {
        let mut queue = notices.state.lock().map_err(|e| e.to_string())?;
        queue.waiting.retain(|payload| payload["card"]["tag"] != tag.as_str());
        queue.ready
    };
    if ready && app.get_webview_window(LABEL).is_some() {
        app.emit_to(LABEL, "notice-withdraw", tag).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The window's page listens now: the cards that came before it are handed over.
#[tauri::command]
pub fn notice_ready(app: AppHandle, notices: State<Notices>) -> Result<(), String> {
    let waiting = {
        let mut queue = notices.state.lock().map_err(|e| e.to_string())?;
        queue.ready = true;
        std::mem::take(&mut queue.waiting)
    };
    for payload in waiting {
        app.emit_to(LABEL, "notice-card", payload).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// How tall the stack of cards is, in logical pixels; none hides the window.
#[tauri::command]
pub fn notice_layout(app: AppHandle, notices: State<Notices>, height: f64) -> Result<(), String> {
    let corner = notices.state.lock().map_err(|e| e.to_string())?.corner.clone();
    let Some(window) = app.get_webview_window(LABEL) else {
        return Ok(());
    };
    if height <= 0.0 {
        return show(&window, None);
    }
    // The screen the main window is on, where the reader looks; the main one when it is not known.
    let monitor = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or("no screen to show notices on")?;
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let (w, h) = ((WIDTH * scale).round() as i32, (height * scale).round() as i32);
    let (right, bottom) = (area.position.x + area.size.width as i32, area.position.y + area.size.height as i32);
    let x = if corner.ends_with('l') { area.position.x } else { right - w };
    let y = if corner.starts_with('t') { area.position.y } else { bottom - h };
    show(&window, Some((x, y, w, h)))
}

/// A click on a card: the main window comes forward on what it is about.
#[tauri::command]
pub fn notice_open(app: AppHandle, tag: String) {
    crate::announce::opened(&app, Some(tag));
}

/// A reply typed into a card, or "mark read": the main page does it.
#[tauri::command]
pub fn notice_act(app: AppHandle, action: serde_json::Value) -> Result<(), String> {
    app.emit_to("main", "notice-action", action).map_err(|e| e.to_string())
}

/// The signal, for a notice the page shows by other means.
#[tauri::command]
pub fn chime(signal: String) {
    if !quiet() {
        play(&signal);
    }
}

/// The notices window, made the first time a card needs it. Made hidden: it shows once it knows its height.
fn window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("notices.html".into()))
        .title("Ommesh notices")
        .inner_size(WIDTH, 120.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .visible(false)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// The window closed by the system (Alt+F4 on a card), which only hides it; a closed one would lose its cards.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        if let Some(window) = window.app_handle().get_webview_window(LABEL) {
            let _ = show(&window, None);
        }
    }
}

/// Places and shows the window without activating it, above everything; or hides it.
#[cfg(windows)]
fn show(window: &tauri::WebviewWindow, at: Option<(i32, i32, i32, i32)>) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE,
    };

    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as _;
    unsafe {
        match at {
            // SWP_SHOWWINDOW with SWP_NOACTIVATE shows it where it is put, and leaves the focus where it was.
            Some((x, y, w, h)) => SetWindowPos(hwnd, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW),
            None => ShowWindow(hwnd, SW_HIDE),
        };
    }
    Ok(())
}

#[cfg(not(windows))]
fn show(window: &tauri::WebviewWindow, at: Option<(i32, i32, i32, i32)>) -> Result<(), String> {
    match at {
        Some((x, y, w, h)) => {
            window.set_size(tauri::PhysicalSize::new(w as u32, h as u32)).map_err(|e| e.to_string())?;
            window.set_position(tauri::PhysicalPosition::new(x, y)).map_err(|e| e.to_string())?;
            window.show().map_err(|e| e.to_string())
        }
        None => window.hide().map_err(|e| e.to_string()),
    }
}

/// The signals, as the client renders them (`scripts/sounds.mjs`), built into the shell.
#[cfg(windows)]
fn sound(signal: &str) -> Option<&'static [u8]> {
    Some(match signal {
        "chirp" => include_bytes!("../../../web/public/sounds/signal_chirp.wav"),
        "roger" => include_bytes!("../../../web/public/sounds/signal_roger.wav"),
        "hop" => include_bytes!("../../../web/public/sounds/signal_hop.wav"),
        "sonar" => include_bytes!("../../../web/public/sounds/signal_sonar.wav"),
        _ => return None,
    })
}

/// Plays a signal and returns at once; a newer one cuts the one playing short.
#[cfg(windows)]
pub fn play(signal: &str) {
    use windows_sys::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};

    let Some(wav) = sound(signal) else {
        return;
    };
    // SND_MEMORY takes the file's bytes where a name would go; they are static, so they outlive the sound.
    unsafe { PlaySoundW(wav.as_ptr() as _, std::ptr::null_mut(), SND_MEMORY | SND_ASYNC | SND_NODEFAULT) };
}

#[cfg(not(windows))]
pub fn play(_signal: &str) {}

/// Whether Windows is keeping quiet: a full-screen game or video, a
/// presentation, or Do not disturb (Focus assist before Windows 11).
#[cfg(windows)]
pub fn quiet() -> bool {
    use windows_sys::Win32::UI::Shell::{
        SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_QUIET_TIME, QUNS_RUNNING_D3D_FULL_SCREEN,
    };

    let mut state = 0;
    if unsafe { SHQueryUserNotificationState(&mut state) } == 0
        && matches!(state, QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE | QUNS_QUIET_TIME)
    {
        return true;
    }
    do_not_disturb()
}

#[cfg(not(windows))]
pub fn quiet() -> bool {
    false
}

/// Do not disturb has no documented API. The shell publishes its profile in
/// a WNF state, `WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED`: 0 is off, 1
/// priority only, 2 alarms only; any but 0 counts as quiet here. Read through
/// ntdll's export, looked up rather than linked, so a Windows without it
/// just reads as not quiet.
#[cfg(windows)]
fn do_not_disturb() -> bool {
    use std::ffi::c_void;
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};

    type Query = unsafe extern "system" fn(*const u64, *const c_void, *const c_void, *mut u32, *mut c_void, *mut u32) -> i32;
    const QUIET_HOURS_PROFILE: u64 = 0x0D83_063E_A3BF_1C75;

    let ntdll: Vec<u16> = "ntdll.dll\0".encode_utf16().collect();
    unsafe {
        let module = GetModuleHandleW(ntdll.as_ptr());
        if module.is_null() {
            return false;
        }
        let Some(address) = GetProcAddress(module, c"NtQueryWnfStateData".as_ptr() as _) else {
            return false;
        };
        let query: Query = std::mem::transmute(address);
        let (mut stamp, mut profile, mut size) = (0u32, 0u32, 4u32);
        let status = query(&QUIET_HOURS_PROFILE, std::ptr::null(), std::ptr::null(), &mut stamp, &mut profile as *mut u32 as *mut c_void, &mut size);
        status >= 0 && size >= 4 && profile != 0
    }
}
