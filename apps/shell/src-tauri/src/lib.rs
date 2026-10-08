//! Agent 悬浮窗外壳（Tauri v2）· M1
//!
//! 职责
//! 1. 透明 / 无边框 / 置顶 / 可拖拽 的 macOS 桌面悬浮窗（窗口参数见 tauri.conf.json）
//! 2. 位置与尺寸记忆：~/Library/Application Support/com.agentpet.shell/window.json
//! 3. 守护本地服务 demo/framed.mjs（默认 127.0.0.1:7799）：启动时探测，未监听则拉起
//! 4. 启动期显示「启动中」占位页（webui/index.html），服务就绪后导航到 http://127.0.0.1:<port>/
//! 5. 导航完成后注入最小 CSS，把 demo/window.html 的「浏览器演示版式」整理成真正的悬浮窗版式
//!    —— 只读注入，不修改 demo/ 下任何文件
//!
//! 日志：所有里程碑都打到 stdout，形如 [shell t_ms=  1234] KEY k=v，便于脚本抓取。

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, RunEvent, WebviewWindow, WindowEvent};

const DEFAULT_PORT: u16 = 7799;
const SPLASH_TITLE: &str = "CodeAll · 启动中";

// ---------------------------------------------------------------- 基础工具

static T0: OnceLock<Instant> = OnceLock::new();

fn t0() -> &'static Instant {
    T0.get_or_init(Instant::now)
}
fn t_ms() -> u128 {
    t0().elapsed().as_millis()
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 统一日志：stdout + 立即 flush（重定向到文件时也能实时看到）
fn log(msg: &str) {
    println!("[shell t_ms={:>6}] {}", t_ms(), msg);
    let _ = std::io::stdout().flush();
}

// ---------------------------------------------------------------- 全局状态

struct ShellState {
    /// 本地服务端口
    port: AtomicU64,
    /// 该服务是否由本外壳拉起（退出时要一起收掉）
    launched: AtomicBool,
    /// 由外壳拉起的子进程
    child: Mutex<Option<Child>>,
    /// 窗口位置/尺寸有变化，等待节流落盘
    dirty: AtomicBool,
}

impl Default for ShellState {
    fn default() -> Self {
        Self {
            port: AtomicU64::new(DEFAULT_PORT as u64),
            launched: AtomicBool::new(false),
            child: Mutex::new(None),
            dirty: AtomicBool::new(false),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct WindowRecord {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    updated_at: u64,
}

// ---------------------------------------------------------------- 信号：被 kill 时也要收尾

static SIG_FLAG: AtomicBool = AtomicBool::new(false);

/// 远程页是否成功拿到 Tauri IPC（capability remote-loopback 生效）
static REMOTE_IPC_OK: AtomicBool = AtomicBool::new(false);
/// 当前是否为放大尺寸
static EXPANDED: AtomicBool = AtomicBool::new(false);
/// 托盘是否创建成功（决定关窗是「收进托盘」还是「退出进程」）
static TRAY_OK: AtomicBool = AtomicBool::new(false);

/// 信号处理器里只做 async-signal-safe 的事：置一个原子标志
#[cfg(unix)]
extern "C" fn on_signal(_sig: libc::c_int) {
    SIG_FLAG.store(true, Ordering::SeqCst);
}

#[cfg(unix)]
fn install_signal_handlers() {
    unsafe {
        let h = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
        libc::signal(libc::SIGTERM, h);
        libc::signal(libc::SIGINT, h);
    }
}

#[cfg(not(unix))]
fn install_signal_handlers() {}

/// 轮询信号标志（在普通线程里做真正的收尾动作，避免在信号处理器里调非安全函数）
fn start_signal_watcher(handle: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(150));
        if SIG_FLAG.swap(false, Ordering::SeqCst) {
            log("SIGNAL_RECEIVED → 收尾退出");
            shutdown(&handle);
            handle.exit(0);
            return;
        }
    });
}

// ---------------------------------------------------------------- 端口 / 路径解析

fn parse_port() -> u16 {
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--port") {
        if let Some(p) = args.get(i + 1).and_then(|s| s.parse::<u16>().ok()) {
            return p;
        }
    }
    if let Ok(v) = std::env::var("AGENT_PET_PORT") {
        if let Ok(p) = v.parse::<u16>() {
            return p;
        }
    }
    DEFAULT_PORT
}

/// .app 打包内自带的服务目录（Contents/Resources/app，布局 = 仓库根子集）。
/// 存在 = 独立分发的安装包，无需源码仓库与系统 Node。
fn bundled_app_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let contents = exe.parent()?.parent()?; // Contents/MacOS/x → Contents
    let root = contents.join("Resources").join("app");
    root.join("demo").join("framed.mjs").exists().then_some(root)
}

/// 仓库根目录：1) 环境变量 2) 编译期路径（开发）3) 打包内 Resources/app（独立分发）4) 从可执行文件向上找
fn resolve_repo_root() -> PathBuf {
    if let Ok(p) = std::env::var("AGENT_PET_ROOT") {
        let pb = PathBuf::from(p);
        if pb.join("demo").join("framed.mjs").exists() {
            return pb;
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(root) = manifest.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
        if root.join("demo").join("framed.mjs").exists() {
            return root.to_path_buf();
        }
    }
    if let Some(bundled) = bundled_app_root() {
        return bundled;
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent().map(Path::to_path_buf);
        while let Some(dir) = cur {
            if dir.join("demo").join("framed.mjs").exists() {
                return dir;
            }
            cur = dir.parent().map(Path::to_path_buf);
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// node 可执行文件：环境变量 → 打包内 Resources/app/bin/node → 常见绝对路径 → PATH
fn resolve_node() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("AGENT_PET_NODE") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    if let Some(bundled) = bundled_app_root() {
        let p = bundled.join("bin").join("node");
        if p.exists() {
            return Some(p);
        }
    }
    for c in ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"] {
        if Path::new(c).exists() {
            return Some(PathBuf::from(c));
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            if dir.is_empty() {
                continue;
            }
            let p = Path::new(dir).join("node");
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

fn window_file(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("window.json")
}

fn server_log_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("framed-server.log")
}

fn port_up(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

/// 从 Rust 侧做一次最小 HTTP GET。
/// WebView 页面（tauri://localhost 源）对 http://127.0.0.1 的 fetch 属跨源请求，会被 CORS 拦掉，
/// 因此「服务是否真的在提供 HTTP」必须由外壳自己判定。
fn http_probe(port: u16, path: &str, timeout: Duration) -> (bool, String) {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = match TcpStream::connect_timeout(&addr, timeout) {
        Ok(s) => s,
        Err(e) => return (false, format!("connect 失败: {}", e)),
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let req = format!(
        "GET {} HTTP/1.0\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\nUser-Agent: agent-pet-shell\r\n\r\n",
        path, port
    );
    if let Err(e) = stream.write_all(req.as_bytes()) {
        return (false, format!("write 失败: {}", e));
    }
    let _ = stream.flush();
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > 262144 {
                    break;
                }
            }
            Err(e) => return (false, format!("read 失败: {}", e)),
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let status = text.lines().next().unwrap_or("").trim().to_string();
    let ok = status.contains(" 200");
    (ok, format!("{} ({} 字节)", status, buf.len()))
}

// ---------------------------------------------------------------- 窗口位置记忆

fn is_on_screen(win: &WebviewWindow, x: i32, y: i32, w: u32, h: u32) -> bool {
    if w < 50 || h < 50 {
        return false;
    }
    let cx = x + (w as i32) / 2;
    let cy = y + 20;
    if let Ok(monitors) = win.available_monitors() {
        for m in monitors {
            let p = m.position();
            let s = m.size();
            if cx >= p.x && cx <= p.x + s.width as i32 && cy >= p.y && cy <= p.y + s.height as i32 {
                return true;
            }
        }
    }
    false
}

fn write_record(app: &AppHandle, rec: &WindowRecord) {
    let path = window_file(app);
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    match serde_json::to_string_pretty(rec) {
        Ok(s) => {
            if let Err(e) = fs::write(&path, s) {
                log(&format!("WINDOW_SAVE_ERR err={}", e));
            }
        }
        Err(e) => log(&format!("WINDOW_SER_ERR err={}", e)),
    }
}

fn persist_window(app: &AppHandle, win: &WebviewWindow, reason: &str) {
    let pos = match win.outer_position() {
        Ok(p) => p,
        Err(e) => {
            log(&format!("WINDOW_SNAPSHOT_ERR reason={} err={}", reason, e));
            return;
        }
    };
    let size = win.outer_size().unwrap_or(PhysicalSize::new(0, 0));
    if size.width == 0 || size.height == 0 {
        return;
    }
    let rec = WindowRecord {
        x: pos.x,
        y: pos.y,
        w: size.width,
        h: size.height,
        updated_at: now_ms(),
    };
    write_record(app, &rec);
    log(&format!(
        "WINDOW_SAVED reason={} pos={},{} size={}x{} t_ms={}",
        reason, rec.x, rec.y, rec.w, rec.h, t_ms()
    ));
}

fn restore_window(app: &AppHandle, win: &WebviewWindow) {
    let path = window_file(app);
    let txt = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => {
            log(&format!("WINDOW_RESTORE none file={}", path.display()));
            return;
        }
    };
    let rec: WindowRecord = match serde_json::from_str(&txt) {
        Ok(r) => r,
        Err(e) => {
            log(&format!("WINDOW_RESTORE parse_err={}", e));
            return;
        }
    };
    let onscreen = is_on_screen(win, rec.x, rec.y, rec.w, rec.h);
    if onscreen {
        let _ = win.set_size(PhysicalSize::new(rec.w.max(360), rec.h.max(340)));
        let _ = win.set_position(PhysicalPosition::new(rec.x, rec.y));
    }
    log(&format!(
        "WINDOW_RESTORED file={} onscreen={} pos={},{} size={}x{}",
        path.display(),
        onscreen,
        rec.x,
        rec.y,
        rec.w,
        rec.h
    ));
}

fn start_persist_thread(handle: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(400));
        let dirty = handle.state::<ShellState>().dirty.swap(false, Ordering::SeqCst);
        if dirty {
            if let Some(w) = handle.get_webview_window("main") {
                persist_window(&handle, &w, "flush");
            }
        }
    });
}

// ---------------------------------------------------------------- macOS 原生：背景拖拽

#[cfg(target_os = "macos")]
fn set_movable_by_background(win: &WebviewWindow, on: bool) -> Result<bool, String> {
    use objc2_app_kit::NSWindow;
    let ptr = win.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
    if ptr.is_null() {
        return Err("ns_window() 返回空指针".into());
    }
    unsafe {
        let ns: &NSWindow = &*ptr;
        ns.setMovableByWindowBackground(on);
        Ok(ns.isMovableByWindowBackground())
    }
}

#[cfg(target_os = "macos")]
fn movable_by_background(win: &WebviewWindow) -> Option<bool> {
    use objc2_app_kit::NSWindow;
    let ptr = win.ns_window().ok()? as *mut NSWindow;
    if ptr.is_null() {
        return None;
    }
    unsafe { Some((&*ptr).isMovableByWindowBackground()) }
}

/// AppKit 判定「点击是否可拖动窗口」时查询的就是 contentView.mouseDownCanMoveWindow。
/// 回读它，作为「不依赖合成鼠标事件的拖拽能力证据」。
#[cfg(target_os = "macos")]
fn mouse_down_can_move_window(win: &WebviewWindow) -> Option<bool> {
    use objc2_app_kit::NSWindow;
    let ptr = win.ns_window().ok()? as *mut NSWindow;
    if ptr.is_null() {
        return None;
    }
    unsafe {
        let ns: &NSWindow = &*ptr;
        ns.contentView().map(|v| v.mouseDownCanMoveWindow())
    }
}

/// macOS 全屏兼容（修复：App 窗口进原生全屏会把悬浮窗一并带进全屏 Space）。
/// 默认集合行为下，同 App 任一窗口进入原生全屏时，其余窗口会被收进全屏 Space，
/// 桌面上就找不到悬浮窗了。给悬浮窗补两个位：
///   CanJoinAllSpaces —— 常驻所有 Space（含各个桌面与全屏 Space）
///   FullScreenAuxiliary —— 允许与全屏窗口并存，不被全屏「带走」
/// tao 的 set_visible_on_all_workspaces 对集合行为是读改写、只切 CanJoinAllSpaces 位，
/// 置顶（set_always_on_top 走 window level）也不会碰它，所以设置一次即可长期生效。
#[cfg(target_os = "macos")]
fn set_floating_space_behavior(win: &WebviewWindow) -> Result<bool, String> {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
    let ptr = win.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
    if ptr.is_null() {
        return Err("ns_window() 返回空指针".into());
    }
    unsafe {
        let ns: &NSWindow = &*ptr;
        let mut b = ns.collectionBehavior();
        b |= NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary;
        ns.setCollectionBehavior(b);
        let cur = ns.collectionBehavior();
        Ok(cur.contains(NSWindowCollectionBehavior::CanJoinAllSpaces)
            && cur.contains(NSWindowCollectionBehavior::FullScreenAuxiliary))
    }
}

/// 读回集合行为两个关键位，进 shell_window_diag 便于诊断
#[cfg(target_os = "macos")]
fn floating_space_flags(win: &WebviewWindow) -> Option<(bool, bool)> {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
    let ptr = win.ns_window().ok()? as *mut NSWindow;
    if ptr.is_null() {
        return None;
    }
    let b = unsafe { (&*ptr).collectionBehavior() };
    Some((
        b.contains(NSWindowCollectionBehavior::CanJoinAllSpaces),
        b.contains(NSWindowCollectionBehavior::FullScreenAuxiliary),
    ))
}

#[cfg(not(target_os = "macos"))]
fn set_floating_space_behavior(_win: &WebviewWindow) -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(target_os = "macos"))]
fn floating_space_flags(_win: &WebviewWindow) -> Option<(bool, bool)> {
    None
}

#[cfg(not(target_os = "macos"))]
fn set_movable_by_background(_win: &WebviewWindow, _on: bool) -> Result<bool, String> {
    Ok(false)
}
#[cfg(not(target_os = "macos"))]
fn movable_by_background(_win: &WebviewWindow) -> Option<bool> {
    None
}

// ---------------------------------------------------------------- 远程页样式整理（只注入，不改 demo/）

const REMOTE_INJECT: &str = r#"
(function () {
  try {
    if (location.hostname !== '127.0.0.1') return;  // 只作用于本地服务页面，启动占位页不受影响
    // agentpet-solid 页（App 界面，原生标题栏窗口）跳过透明化与旧卡片版式覆盖；
    // 其余页面（迷你条）保持「圆角外真透明」的注入
    var SOLID = !!document.querySelector('meta[name="agentpet-solid"]');
    var CSS = [
      'body{-webkit-user-select:none!important;cursor:default}',
      'textarea,input,select{-webkit-user-select:text!important}',
    ].join('');
    if (!SOLID) CSS += [
      'html,body{background:transparent!important;margin:0!important;padding:0!important;',
      'min-height:100vh!important;display:block!important;overflow:hidden!important}',
      '.desk{position:fixed!important;left:0!important;top:0!important;width:100vw!important;height:100vh!important;',
      'max-width:none!important;border:0!important;border-radius:0!important;background:transparent!important;overflow:hidden!important}',
      '.desk:after{display:none!important}',
      '.help{display:none!important}',
      '.win{position:absolute!important;left:0!important;top:0!important;width:100%!important;height:100%!important;',
      'border-radius:14px!important;display:flex!important;flex-direction:column!important;overflow:hidden!important;',
      // 窗口本身 shadow:false；卡片自带的 0 26px 60px 投影会糊到圆角外，
      // 让「圆角外真透明」无法验证，这里去掉，只留 1px 描边。
      'box-shadow:none!important;border:1px solid #2a3444!important;',
      // demo 卡片是 rgba(...,.96)：浮在别的窗口上时背景文字会透出来，读起来发糊，这里改成不透明。
      'background:#11151d!important}',
      '.sessions{flex:1 1 auto!important;min-height:0!important;max-height:none!important}',
      '.titlebar,.toolbar,.aggbar,.composer,.note{flex:0 0 auto!important}',
      '.toolbar{gap:5px!important}',
      '.toolbar select{min-width:0!important}',
      '.toolbar .btn{white-space:nowrap!important;flex:0 0 auto!important;padding:4px 7px!important}',
      '.srow{padding:5px 10px!important}',
      '.aggbar{padding:6px 10px!important}'
    ].join('');
    function apply() {
      if (document.getElementById('__agent_pet_shell_css__')) return;
      if (!document.documentElement) return;
      var s = document.createElement('style');
      s.id = '__agent_pet_shell_css__';
      s.textContent = CSS;
      (document.head || document.documentElement).appendChild(s);
    }
    apply();
    var mo = new MutationObserver(function () { apply(); if (document.getElementById('__agent_pet_shell_css__')) mo.disconnect(); });
    mo.observe(document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', apply);
    window.addEventListener('load', apply);

    // ---- 以下交互只用 Tauri 内置的 window 插件命令（core:window:*）。
    //      Tauri 源码里写得很明确：远程源连**自定义命令**也会被 ACL 拒（除非显式授权 remote capability），
    //      所以这里一律不碰自定义命令；IPC 是否可用改用 URL hash 回传给外壳（见 start_url_watcher）。
    var INT = window.__TAURI_INTERNALS__;
    var T = window.__TAURI__;
    var LABEL = (INT && INT.metadata && INT.metadata.currentWindow && INT.metadata.currentWindow.label) || 'main';

    function rawInvoke(cmd, args) {
      if (T && T.core && T.core.invoke) return T.core.invoke(cmd, args);
      if (INT && INT.invoke) return INT.invoke(cmd, args);
      return Promise.reject(new Error('no-ipc'));
    }
    function winCmd(cmd, args) {
      var a = args || {};
      a.label = LABEL;
      return rawInvoke('plugin:window|' + cmd, a);
    }
    function startDrag() {
      try {
        if (T && T.window) { T.window.getCurrentWindow().startDragging(); return; }
      } catch (e) {}
      winCmd('start_dragging').catch(function () {});
    }
    function logicalWidth() {
      if (T && T.window) {
        return T.window.getCurrentWindow().innerSize().then(function (s) { return s.width / (window.devicePixelRatio || 1); });
      }
      return winCmd('inner_size').then(function (s) { return s.width / (window.devicePixelRatio || 1); });
    }
    function setLogicalSize(w, h) {
      var LogicalSize = T && T.dpi && T.dpi.LogicalSize || T && T.window && T.window.LogicalSize;
      if (T && T.window && LogicalSize) return T.window.getCurrentWindow().setSize(new LogicalSize(w, h));
      return winCmd('set_size', { value: { Logical: { width: w, height: h } } });
    }
    function toggleSize() {
      logicalWidth().then(function (w) {
        return w > 500 ? setLogicalSize(360, 340) : setLogicalSize(720, 680);
      }).catch(function () {});
    }
    // 置顶切换：窗口默认**不置顶**（允许被其他窗口盖住）；点 📌 恢复悬浮置顶。
    // 偏好存 localStorage（同源持久），每次注入后按存储值恢复。
    function setAlwaysOnTop(v) {
      try {
        if (T && T.window) { T.window.getCurrentWindow().setAlwaysOnTop(v); return Promise.resolve(true); }
      } catch (e) {}
      return winCmd('set_always_on_top', { value: v }).then(function () { return true; });
    }
    function wirePin() {
      var tb = document.querySelector('.titlebar');
      if (!tb || document.getElementById('__shell_pin__')) return;
      var b = document.createElement('button');
      b.id = '__shell_pin__';
      b.type = 'button';
      b.textContent = '📌';
      b.title = '置顶悬浮窗（默认关闭，可被其他窗口覆盖；点击切换）';
      var stored = false;
      try { stored = localStorage.getItem('agent-pet-pin') === '1'; } catch (e) {}
      function paint(on) { b.style.opacity = on ? '1' : '.45'; b.style.color = on ? '#e3b341' : ''; b.title = on ? '已置顶：悬浮在所有窗口之上（点击取消）' : '未置顶：可被其他窗口覆盖（点击置顶）'; }
      paint(stored);
      if (stored) setAlwaysOnTop(true).catch(function () {});
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var on = !(localStorage.getItem('agent-pet-pin') === '1');
        try { localStorage.setItem('agent-pet-pin', on ? '1' : '0'); } catch (e) {}
        paint(on);
        setAlwaysOnTop(on).catch(function () {});
      });
      tb.insertBefore(b, document.getElementById('__shell_expand__') || document.getElementById('open-dsh') || null);
    }

    // 1) 标题栏拖拽。不再用 NSWindow.isMovableByWindowBackground：tao 的 TaoWindow.sendEvent
    //    会在 isMovableByWindowBackground=true 时对**每一次左键按下**调用 performWindowDragWithEvent，
    //    点击按钮/输入框都会被拖拽会话干扰。这里改成只在标题栏按下时 startDragging。
    function wireTitlebar() {
      var tb = document.querySelector('.titlebar');
      if (!tb || tb.getAttribute('data-shell-drag') === '1') return;
      tb.setAttribute('data-shell-drag', '1');
      tb.addEventListener('mousedown', function (ev) {
        if (ev.button !== 0) return;
        var t = ev.target;
        if (t && t.closest && t.closest('button,a,input,select,textarea')) return;
        startDrag();
      });
      wirePin();
      if (!document.getElementById('__shell_expand__')) {
        var b = document.createElement('button');
        b.id = '__shell_expand__';
        b.type = 'button';
        b.textContent = '⤢';
        b.title = '放大 / 还原（360×340 ⇄ 720×680）';
        b.addEventListener('click', function (ev) { ev.stopPropagation(); toggleSize(); });
        tb.insertBefore(b, document.getElementById('open-dsh') || null);
      }
    }

    // 2) 「新建会话」提示：只在能力位 canCreate=false（插件未挂载）时生效。
    //    插件已挂载时页面按钮是**真**的：这里绝不能再挂 explainNew —— 否则一次点击会
    //    触发两次 POST /api/new（页面 handler + explainNew 的 cwd:''），多出一个落进默认项目的会话
    //    （2026-10-05 实测踩坑）。
    async function explainNew() {
      var txt = '新建会话需要在 DSH 进程内完成（插件授权）';
      try {
        var r = await fetch('/api/new', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pet-token': (window.__PET_TOKEN__||'') }, body: JSON.stringify({ cwd: '' }) });
        var j = await r.json();
        txt = '新建会话：' + (j.reason || j.error || '未知');
      } catch (e3) { txt = '新建会话失败：' + e3; }
      var n = document.getElementById('note');
      if (n) n.textContent = txt;
    }
    function wireNewHint() {
      wirePin();
      var caps = window.__SNAP__ && window.__SNAP__.capabilities;
      var canCreate = !!(caps && caps.canCreate);
      var d0 = document.getElementById('__shell_newhint__');
      if (canCreate) {
        // 能力位就绪：撤提示条，页面自身 handler 负责创建；不掰 disabled、不挂 explainNew
        if (d0 && d0.parentNode) d0.parentNode.removeChild(d0);
        var nb1 = document.getElementById('new-session');
        if (nb1) { nb1.style.opacity = ''; nb1.style.cursor = ''; }
        return;
      }
      var tbar = document.querySelector('.toolbar');
      if (!tbar) return;
      if (!d0) {
        var d = document.createElement('div');
        d.id = '__shell_newhint__';
        d.textContent = '需插件授权后可新建';
        d.title = '契约 v1.3 能力位 canCreate=false：新建要在 DSH 进程内完成。点击查看服务返回的原因。';
        d.style.cssText = 'flex:0 0 auto;padding:3px 10px;font-size:10px;color:#8b98a9;cursor:pointer;' +
          'border-bottom:1px solid #242c3a;background:rgba(227,179,65,.06)';
        d.addEventListener('click', explainNew);
        tbar.parentNode.insertBefore(d, tbar.nextSibling);
      }
      var nb = document.getElementById('new-session');
      if (nb) {
        if (nb.disabled) nb.disabled = false;   // 页面每次 render 都会重新置灰，这里持续掰回来
        nb.style.opacity = '.6';
        nb.style.cursor = 'pointer';
        if (nb.getAttribute('data-shell-wired') !== '1') {
          nb.setAttribute('data-shell-wired', '1');
          nb.addEventListener('click', explainNew);
        }
      }
    }
    // IPC 探针：只有能调到内置 window 命令，才装标题栏手势/放大按钮；
    // 结果通过 URL hash 告诉外壳（自定义命令对远程源会被 ACL 拒，不能用来上报）。
    winCmd('scale_factor').then(function () {
      try { if (location.hash.indexOf('shell-ipc-ok') < 0) location.hash = 'shell-ipc-ok'; } catch (e5) {}
      wireTitlebar();
    }).catch(function () {});
    wireNewHint();
    document.addEventListener('DOMContentLoaded', wireNewHint);
    window.addEventListener('load', wireNewHint);
    try {
      var mo2 = new MutationObserver(function () { wireNewHint(); });
      mo2.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    } catch (e4) {}
  } catch (e) {}
})();
"#;

/// 轮询 webview 当前 URL，一旦导航到本地服务页就注入版式 CSS（main=迷你条 / app=App 界面）
fn start_url_watcher(handle: AppHandle, port: u16) {
    for (label, title) in [("main", "CodeAll · 迷你条"), ("app", "CodeAll · App")] {
        let handle = handle.clone();
        let label = label.to_string();
        let title = title.to_string();
        std::thread::spawn(move || {
            let needle = format!("http://127.0.0.1:{}/", port);
            let deadline = Instant::now() + Duration::from_secs(120);
            while Instant::now() < deadline {
                if let Some(w) = handle.get_webview_window(&label) {
                    if let Ok(u) = w.url() {
                        let s = u.to_string();
                        if s.starts_with(&needle) {
                            log(&format!("REMOTE_COMMITTED[{}] url={} t_ms={}", label, s, t_ms()));
                            // 远程源不注入 IPC，document.title 不会同步到原生窗口标题，这里显式设置
                            let _ = w.set_title(&title);
                            let _ = w.eval(REMOTE_INJECT);
                            std::thread::sleep(Duration::from_millis(300));
                            let _ = w.eval(REMOTE_INJECT);
                            log(&format!("REMOTE_STYLED[{}] t_ms={}", label, t_ms()));
                            if label == "main" {
                                // 注入后短轮询 URL：远程页把「内置 window 命令可用」写进 hash 回传
                                //（自定义命令对远程源会被 ACL 拒，所以不能用 shell_report 上报）。
                                let mut ipc_ok = false;
                                let wait_until = Instant::now() + Duration::from_millis(4000);
                                while Instant::now() < wait_until {
                                    if let Ok(u2) = w.url() {
                                        if u2.as_str().contains("shell-ipc-ok") {
                                            ipc_ok = true;
                                            break;
                                        }
                                    }
                                    std::thread::sleep(Duration::from_millis(40));
                                }
                                if ipc_ok {
                                    log("REMOTE_IPC_OK → 拖拽走标题栏手势，全局背景拖拽保持关闭");
                                } else {
                                    // 注意：NSWindow 的 setMovableByWindowBackground 只能在主线程调用，
                                    // 在后台线程直接调会抛 NSInternalInconsistencyException 把进程打挂。
                                    log("REMOTE_IPC_UNAVAILABLE → 回退 isMovableByWindowBackground=true");
                                    let h2 = handle.clone();
                                    let _ = handle.run_on_main_thread(move || {
                                        if let Some(w2) = h2.get_webview_window("main") {
                                            match set_movable_by_background(&w2, true) {
                                                Ok(v) => log(&format!("MOVABLE_BY_BACKGROUND_FALLBACK on={}", v)),
                                                Err(e) => log(&format!("MOVABLE_BY_BACKGROUND_FALLBACK_ERR err={}", e)),
                                            }
                                        }
                                    });
                                }
                            }
                            return;
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            log(&format!("REMOTE_COMMIT_TIMEOUT[{}]", label));
        });
    }
}

// ---------------------------------------------------------------- 本地服务守护

fn ensure_server_blocking(app: &AppHandle, port: u16, wait_ms: u64) -> Value {
    {
        let st = app.state::<ShellState>();
        st.port.store(port as u64, Ordering::SeqCst);
    }
    if port_up(port) {
        log(&format!("SERVER_ALREADY_UP port={}", port));
        return json!({"up": true, "launched": false, "owner": "external", "port": port});
    }
    let root = resolve_repo_root();
    let script = root.join("demo").join("framed.mjs");
    if !script.exists() {
        log(&format!("SERVER_SCRIPT_MISSING path={}", script.display()));
        return json!({"up": false, "launched": false, "port": port,
                      "error": format!("未找到 {}", script.display())});
    }
    let node = match resolve_node() {
        Some(n) => n,
        None => {
            log("SERVER_NODE_MISSING");
            return json!({"up": false, "launched": false, "port": port, "error": "未找到 node 可执行文件"});
        }
    };
    let logpath = server_log_path(app);
    if let Some(dir) = logpath.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let out = match fs::File::create(&logpath) {
        Ok(f) => f,
        Err(e) => {
            return json!({"up": false, "launched": false, "port": port,
                          "error": format!("无法写日志 {}: {}", logpath.display(), e)})
        }
    };
    let err = out.try_clone();
    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .arg("--port")
        .arg(port.to_string())
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(out));
    if let Ok(e2) = err {
        cmd.stderr(Stdio::from(e2));
    }
    match cmd.spawn() {
        Ok(child) => {
            log(&format!(
                "SERVER_SPAWN pid={} node={} script={} port={} log={}",
                child.id(),
                node.display(),
                script.display(),
                port,
                logpath.display()
            ));
            let st = app.state::<ShellState>();
            if let Ok(mut g) = st.child.lock() {
                *g = Some(child);
            }
            st.launched.store(true, Ordering::SeqCst);
        }
        Err(e) => {
            log(&format!("SERVER_SPAWN_ERR err={}", e));
            return json!({"up": false, "launched": false, "port": port, "error": format!("拉起失败: {}", e)});
        }
    }
    let deadline = Instant::now() + Duration::from_millis(wait_ms);
    while Instant::now() < deadline {
        if port_up(port) {
            log(&format!("SERVER_UP_LAUNCHED port={} t_ms={}", port, t_ms()));
            return json!({"up": true, "launched": true, "owner": "shell", "port": port,
                          "log": logpath.display().to_string()});
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    log(&format!("SERVER_UP_TIMEOUT port={}", port));
    json!({"up": false, "launched": true, "port": port,
           "error": format!("{}ms 内未监听 127.0.0.1:{}", wait_ms, port),
           "log": logpath.display().to_string()})
}

/// 自检钩子（用于「位置记忆」端到端复现，也可给 CI 用）
///   AGENT_PET_SELFTEST="move:<逻辑x>,<逻辑y>"
/// 启动后把窗口移到该逻辑坐标 → 等待节流落盘 → 保存并退出。
fn start_selftest(handle: AppHandle, spec: String) {
    std::thread::spawn(move || {
        log(&format!("SELFTEST spec={}", spec));
        let parts: Vec<&str> = spec.trim().split(':').collect();
        if parts.len() != 2 || parts[0] != "move" {
            log("SELFTEST_UNSUPPORTED（目前只支持 move:x,y）");
            return;
        }
        let xy: Vec<&str> = parts[1].split(',').collect();
        if xy.len() != 2 {
            log("SELFTEST_BAD_ARGS");
            return;
        }
        let (x, y) = match (xy[0].trim().parse::<f64>(), xy[1].trim().parse::<f64>()) {
            (Ok(a), Ok(b)) => (a, b),
            _ => {
                log("SELFTEST_BAD_ARGS");
                return;
            }
        };
        std::thread::sleep(Duration::from_millis(700));
        if let Some(w) = handle.get_webview_window("main") {
            match w.set_position(tauri::LogicalPosition::new(x, y)) {
                Ok(_) => log(&format!("SELFTEST_MOVED logical={},{}", x, y)),
                Err(e) => log(&format!("SELFTEST_MOVE_ERR err={}", e)),
            }
        }
        std::thread::sleep(Duration::from_millis(1500));
        if let Some(w) = handle.get_webview_window("main") {
            persist_window(&handle, &w, "selftest");
        }
        log("SELFTEST_QUIT");
        shutdown(&handle);
        handle.exit(0);
    });
}

fn shutdown(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        persist_window(app, &w, "shutdown");
    }
    let st = app.state::<ShellState>();
    let taken = st.child.lock().ok().and_then(|mut g| g.take());
    if let Some(mut c) = taken {
        log(&format!("SERVER_KILL pid={}", c.id()));
        let _ = c.kill();
        let _ = c.wait();
    }
    log("SHUTDOWN");
}

// ---------------------------------------------------------------- 前端可调用的命令

#[tauri::command]
fn shell_status(app: AppHandle) -> Result<Value, String> {
    let st = app.state::<ShellState>();
    let port = st.port.load(Ordering::SeqCst) as u16;
    let root = resolve_repo_root();
    let script = root.join("demo").join("framed.mjs");
    Ok(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "port": port,
        "portUp": port_up(port),
        "launchedByShell": st.launched.load(Ordering::SeqCst),
        "repoRoot": root.display().to_string(),
        "serverScript": script.display().to_string(),
        "serverScriptExists": script.exists(),
        "nodePath": resolve_node().map(|p| p.display().to_string()),
        "serverLog": server_log_path(&app).display().to_string(),
        "windowFile": window_file(&app).display().to_string(),
        "splashTitle": SPLASH_TITLE,
    }))
}

#[tauri::command]
async fn shell_ensure_server(app: AppHandle, port: Option<u16>) -> Result<Value, String> {
    let port = port.unwrap_or_else(|| app.state::<ShellState>().port.load(Ordering::SeqCst) as u16);
    tauri::async_runtime::spawn_blocking(move || ensure_server_blocking(&app, port, 15000))
        .await
        .map_err(|e| e.to_string())
}

/// 由外壳（而非 WebView）确认本地服务真的在提供 HTTP；避开跨源限制
#[tauri::command]
async fn shell_http_probe(port: Option<u16>, path: Option<String>) -> Result<Value, String> {
    let port = port.unwrap_or(DEFAULT_PORT);
    let path = path.unwrap_or_else(|| "/api/state".to_string());
    tauri::async_runtime::spawn_blocking(move || {
        let (ok, detail) = http_probe(port, &path, Duration::from_millis(1500));
        log(&format!("HTTP_PROBE port={} path={} ok={} detail={}", port, path, ok, detail));
        json!({"ok": ok, "detail": detail, "port": port, "path": path})
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn shell_report(stage: String, detail: Option<String>) {
    if stage == "remote_ipc_ok" {
        REMOTE_IPC_OK.store(true, Ordering::SeqCst);
    }
    log(&format!("SHELL_EVENT stage={} detail={}", stage, detail.unwrap_or_default()));
}

#[tauri::command]
fn shell_navigating(url: String) {
    log(&format!("SHELL_NAVIGATE url={} t_ms={}", url, t_ms()));
}

#[tauri::command]
fn shell_window_diag(window: WebviewWindow) -> Result<Value, String> {
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let outer = window.outer_size().map_err(|e| e.to_string())?;
    let inner = window.inner_size().map_err(|e| e.to_string())?;
    Ok(json!({
        "label": window.label(),
        "title": window.title().unwrap_or_default(),
        "url": window.url().map(|u| u.to_string()).unwrap_or_default(),
        "pos": [pos.x, pos.y],
        "outerSize": [outer.width, outer.height],
        "innerSize": [inner.width, inner.height],
        "scaleFactor": window.scale_factor().unwrap_or(0.0),
        "visible": window.is_visible().unwrap_or(false),
        "alwaysOnTop": window.is_always_on_top().unwrap_or(false),
        "decorated": window.is_decorated().unwrap_or(true),
        "resizable": window.is_resizable().unwrap_or(true),
        "movableByWindowBackground": movable_by_background(&window),
        "contentViewMouseDownCanMoveWindow": mouse_down_can_move_window(&window),
        "spaceBehaviorCanJoinAllSpaces": floating_space_flags(&window).map(|f| f.0),
        "spaceBehaviorFullScreenAuxiliary": floating_space_flags(&window).map(|f| f.1),
    }))
}

#[tauri::command]
fn shell_start_drag(window: WebviewWindow) -> Result<(), String> {
    log("DRAG_REQUESTED");
    window.start_dragging().map_err(|e| e.to_string())
}

/// 放大 / 还原：紧凑 360×340 ⇄ 展开 720×680（浮窗场景比 macOS 最大化更好用）
#[tauri::command]
fn shell_toggle_size(app: AppHandle, window: WebviewWindow) -> Result<Value, String> {
    let next = !EXPANDED.load(Ordering::SeqCst);
    let (w, h) = if next { (720.0_f64, 680.0_f64) } else { (360.0, 340.0) };
    window
        .set_size(tauri::LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    EXPANDED.store(next, Ordering::SeqCst);
    app.state::<ShellState>().dirty.store(true, Ordering::SeqCst);
    log(&format!("TOGGLE_SIZE expanded={} logical={}x{}", next, w, h));
    Ok(json!({"expanded": next, "w": w, "h": h}))
}

/// 把窗口移动到指定位置（逻辑坐标）。用于「复位位置」以及位置记忆的端到端自检。
#[tauri::command]
fn shell_move_to(app: AppHandle, window: WebviewWindow, x: f64, y: f64) -> Result<Vec<i32>, String> {
    window
        .set_position(tauri::LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    log(&format!("MOVE_TO logical={},{}", x, y));
    app.state::<ShellState>().dirty.store(true, Ordering::SeqCst);
    let p = window.outer_position().map_err(|e| e.to_string())?;
    Ok(vec![p.x, p.y])
}

#[tauri::command]
fn shell_set_always_on_top(window: WebviewWindow, on: bool) -> Result<bool, String> {
    window.set_always_on_top(on).map_err(|e| e.to_string())?;
    Ok(window.is_always_on_top().unwrap_or(false))
}

#[tauri::command]
fn shell_save_position(app: AppHandle, window: WebviewWindow) -> Result<String, String> {
    persist_window(&app, &window, "explicit");
    Ok(window_file(&app).display().to_string())
}

#[tauri::command]
fn shell_inject_remote_css(window: WebviewWindow) -> Result<(), String> {
    log("REMOTE_INJECT_MANUAL");
    window.eval(REMOTE_INJECT).map_err(|e| e.to_string())
}

#[tauri::command]
fn shell_open_log(app: AppHandle) -> Result<String, String> {
    let p = server_log_path(&app);
    let _ = Command::new("open").arg("-R").arg(&p).spawn();
    Ok(p.display().to_string())
}

#[tauri::command]
fn shell_quit(app: AppHandle) {
    log("QUIT_REQUESTED");
    shutdown(&app);
    app.exit(0);
}

// ---------------------------------------------------------------- 托盘 / 菜单栏

static TRAY: Mutex<Option<tauri::tray::TrayIcon<tauri::Wry>>> = Mutex::new(None);

/// 菜单栏托盘：显示 / 隐藏悬浮窗、打开服务日志、退出。
/// 说明：任务书里的「打开设置页」在本项目暂无对应页面（没有设置页），
/// 因此替换为「打开服务日志」，并在 docs/53 记录该取舍。
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;

    let show = MenuItem::with_id(app, "tray_show", "显示悬浮窗", true, None::<&str>)?;
    let showapp = MenuItem::with_id(app, "tray_showapp", "显示 App 界面", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "tray_hide", "隐藏悬浮窗", true, None::<&str>)?;
    let openlog = MenuItem::with_id(app, "tray_log", "打开服务日志", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray_quit", "退出", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &showapp, &hide, &openlog, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id("agent-pet-tray")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("CodeAll")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray_show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                log("TRAY_SHOW");
            }
            "tray_showapp" => {
                if let Some(w) = app.get_webview_window("app") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                log("TRAY_SHOW_APP");
            }
            "tray_hide" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
                log("TRAY_HIDE");
            }
            "tray_log" => {
                let p = server_log_path(app);
                let _ = Command::new("open").arg("-R").arg(&p).spawn();
                log("TRAY_OPEN_LOG");
            }
            "tray_quit" => {
                log("TRAY_QUIT");
                shutdown(app);
                app.exit(0);
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    // TrayIcon 是引用计数类型：最后一个实例 drop 时托盘就没了，必须自己存住
    let tray = builder.build(app)?;
    if let Ok(mut g) = TRAY.lock() {
        *g = Some(tray);
    }
    TRAY_OK.store(true, Ordering::SeqCst);
    log("TRAY_READY");
    Ok(())
}

// ---------------------------------------------------------------- 入口

pub fn run() {
    let _ = t0();
    log("PROCESS_START");
    let port = parse_port();

    tauri::Builder::default()
        .manage(ShellState::default())
        .invoke_handler(tauri::generate_handler![
            shell_status,
            shell_ensure_server,
            shell_http_probe,
            shell_report,
            shell_navigating,
            shell_window_diag,
            shell_start_drag,
            shell_toggle_size,
            shell_move_to,
            shell_set_always_on_top,
            shell_save_position,
            shell_inject_remote_css,
            shell_open_log,
            shell_quit
        ])
        .setup(move |app| {
            {
                let st = app.state::<ShellState>();
                st.port.store(port as u64, Ordering::SeqCst);
            }
            log(&format!(
                "SETUP port={} repo={} node={:?}",
                port,
                resolve_repo_root().display(),
                resolve_node().map(|p| p.display().to_string())
            ));
            let win = app
                .get_webview_window("main")
                .expect("tauri.conf.json 中未声明 label=main 的窗口");

            restore_window(app.handle(), &win);
            // 默认关掉「全局背景拖拽」：tao 的 TaoWindow.sendEvent 在
            // isMovableByWindowBackground=true 时会对**每一次左键按下**调用
            // performWindowDragWithEvent，点击按钮/输入框都会被拖拽会话干扰。
            // 改为标题栏手势 startDragging（见 REMOTE_INJECT）；若远程页拿不到 IPC，
            // start_url_watcher 会在 3.5s 后自动回退打开它。
            match set_movable_by_background(&win, false) {
                Ok(v) => log(&format!(
                    "MOVABLE_BY_BACKGROUND on={} (改为标题栏手势) contentView_mouseDownCanMoveWindow={:?}",
                    v,
                    mouse_down_can_move_window(&win)
                )),
                Err(e) => log(&format!("MOVABLE_BY_BACKGROUND_ERR err={}", e)),
            }
            // 全屏兼容：避免悬浮窗被 App 窗口的原生全屏带走（见函数注释）
            match set_floating_space_behavior(&win) {
                Ok(v) => log(&format!(
                    "FLOATING_SPACE_BEHAVIOR ok={} (canJoinAllSpaces+fullScreenAuxiliary)",
                    v
                )),
                Err(e) => log(&format!("FLOATING_SPACE_BEHAVIOR_ERR err={}", e)),
            }
            match setup_tray(app.handle()) {
                Ok(_) => {}
                Err(e) => log(&format!("TRAY_SETUP_ERR err={}", e)),
            }
            let _ = win.show();
            log(&format!(
                "WINDOW_SHOWN always_on_top={:?} decorated={:?} t_ms={}",
                win.is_always_on_top().unwrap_or(false),
                win.is_decorated().unwrap_or(true),
                t_ms()
            ));

            start_persist_thread(app.handle().clone());
            start_url_watcher(app.handle().clone(), port);
            install_signal_handlers();
            start_signal_watcher(app.handle().clone());

            if let Ok(spec) = std::env::var("AGENT_PET_SELFTEST") {
                if !spec.trim().is_empty() {
                    start_selftest(app.handle().clone(), spec);
                }
            }

            let h = app.handle().clone();
            win.on_window_event(move |event| match event {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    h.state::<ShellState>().dirty.store(true, Ordering::SeqCst);
                }
                WindowEvent::Focused(false) => {
                    if let Some(w) = h.get_webview_window("main") {
                        persist_window(&h, &w, "blur");
                    }
                }
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    if TRAY_OK.load(Ordering::SeqCst) {
                        // 有托盘：关窗只是收起来，从菜单栏「显示悬浮窗」叫回来
                        log("WINDOW_CLOSE_REQUESTED → 收进托盘");
                        if let Some(w) = h.get_webview_window("main") {
                            persist_window(&h, &w, "close-hide");
                            let _ = w.hide();
                        }
                    } else {
                        log("WINDOW_CLOSE_REQUESTED → 无托盘，退出进程");
                        shutdown(&h);
                        h.exit(0);
                    }
                }
                _ => {}
            });

            // app 窗口（App 界面）：红色关闭按钮 = 隐藏（迷你条仍在，⤢ 可再唤出）。
            // 不销毁 webview——销毁后 show() 无法复活，只能重启。
            if let Some(aw) = app.get_webview_window("app") {
                let h3 = app.handle().clone();
                aw.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(w) = h3.get_webview_window("app") {
                            log("APP_WINDOW_CLOSE → hide（迷你条保留）");
                            let _ = w.hide();
                        }
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                shutdown(app);
            }
        });
}
