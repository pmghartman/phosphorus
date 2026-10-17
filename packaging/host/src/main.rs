//! Phosphorus host app, macOS and Windows: bundled with the host binary and release,
//! the host's tray: keys, install, start and stop, feed updates; the frontend opened
//! in Phosphorus Client when it's installed, else the browser

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// one install, start, stop or update at a time
static BUSY: AtomicBool = AtomicBool::new(false);
/// Phosphorus Client's identifier, the separate download opening the frontend
#[cfg(target_os = "macos")]
const CLIENT_ID: &str = "dev.phosphorus.client";
/// the tray menu's first line: what the tooltip says, visible on macOS
static STATUS: OnceLock<MenuItem<tauri::Wry>> = OnceLock::new();
/// the tray's Start, Stop and VPN items, enabled and named by the host's state
static ITEMS: OnceLock<[MenuItem<tauri::Wry>; 3]> = OnceLock::new();

struct App {
    payload: PathBuf,
    home: PathBuf,
    host: PathBuf,
}

fn home_dir() -> PathBuf {
    if let Some(h) = std::env::var_os("PHOSPHORUS_HOME") {
        return h.into();
    }
    if cfg!(windows) {
        // not %LOCALAPPDATA%\Phosphorus: the app's own install dir, wiped by its uninstaller
        PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default()).join("phosphorus")
    } else {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Library/Phosphorus")
    }
}

/// the bundled phosphorus binary, beside this one
fn host_bin() -> PathBuf {
    let dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default();
    dir.join(if cfg!(windows) { "phosphorus-host.exe" } else { "phosphorus-host" })
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).map(|s| s.trim().to_string()).unwrap_or_default()
}

fn write_json(p: &Path, v: &Value) {
    let tmp = p.with_extension("json.tmp");
    let _ = std::fs::create_dir_all(p.parent().unwrap_or(Path::new(".")));
    if std::fs::write(&tmp, v.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, p);
    }
}

/// what the frontend and `phosphorus update` wait on
fn report(home: &Path, id: &str, state: &str, current: bool, version: &str, error: &str) {
    let e: String = error.chars().take(400).collect();
    write_json(
        &home.join("state/update-agent.json"),
        &json!({"id": id, "state": state, "current": current, "version": version, "error": e, "at": now_ms()}),
    );
}

/// the host binary, no console window, the home passed along
fn host_cmd(app: &App, args: &[&str]) -> Command {
    let mut c = Command::new(&app.host);
    c.args(args).arg("--home").arg(&app.home).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}

/// a host command's (ok, output), the output kept in state/<log>.log
fn host_run(app: &App, args: &[&str], log: &str) -> (bool, String) {
    let _ = std::fs::create_dir_all(app.home.join("state"));
    match host_cmd(app, args).output() {
        Ok(o) => {
            let text = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
            let _ = std::fs::write(app.home.join(format!("state/{log}.log")), &text);
            (o.status.success(), text)
        }
        Err(e) => (false, e.to_string()),
    }
}

fn last_error(text: &str) -> String {
    text.lines().filter(|l| l.contains("ERROR")).last().map(str::to_string).unwrap_or_default()
}

/// which keys .env holds, never their values
fn key_status(app: &App) -> HashMap<String, bool> {
    let (_, out) = host_run(app, &["keys", "--status"], "keys");
    serde_json::from_str(out.lines().last().unwrap_or("")).unwrap_or_default()
}

fn keys_missing(app: &App) -> bool {
    !key_status(app).get("TS_AUTHKEY").copied().unwrap_or(false)
}

fn set_tip(app: &AppHandle, text: &str) {
    if let Some(t) = app.tray_by_id("phosphorus") {
        let _ = t.set_tooltip(Some(text));
    }
    if let Some(s) = STATUS.get() {
        let _ = s.set_text(text);
    }
}

/// macOS: a tray-only app brought forward, its windows and dialogs otherwise behind
fn activate(handle: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = handle.run_on_main_thread(|| {
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            #[allow(deprecated)]
            objc2_app_kit::NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
        }
    });
    #[cfg(not(target_os = "macos"))]
    let _ = handle;
}

fn payload_version(app: &App) -> String {
    read(&app.payload.join("VERSION"))
}

/// whether the service and Tailscale are up, (false, false) when the host can't say
fn host_state(app: &App) -> (bool, bool) {
    let out = host_cmd(app, &["status", "--json"]).stderr(Stdio::null()).output();
    let v: Value = out.ok().and_then(|o| serde_json::from_slice(&o.stdout).ok()).unwrap_or_default();
    (v["running"].as_bool().unwrap_or(false), v["vpn"].as_bool().unwrap_or(false))
}

fn status_tip(app: &App) -> String {
    let v = read(&app.home.join(".phosphorus-installed"));
    if v.is_empty() {
        return "Phosphorus not set up".into();
    }
    if keys_missing(app) {
        return format!("Phosphorus {v}: no keys yet");
    }
    let (running, vpn) = host_state(app);
    let svc = if running { "running" } else { "stopped" };
    let net = if vpn { "VPN on" } else { "VPN off" };
    format!("Phosphorus {v}: {svc}, {net}")
}

/// the tray's status line and items set from the host's state, all off while busy
fn refresh(handle: &AppHandle) {
    let app = handle.state::<App>();
    let busy = BUSY.load(Ordering::SeqCst);
    let (running, vpn) = if busy { (false, false) } else { host_state(&app) };
    if !busy {
        set_tip(handle, &status_tip(&app));
    }
    if let Some([start, stop, net]) = ITEMS.get() {
        let _ = start.set_enabled(!busy && !running);
        let _ = stop.set_enabled(!busy && running);
        let _ = net.set_enabled(!busy);
        let _ = net.set_text(if vpn { "Turn VPN Off" } else { "Turn VPN On" });
    }
}

/// a finished action said in a small dialog, the tray otherwise silent
fn notify(handle: &AppHandle, text: &str) {
    activate(handle);
    handle.dialog().message(text).title("Phosphorus").kind(MessageDialogKind::Info).show(|_| {});
}

fn alert(handle: &AppHandle, text: &str) {
    activate(handle);
    handle.dialog().message(text).title("Phosphorus").kind(MessageDialogKind::Error).show(|_| {});
}

/// macOS: the admin-only steps (Remote Login, ssh by name, PATH) behind the
/// system's own password prompt, once; Windows' raised by the binary itself
fn admin_setup(app: &App) {
    #[cfg(target_os = "macos")]
    {
        if host_cmd(app, &["setup", "--check"]).status().map(|s| s.success()).unwrap_or(true) {
            return;
        }
        as_admin(app, "setup");
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// macOS: one host command as root behind the system's password prompt
#[cfg(target_os = "macos")]
fn as_admin(app: &App, args: &str) {
    let q = |p: &Path| format!("'{}'", p.display().to_string().replace('\'', "'\\''"));
    let sh = format!("{} {args} --home {}", q(&app.host), q(&app.home));
    let script = format!("do shell script \"{}\" with administrator privileges", sh.replace('\\', "\\\\").replace('"', "\\\""));
    let _ = Command::new("/usr/bin/osascript").args(["-e", &script]).status();
}

/// start or stop in the background, the tooltip following, a failure shown
fn host_action(handle: AppHandle, action: &'static str, then_open: bool) {
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let app = handle.state::<App>();
        if action == "start" {
            if keys_missing(&app) {
                BUSY.store(false, Ordering::SeqCst);
                let h = handle.clone();
                let _ = handle.run_on_main_thread(move || open_keys(&h));
                return;
            }
            admin_setup(&app);
        }
        set_tip(&handle, if action == "start" { "Phosphorus starting…" } else { "Phosphorus stopping…" });
        refresh(&handle);
        let (ok, out) = host_run(&app, &[action], action);
        BUSY.store(false, Ordering::SeqCst);
        refresh(&handle);
        if !ok {
            let e = last_error(&out);
            alert(&handle, if e.is_empty() { "failed, see state/ in the Phosphorus folder" } else { &e });
        } else if then_open {
            let h = handle.clone();
            let _ = handle.run_on_main_thread(move || open_main(&h));
        } else {
            notify(&handle, if action == "start" { "Phosphorus is running." } else { "Phosphorus stopped." });
        }
    });
}

/// Tailscale on or off; off stops phosphorus first, after a confirm when it's running
fn vpn_action(handle: AppHandle) {
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let app = handle.state::<App>();
        let (running, vpn) = host_state(&app);
        if vpn && running {
            activate(&handle);
            let go = handle
                .dialog()
                .message("Turning the VPN off stops Phosphorus on this computer and takes it off the mesh. Start turns both back on.")
                .title("Turn VPN Off")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom("Turn Off".into(), "Cancel".into()))
                .blocking_show();
            if !go {
                BUSY.store(false, Ordering::SeqCst);
                return;
            }
        }
        let to = if vpn { "off" } else { "on" };
        set_tip(&handle, if vpn { "Phosphorus turning the VPN off…" } else { "Phosphorus turning the VPN on…" });
        refresh(&handle);
        let (ok, out) = host_run(&app, &["vpn", to], "vpn");
        BUSY.store(false, Ordering::SeqCst);
        refresh(&handle);
        if ok {
            notify(&handle, if vpn { "VPN off, Phosphorus stopped." } else { "VPN on." });
        } else {
            let e = last_error(&out);
            alert(&handle, if e.is_empty() { "couldn't change the VPN, see state/vpn.log in the Phosphorus folder" } else { &e });
        }
    });
}

/// an update request: the feed's newer app installed and relaunched (finished on the next
/// launch), else this release's images and config re-applied
async fn handle_update(handle: AppHandle, id: String, ask: bool) {
    if BUSY.swap(true, Ordering::SeqCst) {
        if ask {
            activate(&handle);
            handle.dialog().message("Phosphorus is busy starting, stopping or installing; try again once it's done.").title("Phosphorus Updates").show(|_| {});
        }
        return;
    }
    let app = handle.state::<App>();
    report(&app.home, &id, "running", false, "", "");
    set_tip(&handle, "Phosphorus checking for updates…");
    let found = match handle.updater_builder().timeout(Duration::from_secs(30)).build() {
        Ok(u) => u.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    match found {
        Ok(Some(u)) => {
            if ask {
                activate(&handle);
                let go = handle
                    .dialog()
                    .message(format!("Phosphorus {} is available. Updating restarts phosphorus on this host.", u.version))
                    .title("Phosphorus Updates")
                    .buttons(MessageDialogButtons::OkCancelCustom("Update".into(), "Later".into()))
                    .blocking_show();
                if !go {
                    report(&app.home, &id, "failed", false, "", "update declined");
                    BUSY.store(false, Ordering::SeqCst);
                    refresh(&handle);
                    return;
                }
            }
            set_tip(&handle, &format!("Phosphorus downloading {}…", u.version));
            let version = u.version.strip_suffix(".0").unwrap_or(&u.version).to_string();
            write_json(&app.home.join("state/update-pending.json"), &json!({"id": id, "version": version}));
            // Windows: the installer exits this process and relaunches it
            match u.download_and_install(|_, _| {}, || {}).await {
                Ok(()) => handle.restart(),
                Err(e) => {
                    let _ = std::fs::remove_file(app.home.join("state/update-pending.json"));
                    report(&app.home, &id, "failed", false, "", &e.to_string());
                }
            }
        }
        Ok(None) | Err(_) => {
            if let Err(e) = &found {
                eprintln!("phosphorus: update feed: {e}");
            }
            set_tip(&handle, "Phosphorus applying this release…");
            let payload = app.payload.to_string_lossy().to_string();
            let (ok, out) = host_run(&app, &["install", "--update", "--payload", &payload], "install");
            let v = payload_version(&app);
            let current = out.contains("already up to date");
            if ok {
                report(&app.home, &id, "ok", current, &v, "");
                if ask {
                    activate(&handle);
                    let m = if current { format!("Phosphorus {v} is up to date.") } else { format!("Phosphorus {v} re-applied.") };
                    handle.dialog().message(m).title("Phosphorus Updates").show(|_| {});
                }
            } else {
                let e = last_error(&out);
                report(&app.home, &id, "failed", false, "", if e.is_empty() { "install failed" } else { &e });
            }
        }
    }
    BUSY.store(false, Ordering::SeqCst);
    refresh(&handle);
}

/// launch: a new release unpacked into home, a pending update's verdict
/// written, the keys asked for when there are none, then the update requests watched
fn startup(handle: AppHandle, background: bool) {
    std::thread::spawn(move || {
        let app = handle.state::<App>();
        let installed = read(&app.home.join(".phosphorus-installed"));
        let ver = payload_version(&app);
        if installed != ver && !BUSY.swap(true, Ordering::SeqCst) {
            set_tip(&handle, &format!("Phosphorus installing {ver}…"));
            let payload = app.payload.to_string_lossy().to_string();
            let mut args = vec!["install", "--payload", &payload];
            if !installed.is_empty() {
                args.push("--update");
            }
            let (ok, out) = host_run(&app, &args, "install");
            let pending = app.home.join("state/update-pending.json");
            if let Ok(p) = std::fs::read_to_string(&pending).map(|s| serde_json::from_str::<Value>(&s).unwrap_or_default()) {
                let id = p["id"].as_str().unwrap_or("");
                if ok {
                    report(&app.home, id, "ok", false, &ver, "");
                } else {
                    report(&app.home, id, "failed", false, "", &last_error(&out));
                }
                let _ = std::fs::remove_file(&pending);
            }
            BUSY.store(false, Ordering::SeqCst);
        }
        // opened by hand: the frontend (or the keys); at login: the tray alone
        if !background || keys_missing(&app) {
            let h = handle.clone();
            let _ = handle.run_on_main_thread(move || open_main(&h));
        }
        refresh(&handle);
        let req = app.home.join("state/update-request.json");
        // the menu kept current with changes made elsewhere (the cli, the Tailscale app)
        let mut tick = 0u32;
        loop {
            std::thread::sleep(Duration::from_secs(2));
            tick += 1;
            if tick % 10 == 0 && !BUSY.load(Ordering::SeqCst) {
                refresh(&handle);
            }
            let Ok(text) = std::fs::read_to_string(&req) else { continue };
            let _ = std::fs::remove_file(&req);
            let id = serde_json::from_str::<Value>(&text).ok().and_then(|v| v["id"].as_str().map(str::to_string)).unwrap_or_default();
            tauri::async_runtime::block_on(handle_update(handle.clone(), id, false));
        }
    });
}

/// the mesh's domain, from the host's .env
fn domain(app: &App) -> String {
    let (_, out) = host_run(app, &["keys", "--domain"], "keys");
    out.lines().last().unwrap_or("").trim().to_string()
}

/// the keys asked for first when there are none, else the frontend: in Phosphorus
/// Client when it's installed, else the default browser
fn open_main(handle: &AppHandle) {
    let app = handle.state::<App>();
    if keys_missing(&app) {
        open_keys(handle);
        return;
    }
    let d = domain(&app);
    if d.is_empty() {
        alert(handle, "no mesh domain yet, see Edit Keys");
        return;
    }
    // off the main thread: launching waits on the system
    std::thread::spawn(move || {
        if !launch_client() {
            open_url(&format!("https://{d}/"));
        }
    });
}

/// Phosphorus Client started, a running one brought up; false when it isn't installed
fn launch_client() -> bool {
    #[cfg(target_os = "macos")]
    let ok = Command::new("/usr/bin/open").args(["-b", CLIENT_ID]).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
    // the client installer's per-user dir, then the copy older hosts made
    #[cfg(windows)]
    let ok = {
        let local = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default());
        [local.join(r"Phosphorus Client\Phosphorus.exe"), local.join(r"Programs\Phosphorus Client\Phosphorus Client.exe")]
            .into_iter()
            .find(|p| p.exists())
            .is_some_and(|p| Command::new(p).stdin(Stdio::null()).spawn().is_ok())
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    let ok = false;
    ok
}

fn open_url(url: &str) {
    #[cfg(target_os = "macos")]
    let _ = Command::new("/usr/bin/open").arg(url).spawn();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).creation_flags(0x0800_0000).spawn();
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = Command::new("xdg-open").arg(url).spawn();
}

/// the keys window, one at a time
fn open_keys(handle: &AppHandle) {
    activate(handle);
    if let Some(w) = handle.get_webview_window("keys") {
        let _ = w.set_focus();
        return;
    }
    let b = WebviewWindowBuilder::new(handle, "keys", WebviewUrl::App("keys.html".into()))
        .title("Phosphorus Keys")
        // the tray's own: no taskbar button
        .skip_taskbar(true)
        .inner_size(520.0, 460.0)
        .resizable(false)
        .center()
        .focused(true);
    // no title bar: macOS keeps its traffic lights over the page, the rest none; the page's top strip drags it
    #[cfg(target_os = "macos")]
    let b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let b = b.decorations(false);
    let w = b.build();
    if let Ok(w) = w {
        let _ = w.set_focus();
    }
}

/// for the keys window: which are set, never what they are
#[tauri::command]
fn keys_status(app: tauri::State<App>) -> HashMap<String, bool> {
    key_status(&app)
}

/// the typed keys into .env, blanks keeping what's there, then phosphorus
/// started (or recreated) on them
#[tauri::command]
fn save_keys(handle: AppHandle, values: HashMap<String, String>) -> Result<(), String> {
    let app = handle.state::<App>();
    let body: String = values
        .iter()
        .filter(|(k, v)| !v.trim().is_empty() && k.chars().all(|c| c.is_ascii_uppercase() || c == '_'))
        .map(|(k, v)| format!("{k}={}\n", v.split_whitespace().collect::<String>()))
        .collect();
    if body.is_empty() {
        if keys_missing(&app) {
            return Err("the Tailscale auth key is needed".into());
        }
        close_keys(handle);
        return Ok(());
    }
    let mut c = host_cmd(&app, &["keys", "--stdin"]);
    let mut child = c.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    if let Some(mut i) = child.stdin.take() {
        i.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    if keys_missing(&app) {
        return Err("the Tailscale auth key is needed".into());
    }
    close_keys(handle.clone());
    host_action(handle, "start", true);
    Ok(())
}

#[tauri::command]
fn close_keys(handle: AppHandle) {
    if let Some(w) = handle.get_webview_window("keys") {
        let _ = w.close();
    }
}

/// the app's own folders: config, data, caches, logs
fn app_dirs(handle: &AppHandle) -> Vec<PathBuf> {
    let p = handle.path();
    [p.app_config_dir(), p.app_data_dir(), p.app_local_data_dir(), p.app_cache_dir(), p.app_log_dir()]
        .into_iter()
        .flatten()
        .collect()
}

/// the app itself removed once this process is gone: the bundle (macOS), the
/// installer's uninstaller (Windows)
fn remove_app() {
    let Ok(exe) = std::env::current_exe() else { return };
    #[cfg(target_os = "macos")]
    if let Some(bundle) = exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")) {
        let q = format!("'{}'", bundle.display().to_string().replace('\'', "'\\''"));
        let _ = Command::new("/bin/sh").args(["-c", &format!("sleep 2; rm -rf {q}")]).stdin(Stdio::null()).spawn();
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let un = exe.parent().unwrap_or(Path::new(".")).join("uninstall.exe");
        if un.exists() {
            let _ = Command::new("cmd")
                .args(["/c", "timeout", "/t", "2", "/nobreak", ">nul", "&"])
                .arg(&un)
                .arg("/S")
                .creation_flags(0x0800_0000)
                .spawn();
        }
    }
    #[cfg(target_os = "linux")]
    let _ = exe;
}

/// everything gone after a confirm: a host's service, setup and home, the
/// app's own folders and login item, then the app
fn uninstall(handle: AppHandle) {
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let app = handle.state::<App>();
        let what = format!("This removes Phosphorus from this computer: the host service, its setup and everything in {}, including this host's git data and shares. Other hosts keep the mesh. Phosphorus Client, if installed, stays.", app.home.display());
        activate(&handle);
        let go = handle
            .dialog()
            .message(what)
            .title("Uninstall Phosphorus")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Uninstall".into(), "Cancel".into()))
            .blocking_show();
        if !go {
            BUSY.store(false, Ordering::SeqCst);
            return;
        }
        set_tip(&handle, "Phosphorus uninstalling…");
        #[cfg(target_os = "macos")]
        as_admin(&app, "uninstall --admin");
        // not host_run: its log would put the home back
        match host_cmd(&app, &["uninstall"]).output() {
            Ok(o) if o.status.success() => {}
            Ok(o) => {
                let text = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
                let e = last_error(&text);
                BUSY.store(false, Ordering::SeqCst);
                refresh(&handle);
                alert(&handle, if e.is_empty() { "uninstall failed" } else { &e });
                return;
            }
            Err(e) => {
                BUSY.store(false, Ordering::SeqCst);
                alert(&handle, &e.to_string());
                return;
            }
        }
        let _ = handle.autolaunch().disable();
        for d in app_dirs(&handle) {
            let _ = std::fs::remove_dir_all(d);
        }
        remove_app();
        handle.exit(0);
    });
}

/// macOS: the app menu, its Edit menu the webviews' copy and paste
#[cfg(target_os = "macos")]
fn app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let name = app.package_info().name.clone();
    let main = tauri::menu::Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "uninstall", "Uninstall…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", format!("Quit {name}"), true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let edit = tauri::menu::Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = tauri::menu::Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::fullscreen(app, None)?, &PredefinedMenuItem::close_window(app, None)?],
    )?;
    Menu::with_items(app, &[&main, &edit, &window])
}

/// the tray: the service's controls, Open the frontend
fn tray(app: &AppHandle) -> tauri::Result<()> {
    let item = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>);
    let sep = || PredefinedMenuItem::separator(app);
    let status = MenuItem::with_id(app, "status", "Phosphorus", false, None::<&str>)?;
    let _ = STATUS.set(status.clone());
    let start = item("start", "Start")?;
    let stop = item("stop", "Stop")?;
    let net = item("vpn", "Turn VPN Off")?;
    let _ = ITEMS.set([start.clone(), stop.clone(), net.clone()]);
    let menu = Menu::with_items(
            app,
            &[
                &status,
                &sep()?,
                &item("open", "Open Phosphorus")?,
                &sep()?,
                &start,
                &stop,
                &net,
                &item("update", "Check for Updates")?,
                &sep()?,
                &item("keys", "Edit Keys…")?,
                &sep()?,
                &item("uninstall", "Uninstall…")?,
                &sep()?,
                &item("quit", "Quit (stops phosphorus)")?,
            ],
        )?;
    let b = TrayIconBuilder::with_id("phosphorus").tooltip("Phosphorus").menu(&menu);
    // macOS: the white glyph as a template, tinted like the system's own
    #[cfg(target_os = "macos")]
    let b = b.icon(tauri::image::Image::from_bytes(include_bytes!("../../icons/tray.png"))?).icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let b = b.icon(app.default_window_icon().cloned().expect("icon"));
    b.build(app)?;
    Ok(())
}

/// every menu's items, the tray's and the macOS app menu's
fn menu_event(app: &AppHandle, id: &str) {
    match id {
        "open" => open_main(app),
        "start" => host_action(app.clone(), "start", false),
        "stop" => host_action(app.clone(), "stop", false),
        "vpn" => vpn_action(app.clone()),
        "update" => {
            let a = app.clone();
            let id = format!("app-{}", now_ms());
            tauri::async_runtime::spawn(async move { handle_update(a, id, true).await });
        }
        "keys" => open_keys(app),
        "uninstall" => uninstall(app.clone()),
        "quit" => quit(app.clone()),
        _ => {}
    }
}

/// phosphorus stopped first, then the app gone
fn quit(handle: AppHandle) {
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let app = handle.state::<App>();
        set_tip(&handle, "Phosphorus stopping…");
        let (ok, out) = host_run(&app, &["stop"], "stop");
        if !ok {
            BUSY.store(false, Ordering::SeqCst);
            refresh(&handle);
            let e = last_error(&out);
            alert(&handle, if e.is_empty() { "couldn't stop phosphorus, see state/ in the Phosphorus folder" } else { &e });
            return;
        }
        handle.exit(0);
    });
}

fn main() {
    let background = std::env::args().any(|a| a == "--background");
    let app = tauri::Builder::default()
        // opened again: the running one's window brought up instead
        .plugin(tauri_plugin_single_instance::init(|app, _, _| open_main(app)))
        .enable_macos_default_menu(false)
        .on_menu_event(|app, e| menu_event(app, e.id().as_ref()))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--background"])))
        .invoke_handler(tauri::generate_handler![keys_status, save_keys, close_keys])
        .setup(move |app| {
            // not "phosphorus": beside the Phosphorus binary on a case-insensitive disk
            let payload = app.path().resource_dir()?.join("release");
            let host = host_bin();
            app.manage(App { payload, home: home_dir(), host });
            #[cfg(target_os = "macos")]
            app.set_menu(app_menu(app.handle())?)?;
            // release builds carry the updater config; dev builds none
            if app.config().plugins.0.contains_key("updater") {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            tray(app.handle())?;
            // a host stays up across logins
            let _ = app.autolaunch().enable();
            startup(app.handle().clone(), background);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Phosphorus app");
    app.run(|h, e| match e {
        // the tray outliving its windows, Quit alone ending it
        RunEvent::ExitRequested { api, code: None, .. } => api.prevent_exit(),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => open_main(h),
        _ => {
            let _ = h;
        }
    });
}
