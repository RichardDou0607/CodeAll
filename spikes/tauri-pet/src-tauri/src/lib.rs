// T1 spike: Tauri v2 桌宠外壳最小验证
// 1) 透明无边框窗口  2) 置顶  3) 点击穿透  4) Unix socket JSONL -> WebView 可见状态变化
use std::io::{BufRead, BufReader};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Instant;
use tauri::{Emitter, Manager};

fn t0() -> &'static Instant {
    static T0: OnceLock<Instant> = OnceLock::new();
    T0.get_or_init(Instant::now)
}
fn t_ms() -> u128 {
    t0().elapsed().as_millis()
}

fn socket_path() -> PathBuf {
    if let Ok(p) = std::env::var("PET_SPIKE_SOCKET") { return PathBuf::from(p); }
    let dir = std::env::temp_dir().join("agent-pet");
    std::fs::create_dir_all(&dir).ok();
    dir.join("tauri-spike.sock")
}

fn report_path() -> PathBuf {
    if let Ok(p) = std::env::var("PET_SPIKE_REPORT") { return PathBuf::from(p); }
    let dir = std::env::temp_dir().join("agent-pet");
    std::fs::create_dir_all(&dir).ok();
    dir.join("tauri-spike-report.jsonl")
}

fn append_report(line: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(report_path()) {
        let _ = writeln!(f, "{}", line);
    }
}

fn json_escape(s: &str) -> String { s.replace('"', "'") }

/// 前端确认状态已真正渲染到 DOM 后回调
#[tauri::command]
fn report_state(state: String, event_type: String, dom_text: String) {
    println!("DOM_APPLIED state={} type={} dom={} t_ms={}", state, event_type, dom_text, t_ms());
    append_report(&format!("{{\"kind\":\"dom_applied\",\"state\":\"{}\",\"type\":\"{}\",\"dom_text\":\"{}\"}}", state, event_type, json_escape(&dom_text)));
}

#[tauri::command]
fn frontend_ready() {
    println!("FRONTEND_READY");
    append_report("{\"kind\":\"frontend_ready\"}");
}

fn window_diagnostics(window: &tauri::WebviewWindow) -> String {
    let visible = window.is_visible().unwrap_or(false);
    let pos = window.outer_position().map(|p| format!("{},{}", p.x, p.y)).unwrap_or_else(|_| "?".into());
    let size = window.inner_size().map(|s| format!("{}x{}", s.width, s.height)).unwrap_or_else(|_| "?".into());
    let scale = window.scale_factor().unwrap_or(0.0);
    format!("{{\"visible\":{},\"pos\":\"{}\",\"size\":\"{}\",\"scale\":{}}}", visible, pos, size, scale)
}

/// 运行时切换点击穿透，并回读窗口属性
#[tauri::command]
fn set_click_through(window: tauri::WebviewWindow, on: bool) -> Result<String, String> {
    window.set_ignore_cursor_events(on).map_err(|e| e.to_string())?;
    let diag = window_diagnostics(&window);
    println!("CLICK_THROUGH on={} diag={} t_ms={}", on, diag, t_ms());
    append_report(&format!("{{\"kind\":\"click_through\",\"on\":{},\"diag\":{}}}", on, json_escape(&diag)));
    Ok(diag)
}

#[tauri::command]
fn window_diag(window: tauri::WebviewWindow) -> String {
    let d = window_diagnostics(&window);
    println!("WINDOW_DIAG {} t_ms={}", d, t_ms());
    append_report(&format!("{{\"kind\":\"window_diag\",\"diag\":{}}}", json_escape(&d)));
    d
}

fn handle_client(app: tauri::AppHandle, stream: UnixStream) {
    let reader = BufReader::new(stream);
    for line in reader.lines() {
        match line {
            Ok(l) => {
                let l = l.trim().to_string();
                if l.is_empty() { continue; }
                match serde_json::from_str::<serde_json::Value>(&l) {
                    Ok(v) => {
                        let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("<no-type>").to_string();
                        println!("SOCKET_EVENT type={}", t);
                        if let Err(e) = app.emit("pet-event", v) { println!("EMIT_ERR {}", e); }
                    }
                    Err(e) => println!("PARSE_ERR {}", e),
                }
            }
            Err(e) => { println!("CLIENT_CLOSED {}", e); break; }
        }
    }
}

fn start_socket_server(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let path = socket_path();
        let _ = std::fs::remove_file(&path);
        let listener = match UnixListener::bind(&path) {
            Ok(l) => l,
            Err(e) => { println!("BIND_FAIL {} {}", path.display(), e); return; }
        };
        println!("READY {} t_ms={}", path.display(), t_ms());
        for stream in listener.incoming() {
            match stream {
                Ok(s) => {
                    println!("CLIENT_CONNECTED");
                    let a = app.clone();
                    std::thread::spawn(move || handle_client(a, s));
                }
                Err(e) => println!("ACCEPT_ERR {}", e),
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = t0(); // 尽早启动计时，使 t_ms 从进程启动算起
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![report_state, frontend_ready, set_click_through, window_diag])
        .setup(|app| {
            let win = app.get_webview_window("main").expect("main window");
            println!("WINDOW_CONFIG size={:?} t_ms={}", win.inner_size(), t_ms());
            match win.set_ignore_cursor_events(true) {
                Ok(_) => println!("CLICK_THROUGH_SET on=true t_ms={}", t_ms()),
                Err(e) => println!("CLICK_THROUGH_SET_ERR {}", e),
            }
            append_report("{\"kind\":\"window_created\"}");
            start_socket_server(app.handle().clone());
            let w = win.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                println!("WINDOW_DIAG {} t_ms={}", window_diagnostics(&w), t_ms());
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
