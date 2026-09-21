//! A radio on the network. Companion firmware built with Wi-Fi (ESP32 boards,
//! `WIFI_SSID` at build time) listens on TCP port 5000 and speaks exactly what
//! its USB serial speaks, so this module is a socket and nothing more: the
//! client frames the stream, as it does for the cable.
//!
//! Bytes the radio sends arrive on a `Channel` the page hands to `open`; the
//! end of the connection arrives on a second one, once, unless the page closed
//! it itself. The firmware serves one client at a time and drops the old one
//! for a new one, which reads here as the radio closing the connection.
//!
//! A radio that goes away without a word (switched off, out of Wi-Fi) is
//! found by TCP keepalive: its network stack answers probes for as long as it
//! is there, and a connection that stops answering is reported like any other
//! drop, within half a minute.
//!
//! Each connection has a reader thread. Windows does not wake a blocked read
//! when the socket is shut down from this side, so the reader reads with a
//! short timeout and, when it runs out, stops if the page has closed the
//! connection in the meantime.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use socket2::{SockRef, TcpKeepalive};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

const WRITE_DEADLINE: Duration = Duration::from_secs(10);
/// How long a closed connection's reader may linger.
const READ_TICK: Duration = Duration::from_secs(1);

#[derive(Default)]
pub struct Tcp {
    links: Mutex<HashMap<u32, Arc<TcpStream>>>,
    next: AtomicU32,
}

fn connect(host: &str, port: u16, timeout: Duration) -> Result<TcpStream, String> {
    let addresses: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("{host}: {e}"))?
        .collect();
    let mut last = format!("{host}: no address");
    for address in addresses {
        match TcpStream::connect_timeout(&address, timeout) {
            Ok(stream) => return Ok(stream),
            Err(e) => last = format!("{address}: {e}"),
        }
    }
    Err(last)
}

fn tune(stream: &TcpStream) -> std::io::Result<()> {
    // Frames are small and a command waits for its answer: no batching.
    stream.set_nodelay(true)?;
    stream.set_write_timeout(Some(WRITE_DEADLINE))?;
    stream.set_read_timeout(Some(READ_TICK))?;
    // The probe count is the system's: ten on Windows, eight or nine elsewhere.
    let keepalive = TcpKeepalive::new()
        .with_time(Duration::from_secs(10))
        .with_interval(Duration::from_secs(2));
    SockRef::from(stream).set_tcp_keepalive(&keepalive)
}

/// Reads until the connection ends, then says why on `on_closed` if the page
/// did not end it itself (a closed link is gone from the map already).
fn read_loop(app: AppHandle, id: u32, stream: Arc<TcpStream>, on_data: Channel<Vec<u8>>, on_closed: Channel<String>) {
    let mut buffer = [0u8; 4096];
    let reason = loop {
        match (&*stream).read(&mut buffer) {
            Ok(0) => break String::new(),
            Ok(n) => {
                log::trace!("tcp {id}: <- {n} bytes");
                if on_data.send(buffer[..n].to_vec()).is_err() {
                    break "the page stopped listening".into();
                }
            }
            // A quiet radio, or a connection the page has closed.
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                if !app.state::<Tcp>().links.lock().unwrap().contains_key(&id) {
                    return;
                }
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => break e.to_string(),
        }
    };
    let ours = app.state::<Tcp>().links.lock().unwrap().remove(&id).is_some();
    if ours {
        log::info!("tcp {id}: dropped: {reason}");
        let _ = on_closed.send(reason);
    }
}

/// Connects to `host:port`. Bytes arrive on `on_data`; `on_closed` says when
/// the radio ends the connection, with the reason or an empty string.
#[tauri::command]
pub async fn tcp_open(
    app: AppHandle,
    state: State<'_, Tcp>,
    host: String,
    port: u16,
    timeout_ms: Option<u64>,
    on_data: Channel<Vec<u8>>,
    on_closed: Channel<String>,
) -> Result<u32, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(10_000));
    let stream = tauri::async_runtime::spawn_blocking(move || connect(&host, port, timeout))
        .await
        .map_err(|e| e.to_string())??;
    tune(&stream).map_err(|e| e.to_string())?;
    let stream = Arc::new(stream);
    let id = state.next.fetch_add(1, Ordering::Relaxed);
    state.links.lock().unwrap().insert(id, stream.clone());
    log::info!("tcp {id}: connected to {}", stream.peer_addr().map(|a| a.to_string()).unwrap_or_default());
    std::thread::Builder::new()
        .name(format!("tcp-{id}"))
        .spawn(move || read_loop(app, id, stream, on_data, on_closed))
        .map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub async fn tcp_write(state: State<'_, Tcp>, id: u32, data: Vec<u8>) -> Result<(), String> {
    let stream = state.links.lock().unwrap().get(&id).cloned().ok_or("not connected")?;
    tauri::async_runtime::spawn_blocking(move || (&*stream).write_all(&data).map(|_| data.len()))
        .await
        .map_err(|e| e.to_string())?
        .map(|n| log::trace!("tcp {id}: -> {n} bytes"))
        .map_err(|e| e.to_string())
}

/// Ends the connection. The reader stops without a word within a second.
#[tauri::command]
pub async fn tcp_close(state: State<'_, Tcp>, id: u32) -> Result<(), String> {
    if let Some(stream) = state.links.lock().unwrap().remove(&id) {
        let _ = stream.shutdown(Shutdown::Both);
        log::info!("tcp {id}: closed");
    }
    Ok(())
}
