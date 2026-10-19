//! the bridge's live record of Claude's calls: in flight and just done, kept in a
//! file the client's window reads, refreshed by a heartbeat while the bridge runs

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const RECENT: usize = 40;
/// the heartbeat's period; a reader counts the bridge gone after a few missed
pub const BEAT_MS: u64 = 3000;

struct Live {
    id: u64,
    label: String,
    detail: String,
    since: u64,
}

struct State {
    next: u64,
    live: Vec<Live>,
    done: Vec<Value>,
    at: u64,
    ok: bool,
    error: Option<String>,
}

static STATE: Mutex<State> = Mutex::new(State { next: 0, live: Vec::new(), done: Vec::new(), at: 0, ok: true, error: None });
static FILE: OnceLock<PathBuf> = OnceLock::new();

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// the file the window reads
pub fn read(p: &Path) -> Value {
    std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}))
}

fn flush(s: &State) {
    let Some(p) = FILE.get() else { return };
    let calls: Vec<Value> = s.live.iter().map(|c| json!({"tool": c.label, "detail": c.detail, "since": c.since})).collect();
    let v = json!({"beat": now_ms(), "pid": std::process::id(), "at": s.at, "ok": s.ok, "error": s.error, "calls": calls, "recent": s.done});
    let tmp = p.with_extension("json.tmp");
    let _ = std::fs::create_dir_all(p.parent().unwrap_or(Path::new(".")));
    if std::fs::write(&tmp, v.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, p);
    }
}

/// the bridge is up: its file written now and again every few seconds
pub fn start(file: PathBuf) {
    let _ = FILE.set(file);
    flush(&STATE.lock().unwrap());
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_millis(BEAT_MS));
        flush(&STATE.lock().unwrap());
    });
}

/// a request taken in; the label and detail are what the window shows for it
pub fn begin((label, detail): (String, String)) -> u64 {
    let mut s = STATE.lock().unwrap();
    s.next += 1;
    let id = s.next;
    s.live.push(Live { id, label, detail, since: now_ms() });
    flush(&s);
    id
}

/// a request answered, or failed with why
pub fn end(id: u64, error: Option<String>) {
    let mut s = STATE.lock().unwrap();
    let Some(i) = s.live.iter().position(|c| c.id == id) else { return };
    let c = s.live.remove(i);
    let at = now_ms();
    let ok = error.is_none();
    s.done.insert(0, json!({"tool": c.label, "detail": c.detail, "at": at, "ms": at.saturating_sub(c.since), "ok": ok, "error": error}));
    s.done.truncate(RECENT);
    s.at = at;
    s.ok = ok;
    s.error = error;
    flush(&s);
}

/// what a request is called: a tool by its name and its main argument, else its method; pings none
pub fn label_of(req: &Value) -> Option<(String, String)> {
    let m = req["method"].as_str()?;
    match m {
        "ping" => None,
        "tools/call" => {
            let p = &req["params"];
            Some((p["name"].as_str().unwrap_or("tool").to_string(), detail_of(&p["arguments"])))
        }
        _ => Some((m.to_string(), String::new())),
    }
}

/// a call's arguments in a line: the usual subject keys first, else the first string
fn detail_of(args: &Value) -> String {
    const KEYS: [&str; 10] = ["command", "script", "path", "file", "url", "query", "host", "name", "repo", "text"];
    let Some(o) = args.as_object() else { return String::new() };
    let s = KEYS.iter().find_map(|k| o.get(*k).and_then(Value::as_str)).or_else(|| o.values().find_map(Value::as_str)).unwrap_or("");
    let one = s.split_whitespace().collect::<Vec<_>>().join(" ");
    match one.char_indices().nth(120) {
        Some((i, _)) => format!("{}…", &one[..i]),
        None => one,
    }
}
