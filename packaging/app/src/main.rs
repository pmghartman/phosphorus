//! Phosphorus tray app, macOS and Windows: keys asked for, the bundled host binary's
//! install and bring-up, start and stop, feed updates

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// one install, start, stop or update at a time
static BUSY: AtomicBool = AtomicBool::new(false);

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
}

fn payload_version(app: &App) -> String {
    read(&app.payload.join("VERSION"))
}

fn status_tip(app: &App) -> String {
    let v = read(&app.home.join(".phosphorus-installed"));
    if v.is_empty() {
        "Phosphorus not set up".into()
    } else if keys_missing(app) {
        format!("Phosphorus {v}: no keys yet")
    } else {
        format!("Phosphorus {v}")
    }
}

fn alert(handle: &AppHandle, text: &str) {
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
        let q = |p: &Path| format!("'{}'", p.display().to_string().replace('\'', "'\\''"));
        let sh = format!("{} setup --home {}", q(&app.host), q(&app.home));
        let script = format!("do shell script \"{}\" with administrator privileges", sh.replace('\\', "\\\\").replace('"', "\\\""));
        let _ = Command::new("/usr/bin/osascript").args(["-e", &script]).status();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// start or stop in the background, the tooltip following, a failure shown
fn host_action(handle: AppHandle, action: &'static str) {
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
        let (ok, out) = host_run(&app, &[action], action);
        BUSY.store(false, Ordering::SeqCst);
        set_tip(&handle, &status_tip(&app));
        if !ok {
            let e = last_error(&out);
            alert(&handle, if e.is_empty() { "failed, see state/ in the Phosphorus folder" } else { &e });
        }
    });
}

/// an update request: the feed's newer app installed and relaunched (finished on the next
/// launch), else this release's images and config re-applied
async fn handle_update(handle: AppHandle, id: String, ask: bool) {
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = handle.state::<App>();
    report(&app.home, &id, "running", false, "", "");
    set_tip(&handle, "Phosphorus checking for updates…");
    let found = match handle.updater() {
        Ok(u) => u.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    match found {
        Ok(Some(u)) => {
            if ask {
                let go = handle
                    .dialog()
                    .message(format!("Phosphorus {} is available. Updating restarts this host's containers.", u.version))
                    .title("Phosphorus Updates")
                    .buttons(MessageDialogButtons::OkCancelCustom("Update".into(), "Later".into()))
                    .blocking_show();
                if !go {
                    report(&app.home, &id, "failed", false, "", "update declined");
                    BUSY.store(false, Ordering::SeqCst);
                    set_tip(&handle, &status_tip(&app));
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
    set_tip(&handle, &status_tip(&app));
}

/// launch: a new release unpacked into home, a pending update's verdict
/// written, the keys asked for when there are none, then the update requests watched
fn startup(handle: AppHandle) {
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
        if keys_missing(&app) {
            let h = handle.clone();
            let _ = handle.run_on_main_thread(move || open_keys(&h));
        }
        set_tip(&handle, &status_tip(&app));
        let req = app.home.join("state/update-request.json");
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let Ok(text) = std::fs::read_to_string(&req) else { continue };
            let _ = std::fs::remove_file(&req);
            let id = serde_json::from_str::<Value>(&text).ok().and_then(|v| v["id"].as_str().map(str::to_string)).unwrap_or_default();
            tauri::async_runtime::block_on(handle_update(handle.clone(), id, false));
        }
    });
}

/// the keys window, one at a time
fn open_keys(handle: &AppHandle) {
    if let Some(w) = handle.get_webview_window("keys") {
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(handle, "keys", WebviewUrl::App("keys.html".into()))
        .title("Phosphorus Keys")
        .inner_size(520.0, 600.0)
        .resizable(false)
        .center()
        .focused(true)
        .build();
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
    host_action(handle, "start");
    Ok(())
}

#[tauri::command]
fn close_keys(handle: AppHandle) {
    if let Some(w) = handle.get_webview_window("keys") {
        let _ = w.close();
    }
}

fn tray(app: &AppHandle) -> tauri::Result<()> {
    let item = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>);
    let menu = Menu::with_items(
        app,
        &[
            &item("start", "Start")?,
            &item("stop", "Stop")?,
            &item("update", "Check for Updates")?,
            &PredefinedMenuItem::separator(app)?,
            &item("keys", "Edit Keys…")?,
        ],
    )?;
    let b = TrayIconBuilder::with_id("phosphorus").tooltip("Phosphorus").menu(&menu);
    // macOS: the white glyph as a template, tinted like the system's own
    #[cfg(target_os = "macos")]
    let b = b.icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?).icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let b = b.icon(app.default_window_icon().cloned().expect("icon"));
    b.on_menu_event(|app, e| match e.id().as_ref() {
        "start" => host_action(app.clone(), "start"),
        "stop" => host_action(app.clone(), "stop"),
        "update" => {
            let a = app.clone();
            let id = format!("app-{}", now_ms());
            tauri::async_runtime::spawn(async move { handle_update(a, id, true).await });
        }
        "keys" => open_keys(app),
        _ => {}
    })
    .build(app)?;
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![keys_status, save_keys, close_keys])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            // not "phosphorus": beside the Phosphorus binary on a case-insensitive disk
            let payload = app.path().resource_dir()?.join("release");
            app.manage(App { payload, home: home_dir(), host: host_bin() });
            tray(app.handle())?;
            // release builds carry the updater config; dev builds none
            if app.config().plugins.0.contains_key("updater") {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            // a host stays up across logins
            let _ = app.autolaunch().enable();
            startup(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Phosphorus app");
    app.run(|_, e| {
        // the keys window closing never quits the tray
        if let RunEvent::ExitRequested { api, code: None, .. } = e {
            api.prevent_exit();
        }
    });
}
