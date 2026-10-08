# 53 · Tauri 桌面悬浮窗外壳（M1）实测

> 目标：把只在浏览器里跑的悬浮窗（demo/window.html + demo/framed.mjs）搬进**真正的 macOS 桌面窗口**。
> 产物：apps/shell/（Tauri v2 工程）+ 本文。
> 所有数字都在本机实测，命令可直接复制；跑完的原始输出见 apps/shell/artifacts/measure-final.txt。

## 0. 结论速览

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 透明 + 无边框圆角 | ✅ 圆角外 alpha=0.000，卡片 alpha=1.000 | 窗口单独截图 + pixelprobe 四角/中心 |
| 置顶 | ✅ layer=5（普通窗口 layer=0）onscreen=true | spikes/tools/bin/wininfo（CGWindowList，非应用自述） |
| 可拖拽 | ⚠️ 机制已生效、真实位移**未验证** | 原生 API 回读双证据；合成鼠标事件被系统丢弃（无辅助功能权限） |
| 位置记忆 | ✅ 两次往返 POSITION_MEMORY_OK | window.json + 重启 + wininfo 交叉核对 |
| 服务未启动 → 「启动中」+ 自动拉起 | ✅ SERVER_SPAWN→SERVER_UP_LAUNCHED 345ms | 外壳日志 + lsof |
| 加载 http://127.0.0.1:7799/ | ✅ 远程页提交 389ms，SSE 连接建立 | lsof ESTABLISHED |
| run.sh 一键跑 | ✅ | 实测命令见 §6 |

环境：macOS 27.0.1 (26A434) · arm64 (Apple M5) · node v24.18.0 · pnpm 12.9.1 · cargo/rustc 1.99.0

## 1. 一键运行与复现

    apps/shell/run.sh                # 需要时自动构建，然后以 7799 端口启动
    apps/shell/run.sh --port 7801    # 换端口；服务未监听时由外壳自动拉起 demo/framed.mjs
    apps/shell/run.sh --build        # 强制重新构建 .app
    apps/shell/run.sh --no-build     # 直接用已有产物
    apps/shell/run.sh --dev          # tauri dev 模式

采集全部验收数据（约 40s，跑完自动清理它自己拉起的服务）：

    apps/shell/tools/measure.sh                    # 默认 7799
    PET_PORT=7801 apps/shell/tools/measure.sh      # 换端口

位置记忆往返（独立脚本）：

    apps/shell/tools/window-memory.sh 7802

首次从零构建（本次实测 1m10s；之后改一行 Rust 重新构建约 37s）：

    cd apps/shell && pnpm install && PATH="$HOME/.cargo/bin:$PATH" pnpm tauri build

> 注意：本机 cargo/rustc 不在默认 PATH 里（装在 ~/.cargo/bin）。run.sh 会自动补上。

## 2. 实测数字

### 2.1 .app 体积

    $ du -sh apps/shell/src-tauri/target/release/bundle/macos/AgentPet.app
    3.9M
    $ du -sk .../AgentPet.app | awk '{printf "%.2f MiB\n", $1/1024}'
    3.95 MiB
    $ ls -l .../AgentPet.app/Contents/MacOS/agent-pet-shell
    3.84 MiB   ← 主可执行文件，占整个 bundle 的 97%

release profile：codegen-units=1 · lto=true · opt-level=3 · panic=abort · strip=true。

### 2.2 启动耗时（墙钟 exec → 里程碑；外壳内部 t_ms 从进程起算）

冷启动 + 端口空闲（外壳要自己拉起 demo/framed.mjs，最坏路径）：

| 里程碑 | 墙钟 | 外壳内部 t_ms |
| --- | --- | --- |
| 窗口可见 WINDOW_SHOWN | 561 ms | 125 |
| 本地服务就绪 SERVER_UP_LAUNCHED | 765 ms | 345 |
| 导航指令 SHELL_NAVIGATE | 798 ms | 349 |
| 远程页提交 REMOTE_COMMITTED | 823 ms | 389 |
| 版式注入完成 REMOTE_STYLED | — | 695 |

热启动 + 端口已有服务（复用外部服务）：

| 里程碑 | 墙钟 | 外壳内部 t_ms |
| --- | --- | --- |
| 窗口可见 | 202 ms | 111 |
| 远程页提交 | 478 ms | 258 |

即：**窗口 0.1~0.2s 可见；连上已跑通的悬浮窗界面 ≈0.4~0.8s**（视是否要冷启 node）。

### 2.3 空闲内存 phys_footprint（footprint(1)，启动后静置 ~7s）

    spikes/tools/footprint-sum.sh SHELL  <外壳 pid> <它拉起的 node pid>
    spikes/tools/footprint-sum.sh WEBKIT <本次新出现的 com.apple.WebKit.* pid>

| 进程 | phys_footprint |
| --- | --- |
| agent-pet-shell（外壳本体） | 23.0 MB |
| com.apple.WebKit.GPU | 60.0 MB |
| com.apple.WebKit.WebContent（页面） | 24.0 MB |
| com.apple.WebKit.WebContent（辅助） | 7.5 MB |
| com.apple.WebKit.Networking | 5.7 MB |
| **外壳 + WebView 合计** | **≈120 MB** |
| （另）node demo/framed.mjs | 103.0 MB |

要点：**WKWebView 的渲染/网络进程由系统 XPC 托管，不在应用进程树里**（ps 看不到父子关系）。
measure.sh 用「启动前后 WebKit 进程集合差」把它们揪出来，否则会漏掉 97 MB、把外壳说成 23 MB。
真正与「外壳」强相关的开销是 23 MB（Rust 部分）；120 MB 是「一个 WebView 应用」的固有成本。

### 2.4 窗口层级（独立工具 CGWindowList 交叉核对，非应用自述）

    $ spikes/tools/bin/wininfo AgentPet
    window=3395 pid=83680 owner=AgentPet name=Agent 悬浮窗 layer=5 alpha=1.0 onscreen=true bounds=(x:675 y:373 w:360 h:340)
    matched_windows=1

同一时刻全屏窗口的 layer 分布（对照）：

    layer=0    DeepSeek Harness / Google Chrome / Nowdex / Clash Verge   ← 普通应用窗口
    layer=5    AgentPet                                                  ← 本窗口（浮动层）
    layer=20   程序坞      layer=24 Window Server

### 2.5 透明（无边框圆角）

窗口单独截图（保留 alpha），四角 / 中心像素：

    $ WINID=$(spikes/tools/bin/wininfo AgentPet | sed -n 's/^window=\([0-9]*\).*/\1/p' | head -1)
    $ screencapture -x -o -l "$WINID" artifacts/window.png
    $ spikes/tools/bin/pixelprobe artifacts/window.png 2 2
    image=720x680 hasAlpha=true
    pixel(2,2)     r=0.000 g=0.000 b=0.000 a=0.000   ← 左上角外：完全透明
    pixel(717,2)   r=0.000 g=0.000 b=0.000 a=0.000   ← 右上角外
    pixel(2,677)   r=0.000 g=0.000 b=0.000 a=0.000   ← 左下角外
    pixel(360,340) r=0.071 g=0.082 b=0.110 a=1.000   ← 卡片中心：不透明

同一区域的整屏合成截图里，该角像素 = 底层桌面内容（r=0.082 g=0.082 b=0.090 a=1.000），
即外壳没有在那里画任何东西。可视效果见 artifacts/window-on-desktop.png（窗口浮在别的窗口之上，四角透出下层文字）。

### 2.6 位置记忆

记录文件（Tauri app_config_dir）：

    ~/Library/Application Support/com.agentpet.shell/window.json
    { "x": 840, "y": 520, "w": 720, "h": 680, "updated_at": 1791178092978 }

- 单位是**物理像素**（Retina 2x：逻辑 420,260 × 360×340 ↔ 物理 840,520 × 720×680）。
- 写盘时机：Moved/Resized 标脏 → 400ms 节流落盘；失焦 / 关闭窗口 / 退出 / SIGTERM 强制落盘。
- 恢复时做离屏保护（窗口中心点必须落在某个显示器内），坏记录不会把窗口丢到屏幕外。
- 实测往返（apps/shell/tools/window-memory.sh）：

      [shell] WINDOW_RESTORE none file=.../window.json
      [shell] SELFTEST_MOVED logical=420,260
      [shell] WINDOW_SAVED reason=flush pos=840,520 size=720x680
      $ spikes/tools/bin/wininfo AgentPet
      bounds=(x:420 y:260 w:360 h:340)      ← 期望 420 260 360 340
      POSITION_MEMORY_OK

## 3. 承载方式：选 (a) 直接加载 http://127.0.0.1:<port>/

理由：与已跑通的 SSE/HTTP 完全兼容，**不改 demo/ 一行代码**。

完整启动链路：

    run.sh → AgentPet 可执行文件
      → tauri.conf.json 建窗口（360×340，transparent / decorations:false / alwaysOnTop / shadow:false）
      → setup：恢复位置 → NSWindow.isMovableByWindowBackground=true → show()
      → 窗口先加载本地占位页 webui/index.html（标题「Agent 悬浮窗 · 启动中」）
      → 占位页经 IPC 调 shell_ensure_server：探测 127.0.0.1:PORT
            · 已监听 → SERVER_ALREADY_UP（复用外部服务，不动它）
            · 未监听 → SERVER_SPAWN 用 node 拉起 demo/framed.mjs（子进程随外壳退出）
      → shell_http_probe 由 **Rust 侧**发一次最小 HTTP GET 确认真的在服务
      → location.replace('http://127.0.0.1:PORT/')
      → 外壳轮询 webview URL，提交后注入版式 CSS（见 §4）

**踩到的坑（值得记）**：占位页最初用浏览器 fetch 探活，一直被拦。
占位页源是 tauri://localhost，对 http://127.0.0.1 的 fetch 属跨源请求，而 demo/framed.mjs 不发 CORS 头
→ 响应被浏览器丢掉。所以探活必须由外壳（Rust 侧 TcpStream + 最小 HTTP GET）做。
Navigation（顶层跳转）不受 CORS 限制，实测 ATS 也不拦 127.0.0.1，跳转正常。

## 4. 与 demo/window.html 的关系：只注入，不改 demo/

demo/window.html 是**浏览器演示版式**：body 有背景渐变，.desk 是 560×620 的「模拟桌面」，右侧还有说明栏。
直接塞进 360×340 的透明窗口会显示成一张被裁掉的网页。

因此外壳在导航提交后 eval 注入一段 CSS（REMOTE_INJECT）：

- html,body 背景改透明、overflow:hidden
- .desk 铺满窗口、去掉边框/圆角/背景；隐藏右下角「模拟桌面（演示用）」标记
- .help 说明栏隐藏
- .win 铺满窗口、border-radius:14px、flex 纵向布局；.sessions 改为 flex:1 自适应滚动
- 去掉卡片自带的 box-shadow:0 26px 60px（会糊到圆角外，让「圆角外真透明」无法验证）
- 卡片背景从 rgba(18,22,31,.96) 改成不透明（浮在别的窗口上时下层文字会透出来，发糊）
- 工具栏按钮 white-space:nowrap（窄窗口下按钮会折成三行）
- -webkit-user-select:none（配合原生背景拖拽，避免拖窗口变成选文字）

demo/ 目录零改动；注入是运行时的、幂等的、可随时用 shell_inject_remote_css 手动重放。

## 5. 可拖拽：为什么用原生 API，以及哪里没验证

远程源（http://127.0.0.1:7799）不会被注入 Tauri IPC，所以 data-tauri-drag-region 在内容页上不生效。
改用 macOS 原生：

    NSWindow.isMovableByWindowBackground = true      // objc2-app-kit

两条**独立回读**证据（外壳日志 + shell_window_diag）：

    MOVABLE_BY_BACKGROUND on=true contentView_mouseDownCanMoveWindow=Some(true)

第二条尤其关键：contentView.mouseDownCanMoveWindow 正是 AppKit 在背景拖拽时查询的属性，
WKWebView 对它返回 true，说明「在网页内容上按住拖动 → 会移动窗口」。

**未验证的部分（诚实记录）**：没有做出「按住鼠标拖动 → 窗口位移 X px」的实测。
合成鼠标事件的工具已写好（apps/shell/tools/dragtest.swift，用法 dragtest AgentPet 120 60），
但本机 AXIsProcessTrusted=false，CGEvent 合成事件被系统丢弃：

    $ apps/shell/tools/dragtest AgentPet 120 60
    AXIsProcessTrusted=false
    before id=3395 bounds=(675,373,360,340)   grab=(855,388) delta=(120,60)
    after  id=3395 bounds=(675,373,360,340)
    DRAG_NO_EFFECT（合成事件被系统丢弃：需要「辅助功能」权限）

补测方法（任选）：
① 给终端授予「系统设置 → 隐私与安全性 → 辅助功能」后重跑上面这条命令，期望输出 DRAG_OK；
② 人工用鼠标拖一下窗口，然后看 window.json 的 x/y 是否随拖动变化
（已实测过：用户拖动后确实写出 WINDOW_SAVED reason=flush pos=1948,640）。

## 6. run.sh 实测输出

    $ apps/shell/run.sh --no-build --port 7803
    [run.sh] 产物   .../AgentPet.app
    [run.sh] 端口   7803（未监听时由外壳拉起 demo/framed.mjs）
    [run.sh] 仓库根 /Users/demo/Desktop/agent桌宠
    [run.sh] 启动   .../AgentPet.app/Contents/MacOS/agent-pet-shell
    [shell t_ms=   111] SETUP port=7803 ...
    [shell t_ms=   112] WINDOW_RESTORED ... onscreen=true pos=840,520 size=720x680
    [shell t_ms=   115] WINDOW_SHOWN always_on_top=true decorated=false
    [shell t_ms=   206] SERVER_SPAWN pid=82053 node=.../demo/framed.mjs --port 7803
    [shell t_ms=   329] SERVER_UP_LAUNCHED port=7803
    [shell t_ms=   384] REMOTE_COMMITTED url=http://127.0.0.1:7803/
    $ spikes/tools/bin/wininfo AgentPet
    bounds=(x:420 y:260 w:360 h:340)   layer=5 onscreen=true
    （退出后）7803 已释放

## 7. 已知限制与下一步

1. **真实拖拽位移未验证**（缺辅助功能权限）—— 见 §5 补测方法。
2. **托盘/菜单栏没做**（任务里标注为可选）：当前退出方式是窗口内「退出」按钮 / ⌘Q / SIGTERM。
   没有托盘时关掉窗口即退出进程，符合预期但没有「隐藏到菜单栏」的常驻形态。
3. **强杀不保证落盘**：SIGKILL 不会走收尾路径。但位置在每次移动后 ≤400ms 就会落盘，
   所以最坏情况只丢「最后一次移动的最后 400ms」。
4. **多显示器**：离屏保护按中心点判定（本机单显示器，逻辑分辨率 1710×1112）。
   多屏热插拔后恢复位置的行为未实测。
5. **服务端口固定 127.0.0.1**：外壳只连本机回环，不监听 0.0.0.0；换端口用 --port / AGENT_PET_PORT。
6. **构建注意**：不要并发跑两个 pnpm tauri build（本次出现过一次
   deps/*.rcgu.o 的瞬时 No such file or directory 失败，重跑即恢复）。
7. 窗口尺寸固定 360×340 起（min 360×340，可缩放）；窗口内布局靠注入 CSS 的 flex 自适应，
   没有做「内容超长时自动加高」。

## 8. 外壳暴露的 IPC 命令

供 webui/index.html 使用；远程页不注入 IPC（最小权限）。

| 命令 | 作用 |
| --- | --- |
| shell_status | 版本 / 端口 / 仓库根 / node 路径 / 日志与 window.json 路径 |
| shell_ensure_server | 探测端口；未监听则拉起 demo/framed.mjs 并等待就绪 |
| shell_http_probe | Rust 侧发一次最小 HTTP GET（绕开 WebView 跨源限制） |
| shell_report / shell_navigating | 启动里程碑上报（落进外壳日志） |
| shell_window_diag | 位置/尺寸/置顶/无边框/可拖拽 等回读 |
| shell_start_drag | 调 startDragging（本地页面的拖拽手柄用） |
| shell_move_to | 按逻辑坐标移动窗口（复位位置 / 自检） |
| shell_set_always_on_top | 运行时切换置顶 |
| shell_save_position | 立即落盘窗口位置 |
| shell_inject_remote_css | 手动重放版式注入 |
| shell_open_log | 在访达里定位服务日志 |
| shell_quit | 收尾（保存位置 + 关掉自己拉起的服务）并退出 |

## 9. 环境变量与自检钩子

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| AGENT_PET_ROOT | 自动推断 | 仓库根（需含 demo/framed.mjs） |
| AGENT_PET_PORT | 7799 | 本地服务端口 |
| AGENT_PET_NODE | 自动探测 | node 可执行文件 |
| AGENT_PET_SELFTEST | 空 | move:<逻辑x>,<逻辑y>：启动后移到该位置、落盘、优雅退出（CI / 位置记忆复现用） |

## 10. 产物清单

    apps/shell/
    ├── run.sh                        一键运行
    ├── webui/index.html              「启动中」占位页（IPC 驱动探活 + 拉起 + 导航）
    ├── src-tauri/tauri.conf.json     窗口参数
    ├── src-tauri/capabilities/default.json
    ├── src-tauri/src/lib.rs          服务守护 / 位置记忆 / 原生拖拽 / 版式注入 / 诊断命令
    ├── tools/measure.sh              验收数据采集（本文 §2 全部数字的来源）
    ├── tools/window-memory.sh        位置记忆往返复现
    ├── tools/dragtest.swift          合成鼠标拖拽（需辅助功能权限）
    └── artifacts/
        ├── measure-final.txt         本文所有数字的原始输出
        ├── window.png                窗口单独截图（含 alpha）
        └── window-on-desktop.png     浮在其它窗口之上的合成截图

## 11. 改动边界

- 新增：apps/shell/**（本任务唯一代码写入范围）
- 新增：docs/53-tauri-shell.md（本文）
- **未改**：demo/**、docs/00-interface-contract.md、docs/10-architecture.md，以及 ~/.dsh、/Applications 下任何文件
- 运行时只读取 ~/.dsh/sessions/**（由 demo/framed.mjs 负责），外壳自身只写：
  ~/Library/Application Support/com.agentpet.shell/window.json 与
  ~/Library/Logs/com.agentpet.shell/framed-server.log
---

## 12. UX 修复（B）— 2026-10-05 追加

决策背景：用户实测反馈「按钮像空的 / 没法放大 / 没法关闭 / 每次点击都像在拖窗口」。
本轮**只动外壳**（apps/shell/**），一行都没改 demo/；需要额外 DOM 的地方全部用远程页注入实现。

### 12.1 修了「每次左键按下都触发窗口拖拽」

根因在依赖里，不在我们的代码。tao 0.37.1 的 `TaoWindow` 重写了 `sendEvent:`：

    // tao-0.37.1/src/platform_impl/macos/window.rs:434
    extern "C" fn send_event(this: &Object, _sel: Sel, event: &NSEvent) {
      if event_type == NSEventType::LeftMouseDown {
        let is_movable_window: bool = msg_send![this, isMovableByWindowBackground];
        if is_movable_window { let _: () = msg_send![this, performWindowDragWithEvent: event]; }
      }
      ...super sendEvent...
    }

只要 `isMovableByWindowBackground == true`，**每一次左键按下**都会开一个窗口拖拽会话，
点按钮、点输入框都被干扰。之前为了「远程页没有 IPC 也能拖窗口」才打开的它，现在改成：

- 默认 `isMovableByWindowBackground = false`（不再劫持点击）
- 拖拽只在**标题栏**（`.titlebar`，排除 button/a/input/select/textarea）按下左键时 `startDragging()`
- 若远程页最终拿不到 IPC，外壳会在 4s 后**收回退**（回主线程调用，见下方注意）

> 注意：AppKit 的 `setMovableByWindowBackground` **只能在主线程调用**。
> 回退代码最初写在后台线程里，直接抛 `NSInternalInconsistencyException: NSWindow geometry should only be modified on the main thread!`
> 把进程打挂（实测崩过一次），现在统一走 `AppHandle::run_on_main_thread`。

### 12.2 远程页只用内置命令：Tauri 对远程源连**自定义命令**都会 ACL 拒

这是本轮最大的坑。capability 里给 `http://127.0.0.1:<port>` 开了 remote 之后，
页面仍然调不到自定义命令。Tauri 2.12.1 `src/webview/mod.rs:2075` 写得很直白：

    // Check ACL on plugin commands, when the app defined its ACL manifest,
    // or when the request comes from a non-local (remote) origin. This
    // ensures remote content can never reach custom commands unless an
    // explicit `remote` capability has been configured for them.

也就是说远程源调用 `shell_toggle_size` 这类**应用自定义命令**会被拒绝，
而 `plugin:window|*` 这类**内置命令**只要 capability 列了权限就放行。

所以最终方案：
- 放大/还原、隐藏、拖拽 全部只用 `plugin:window|*`（`set_size / inner_size / scale_factor / start_dragging / hide`）
- 「远程页 IPC 是否可用」不用自定义命令上报，改成页面往 `location.hash` 写 `#shell-ipc-ok`，
  外壳轮询 `WebviewWindow::url()` 读到即认为通了（零 ACL 依赖）

另一个实测结论：capability 的 `remote.urls` 用 **URLPattern 通配端口不生效**——
`http://127.0.0.1:*` 实测不匹配，必须逐个写明确端口
（现在列了 7799–7810；换到列表外端口会打 `REMOTE_IPC_UNAVAILABLE` 并自动退回全局拖拽）。

### 12.3 新增的界面改动（全部注入，不改 demo/）

| 改动 | 实现 | 位置 |
| --- | --- | --- |
| ⤢ 放大 / 还原 | 注入按钮 → `plugin:window|set_size`，360×340 ⇄ 720×680（读 `inner_size` 判断当前档） | 标题栏 |
| ✕ 隐藏 | Lead 已加进 demo/window.html（`#hide-win`）；本轮**确认在外壳里可用**：远程 IPC 打通后 `getCurrentWindow().hide()` 真正生效 | 标题栏 |
| 「需插件授权后可新建」 | 注入一行常显小字（工具栏下方，琥珀色底） | 工具栏下方 |
| 新建被禁用的原因 | 让 `#new-session` 不再 `disabled`（用 `MutationObserver` 对抗页面每 2s 的重渲染），点击后 `POST /api/new` 把 reason 写进底部 note | 工具栏 |
| 托盘 / 菜单栏 | `TrayIconBuilder`：显示悬浮窗 / 隐藏悬浮窗 / 打开服务日志 / 退出。有托盘时**关窗＝收进托盘**，不再退出进程 | 菜单栏 |

> 「打开设置页」按任务书要求未做替代实现：本项目目前**没有设置页**，
> 因此托盘第三项改为「打开服务日志」（在访达中定位 framed-server.log）。这是一处需要确认的取舍。

### 12.4 本轮实测（日志原文）

    [shell t_ms=   250] MOVABLE_BY_BACKGROUND on=false (改为标题栏手势) contentView_mouseDownCanMoveWindow=Some(true)
    [shell t_ms=   256] TRAY_READY
    [shell t_ms=   405] REMOTE_COMMITTED url=http://127.0.0.1:7799/
    [shell t_ms=   710] REMOTE_STYLED t_ms=710
    [shell t_ms=   754] REMOTE_IPC_OK → 拖拽走标题栏手势，全局背景拖拽保持关闭

- 体积从 3.95 MiB → **5.37 MiB**（多了 tray-icon / muda）。
- 窗口截图可见标题栏三个按钮（⤢ ↗ ✕）与「需插件授权后可新建」横条；用户把窗口拖到 498×513 后
  布局仍自适应（注入的 flex 生效）。
- 拖拽再次被真实用户操作验证：`WINDOW_SAVED reason=flush pos=2456,602 → 1032,668`。

### 12.5 仍未验证 / 未做

1. **⤢ / ✕ / 托盘菜单项没有做「模拟点击」验证**：本机没有辅助功能权限，合成鼠标事件会被系统丢弃
   （见 §5）。目前证据是「IPC 探针成功 + 元素已渲染在截图里 + 命令是内置命令且权限已列」。
   人工点一下即可确认。
2. **托盘菜单项未逐项点过**（`TRAY_READY` 只证明托盘注册成功）。
3. 输入投递到 Agent 会话仍未打通（属 B 之后的 A：DSH 插件），本轮未触碰 ~/.dsh。

### 12.6 本轮改动文件

    apps/shell/src-tauri/Cargo.toml                          tauri features 增加 tray-icon
    apps/shell/src-tauri/capabilities/remote-loopback.json   新增（回环源最小权限，逐端口列出）
    apps/shell/src-tauri/src/lib.rs                          拖拽改标题栏手势 / 托盘 / 注入脚本 / 主线程回退
    docs/53-tauri-shell.md                                   本节

---

## 13. 输入送达（最后一跳）— 2026-10-05 追加

### 13.1 结论：不是外壳的 bug，是链路缺一跳

用户的输入**确实送达了本地服务**，卡在「队列 → DSH 会话」：

    悬浮窗 → 外壳 → POST /api/input → 本地队列 ✅   →   DSH 会话 ❌（缺通道）

证据：`demo/framed.mjs:196-200` 在未配置 `PET_INPUT_CMD` 时只写队列并标记 `queued`；
`~/.agent-pet/input-queue.jsonl` 里用户的 3 条输入全是 `status=queued`；
服务启动日志自己写着「输入通道： 手动队列（未配置 PET_INPUT_CMD）」。

### 13.2 补齐这一跳需要什么

队友 D 已经把插件做好并在 /tmp 端到端验证过（见 [docs/54-dsh-plugin.md](./54-dsh-plugin.md)）：

    POST /input {"text":"…"}  →  {"ok":true,"via":"agents.followup",…}
    会话日志出现 agent/inbox/spliced + user/message（time 与 POST 完全一致）

缺的只是**把它挂到用户 desktop profile**：往
`~/.dsh/profiles/desktop/cordis.patch.yml` 末尾追加 3 行（HMR 热加载，无需重启 DSH）。
这一条属于「改 ~/.dsh 下用户现有文件」，按本轮任务禁令**需用户显式授权**，故未执行。

### 13.3 本轮新增的两个工具（仓库内，已可跑）

    apps/shell/tools/mount-dsh-plugin.sh     # 挂载；--dry-run / --status / --rollback
    apps/shell/tools/pet-input-send.mjs      # stdin → POST /input（PET_INPUT_CMD 用）

`mount-dsh-plugin.sh` 的安全设计：**只追加、不改任何现有行**；追加内容带 BEGIN/END 标记，
`--rollback` 按整块精确删除；挂载前自动备份到 `cordis.patch.yml.bak-agentpet-<时间戳>`；
挂载后 20s 内轮询 `/health` 自检，**失败自动回滚**。

### 13.4 挂载后的完整启用步骤

    # 1) 挂载（需要用户授权；自动备份 + 自检 + 失败回滚）
    apps/shell/tools/mount-dsh-plugin.sh

    # 2) 重启悬浮窗外壳；run.sh 检测到插件 socket 会自动带上投递通道
    apps/shell/run.sh --no-build --restart-server

    # 3) 在悬浮窗里发一条消息：队列状态应从 queued 变成 delivered

`run.sh` 本轮补了两件事：探测 `$TMPDIR/agent-pet/dsh-plugin.sock` 存在就自动设置
`PET_INPUT_CMD=node apps/shell/tools/pet-input-send.mjs`；`--restart-server` 先停掉端口上
旧的 `demo/framed.mjs`，让外壳用新环境变量重新拉起（否则会复用没有投递通道的旧服务）。

回滚：`apps/shell/tools/mount-dsh-plugin.sh --rollback`（插件不写任何持久状态）。


## 14. macOS 原生全屏不再「带走」悬浮窗 — 2026-10-08 追加

### 14.1 现象与根因

用户反馈：把 App 界面（label=app，原生标题栏窗口）用绿色按钮进原生全屏后，
悬浮迷你条（label=main）被一起带进全屏 Space——桌面上再也找不到它。

根因是 macOS 的默认窗口集合行为：**同 App 任一窗口进入原生全屏时，其余
默认集合行为的窗口会被收进全屏 Space**（NSWindowCollectionBehavior 没有
FullScreenAuxiliary 位的窗口不允许与全屏窗口并存）。tao/Tauri 配置里没有暴露
集合行为（`visibleOnAllWorkspaces` 只覆盖 CanJoinAllSpaces 一个位），需要原生补位。

### 14.2 修复

`lib.rs` 新增 `set_floating_space_behavior()`（与既有 `set_movable_by_background`
同一套 objc2-app-kit 直调模式），对 main 窗口 OR 入两个位：

- `CanJoinAllSpaces` —— 常驻所有 Space（各个桌面 + 全屏 Space），桌面永远能看到；
- `FullScreenAuxiliary` —— 允许与全屏窗口并存，不再被全屏带走。

在 setup() 里 `win.show()` 之前调用一次即可长期生效：tao 的
`set_visible_on_all_workspaces` 对集合行为是读改写且只切 CanJoinAllSpaces 位，
`set_always_on_top` 只动 window level，都不会冲掉 FullScreenAuxiliary。

读回证据进日志与 `shell_window_diag`（新增 `spaceBehaviorCanJoinAllSpaces` /
`spaceBehaviorFullScreenAuxiliary` 字段）：

    [shell t_ms=  1745] FLOATING_SPACE_BEHAVIOR ok=true (canJoinAllSpaces+fullScreenAuxiliary)

行为语义：📌 未置顶时悬浮窗仍是普通层级（全屏窗口盖住它，但切回桌面它一直都在）；
📌 置顶时悬浮窗浮在全屏 App 之上——桌宠语义。改动文件：`apps/shell/src-tauri/src/lib.rs`。
