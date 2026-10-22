// Sulfur's desktop app: its own server (cmd/sulfur, bundled beside it) started
// on 127.0.0.1, then Sulfur from it in a window whose title bar is Sulfur's
// own, as VS Code's is. Offline the server is this computer; connected, it
// stands in front of a Phosphorus mesh, so the window never leaves 127.0.0.1
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread::sleep;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, Url};

// fixed, so the page's own storage (layout, open tabs) is the same each launch
const ADDR: &str = "127.0.0.1:47615";

struct Server(Mutex<Option<Child>>);

fn up() -> bool {
    let a: SocketAddr = ADDR.parse().expect("ADDR");
    TcpStream::connect_timeout(&a, Duration::from_millis(250)).is_ok()
}

// the server beside the app's own executable, started unless another Sulfur's already serving
fn start() -> Option<Child> {
    if up() {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let name = if cfg!(windows) { "sulfur-server.exe" } else { "sulfur-server" };
    let mut cmd = Command::new(exe.parent()?.join(name));
    cmd.arg("-addr").arg(ADDR);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn().ok()
}

fn main() {
    let child = start();
    let app = tauri::Builder::default()
        .manage(Server(Mutex::new(child)))
        .setup(|app| {
            let win = app.get_webview_window("main").expect("the main window");
            // the splash until the server answers, then Sulfur; said on the splash if it never does
            std::thread::spawn(move || {
                let t0 = Instant::now();
                while !up() {
                    if t0.elapsed() > Duration::from_secs(20) {
                        let _ = win.eval("document.body.classList.add('fail')");
                        return;
                    }
                    sleep(Duration::from_millis(80));
                }
                let url = Url::parse(&format!("http://{ADDR}/sulfur/")).expect("url");
                let _ = win.navigate(url);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Sulfur failed to start");
    app.run(|app, ev| {
        if let RunEvent::Exit = ev {
            if let Some(mut c) = app.state::<Server>().0.lock().ok().and_then(|mut s| s.take()) {
                let _ = c.kill();
            }
        }
    });
}
