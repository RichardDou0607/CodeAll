// apps/shell/tools/dragtest.swift
// 合成鼠标拖拽：独立验证「悬浮窗可拖拽」，不依赖应用自述
// 编译：cd apps/shell && swiftc -O -o tools/bin/dragtest tools/dragtest.swift
// 用法：tools/bin/dragtest <owner-filter> <dx> <dy> [--grab-y N]
// 退出码：0=窗口确实被拖动  3=合成事件被系统丢弃（缺「辅助功能」权限）  4=没找到窗口
import ApplicationServices
import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count >= 4 else {
    print("usage: dragtest <owner-filter> <dx> <dy> [--grab-y N]")
    exit(2)
}
let filter = args[1]
let dx = Int(args[2]) ?? 0
let dy = Int(args[3]) ?? 0
var grabY = 15
if let i = args.firstIndex(of: "--grab-y"), i + 1 < args.count { grabY = Int(args[i + 1]) ?? 15 }

print("AXIsProcessTrusted=\(AXIsProcessTrusted())")

func findWindow() -> (id: Int, x: Int, y: Int, w: Int, h: Int)? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    for info in list {
        let owner = (info[kCGWindowOwnerName as String] as? String) ?? ""
        let name = (info[kCGWindowName as String] as? String) ?? ""
        if !owner.lowercased().contains(filter.lowercased()) && !name.lowercased().contains(filter.lowercased()) { continue }
        let b = info[kCGWindowBounds as String] as? [String: Any] ?? [:]
        let num = info[kCGWindowNumber as String] as? Int ?? -1
        let x = Int(b["X"] as? Double ?? 0), y = Int(b["Y"] as? Double ?? 0)
        let w = Int(b["Width"] as? Double ?? 0), h = Int(b["Height"] as? Double ?? 0)
        if w > 100 && h > 100 { return (num, x, y, w, h) }
    }
    return nil
}

guard let before = findWindow() else { print("WINDOW_NOT_FOUND filter=\(filter)"); exit(4) }
print("before id=\(before.id) bounds=(\(before.x),\(before.y),\(before.w),\(before.h))")

let sx = Double(before.x + before.w / 2)
let sy = Double(before.y + grabY)
print("grab=(\(Int(sx)),\(Int(sy))) delta=(\(dx),\(dy))")

func post(_ type: CGEventType, _ p: CGPoint) {
    if let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left) {
        e.post(tap: .cghidEventTap)
    }
}

post(.mouseMoved, CGPoint(x: sx, y: sy))
usleep(120_000)
post(.leftMouseDown, CGPoint(x: sx, y: sy))
usleep(180_000)
let steps = 24
for i in 1...steps {
    let t = Double(i) / Double(steps)
    post(.leftMouseDragged, CGPoint(x: sx + Double(dx) * t, y: sy + Double(dy) * t))
    usleep(16_000)
}
usleep(120_000)
post(.leftMouseUp, CGPoint(x: sx + Double(dx), y: sy + Double(dy)))
usleep(400_000)

guard let after = findWindow() else { print("WINDOW_LOST"); exit(4) }
let movedX = after.x - before.x
let movedY = after.y - before.y
print("after  id=\(after.id) bounds=(\(after.x),\(after.y),\(after.w),\(after.h))")
print("moved=(\(movedX),\(movedY)) expected=(\(dx),\(dy))")
if abs(movedX - dx) <= 4 && abs(movedY - dy) <= 4 {
    print("DRAG_OK"); exit(0)
} else if movedX == 0 && movedY == 0 {
    print("DRAG_NO_EFFECT（合成事件被系统丢弃：需要「辅助功能」权限）"); exit(3)
} else {
    print("DRAG_PARTIAL moved=(\(movedX),\(movedY))"); exit(1)
}
