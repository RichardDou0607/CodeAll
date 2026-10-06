// T1 spike · Swift + AppKit 桌宠外壳最小验证
// 验证：1) 透明无边框窗口(像素级 alpha) 2) 置顶(NSWindow.level + CGWindowList layer)
//       3) 点击穿透(NSWindow.ignoresMouseEvents + hitTest) 4) Unix socket JSONL -> 6 态可见变化
// 编译：swiftc -O -o bin/swift-pet Sources/main.swift
import AppKit
import CoreGraphics
import Foundation

// ---------- 事件契约 §4 状态机 ----------
enum PetState: String {
    case idle, done, thinking, working, error, waiting
    var priority: Int {
        switch self {
        case .idle: return 0
        case .done: return 1
        case .thinking: return 2
        case .working: return 3
        case .error: return 4
        case .waiting: return 5
        }
    }
    var emoji: String {
        switch self {
        case .idle: return "\u{1F634}"
        case .done: return "\u{2728}"
        case .thinking: return "\u{1F914}"
        case .working: return "\u{1F6E0}"
        case .error: return "\u{1F4A5}"
        case .waiting: return "\u{270B}"
        }
    }
    var color: NSColor {
        switch self {
        case .idle: return NSColor(calibratedRed: 0.50, green: 0.55, blue: 0.61, alpha: 0.92)
        case .done: return NSColor(calibratedRed: 0.24, green: 0.86, blue: 0.52, alpha: 0.92)
        case .thinking: return NSColor(calibratedRed: 0.23, green: 0.63, blue: 1.00, alpha: 0.92)
        case .working: return NSColor(calibratedRed: 1.00, green: 0.70, blue: 0.28, alpha: 0.92)
        case .error: return NSColor(calibratedRed: 1.00, green: 0.23, blue: 0.19, alpha: 0.92)
        case .waiting: return NSColor(calibratedRed: 1.00, green: 0.30, blue: 0.43, alpha: 0.92)
        }
    }
}

// ---------- CLI ----------
func argValue(_ name: String, _ def: String) -> String {
    let a = CommandLine.arguments
    if let i = a.firstIndex(of: name), i + 1 < a.count { return a[i + 1] }
    return def
}
func argFlag(_ name: String) -> Bool { CommandLine.arguments.contains(name) }

let tmpDir = ProcessInfo.processInfo.environment["TMPDIR"] ?? "/tmp"
let petDir = tmpDir + "agent-pet"
try? FileManager.default.createDirectory(atPath: petDir, withIntermediateDirectories: true)

// 契约 §3 的 16 个 type 字面量（表格 14 行 = 16 个 type，见 docs/30 的「建议变更」）
let KNOWN_TYPES: Set<String> = [
    "session.start", "session.end", "pet.heartbeat",
    "turn.start", "turn.end", "step.start", "step.end", "message.assistant",
    "tool.call", "tool.result", "approval.request", "approval.resolved",
    "user.question", "user.answer", "agent.status", "error.raised",
]

let socketPath = argValue("--socket", petDir + "/swift-spike.sock")
let reportPath = argValue("--report", petDir + "/swift-spike-report.jsonl")
let artifactDir = argValue("--artifacts", "artifacts")
let runSeconds = Double(argValue("--run-seconds", "14")) ?? 14
let toggleAt = Double(argValue("--click-through-toggle-at", "4")) ?? 4
let tStart = Date()

try? FileManager.default.createDirectory(atPath: artifactDir, withIntermediateDirectories: true)
FileManager.default.createFile(atPath: reportPath, contents: nil)
let reportHandle = FileHandle(forWritingAtPath: reportPath)
let stdoutHandle = FileHandle.standardOutput
func report(_ line: String) {
    // 直接 write(2)，避免 stdout 重定向到文件时被块缓冲（否则外部脚本无法实时看到 READY）
    let data = (line + "\n").data(using: .utf8)!
    stdoutHandle.write(data)
    reportHandle?.write(data)
}
func ms(_ d: Date) -> Int { Int(d.timeIntervalSince(tStart) * 1000) }
report("T_START t_ms=\(Int(tStart.timeIntervalSince1970 * 1000)) swift=\(#file)")

// ---------- 窗口 ----------
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let W: CGFloat = 240
let window = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: W, height: W),
    styleMask: [.borderless],
    backing: .buffered,
    defer: false)
window.isOpaque = false
window.backgroundColor = .clear
window.hasShadow = false
window.level = .floating                       // 置顶
window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
window.ignoresMouseEvents = true               // 点击穿透（初始开）
window.isMovableByWindowBackground = true
if let screen = NSScreen.main {
    let f = screen.visibleFrame
    window.setFrameOrigin(NSPoint(x: f.midX - W / 2, y: f.midY - W / 2))
}

// ---------- 宠物视图 ----------
final class PetView: NSView {
    var state: PetState = .idle { didSet { needsDisplay = true } }
    var bubble: String = ""
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.set()
        dirtyRect.fill()
        let d: CGFloat = 130
        let r = NSRect(x: (bounds.width - d) / 2, y: 20, width: d, height: d)
        state.color.setFill()
        NSBezierPath(ovalIn: r).fill()
        let emoji = state.emoji as NSString
        let eAttrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 62)]
        let esize = emoji.size(withAttributes: eAttrs)
        emoji.draw(at: NSPoint(x: r.midX - esize.width / 2, y: r.midY - esize.height / 2), withAttributes: eAttrs)
        let label = state.rawValue as NSString
        let lAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.boldSystemFont(ofSize: 20),
            .foregroundColor: NSColor.white,
        ]
        let lsize = label.size(withAttributes: lAttrs)
        label.draw(at: NSPoint(x: (bounds.width - lsize.width) / 2, y: 160), withAttributes: lAttrs)
        if !bubble.isEmpty {
            let b = bubble as NSString
            let bAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 13),
                .foregroundColor: NSColor.white,
            ]
            let bsize = b.size(withAttributes: bAttrs)
            let br = NSRect(x: 8, y: 190, width: bounds.width - 16, height: bsize.height + 6)
            NSColor(calibratedWhite: 0.1, alpha: 0.72).setFill()
            NSBezierPath(roundedRect: br, xRadius: 8, yRadius: 8).fill()
            b.draw(at: NSPoint(x: br.midX - bsize.width / 2, y: br.minY + 3), withAttributes: bAttrs)
        }
    }
}
let view = PetView(frame: NSRect(x: 0, y: 0, width: W, height: W))
window.contentView = view
window.orderFrontRegardless()
app.activate(ignoringOtherApps: false)

// ---------- fakes 适配器接入：Unix domain socket + JSONL ----------
var stateSeq: [String] = []
var unknownCount = 0
var appliedCount = 0
var snapshotIndex = 0

func snapshot(state: PetState) {
    guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
    view.cacheDisplay(in: view.bounds, to: rep)
    snapshotIndex += 1
    let name = String(format: "state-%02d-%@.png", snapshotIndex, state.rawValue)
    let path = artifactDir + "/" + name
    if let data = rep.representation(using: .png, properties: [:]) {
        try? data.write(to: URL(fileURLWithPath: path))
    }
    var cornerAlpha = -1.0
    var centerAlpha = -1.0
    if let c = rep.colorAt(x: 3, y: 3) { cornerAlpha = Double(c.alphaComponent) }
    if let c = rep.colorAt(x: Int(W / 2), y: Int(20 + 65)) { centerAlpha = Double(c.alphaComponent) }
    report("SNAPSHOT file=\(path) state=\(state.rawValue) corner_alpha=\(cornerAlpha) pet_alpha=\(centerAlpha) t_ms=\(ms(Date()))")
}

func mapEventToState(_ type: String, _ data: [String: Any]) -> PetState? {
    switch type {
    case "session.start", "turn.start": return .thinking
    case "step.start", "tool.call": return .working
    case "approval.request", "user.question": return .waiting
    case "approval.resolved":
        return (data["decision"] as? String) == "allow" ? .done : .error
    case "tool.result": return (data["status"] as? String) == "error" ? .error : .working
    case "turn.end": return (data["status"] as? String) == "error" ? .error : .done
    case "session.end": return (data["reason"] as? String) == "error" ? .error : .done
    case "error.raised": return .error
    case "agent.status":
        if let s = data["state"] as? String, let st = PetState(rawValue: s) { return st }
        return nil
    case "pet.heartbeat": return nil
    default: return nil
    }
}

func applyLine(_ line: String) {
    guard let d = line.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else {
        report("PARSE_ERR")
        return
    }
    guard let type = obj["type"] as? String else { report("PARSE_ERR no type"); return }
    let data = (obj["data"] as? [String: Any]) ?? [:]
    guard let next = mapEventToState(type, data) else {
        if !KNOWN_TYPES.contains(type) {          // 契约 §7.3：未知 type 计数，不抛异常
            unknownCount += 1
            if unknownCount % 250 == 0 || unknownCount == 1 {
                report("UNKNOWN_EVENT type=\(type) unknownEvents=\(unknownCount)")
            }
        }
        return
    }
    let cur = view.state
    if next.priority < cur.priority && next != .idle {
        report("QUEUED type=\(type) next=\(next.rawValue) current=\(cur.rawValue) reason=priority")
        return
    }
    view.state = next
    let bubbleText = (data["summary"] as? String) ?? (data["text"] as? String) ?? ""
    view.bubble = bubbleText
    view.needsDisplay = true
    appliedCount += 1
    stateSeq.append(next.rawValue)
    report("DOM_APPLIED state=\(next.rawValue) type=\(type) seq_tag_count=\(appliedCount) t_ms=\(ms(Date()))")
    snapshot(state: next)
}

// POSIX Unix domain socket 服务端（契约 §5：适配器 -> 桌宠）
func startSocketServer(path: String) {
    unlink(path)
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { report("SOCKET_FAIL errno=\(errno)"); return }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
        raw.copyBytes(from: bytes.prefix(raw.count - 1))
    }
    let len = socklen_t(MemoryLayout<sockaddr_un>.size)
    let bound = withUnsafePointer(to: &addr) { p in
        p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in Darwin.bind(fd, sa, len) }
    }
    guard bound == 0 else { report("BIND_FAIL errno=\(errno) path=\(path)"); return }
    guard Darwin.listen(fd, 8) == 0 else { report("LISTEN_FAIL errno=\(errno)"); return }
    report("READY socket=\(path) t_ms=\(ms(Date()))")
    Thread.detachNewThread {
        while true {
            let client = Darwin.accept(fd, nil, nil)
            if client < 0 { continue }
            report("CLIENT_CONNECTED t_ms=\(ms(Date()))")
            Thread.detachNewThread {
                var buf = [UInt8](repeating: 0, count: 65536)
                var pending = Data()
                while true {
                    let n = Darwin.read(client, &buf, buf.count)
                    if n <= 0 { break }
                    pending.append(contentsOf: buf[0..<n])
                    while let nl = pending.firstIndex(of: 0x0A) {
                        let lineData = pending.subdata(in: pending.startIndex..<nl)
                        pending.removeSubrange(pending.startIndex...nl)
                        if let s = String(data: lineData, encoding: .utf8), !s.isEmpty {
                            DispatchQueue.main.async { applyLine(s) }
                        }
                    }
                }
                report("CLIENT_CLOSED t_ms=\(ms(Date()))")
            }
        }
    }
}

// ---------- 窗口属性自检 ----------
func cgInfo(_ number: Int) -> String {
    guard number > 0 else { return "no-window-number" }
    let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(number)) as? [[String: Any]] ?? []
    guard let info = list.first else { return "not-found" }
    let layer = info[kCGWindowLayer as String] as? Int ?? -999
    let alpha = info[kCGWindowAlpha as String] as? Double ?? -1
    let onscreen = info[kCGWindowIsOnscreen as String] as? Bool ?? false
    let b = info[kCGWindowBounds as String] as? [String: Any] ?? [:]
    return "layer=\(layer) alpha=\(alpha) onscreen=\(onscreen) bounds=(x:\(b["X"] ?? "?") y:\(b["Y"] ?? "?") w:\(b["Width"] ?? "?") h:\(b["Height"] ?? "?"))"
}

func hitTestResult() -> String {
    guard let cv = window.contentView else { return "no-content-view" }
    let p = NSPoint(x: cv.bounds.midX, y: 85)   // 宠物圆内
    let hit = cv.hitTest(p)
    return hit == nil ? "nil(未命中)" : String(describing: type(of: hit!))
}

func windowSelfCheck(tag: String) {
    report("WINDOW_CHECK tag=\(tag) styleMask=\(window.styleMask.rawValue) isOpaque=\(window.isOpaque) "
        + "bgAlpha=\(window.backgroundColor.alphaComponent) level=\(window.level.rawValue) "
        + "ignoresMouseEvents=\(window.ignoresMouseEvents) hasShadow=\(window.hasShadow) "
        + "isVisible=\(window.isVisible) alpha=\(window.alphaValue) collectionBehavior=\(window.collectionBehavior.rawValue) "
        + "hitTest=\(hitTestResult()) t_ms=\(ms(Date()))")
    report("CGWINDOW_CHECK tag=\(tag) windowNumber=\(window.windowNumber) \(cgInfo(window.windowNumber))")
}

// ---------- 启动 ----------
windowSelfCheck(tag: "boot")
startSocketServer(path: socketPath)

// 运行中切换点击穿透（默认 boot 时为 ON，切换为 OFF 以验证两态）
DispatchQueue.main.asyncAfter(deadline: .now() + toggleAt) {
    let next = !window.ignoresMouseEvents
    window.ignoresMouseEvents = next
    report("CLICK_THROUGH_TOGGLE ignoresMouseEvents=\(next) t_ms=\(ms(Date()))")
    windowSelfCheck(tag: next ? "click-through-on" : "click-through-off")
}
DispatchQueue.main.asyncAfter(deadline: .now() + toggleAt + 4) {
    let next = !window.ignoresMouseEvents
    window.ignoresMouseEvents = next
    report("CLICK_THROUGH_TOGGLE ignoresMouseEvents=\(next) t_ms=\(ms(Date()))")
    windowSelfCheck(tag: next ? "click-through-on" : "click-through-off")
}
DispatchQueue.main.asyncAfter(deadline: .now() + runSeconds) {
    report("SUMMARY applied=\(appliedCount) unknownEvents=\(unknownCount) states=\(stateSeq.joined(separator: ">")) "
        + "windowNumber=\(window.windowNumber) finalLevel=\(window.level.rawValue) finalIgnoresMouseEvents=\(window.ignoresMouseEvents)")
    report("T_EXIT t_ms=\(ms(Date()))")
    reportHandle?.closeFile()
    exit(0)
}
report("T_RUNLOOP t_ms=\(ms(Date()))")
app.run()
