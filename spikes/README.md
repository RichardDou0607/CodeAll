# spikes/ · T1 骨架验证工程（队友 A）

> 目的：不做 PPT 选型。用三个**最小可运行工程**验证桌宠外壳的四项硬需求：① 透明无边框窗口 ② 置顶 ③ 点击穿透 ④ 从 Unix socket 读 JSONL 驱动可见状态变化。
> 结论与完整数据见 [../docs/30-implementation-stack.md](../docs/30-implementation-stack.md)。所有命令都在 macOS 27.0.1 arm64 上实测通过（2026-10-05）。

## 目录

| 路径 | 内容 |
|---|---|
| `swift-appkit-pet/` | **纯 Swift + AppKit** 最小桌宠（122 KB 二进制）：透明/置顶/穿透 + socket JSONL + 6 态状态机 + 每态快照 PNG |
| `tauri-pet/` | **Tauri v2** 最小桌宠（4.0 MB `.app`）：`transparent + macOSPrivateApi + alwaysOnTop`，Rust 侧监听 socket 并 `emit` 给 WebView，JS 只做渲染与上报 |
| `electron-pet/` | **Electron 44** 最小桌宠（288 MB 运行时）：`transparent+frame:false+setAlwaysOnTop+setIgnoreMouseEvents` 对照实现 |
| `jsonl-feed/feed.mjs` | **假适配器**：按 [契约 §2/§3](../docs/00-interface-contract.md) 生成规范事件，经 Unix socket 以 JSONL 写入桌宠；支持 `unknown-storm` 场景 |
| `tools/` | 独立核对工具：`wininfo`（CGWindowList 查窗口 layer/alpha/onscreen）、`tree-rss.mjs`（进程树 RSS）、`footprint-sum.sh`（phys_footprint 合计）、`pixelprobe`（PNG 像素 RGBA，验证真透明） |

## 快速开始

```bash
# 0) 编译核对工具（~2 s）
cd tools && swiftc -O -o bin/wininfo Sources/wininfo.swift && swiftc -O -o bin/pixelprobe Sources/pixelprobe.swift

# 1) Swift + AppKit（编译 ~1.0 s，运行 14 s 自动退出）
cd ../swift-appkit-pet && swiftc -O -o bin/swift-pet Sources/main.swift
./run-spike.sh demo            # 全 6 态 + 快照 + 窗口自检
./run-spike.sh unknown-storm   # 契约 §7.3：1000 条未知事件 → unknownEvents=1000

# 2) Tauri v2（首次构建 ~47 s，增量 ~38 s；需先装 Rust 工具链）
cd ../tauri-pet && pnpm install && pnpm tauri build
./run-spike.sh

# 3) Electron（首次下载 ~42 s / 288 MB）
cd ../electron-pet && pnpm add -D electron
./run-spike.sh
```

依赖前提：`node -v`(v24.18.0)、`pnpm -v`(12.9.1)、`swiftc --version`(Swift 6.4)、Rust 工具链（Tauri 需要；本机用 `rustup --profile minimal` 装的 1.99.0）。

## 每个 spike 验证了什么

| 验证项 | Swift | Tauri | Electron |
|---|---|---|---|
| 透明无边框窗口 | `isOpaque=false`+`bgAlpha=0.0`+**快照角像素 alpha=0.0** | `transparent:true`+`macOSPrivateApi:true`（像素级未验证：无屏幕录制权限） | `transparent:true`+`frame:false`（同上） |
| 置顶 | `level=.floating` → 独立工具实测 `layer=3` | `alwaysOnTop:true` → 实测 `layer=5` | `setAlwaysOnTop(true,'floating')` → 实测 `layer=3` |
| 点击穿透 | `ignoresMouseEvents`（两态回读） | `set_ignore_cursor_events`（两态回读） | `setIgnoreMouseEvents(on,{forward:true})` |
| socket JSONL → 状态 | 11 条事件 → 7 次状态应用 | 11 条 → 6 次 DOM 应用 | 11 条 → 7 次 DOM 应用 |
| 未知事件风暴 | 1000 条 → `unknownEvents=1000`，无崩溃 | 未跑 | 未跑 |
| 空闲内存（footprint） | 13.0 MB | 57.1 MB | 89.2 MB |
| 产物体积 | 122 KB | 4.0 MB | 288 MB |

## 输出物在哪

- 应用日志：`<spike>/artifacts/app-stdout.log`
- 状态快照 PNG：`swift-appkit-pet/artifacts/state-*.png`（每态一张，SHA-256 互不相同）
- 上报文件：`$TMPDIR/agent-pet/*-spike-report.jsonl`；注入的事件：`$TMPDIR/agent-pet/fed-*.jsonl`

## 已知坑（踩过，别再踩）

1. **`ELECTRON_RUN_AS_NODE=1`**：从 DSH（Electron 应用）继承该环境变量时，Electron 会退化成纯 Node，`require("electron")` 返回路径字符串、`ipcMain` 为 undefined，报错位置看起来像业务代码 bug。`run-spike.sh` 已内置 `env -u ELECTRON_RUN_AS_NODE`。
2. **pnpm 下的 `electron` bin 是 JS shim**：直接用 `node_modules/.pnpm/electron@*/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .` 更可靠（脚本已如此）。
3. **Swift `print` 重定向到文件是块缓冲**：外部脚本会看不到 `READY`，导致等待循环空转。spike 用 `FileHandle.standardOutput.write` 直写 fd，保证实时可见。
4. **`NSView.hitTest` 不能判定点击穿透**：穿透 ON/OFF 两态都返回同一个 view（实测）。判定依据用 `ignoresMouseEvents` 属性回读 + 手工点击验证。
5. **Tauri `identifier` 不允许下划线**：`com.foo.tauri-pet` 会被拒绝（`bundle identifier ... only alphanumeric, hyphens, periods`），改用 `com.agentpet.spike`。
6. **`screencapture -l <windowNumber>`** 在未授予"屏幕录制"权限时报 `could not create image from window`；Swift spike 的像素级透明证据来自**进程内 `cacheDisplay` 快照**，不依赖该权限。
7. 运行期间会短暂出现置顶小窗口（每个 spike 自动退出/被 kill），不会占用任何端口；socket 文件位于 `$TMPDIR/agent-pet/`。
