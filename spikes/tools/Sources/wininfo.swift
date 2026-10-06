// 独立工具：用 CGWindowList 交叉核对任意进程窗口的 level/alpha/onscreen/bounds
// 用法：swiftc -O -o bin/wininfo Sources/wininfo.swift && ./bin/wininfo <owner-name-filter>
import CoreGraphics
import Foundation

let filter = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
    print("CGWindowListCopyWindowInfo failed")
    exit(1)
}
var matched = 0
for info in list {
    let owner = (info[kCGWindowOwnerName as String] as? String) ?? ""
    let name = (info[kCGWindowName as String] as? String) ?? ""
    if !filter.isEmpty && !owner.lowercased().contains(filter.lowercased()) && !name.lowercased().contains(filter.lowercased()) {
        continue
    }
    let num = info[kCGWindowNumber as String] as? Int ?? -1
    let layer = info[kCGWindowLayer as String] as? Int ?? -999
    let alpha = info[kCGWindowAlpha as String] as? Double ?? -1
    let onscreen = info[kCGWindowIsOnscreen as String] as? Bool ?? false
    let b = info[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let ownerPid = info[kCGWindowOwnerPID as String] as? Int ?? -1
    print("window=\(num) pid=\(ownerPid) owner=\(owner) name=\(name.isEmpty ? "<redacted-or-empty>" : name) layer=\(layer) alpha=\(alpha) onscreen=\(onscreen) bounds=(x:\(b["X"] ?? "?") y:\(b["Y"] ?? "?") w:\(b["Width"] ?? "?") h:\(b["Height"] ?? "?"))")
    matched += 1
}
print("matched_windows=\(matched)")
