// Sulfur's desktop app: a window on a Phosphorus server's Sulfur. Its own page
// (dist/index.html) asks which server and remembers it; the server's page does
// the rest, logged in as in a browser, so nothing of the editor lives here
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

// whether host:port answers a connect, so a server that's down or off the
// tailnet is said so on the app's page instead of a webview's dead end
#[tauri::command]
fn reach(host: String, port: u16) -> Result<(), String> {
    let addrs = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("can't find {host}: {e}"))?;
    let mut last = format!("{host} has no address");
    for a in addrs {
        match TcpStream::connect_timeout(&a, Duration::from_secs(4)) {
            Ok(_) => return Ok(()),
            Err(e) => last = format!("{host}:{port} didn't answer: {e}"),
        }
    }
    Err(last)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![reach])
        .run(tauri::generate_context!())
        .expect("Sulfur failed to start");
}
