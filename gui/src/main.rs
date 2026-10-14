//! Hesperus tray app, macOS and Windows: release into the home, bring-up, feed updates

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

/// one install or update at a time
static BUSY: AtomicBool = AtomicBool::new(false);

struct App {
    payload: PathBuf,
    home: PathBuf,
    line: MenuItem<tauri::Wry>,
}

fn home_dir() -> PathBuf {
    if let Some(h) = std::env::var_os("HESPERUS_HOME") {
        return h.into();
    }
    if cfg!(windows) {
        // not %LOCALAPPDATA%\Hesperus: the app's own install dir, wiped by its uninstaller
        PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default()).join("hesperus")
    } else {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Library/Hesperus")
    }
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

/// what the frontend and `hesperus update` wait on
fn report(home: &Path, id: &str, state: &str, current: bool, version: &str, error: &str) {
    let e: String = error.chars().take(400).collect();
    write_json(
        &home.join("state/update-agent.json"),
        &json!({"id": id, "state": state, "current": current, "version": version, "error": e, "at": now_ms()}),
    );
}

fn env_value(home: &Path, key: &str) -> String {
    read(&home.join(".env"))
        .lines()
        .find_map(|l| l.strip_prefix(&format!("{key}=")).map(str::to_string))
        .unwrap_or_default()
}

fn configured(home: &Path) -> bool {
    let d = env_value(home, "BASE_DOMAIN");
    !d.is_empty() && d != "example.com"
}

/// the package's install script, its output kept in state/install.log
fn install_cmd(payload: &Path, update: bool) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]).arg(payload.join("scripts/windows/install.ps1"));
        if update {
            c.arg("-Update");
        }
        c.creation_flags(0x0800_0000);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("/bin/bash");
        c.arg(payload.join("scripts/install.sh"));
        if update {
            c.arg("--update");
        }
        // Finder's PATH: no homebrew docker or colima
        let path = std::env::var("PATH").unwrap_or_default();
        c.env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{path}"));
        c
    }
}

/// non-interactive install --update: (ok, already current, last lines)
fn run_update_install(app: &App) -> (bool, bool, String) {
    let log = app.home.join("state/install.log");
    let _ = std::fs::create_dir_all(app.home.join("state"));
    let out = install_cmd(&app.payload, true).stdin(Stdio::null()).output();
    match out {
        Ok(o) => {
            let text = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
            let _ = std::fs::write(&log, &text);
            let tail = text.lines().filter(|l| l.contains("ERROR")).last().unwrap_or("").to_string();
            (o.status.success(), text.contains("already up to date"), tail)
        }
        Err(e) => (false, false, e.to_string()),
    }
}

/// first install: visible, for sudo (macOS) or admin (Windows) prompts
fn run_interactive_install(app: &App) -> Result<(), String> {
    #[cfg(windows)]
    {
        let script = app.payload.join("scripts\\windows\\install.ps1");
        let arg = format!(
            "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-File','\"{}\"','-HesperusHome','\"{}\"'",
            script.display(),
            app.home.display()
        );
        Command::new("powershell").args(["-NoProfile", "-Command", &arg]).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let cmd = format!(
            "export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; /bin/bash '{}'",
            app.payload.join("scripts/install.sh").display()
        );
        let script = format!("tell application \"Terminal\" to do script \"{}\"\ntell application \"Terminal\" to activate", cmd.replace('"', "\\\""));
        Command::new("/usr/bin/osascript").args(["-e", &script]).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

fn docker_up() -> bool {
    let mut c = Command::new("docker");
    c.args(["info", "--format", "{{.ServerVersion}}"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    {
        let path = std::env::var("PATH").unwrap_or_default();
        c.env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{path}"));
    }
    c.status().map(|s| s.success()).unwrap_or(false)
}

/// the docker engine up at login: colima on macOS, Docker Desktop on Windows
fn ensure_engine(handle: &AppHandle) -> Result<(), String> {
    if docker_up() {
        return Ok(());
    }
    set_line(handle, "Hesperus starting docker…");
    #[cfg(windows)]
    {
        let pf = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Program Files"));
        let exe = pf.join("Docker\\Docker\\Docker Desktop.exe");
        if !exe.exists() {
            return Err("Docker Desktop not installed".into());
        }
        Command::new(exe).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let path = std::env::var("PATH").unwrap_or_default();
        // blocks until the vm's docker answers or colima gives up
        let ok = Command::new("colima")
            .arg("start")
            .env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{path}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| format!("colima: {e}"))?;
        if !ok.success() {
            return Err("colima didn't start".into());
        }
    }
    for _ in 0..90 {
        if docker_up() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    Err("docker never answered".into())
}

fn set_line(app: &AppHandle, text: &str) {
    let _ = app.state::<App>().line.set_text(text);
    if let Some(t) = app.tray_by_id("hesperus") {
        let _ = t.set_tooltip(Some(text));
    }
}

fn payload_version(app: &App) -> String {
    read(&app.payload.join("VERSION"))
}

/// an update request: the feed's newer app installed and relaunched (finished on the next
/// launch), else this release's images and config re-applied
async fn handle_update(handle: AppHandle, id: String, ask: bool) {
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = handle.state::<App>();
    report(&app.home, &id, "running", false, "", "");
    set_line(&handle, "Hesperus checking for updates…");
    let found = match handle.updater() {
        Ok(u) => u.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    match found {
        Ok(Some(u)) => {
            if ask {
                let go = handle
                    .dialog()
                    .message(format!("Hesperus {} is available. Updating restarts this host's containers.", u.version))
                    .title("Hesperus Updates")
                    .buttons(MessageDialogButtons::OkCancelCustom("Update".into(), "Later".into()))
                    .blocking_show();
                if !go {
                    report(&app.home, &id, "failed", false, "", "update declined");
                    BUSY.store(false, Ordering::SeqCst);
                    set_line(&handle, &status_line(&app));
                    return;
                }
            }
            set_line(&handle, &format!("Hesperus downloading {}…", u.version));
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
                eprintln!("hesperus: update feed: {e}");
            }
            set_line(&handle, "Hesperus applying this release…");
            let (ok, current, tail) = run_update_install(&app);
            let v = payload_version(&app);
            if ok {
                report(&app.home, &id, "ok", current, &v, "");
                if ask {
                    let m = if current { format!("Hesperus {v} is up to date.") } else { format!("Hesperus {v} re-applied.") };
                    handle.dialog().message(m).title("Hesperus Updates").show(|_| {});
                }
            } else {
                report(&app.home, &id, "failed", false, "", if tail.is_empty() { "install failed" } else { &tail });
            }
        }
    }
    BUSY.store(false, Ordering::SeqCst);
    set_line(&handle, &status_line(&app));
}

fn status_line(app: &App) -> String {
    let v = read(&app.home.join(".hesperus-installed"));
    if v.is_empty() {
        "Hesperus not set up".into()
    } else if !configured(&app.home) {
        format!("Hesperus {v}: fill in .env")
    } else {
        format!("Hesperus {v}")
    }
}

/// launch: a new release unpacked into home, a pending update's verdict written,
/// then the web UI's requests watched
fn startup(handle: AppHandle) {
    std::thread::spawn(move || {
        let app = handle.state::<App>();
        let installed = read(&app.home.join(".hesperus-installed"));
        let ver = payload_version(&app);
        // first run's install starts the engine itself
        let engine = if installed.is_empty() { Ok(()) } else { ensure_engine(&handle) };
        if let Err(e) = &engine {
            eprintln!("hesperus: engine: {e}");
        }
        if installed.is_empty() && !app.home.join(".env").exists() {
            // first run: bring-up needs the person's sudo or admin
            let _ = run_interactive_install(&app);
        } else if installed != ver && !BUSY.swap(true, Ordering::SeqCst) {
            set_line(&handle, &format!("Hesperus installing {ver}…"));
            let (ok, _, tail) = run_update_install(&app);
            let pending = app.home.join("state/update-pending.json");
            if let Ok(p) = std::fs::read_to_string(&pending).map(|s| serde_json::from_str::<Value>(&s).unwrap_or_default()) {
                let id = p["id"].as_str().unwrap_or("");
                if ok {
                    report(&app.home, id, "ok", false, &ver, "");
                } else {
                    report(&app.home, id, "failed", false, "", &tail);
                }
                let _ = std::fs::remove_file(&pending);
            }
            BUSY.store(false, Ordering::SeqCst);
        }
        match &engine {
            Err(e) => set_line(&handle, &format!("Hesperus: {e}")),
            Ok(()) => set_line(&handle, &status_line(&app)),
        }
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

/// hesperus start / stop through the installed cli
fn cli(app: &App, arg: &str) {
    #[cfg(windows)]
    let mut c = {
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-File"])
            .arg(app.home.join("scripts\\windows\\bin\\hesperus.ps1"))
            .arg(arg);
        c
    };
    #[cfg(not(windows))]
    let mut c = {
        let cmd = format!(
            "export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; /bin/bash '{}' {arg}",
            app.home.join("scripts/hesperus").display()
        );
        let script = format!("tell application \"Terminal\" to do script \"{}\"\ntell application \"Terminal\" to activate", cmd.replace('"', "\\\""));
        let mut c = Command::new("/usr/bin/osascript");
        c.args(["-e", &script]);
        c
    };
    let _ = c.spawn();
}

fn tray(app: &AppHandle, line: &MenuItem<tauri::Wry>) -> tauri::Result<()> {
    let item = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>);
    let open = item("open", "Open Hesperus")?;
    let upd = item("update", "Check for Updates")?;
    let start = item("start", "Start")?;
    let stop = item("stop", "Stop")?;
    let env = item("env", "Edit Settings (.env)")?;
    let folder = item("folder", "Show Files")?;
    let quit = item("quit", "Quit (containers keep running)")?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(app, &[line, &sep()?, &open, &upd, &sep()?, &start, &stop, &env, &folder, &sep()?, &quit])?;
    TrayIconBuilder::with_id("hesperus")
        .icon(app.default_window_icon().cloned().expect("icon"))
        .tooltip("Hesperus")
        .menu(&menu)
        .on_menu_event(|app, e| {
            let st = app.state::<App>();
            match e.id().as_ref() {
                "open" => {
                    let d = env_value(&st.home, "BASE_DOMAIN");
                    if !d.is_empty() {
                        let _ = app.opener().open_url(format!("https://{d}/"), None::<&str>);
                    }
                }
                "update" => {
                    let a = app.clone();
                    let id = format!("app-{}", now_ms());
                    tauri::async_runtime::spawn(async move { handle_update(a, id, true).await });
                }
                "start" => cli(&st, "start"),
                "stop" => cli(&st, "stop"),
                "env" => {
                    let _ = app.opener().open_path(st.home.join(".env").to_string_lossy(), None::<&str>);
                }
                "folder" => {
                    let _ = app.opener().open_path(st.home.to_string_lossy(), None::<&str>);
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            // not "hesperus": beside the Hesperus binary on a case-insensitive disk
            let payload = app.path().resource_dir()?.join("release");
            let line = MenuItem::with_id(app, "status", "Hesperus", false, None::<&str>)?;
            app.manage(App { payload, home: home_dir(), line: line.clone() });
            tray(app.handle(), &line)?;
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
        .expect("Hesperus app");
    app.run(|_, e| {
        if let RunEvent::ExitRequested { api, code: None, .. } = e {
            api.prevent_exit();
        }
    });
}
