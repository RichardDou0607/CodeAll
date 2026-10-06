# 30 · 实现技术栈与选型（Phase 1）

> 负责人：队友 A（pet-runtime-scout）｜状态：**DRAFT-v1，含本机实测骨架验证**｜日期：2026-10-05（Asia/Shanghai）
> 结论一句话：**主选 Tauri v2（Rust 壳 + WKWebView/WebView2 渲染），备选 A 纯 Swift+AppKit（macOS 保底），备选 B Electron（复用 DSH 生态、工期优先）。**
> 本文所有"实测"数据均来自 `spikes/` 下三个可复现工程，命令与输出见 §4 与 [spikes/README.md](../spikes/README.md)。外部信息给完整 URL + 访问日期；无法核验的一律标 **未验证** 并给出验证方法。

---

## 1. 需求 → 可判定的技术维度

桌宠外壳（shell）要满足的不是"能显示窗口"，而是下面 9 条可验收的硬指标。后文所有比较都以此为准。

| ID | 维度 | Phase 1 门槛（可判定） | 为什么是硬指标 |
|---|---|---|---|
| D1 | macOS 透明 + 无边框 + 置顶 + 点击穿透 | 4 项全通过，且**穿透可运行时切换** | 桌宠必须"看得出、点得动、不挡鼠标"；缺点击穿透就变成一个挡住用户操作的浮窗 |
| D2 | Windows 支持 | Phase 2 必须原生支持透明 + 置顶 + 穿透 | 第二阶段要覆盖 Claude Code / Codex / Cursor 的 Windows 用户 |
| D3 | 安装包体积 | ≤ 30 MB 为优，≤ 100 MB 可接受 | 桌宠是"顺便装一个"的轻应用，体积直接决定下载转化 |
| D4 | 空闲内存 | **≤ 150 MB**（Lead 设定） | 桌宠需要 7×24 常驻，必须与用户的 IDE/浏览器共存 |
| D5 | Web 动画生态 | 能直接用 Live2D / Spine / Rive / Lottie 的 Web 运行时 | 皮肤是 Phase 2 的变现主线，不能用就得自研动画管线 |
| D6 | 开发效率 | 8 周内出可演示 demo（含状态机 + 1 个换装皮肤） | 团队是 TS 背景，学习曲线直接吃工期 |
| D7 | 签名 / 公证 / 分发 | 可自动化签名 + 公证 + DMG 直分发 | 未签名应用在 macOS 上会被 Gatekeeper 拦 |
| D8 | 与 DSH（TS/Cordis）生态契合 | 渲染层与适配器能用 TS 写，能与 DSH 插件生态共享代码 | DSH 桌面端本身是 Electron + TS（见 §2.1），Phase 1 适配器必须贴着它 |
| D9 | 成熟度 / 风险 | 有量产案例、社区活跃、无致命单点 | 避免把 8 周 demo 押在 beta 技术上 |

---

## 2. 关键事实（先确认地基）

### 2.1 DSH 桌面端自己就是 Electron 应用（本机实测）

```bash
ls "/Applications/DeepSeek Harness.app/Contents/Frameworks/"
# → Electron Framework.framework / DeepSeek Harness Helper (Renderer).app / (GPU).app / Squirrel.framework
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "/Applications/DeepSeek Harness.app/Contents/Info.plist"   # → 0.2.0-rc.2
du -sh "/Applications/DeepSeek Harness.app"                                                                              # → 999M（含 runtime/pnpm/office-skills）
```

含义：Phase 1 的适配器只要能喂 JSONL，就不必和 DSH 同栈；但"与 DSH 生态共享 TS 代码/调试习惯"是真实收益，也是 Electron 备选方案的核心理由。

### 2.2 本机环境（实测）

| 项 | 值 | 命令 |
|---|---|---|
| OS / 内核 | macOS 27.0.1 (Build 26A434) / Darwin 27.0.0 arm64 (T8142) | `sw_vers`、`uname -a` |
| Node / pnpm | v24.18.0 / 12.9.1 | `node -v`、`pnpm -v` |
| Swift / Xcode | Swift 6.4 (swiftlang-6.4.0.34.1)，`/Applications/Xcode.app/Contents/Developer` | `swiftc --version`、`xcode-select -p` |
| Rust | **初始未安装**；本次用 rustup `--profile minimal` 装了 1.99.0 (b940084d7 2026-09-28) | `rustc --version` |
| GUI 会话 | 可用（`NSScreen.screens.count == 1`，可创建并显示置顶窗口） | `spikes/` 探针 |

> ⚠️ 本机环境有一个坑：**继承自 DSH 的 `ELECTRON_RUN_AS_NODE=1`**，会让 Electron 退化成纯 Node（`require("electron")` 返回路径字符串、`ipcMain` 为 undefined）。复现 Electron spike 必须 `env -u ELECTRON_RUN_AS_NODE`（脚本已内置）。详见 §4.3。

---

## 3. 技术栈对比

### 3.1 窗口能力（D1/D2）

| 栈 | macOS 透明无边框 | 置顶 | 点击穿透 | Windows 透明+穿透 | 证据 |
|---|---|---|---|---|---|
| **Tauri v2** | ✅ `transparent:true` + `decorations:false` + `macOSPrivateApi:true` | ✅ `alwaysOnTop:true`（实测 CGWindowList layer=5） | ✅ `set_ignore_cursor_events(bool)` | ⚠️ 配置项同源，但**未实测**（见 §7） | 本机实测 + 本地依赖源码 `tauri-2.12.1/src/webview/webview_window.rs:2260`、`tauri-utils-2.10.1/src/config.rs:2063/2072/2078/3374` |
| **Electron** | ✅ `transparent:true, frame:false` | ✅ `setAlwaysOnTop(true,'floating')`（实测 layer=3） | ✅ `setIgnoreMouseEvents(bool,{forward:true})` | ✅ 成熟（同 API） | 本机实测 + `electron.d.ts:3392 / 4080 / 3197` |
| **Swift + AppKit** | ✅ `.borderless` + `isOpaque=false` + `backgroundColor=.clear`（像素级 alpha=0，实测） | ✅ `window.level = .floating`（实测 layer=3） | ✅ `window.ignoresMouseEvents` | ❌ 需为 Windows 重写（Win32/WPF/DirectComposition） | 本机实测（`NSWindow` 属性回读 + 进程内快照角像素 alpha=0.0） |
| **Flutter** | ⚠️ 需第三方插件（`window_manager` 支持 macOS/Windows/Linux；`flutter_acrylic` 提供 `acknowledgeMouseEvents`） | ⚠️ 插件 | ⚠️ 插件，粒度/稳定性依赖社区 | ⚠️ 插件 | [pub.dev/packages/window_manager](https://pub.dev/packages/window_manager)（已抓取，v0.5.2，2026-10-05）、[flutter_acrylic 文档](https://pub.dev/documentation/flutter_acrylic/latest/window/Window/acknowledgeMouseEvents.html)（未抓取） |
| **Qt 6 / QML** | ✅ `WA_TranslucentBackground` + `FramelessWindowHint` | ✅ `WindowStaysOnTopHint` | ✅ `Qt::WindowTransparentForInput` | ✅ 同 API | [doc.qt.io/qt-6/qt.html](https://doc.qt.io/qt-6/qt.html)（本机网络不可达，**未直接核验原文**） |
| **Godot 4（贴桌面）** | ✅ `display/window/per_pixel_transparency` | ✅ 窗口标志 | ⚠️ `DisplayServer.window_set_mouse_passthrough` + 社区资产 | ⚠️ 社区资产 [Windows Mouse Passthrough](https://store.godotengine.org/asset/jakub-hubacek/windows-mouse-passthrough/) | [docs.godotengine.org DisplayServer](https://docs.godotengine.org/en/stable/classes/class_displayserver.html)（已抓取，关键词未命中，**未验证**） |
| **Wails v3** | ✅（Go + WebView2/WKWebView） | ✅ | ⚠️ **Windows 上"逐像素透明 + 点击穿透"已知不能同时满足** | ⚠️ 同上 | [wails#5812](https://github.com/wailsapp/wails/issues/5812)（搜索摘要，**原文未能打开核验**）；v3 尚未 GA |
| **Neutralino** | 依赖系统 WebView，无内置透明/穿透保证 | — | — | — | **未验证**；生态与窗口能力弱于 Wails，不推荐深入 |

### 3.2 体积 / 启动 / 内存（D3/D4）— 全部本机实测

测量方法（三者一致，脚本见 `spikes/tools/`）：
- 体积：`du -sh <产物>`（Tauri 取 `.app` 与裸二进制；Electron 取其自带运行时 `Electron.app`；Swift 取可执行文件）
- 启动：shell 记录 spawn 时刻 → 等应用自报 `READY`/`WINDOW_SHOWN`，同时对比应用内部计时
- 内存：`ps -o rss=`（**RSS，会把共享框架页在每个进程重复计入**）与 `footprint -p <pid>` 的 `phys_footprint`（Apple 自带，≈ 活动监视器"内存"列，**更接近真实占用**）；Tauri 的 WKWebView 辅助进程由系统 XPC 拉起、**不在进程树内**，用"启动前后 WebKit 进程 pid 差集"归属

| 栈（版本） | 产物体积 | 启动（spawn→窗口/READY） | 空闲 RSS 合计 | 空闲 phys_footprint 合计 | 达标 D4(≤150MB) |
|---|---|---|---|---|---|
| **Tauri v2.12.1**（+ @tauri-apps/api 2.12.1） | 裸二进制 **3.9 MB**；`.app` **4.0 MB** | **208–475 ms**（多次运行；内部 setup→READY 118–123 ms） | 93.6 MB(app) + 44.7 + 31.0 + 16.0(WebKit) ≈ **185 MB** | 23.0 + 17.0(WebContent) + 12.0(GPU) + 5.1(Networking) = **57.1 MB** | ✅（footprint）/ ❌（RSS） |
| **Electron 44.5.1** | 运行时 **288 MB**（+ 业务代码 ~10 KB） | **276 ms**（内部 t_ms=143–144；二次热态运行仅记录内部值） | 155.7 + 99.6 + 73.5 + 46.5 = **375.3 MB**（4 进程） | 39.0 + 22.0 + 21.0 + 7.2 = **89.2 MB**（4 进程） | ✅（footprint）/ ❌（RSS） |
| **Swift 6.4 + AppKit** | 可执行文件 **122 KB** | **395–448 ms**（spawn→进程 352–395 ms + →READY 53–59 ms） | **45.0 ~ 47.3 MB**（单进程，3 次采样） | **13.0 MB** | ✅✅ |

> 口径与波动：以上为**多次运行中的实测值**，同一命令重复执行会有 ±10% 级别波动（例如 Tauri spawn→READY 在 208–475 ms 之间，受文件缓存/系统负载影响）；内存为窗口静止 5 s 后的单次快照，三个栈各重复 2–3 次，波动 <5%。RSS 与 footprint 的差别解释见下。

三个反直觉但重要的结论：
1. **"Electron 一定 >150 MB"是错的**——按 `phys_footprint`（89.2 MB）它也在门槛内；按 RSS（375 MB）则远超。**团队必须在验收指标里写清用哪个口径**，否则会吵不清。建议：验收用 `phys_footprint` 合计 + 记录 RSS 作为参考。
2. Tauri 的 `4 MB` 包体是真的，但**内存优势只有 1.6×**（57 MB vs 89 MB），因为 WKWebView 的 WebContent/GPU 进程由系统承担、不随包分发。真正的差距在**分发体积（4 MB vs 288 MB）**与**升级成本**。
3. 纯 Swift 是唯一"三项全优"的选项（122 KB / 411 ms / 13 MB），代价是 Windows 归零 + 无 Web 动画生态（D5/D2 直接不达标）。

### 3.3 生态 / 工程 / 风险（D5–D9）

| 栈 | Web 动画生态(D5) | 开发效率(D6, 8 周) | 签名/公证(D7) | TS/Cordis 契合(D8) | 成熟度与风险(D9) |
|---|---|---|---|---|---|
| **Tauri v2** | ✅ 渲染层就是 WebView，Live2D/Spine/Rive/Lottie 直接用 | ⚠️ 前端 TS 很快，但**要写 Rust**（transport/状态机/托盘）；本机首个 release build 47 s，增量 38 s | ⚠️ 需 `codesign`+`notarytool`；**启用 `macOSPrivateApi` 后 Mac App Store 有被拒风险**（社区共识，**未核验官方原文**）→ 建议 DMG 直分发 | ✅ 前端 TS；Rust 侧以 JSON 事件为界，与 Cordis 无耦合 | ✅ 2.x 已量产（本次 2.12.1）；插件生态完整 |
| **Electron** | ✅ 同上 | ✅ **最快**：纯 TS/JS，能直接照抄 DSH 的 Electron 经验与工具链 | ✅ electron-builder/forge 成熟，社区文档最多 | ✅✅ 与 DSH 同栈，可共享插件/调试/CI 习惯 | ✅ 最成熟；风险是体积与内存口碑 |
| **Swift + AppKit** | ❌ 无 Web 动画生态；Live2D 需自绘或内嵌 WKWebView（等于混合方案） | ❌ 8 周内要同时做渲染管线 + 动画，风险高；且团队 TS 背景 | ✅ 最顺（Xcode 一把梭），但**无 Windows 复用** | ❌ | ✅ 最稳；风险是 Phase 2 推倒重来 |
| **Flutter** | ⚠️ 无 Web 动画生态（Live2D 需 Dart/C++ 绑定或内嵌 WebView） | ⚠️ Dart 新语言 + 桌面插件质量参差 | ⚠️ 需自行处理 macOS 公证 | ❌ 与 TS 生态割裂 | ⚠️ 桌面端非主战场 |
| **Qt / QML** | ⚠️ QML 动画强，但**无 Live2D/Spine 官方 Web 运行时**，需 C++ 集成 | ❌ C++/QML 与团队技能不匹配 | ⚠️ 需处理 LGPL 动态链接合规或买商业授权 | ❌ | ✅ 技术成熟，商业授权成本是主要风险 |
| **Godot 4** | ⚠️ 有 Live2D 社区插件（**未验证**），非官方 | ❌ 用游戏引擎做桌宠，工程/资源管线错配 | ⚠️ 少见 | ❌ | ⚠️ 能跑通但"大炮打蚊子" |
| **Wails v3** | ✅ WebView | ⚠️ Go 绑定 + v3 未 GA | ⚠️ | ⚠️ | ❌ Windows 透明+穿透冲突（#5812），Phase 2 直接踩雷 |

---

## 4. 骨架验证（spikes/，本机实跑）

> 目标：不做 PPT 选型。三个最小工程各验证 **① 透明无边框窗口 ② 置顶 + 点击穿透 ③ 从 Unix socket 读 JSONL 驱动可见状态变化**。
> 复现入口：[spikes/README.md](../spikes/README.md)。所有工程都复用同一个"假适配器" [spikes/jsonl-feed/feed.mjs](../spikes/jsonl-feed/feed.mjs)（按契约 §2/§3 生成事件）。

### 4.1 Swift + AppKit（`spikes/swift-appkit-pet/`）

```bash
cd spikes/swift-appkit-pet && swiftc -O -o bin/swift-pet Sources/main.swift   # 实测 ~1.0 s
./run-spike.sh demo
```

关键输出（节选，完整日志见 `spikes/swift-appkit-pet/artifacts/app-stdout.log`）：

```text
WINDOW_CHECK tag=boot styleMask=0 isOpaque=false bgAlpha=0.0 level=3 ignoresMouseEvents=true hasShadow=false isVisible=true alpha=1.0 hitTest=PetView t_ms=...
CGWINDOW_CHECK tag=boot windowNumber=2873 ...            ← boot 瞬间窗口还没进 WindowServer 列表（not-found）
CLICK_THROUGH_TOGGLE ignoresMouseEvents=false t_ms=4256
WINDOW_CHECK tag=click-through-off ... ignoresMouseEvents=false ... hitTest=PetView
CGWINDOW_CHECK tag=click-through-off windowNumber=2873 layer=3 alpha=1.0 onscreen=true bounds=(x:735 y:423 w:240 h:240)
SNAPSHOT file=artifacts/state-01-thinking.png state=thinking corner_alpha=0.0 pet_alpha=0.0
...（7 张快照，SHA-256 各不相同）
SUMMARY applied=7 unknownEvents=0 states=thinking>thinking>working>working>working>waiting>idle
```

结论：
- **透明**：`isOpaque=false`、`backgroundColor.alpha=0.0`，且**进程内快照的角像素 alpha=0.0**（像素级证据，不依赖屏幕录制权限）。
- **置顶**：`window.level=3(.floating)`，并由**独立进程**（`spikes/tools/bin/wininfo`，CGWindowList）交叉核对 `layer=3 alpha=1.0 onscreen=true`。
- **点击穿透**：`ignoresMouseEvents` 两态可切并可回读。
  ⚠️ **实测发现**：`NSView.hitTest` 在穿透 ON/OFF 两态**都返回 PetView**，因此 hitTest 不能作为穿透的判定依据；端到端"点击真的穿过去"需要注入合成点击（需辅助功能权限），本次**未验证**，手工验证步骤见 §7。
- **JSONL 驱动**：11 条契约事件 → 7 次状态应用，每态落一张 PNG，SHA-256 互不相同（`state-01` 与 `state-02` 同为 thinking 故哈希相同，符合预期）。
- **契约 §7.3 未知事件风暴**：`./run-spike.sh unknown-storm` 注入 1000 条 `future.event.v2.*` → `SUMMARY applied=0 unknownEvents=1000`，无崩溃、无异常（计数只在 type 不在契约 16 个 type 字面量内时递增）。

### 4.2 Tauri v2（`spikes/tauri-pet/`）

```bash
cd spikes/tauri-pet
pnpm install && pnpm tauri build      # 首次全量编译 ~47 s（含 ~400 crate）；改代码后增量 ~38 s
./run-spike.sh
```

关键输出（节选）：

```text
binary=3.9MB ./src-tauri/target/release/tauri-pet      # .app 4.0M
spawn->READY 墙钟 ms: 475                              # 应用内部 t_ms=123
WINDOW_CONFIG size=Ok(PhysicalSize { width: 480, height: 482 }) t_ms=123
CLICK_THROUGH_SET on=true t_ms=123
READY .../agent-pet/tauri-spike.sock t_ms=123
FRONTEND_READY / WINDOW_DIAG {"visible":true,"pos":"1470,846","size":"480x482","scale":2}
CLICK_THROUGH on=false diag=... t_ms=4308              # 运行时切穿透 OFF
CLICK_THROUGH on=true  diag=... t_ms=8307              # 再切回 ON（宠物常驻态）
SOCKET_EVENT type=session.start → DOM_APPLIED state=thinking ...
...（6 次 DOM 状态应用，含 working/waiting/idle）
```
以及独立工具：`wininfo tauri-pet` → `layer=5 alpha=1.0 onscreen=true bounds=(x:735 y:423 w:240 h:241)`。

结论：
- 配置层：`transparent:true / decorations:false / alwaysOnTop:true / shadow:false / macOSPrivateApi:true`，其中 `macOSPrivateApi` 在本地依赖源码中确认会打开 cargo feature `macos-private-api`（`tauri-utils-2.10.1/src/config.rs:3529`），透明由 `tauri-runtime-wry-2.12.1/src/lib.rs:1038/4740` 的 `with_transparent` 生效。
- **通道链路完整跑通**：Unix socket → Rust 线程逐行解析 → `app.emit("pet-event")` → WebView JS 状态机 → DOM 变化 → `invoke("report_state")` 回写日志。**这正是建议的正式架构**（Rust 持权威状态机，WebView 只渲染）。
- **置顶实测 layer=5**（Swift/Electron 为 3），三者都 >0（普通窗口层），均满足"置顶"；层号差异不影响结论，但说明各家实现细节不同（**具体语义未在官方文档核验**）。
- 透明窗口的**像素级**证据缺失：`screencapture -l <windowNumber>` 返回 `could not create image from window`（缺"屏幕录制"权限），故本条标 **未验证**（配置 + API 层面已验证）。

### 4.3 Electron（`spikes/electron-pet/`）

```bash
cd spikes/electron-pet
pnpm add -D electron        # 实测 41.6 s（含 ~288MB 运行时下载）
./run-spike.sh              # 脚本内部已 env -u ELECTRON_RUN_AS_NODE
```

关键输出（节选）：

```text
注意：检测到 ELECTRON_RUN_AS_NODE=1，已为本次运行清除
WINDOW_CREATED t_ms=102 / READY socket=.../electron-spike.sock t_ms=102 / FRONTEND_READY t_ms=160 / WINDOW_SHOWN t_ms=163
WINDOW_DIAG {"isVisible":true,"isAlwaysOnTop":true,"bounds":{...240x240},"windowNumber":873792}
CLICK_THROUGH_TOGGLE ignoreMouseEvents=false t_ms=4104
DOM_APPLIED state=thinking type=session.start dom=🤔 ...
...（7 次 DOM 状态应用）
```
独立工具：`wininfo Electron` → `layer=3 alpha=1.0 onscreen=true`；内存 4 进程 RSS 375.3 MB / footprint 89.2 MB。

结论：窗口 4 项能力全部通过且 API 最顺；**唯一实质性问题是分发体积（288 MB）与内存（footprint 89 MB / RSS 375 MB）**。踩坑记录：pnpm 下 `node_modules/.bin/electron` 是 JS shim，且本机继承 `ELECTRON_RUN_AS_NODE=1`，必须直接用 `Electron.app/Contents/MacOS/Electron` 并清除该环境变量，否则 `main.js` 会被当普通 Node 脚本执行（`ipcMain` undefined）。

### 4.4 三个 spike 的横向对照（同一份 JSONL、同一套判定）

| 项 | Swift+AppKit | Tauri v2 | Electron 44 |
|---|---|---|---|
| 透明（配置/属性） | ✅ `isOpaque=false`、bgAlpha=0.0、**像素 alpha=0.0** | ✅ `transparent:true`+`macOSPrivateApi`（像素级未验证） | ✅ `transparent:true`（像素级未验证） |
| 置顶（独立工具核对） | ✅ layer=3 | ✅ layer=5 | ✅ layer=3 |
| 点击穿透（API 回读） | ✅ `ignoresMouseEvents` true/false | ✅ `set_ignore_cursor_events` true/false | ✅ `setIgnoreMouseEvents` true/false |
| socket JSONL → 可见状态 | ✅ 7/11 事件（其余为无状态映射或心跳） | ✅ 6/11 | ✅ 7/11 |
| 未知事件 1000 条 | ✅ unknownEvents=1000，无崩溃 | 未跑（同一解析路径，风险低） | 未跑 |
| 空闲 footprint | 13.0 MB | 57.1 MB | 89.2 MB |
| 产物体积 | 122 KB | 4.0 MB | 288 MB |

---

## 5. 主选 / 备选 / 淘汰（决策表）

### 5.1 决策

| 角色 | 选择 | 触发条件 / 适用期 |
|---|---|---|
| **主选** | **Tauri v2（Rust 壳 + WebView 渲染 + TS 前端）** | 默认路线，Phase 1 与 Phase 2 共用 |
| 备选 A | **纯 Swift + AppKit 壳**（+ 内嵌 WKWebView 只做动画舞台） | 若"体积/内存/原生手感"成为第一优先级，或 Rust 人力始终补不上；代价是 Windows 归零 |
| 备选 B | **Electron**（复用 DSH 生态） | 若 8 周工期告急且愿意接受 288 MB 分发体积；或 Phase 1 需要与 DSH 深度耦合（共用 Electron 插件/窗口） |

### 5.2 主选 Tauri v2 的理由（全部绑定本机实测）

1. **分发体积压倒性优势**：4.0 MB vs Electron 288 MB（72×）。桌宠是"顺手装一个"的产品，这一条直接决定获客成本。
2. **内存达标**：footprint 57.1 MB，是 Electron（89.2 MB）的 64%，且远低于 150 MB 门槛（RSS 口径 185 MB vs 375 MB 同样占优）。
3. **D1 四项能力都有官方一等公民 API**（本地依赖源码可核验）：`transparent`/`decorations`/`always_on_top`/`shadow` 配置 + `set_ignore_cursor_events`，无需社区插件。
4. **D5 白送**：渲染层就是 WebView，Live2D/Spine/Rive/Lottie 的 Web 运行时全部可用；Phase 2 皮肤市场直接复用 Web 资产管线。
5. **D8 半契合但边界干净**：前端 TS（与 DSH 同语言/同前端工具链），Rust 只负责窗口 + transport + 状态机权威，二者以 JSON 事件为界——契约 §5 的 JSONL 天然就是这个边界。
6. **D6 可接受**：本次实测"rustup 装工具链 → 脚手架 → 首个 release 构建"全流程在**一次会话内完成**，前端仍是热重载（`pnpm tauri dev`）；Rust 部分代码量小（spike 的完整 transport+窗口只有 ~200 行）。

### 5.3 淘汰理由（逐条，不留"都可以"）

| 淘汰对象 | 一句话理由（决定性的一条） |
|---|---|
| Flutter | **D5 与 D8 双输**：没有 Web 动画生态，Live2D 要自研绑定；Dart 与 TS 生态割裂，Phase 2 的皮肤资产管线要重做。桌面的透明/穿透还得靠 `window_manager`/`flutter_acrylic` 等社区插件（D1 风险外置）。 |
| Qt / QML | **D8 + 授权成本**：C++/QML 与团队技能、DSH TS 生态都不匹配；Live2D/Spine 无官方 Web 运行时；LGPL 动态链接合规或商业授权是长期负担。技术本身没问题，是"错配"。 |
| Godot 4 | **工程错配**：用游戏引擎做桌宠意味着自带整套资源/场景管线，且窗口穿透依赖社区资产（原文未验证）；D8 直接不满足。 |
| Wails v3 | **D2 直接踩雷**：Windows 上"逐像素透明 + 点击穿透"已知不能同时满足（[wails#5812](https://github.com/wailsapp/wails/issues/5812)，搜索摘要），且 v3 未 GA。既然后续要 Windows，就不该起这个头。 |
| Neutralino | 窗口能力弱、无透明/穿透保证、社区小（**未验证**）；相对 Tauri 没有独占优势。 |
| Electron（不淘汰，降为备选 B） | 唯一硬伤是体积/内存，其余维度（D1/D2/D5/D6/D7/D8/D9）全部优秀，因此保留为"工期或生态需要时"的备选，而不是淘汰。 |
| Swift（不淘汰，降为备选 A） | macOS 上三项全优，但 D2/D5 不达标，只能作为"只做 macOS 且要极致轻量"的路线。 |

---

## 6. 骨架仓库目录建议（含契约 §5 对接）

```text
agent-pet/
├─ apps/
│  └─ desktop/                     # 桌宠外壳（Tauri v2）
│     ├─ src-tauri/                # Rust：窗口 + 托盘 + 传输 + 权威状态机
│     │  ├─ src/main.rs
│     │  ├─ src/window.rs          # 透明/置顶/穿透/多显示器/贴边吸附
│     │  ├─ src/state.rs           # 契约 §4 状态机（唯一权威）
│     │  ├─ src/transport/
│     │  │  ├─ mod.rs              # 统一 trait: PetTransport
│     │  │  ├─ unix_socket.rs      # macOS/Linux：$TMPDIR/agent-pet/<source>.sock
│     │  │  ├─ named_pipe.rs       # Windows：\\.\pipe\agent-pet-<source>
│     │  │  ├─ ws.rs               # 可选：127.0.0.1 WebSocket（默认关）
│     │  │  └─ replay.rs           # --replay <*.pet.jsonl> 走同一条解析路径
│     │  └─ src/recorder.rs        # 录制：~/.agent-pet/records/<source>-<date>.pet.jsonl（20MB×7 天）
│     └─ src/                      # TS：仅渲染 + 交互（不含权威状态）
│        ├─ state/{machine.ts,ordering.ts}   # 乱序缓冲 2s/32 条 + 优先级打断（与 Rust 同规则）
│        ├─ stage/{live2d.ts,spine.ts,rive.ts}
│        ├─ stage/effects/{stars.ts,cloud.ts,sweat.ts}
│        └─ ui/{bubble.ts,tray.ts,notice.ts}
├─ packages/
│  ├─ contract/                    # 事件信封 + 16 个 type 的 zod schema + 契约一致性测试
│  ├─ adapter-sdk/                 # 适配器 SDK（TS 库，见 §7）
│  └─ pet-assets/                  # 皮肤清单/动作映射（Phase 2 市场用）
├─ adapters/
│  ├─ dsh/                         # Phase 1 唯一适配器（对接 dsh hooks / session 事件）
│  ├─ claude-code/                 # Phase 2
│  └─ codex/                       # Phase 2
├─ fixtures/                       # *.pet.jsonl 回放样本（契约 §7 验收用）
├─ spikes/                         # 本目录：已跑通的验证工程（保留作回归基准）
└─ docs/
```

### 与契约 §5 传输层的对接方式（推荐实现，spike 已验证解析路径）

| 契约要素 | 落点 | 说明 |
|---|---|---|
| `$TMPDIR/agent-pet/<source>.sock` | `transport/unix_socket.rs` | 桌宠**监听**，适配器**连接**（`UnixListener` 已被 spike 验证）；注意 `unlink` 旧文件前先探活，避免踩掉另一实例的 socket（见 §8 建议） |
| 行分隔 JSONL | `transport/mod.rs` | 累积缓冲 + 按 `\n` 切分；单行 ≤8 KB，超限按契约截断并标 `privacy.fields` |
| 握手 `{"ack":true,"contract":1}` | 连接建立后立即回写 | 版本不匹配 → 拒收 + UI 提示升级 |
| Windows 命名管道 | `transport/named_pipe.rs` | 契约写的是 `\\?\pipe\agent-pet-<source>`，**该前缀疑似笔误**（Windows 管道标准前缀是 `\\.\pipe\`），已列入 §8 建议 |
| 心跳 15 s / 离线判定 45 s | `state.rs` 定时器 | 45 s 无任何事件 → 强制 `idle`；10 min 无事件 → 记录 `stale` |
| 录制 / 回放 | `recorder.rs` / `replay.rs` | 回放与实时共用同一条解析路径，保证"录制即测试用例" |
| 未知事件计数 | `state.rs` | 契约 §7.3 已在 Swift spike 实测（1000/1000） |
| `unknownEvents` / 乱序缓冲 | `state.rs` + `state/ordering.ts` | 乱序窗口 2 s/32 条，两侧同规则；权威判定在 Rust |

**架构边界一句话**：*Rust = 窗口 + 传输 + 权威状态机；WebView = 渲染与交互；适配器 = 极薄的翻译层。* 这样做的理由：窗口最小化/后台节流时 WebView 可能被降频，状态权威放在 Rust 才不会丢事件（**该行为需在真机做长稳测试验证，见 §9**）。

---

## 7. 适配器 SDK 形态建议

### 7.1 两条分发路径的取舍

| 维度 | A) TS 库（npm 包 `@agent-pet/adapter-sdk`） | B) CLI（`agent-pet-bridge`） |
|---|---|---|
| 目标用户 | 自己要写适配器的开发者 / Phase 2 第三方 | 只想"挂上桌宠"的普通用户；无 Node 环境的 agent 工具 |
| 集成成本 | 需懂 TS，但可精细控制（自定义映射/脱敏） | 一条命令：`agent-pet-bridge --source claude-code --socket ...` |
| 分发 | npm/pnpm（体积小、秒级更新） | npm bin、单文件二进制（bun compile / Node SEA）、或随桌宠 App 内置 |
| 失败模式 | 用户代码崩 → 桌宠只看到"断连"（契约 §1 已兜底） | 需要把各后端"怎么读事件"也封装进去（维护成本上移） |
| 版本/ABI | semver + `peerDependencies` 约束 | 版本随 App 走，升级一致性更好 |
| 结论 | **核心形态**（所有能力都在这层实现） | **同一仓库的 `bin` 入口**，是 SDK 的薄壳而非第二套实现 |

**建议**：一个仓库两个入口（dual distribution）。`adapter-sdk` 提供：
1. `PetEmitter`：自动维护 `v/seq/ts/source/sessionId` 信封、15 s 心跳、断线重连、`ack` 握手；
2. `redact()`/`truncate()`：按契约把 `text` 截到 280 字符、8 KB 上限、写 `privacy.fields`；
3. `map*()`：各后端的原生事件 → 规范事件的纯函数映射（可单测）；
4. 契约一致性测试：断言输出覆盖 §3 全部必填字段（契约 §7.5 验收项）。
CLI 只做"读 stdin/文件/各后端日志目录 → 调 SDK"。**不要**在 CLI 里复制映射逻辑。

### 7.2 ABI / 契约版本策略

| 项 | 策略 |
|---|---|
| 传输契约 | 冻结在 `v:1`；破坏性变更 → `v:2`，桌宠在一个版本内**同时接受 v1/v2**（按行解析，不按连接） |
| 握手 | 连接后首行 → 桌宠回 `{"ack":true,"contract":1}`；不匹配则拒收并在 UI 提示升级（契约 §5） |
| SDK 版本 | semver；**主版本 = 契约主版本**（SDK 2.x 只发 `v:2`，同时提供 `emitV1()` 兼容层） |
| 能力协商 | 建议新增可选字段 `hello.capabilities`（如 `["step","approval"]`），让适配器声明"我这条链路有哪些事件类型"，桌宠据此隐藏不适用的动作（见 §8） |
| 兼容性测试 | `fixtures/` 里每个后端一份 `*.pet.jsonl`，CI 回放断言状态序列；新增适配器必须补 fixture |

---

## 8. 建议变更（对 `00-interface-contract.md`，仅建议，未改该文件）

1. **"14 类事件"与 type 字面量数量不一致**：按表格行数是 14（`step.start/step.end` 与 `user.question/user.answer` 各占一行），但按 `type` 字面量是 **16 个**。spike 的 `unknownEvents` 判定按 16 个实现。建议契约注明"14 行 = 16 个 type"。
2. **`unknownEvents` 的语义**：应明确"**不在 16 个 type 内**"才算 unknown；已知 type 但没有状态映射（如 `message.assistant`、`pet.heartbeat`）不应计入，否则契约 §7.3 的计数会被污染（spike 首版踩过这个坑）。
3. **socket 文件名冲突**：按 `<source>.sock` 命名时，同 source 起两个桌宠实例会互相 `unlink`。建议加实例后缀（`<source>-<pid>.sock`）或写 `<source>.sock` + `<source>.lock`（pid + 心跳时间戳）做单实例探测。
4. **Windows 管道前缀疑似笔误**：`\\?\pipe\agent-pet-<source>` 建议改成 `\\.\pipe\agent-pet-<source>`（`\\.\pipe\` 才是本地命名管道命名空间）。**未在 Windows 上实测**。
5. **建议增加可选的握手能力字段**（`capabilities`），理由见 §7.2；纯增量，不破坏 v1。
6. **建议明确内存验收口径**：RSS 与 phys_footprint 差 2–4 倍（实测 Tauri 185 MB vs 57 MB），契约/验收文档应指定其一（建议 `phys_footprint` 合计）。

---

## 9. 未验证项与下一步验证方法

| 未验证项 | 为什么没做 | 怎么验证 |
|---|---|---|
| **Windows 全链路**（透明/置顶/穿透/WebView2 依赖） | 本机只有 macOS | 借一台 Win11 机器：`pnpm tauri build` → 复用 `spikes/tauri-pet/run-spike.sh`（把 socket 换成命名管道 + `wininfo` 换成 Spy++/WinSpy）；重点验证 WebView2 运行时是否随系统预装、逐像素透明是否需 `noRedirectionBitmap` |
| **点击穿透的端到端验证**（真的点到底层应用） | 注入合成点击需"辅助功能"权限，且会点到用户屏幕 | 手工 30 秒：`./run-spike.sh` 期间把鼠标移到宠物上点击——穿透 ON 时点击落到下层窗口，OFF 时落在宠物上（spike 每 4 s 自动切换一次两态并打日志） |
| **透明窗口的像素级证据（Tauri/Electron）** | `screencapture -l` 报 `could not create image from window`（缺屏幕录制权限） | 系统设置 → 隐私与安全性 → 屏幕录制，授权终端后重跑 `screencapture -x -o -l <windowNumber> shot.png` + `spikes/tools/bin/pixelprobe shot.png 3 3`（应为 alpha=0.0） |
| **签名 / 公证 / 商店审核** | 需要 Apple Developer 账号（付费） | 真实打包后跑 `codesign --verify`、`xcrun notarytool submit --wait`；同时确认 `macOSPrivateApi` 是否触发 App Store 拒审（建议先走 DMG 直分发） |
| **Live2D/Spine 在 WKWebView 的渲染性能** | 需要真实模型与授权 | 用 Live2D 官方 Web 示例（CubismWebSamples）跑 5 分钟，记录 FPS/CPU/内存；注意 **SDK 授权**：商用需按 Live2D 的发布许可（[live2d.com/en/sdk/license](https://www.live2d.com/en/sdk/license/)，本机网络不可达，**未核验原文**）；Spine 需持有 Spine 编辑器授权（[esotericsoftware.com/spine-runtimes-license](https://esotericsoftware.com/spine-runtimes-license)，**未核验**）。**这一条应在 Phase 1 内闭环，否则 D5 的"白送"结论要打折。** |
| **Tauri Windows/Linux 的置顶层级语义** | 只测了 macOS | 在 Windows 上用 AHK/Spy++ 核对 `WS_EX_TOPMOST`；Linux 上核对 `_NET_WM_STATE_ABOVE`（Phase 2 再说） |
| 长时间运行（内存爬升 / 事件风暴） | spike 只跑 14 s | 写一个 24 h 常驻回归：`feed.mjs --scenario demo --gap 50` 循环 + 每小时采样 footprint，看是否有单调上升 |

---

## 10. 复现清单（复制即可跑）

```bash
# 0) 通用：编译独立核对工具
cd spikes/tools && swiftc -O -o bin/wininfo Sources/wininfo.swift && swiftc -O -o bin/pixelprobe Sources/pixelprobe.swift

# 1) Swift + AppKit（最快，~1 s 编译 + 14 s 运行）
cd ../swift-appkit-pet && swiftc -O -o bin/swift-pet Sources/main.swift && ./run-spike.sh demo
./run-spike.sh unknown-storm        # 契约 §7.3：1000 条未知事件

# 2) Tauri v2（首次构建 ~47 s）
cd ../tauri-pet && pnpm install && pnpm tauri build && ./run-spike.sh

# 3) Electron（首次下载 ~42 s / 288 MB）
cd ../electron-pet && pnpm add -D electron && ./run-spike.sh

# 4) 只跑假适配器（对着任意已监听的 socket）
node ../jsonl-feed/feed.mjs --socket "$TMPDIR/agent-pet/tauri-spike.sock" --scenario demo --gap 700
```

耗时记录（实测）：`pnpm create tauri-app` 3.2 s；Rust 工具链 rustup minimal 一次装好；`pnpm tauri build` 首次（含 ~400 crate 编译）**47 s**、增量 **38 s**；`pnpm add -D electron` **41.6 s**（含 288 MB 运行时）；`swiftc -O` **~1.0 s**。**结论：8 周 demo 的"环境搭建"不是风险项。**

---

## 11. 来源

**本机实测（2026-10-05，macOS 27.0.1 arm64）**
- `spikes/swift-appkit-pet/`（源码 + `artifacts/app-stdout.log` + 状态快照 PNG）
- `spikes/tauri-pet/`（`src-tauri/src/lib.rs`、`artifacts/app-stdout.log`）
- `spikes/electron-pet/`（`main.js`、`artifacts/app-stdout.log`）
- `spikes/tools/`（`wininfo` CGWindowList 交叉核对、`tree-rss.mjs`、`footprint-sum.sh`、`pixelprobe`）

**本地依赖源码（可 `grep` 复核，比网页更硬）**
- `~/.cargo/registry/src/*/tauri-2.12.1/src/webview/webview_window.rs:2260`（`set_ignore_cursor_events`）
- `~/.cargo/registry/src/*/tauri-utils-2.10.1/src/config.rs:2063/2072/2078/2144/3374/3529`（`transparent`/`decorations`/`always_on_top`/`shadow`/`macOSPrivateApi`）
- `~/.cargo/registry/src/*/tauri-runtime-wry-2.12.1/src/lib.rs:1038,4740`（`with_transparent`）
- `spikes/electron-pet/node_modules/electron/electron.d.ts:3197/3392/4080`（`setAlwaysOnTop`/`setIgnoreMouseEvents`/`transparent`）

**外部来源（访问日期 2026-10-05）**
- Electron 官方文档 <https://www.electronjs.org/docs/latest/api/browser-window>（`transparent` 选项，已抓取）
- Electron 自定义窗口交互 <https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions>（已抓取）
- Flutter `window_manager`（0.5.2，支持 macOS/Windows/Linux）<https://pub.dev/packages/window_manager>（已抓取）
- Flutter `flutter_acrylic` 的 `acknowledgeMouseEvents` <https://pub.dev/documentation/flutter_acrylic/latest/window/Window/acknowledgeMouseEvents.html>（未抓取）
- Wails v3 Windows 透明+穿透冲突 <https://github.com/wailsapp/wails/issues/5812>（搜索摘要，原文未打开）
- Godot `DisplayServer` <https://docs.godotengine.org/en/stable/classes/class_displayserver.html>（已抓取，关键词未命中）
- Godot 社区穿透资产 <https://store.godotengine.org/asset/jakub-hubacek/windows-mouse-passthrough/>（未核验）
- Qt `Qt::WindowType` <https://doc.qt.io/qt-6/qt.html>（本机网络不可达，未核验）
- Live2D SDK 授权 <https://www.live2d.com/en/sdk/license/>、发布许可说明 <https://help.live2d.com/zh-CHS/sdk/>（本机网络不可达，未核验）
- Spine 运行时授权 <https://esotericsoftware.com/spine-runtimes-license>（本机网络不可达，未核验）

> 网络说明：本机可访问 electronjs.org / docs.godotengine.org / pub.dev / github.com（较慢），**不可访问** tauri.app、doc.qt.io、live2d.com、esotericsoftware.com、raw.githubusercontent.com、registry.npmjs.org。因此 Tauri 的 API 事实全部改用**本地 crate 源码**作为证据（版本 2.12.1，比文档更具体）。
