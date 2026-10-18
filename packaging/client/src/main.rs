//! Phosphorus Client, macOS, Windows and Linux: a window on the mesh's frontend,
//! updating itself from the release feed; installed apart from any host

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "macos", windows))]
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// one update or uninstall at a time
static BUSY: AtomicBool = AtomicBool::new(false);
/// popped out windows' labels
static TABS: AtomicU32 = AtomicU32::new(0);
/// between the feed's quiet checks while running
const UPDATE_EVERY: Duration = Duration::from_secs(6 * 3600);

struct App {
    // where the mesh's domain is kept
    config: PathBuf,
}

/// a host's home on this machine, its domain the client's default
fn home_dir() -> PathBuf {
    if let Some(h) = std::env::var_os("PHOSPHORUS_HOME") {
        return h.into();
    }
    if cfg!(windows) {
        PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default()).join("phosphorus")
    } else {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Library/Phosphorus")
    }
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

fn alert(handle: &AppHandle, text: &str) {
    handle.dialog().message(text).title("Phosphorus Client").kind(MessageDialogKind::Error).show(|_| {});
}

/// a typed domain bare: no scheme, path or port
fn bare_domain(s: &str) -> String {
    let s = s.trim().trim_start_matches("https://").trim_start_matches("http://");
    s.split(['/', '?', '#']).next().unwrap_or("").to_ascii_lowercase()
}

/// the frontend's address: https at a domain, http at a tailnet name or address
fn url_of(d: &str) -> String {
    let tail = !d.contains('.') || d.ends_with(".ts.net") || d.parse::<std::net::IpAddr>().is_ok();
    format!("{}://{d}/", if tail { "http" } else { "https" })
}

/// a host's mesh domain on this machine: .env's, else the one copied from a peer,
/// else, on a host with none, its own frontend
fn host_domain() -> String {
    let h = home_dir();
    let env = std::fs::read_to_string(h.join(".env")).unwrap_or_default();
    let d = env
        .lines()
        .find_map(|l| l.trim().strip_prefix("BASE_DOMAIN=").map(|v| v.trim().trim_matches(['"', '\'']).to_string()))
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| read(&h.join("state/base-domain")));
    let d = bare_domain(&d);
    if d.is_empty() && h.join(".env").exists() {
        return "localhost".into();
    }
    d
}

/// the mesh's domain: a host's here, else the one entered
fn domain(app: &App) -> String {
    let d = host_domain();
    if !d.is_empty() {
        return d;
    }
    serde_json::from_str::<Value>(&read(&app.config)).ok().and_then(|v| v["domain"].as_str().map(str::to_string)).unwrap_or_default()
}

/// the frontend in a window of its own, no menu bar; the domain asked for without one
fn open_main(handle: &AppHandle) {
    if let Some(w) = handle.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let d = domain(&handle.state::<App>());
    let url = tauri::Url::parse(&url_of(&d));
    let Ok(url) = url.map_err(|_| ()).and_then(|u| if d.is_empty() { Err(()) } else { Ok(u) }) else {
        open_connect(handle);
        return;
    };
    let h = handle.clone();
    let b = WebviewWindowBuilder::new(handle, "main", WebviewUrl::External(url))
        .title("Phosphorus")
        .inner_size(1280.0, 820.0)
        .min_inner_size(480.0, 360.0)
        .maximized(true)
        .focused(true)
        .on_new_window(move |u, _| popout(&h, u))
        .initialization_script("window.__phosphorusClient = true;");
    // macOS: no title bar, the traffic lights over the page and a strip above it to drag by
    #[cfg(target_os = "macos")]
    let b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true).initialization_script(DRAG_STRIP);
    #[cfg(target_os = "macos")]
    {
        let cap = tauri::ipc::CapabilityBuilder::new("drag")
            .remote(format!("{}*", url_of(&d)))
            .window("main")
            .permission("core:window:allow-start-dragging")
            .permission("core:window:allow-internal-toggle-maximize");
        let _ = handle.add_capability(cap);
    }
    let _ = b.build();
}

/// the page's top 28px a drag strip, as a title bar; the page pads its desk under it
#[cfg(target_os = "macos")]
const DRAG_STRIP: &str = r#"
document.documentElement.classList.add('app-mac');
addEventListener('DOMContentLoaded', () => {
  const s = document.createElement('div');
  s.setAttribute('data-tauri-drag-region', '');
  s.style.cssText = 'position:fixed;top:0;left:0;right:0;height:28px;z-index:2147483647';
  document.body.appendChild(s);
});
"#;

/// an app's new tab or window: a window of its own on the same session
fn popout(handle: &AppHandle, url: tauri::Url) -> NewWindowResponse<tauri::Wry> {
    let h = handle.clone();
    let _ = handle.run_on_main_thread(move || open_tab(&h, url));
    NewWindowResponse::Deny
}

fn open_tab(handle: &AppHandle, url: tauri::Url) {
    let label = format!("tab-{}", TABS.fetch_add(1, Ordering::SeqCst));
    let title = url.host_str().unwrap_or("Phosphorus").to_string();
    let h = handle.clone();
    let _ = WebviewWindowBuilder::new(handle, label, WebviewUrl::External(url))
        .title(title)
        .inner_size(1100.0, 760.0)
        .min_inner_size(360.0, 240.0)
        .center()
        .focused(true)
        .on_new_window(move |u, _| popout(&h, u))
        .build();
}

/// the first start: the mesh's domain asked for
fn open_connect(handle: &AppHandle) {
    if let Some(w) = handle.get_webview_window("connect") {
        let _ = w.set_focus();
        return;
    }
    let w = WebviewWindowBuilder::new(handle, "connect", WebviewUrl::App("connect.html".into()))
        .title("Phosphorus")
        .inner_size(460.0, 260.0)
        .resizable(false)
        .center()
        .focused(true)
        .build();
    if let Ok(w) = w {
        let _ = w.set_focus();
    }
}

// async: a window made in a sync command deadlocks WebView2, a white main window
#[tauri::command]
async fn set_domain(handle: AppHandle, domain: String) -> Result<(), String> {
    let d = bare_domain(&domain);
    if d.is_empty() || d.chars().any(|c| !(c.is_ascii_alphanumeric() || c == '.' || c == '-')) {
        return Err("a domain or tailnet name".into());
    }
    write_json(&handle.state::<App>().config, &json!({"domain": d}));
    // main up before connect goes, never a moment with no window to quit on
    open_main(&handle);
    if let Some(w) = handle.get_webview_window("connect") {
        let _ = w.close();
    }
    Ok(())
}

/// release builds carry the updater config; dev builds none
fn can_update(handle: &AppHandle) -> bool {
    handle.config().plugins.0.contains_key("updater")
}

/// the feed's newer client offered, then installed and relaunched; quiet on none
/// or a failed check unless asked
async fn check_update(handle: AppHandle, ask: bool) {
    if !can_update(&handle) || BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    let found = match handle.updater_builder().timeout(Duration::from_secs(30)).build() {
        Ok(u) => u.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    match found {
        Ok(Some(u)) => {
            let v = u.version.strip_suffix(".0").unwrap_or(&u.version).to_string();
            let go = handle
                .dialog()
                .message(format!("Phosphorus Client {v} is available. Updating restarts the client."))
                .title("Phosphorus Client Updates")
                .buttons(MessageDialogButtons::OkCancelCustom("Update".into(), "Later".into()))
                .blocking_show();
            if go {
                // Windows: the installer exits this process and relaunches it
                match u.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => handle.restart(),
                    Err(e) => alert(&handle, &format!("update failed: {e}")),
                }
            }
        }
        Ok(None) if ask => {
            let v = handle.package_info().version.to_string();
            let v = v.strip_suffix(".0").unwrap_or(&v).to_string();
            handle.dialog().message(format!("Phosphorus Client {v} is up to date.")).title("Phosphorus Client Updates").show(|_| {});
        }
        Err(e) if ask => alert(&handle, &format!("couldn't check for updates: {e}")),
        Err(e) => eprintln!("phosphorus client: update feed: {e}"),
        Ok(None) => {}
    }
    BUSY.store(false, Ordering::SeqCst);
}

/// a quiet check soon after launch, then every few hours
fn watch_updates(handle: AppHandle) {
    if !can_update(&handle) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(5));
        loop {
            tauri::async_runtime::block_on(check_update(handle.clone(), false));
            std::thread::sleep(UPDATE_EVERY);
        }
    });
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
/// installer's uninstaller (Windows); a Linux package left to apt
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

/// the client and its settings gone after a confirm
fn uninstall(handle: AppHandle) {
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let go = handle
            .dialog()
            .message("This removes Phosphorus Client and its settings from this computer.")
            .title("Uninstall Phosphorus Client")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Uninstall".into(), "Cancel".into()))
            .blocking_show();
        if !go {
            BUSY.store(false, Ordering::SeqCst);
            return;
        }
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
            &MenuItem::with_id(app, "update", "Check for Updates…", can_update(app), None::<&str>)?,
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

fn menu_event(app: &AppHandle, id: &str) {
    match id {
        "update" => {
            let a = app.clone();
            tauri::async_runtime::spawn(async move { check_update(a, true).await });
        }
        "uninstall" => uninstall(app.clone()),
        "quit" => app.exit(0),
        _ => {}
    }
}

fn main() {
    let app = tauri::Builder::default()
        // opened again: the running one's window brought up instead
        .plugin(tauri_plugin_single_instance::init(|app, _, _| open_main(app)))
        .enable_macos_default_menu(false)
        .on_menu_event(|app, e| menu_event(app, e.id().as_ref()))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![set_domain])
        .setup(|app| {
            let config = app.path().app_config_dir()?.join("client.json");
            app.manage(App { config });
            #[cfg(target_os = "macos")]
            app.set_menu(app_menu(app.handle())?)?;
            if can_update(app.handle()) {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            open_main(app.handle());
            watch_updates(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Phosphorus Client");
    app.run(|h, e| match e {
        // the main window closed: the client quit, its tabs with it
        RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } if label == "main" => h.exit(0),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => open_main(h),
        _ => {
            let _ = h;
        }
    });
}
