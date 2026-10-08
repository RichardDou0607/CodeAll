# apps/shell — CodeAll 桌面外壳（Tauri v2 · M1）

把原先只在浏览器里跑的悬浮窗（demo/window.html + demo/framed.mjs）搬进**真正的 macOS 桌面窗口**：
透明、无边框圆角、置顶、可拖拽、位置记忆；本地服务没起时显示「启动中」并自动拉起。

实测数据与复现命令见 [docs/53-tauri-shell.md](../../docs/53-tauri-shell.md)。

## 一键运行

    apps/shell/run.sh                # 需要时自动构建，然后以 7799 端口启动
    apps/shell/run.sh --port 7801    # 换端口（服务未监听时由外壳自动拉起 demo/framed.mjs）
    apps/shell/run.sh --build        # 强制重新构建 .app
    apps/shell/run.sh --no-build     # 直接用已有产物
    apps/shell/run.sh --dev          # tauri dev 模式
    apps/shell/run.sh --install      # 构建并安装到 /Applications：以后启动台/Spotlight 搜「CodeAll」一键打开

前置：Node.js、pnpm、Rust 工具链（run.sh 会自动把 ~/.cargo/bin 加进 PATH）。

## 结构

    apps/shell/
    ├── run.sh                     一键运行脚本
    ├── webui/index.html           启动占位页（「启动中」+ 拉起服务 + 就绪后导航）
    ├── src-tauri/
    │   ├── tauri.conf.json        窗口参数：transparent/decorations:false/alwaysOnTop/shadow:false/360×340
    │   ├── capabilities/default.json
    │   └── src/lib.rs             服务守护、位置记忆、原生拖拽、版式注入、诊断命令
    └── tools/
        ├── measure.sh             一次性采集 M1 验收数据
        └── dragtest.swift         合成鼠标拖拽（独立验证「可拖拽」）

## 置顶行为（2026-10-05 起）

- 窗口**默认不置顶**：作为普通窗口可被其他应用覆盖，不挡工作。
- 标题栏 **📌 按钮**随时切换置顶（悬浮模式）：点亮=置顶，半透明=普通窗口；偏好记在页面 localStorage，下次启动自动恢复。
- 「新建会话」注入逻辑只在能力位 `canCreate=false` 时接管按钮；插件连通后完全交给页面本身（避免一次点击触发两次创建、多出一个落进默认项目的会话）。

## 设计要点

1. **承载方式选 (a)：直接加载 http://127.0.0.1:<port>/**。
   与已跑通的 SSE/HTTP 完全兼容，不改 demo/ 一行代码。
2. **服务守护**：外壳启动时探测端口；未监听则用 node 拉起 demo/framed.mjs（子进程随外壳退出）。
3. **「启动中」占位页**：webui/index.html 通过 Tauri IPC 驱动外壳探测服务；
   探活由 **Rust 侧**发起（WebView 页面源是 tauri://localhost，对 http://127.0.0.1 的
   fetch 属跨源请求会被 CORS 拦掉），就绪后 location.replace 到本地服务。
4. **版式注入**：demo/window.html 是「浏览器演示版式」（模拟桌面 + 说明栏，560×620 固定卡片）。
   导航提交后由外壳 eval 注入一段 CSS，把它整理成贴合悬浮窗的版式（铺满窗口、圆角、隐藏演示元素）。
   **只注入，不修改 demo/ 下任何文件。**
5. **拖拽**：远程源不注入 Tauri IPC，data-tauri-drag-region 不可用；
   改为 macOS 原生 NSWindow.isMovableByWindowBackground = true（objc2-app-kit）。
6. **位置记忆**：~/Library/Application Support/com.agentpet.shell/window.json
   （物理像素；Moved/Resized 标脏 → 400ms 节流落盘；失焦/关闭/退出强制落盘；恢复时做离屏保护）。

## 外壳暴露的 IPC 命令（供 webui/index.html 调用）

| 命令 | 作用 |
| --- | --- |
| shell_status | 版本 / 端口 / 仓库根 / node 路径 / 日志与 window.json 路径 |
| shell_ensure_server | 探测端口；未监听则拉起 demo/framed.mjs 并等待就绪 |
| shell_http_probe | 由 Rust 侧发一次最小 HTTP GET（绕开 WebView 跨源限制） |
| shell_report / shell_navigating | 启动里程碑上报（落进外壳日志） |
| shell_window_diag | 窗口位置/尺寸/置顶/是否无边框/可拖拽 等回读 |
| shell_start_drag | 调 startDragging（本地页面的拖拽手柄用） |
| shell_move_to | 把窗口移到指定逻辑坐标（复位位置 / 自检） |
| shell_set_always_on_top | 运行时切换置顶 |
| shell_save_position | 立即落盘窗口位置 |
| shell_inject_remote_css | 手动重放版式注入 |
| shell_open_log | 在访达里定位服务日志 |
| shell_quit | 收尾（保存位置 + 关掉自己拉起的服务）并退出 |

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| AGENT_PET_ROOT | 自动推断 | 仓库根（需含 demo/framed.mjs） |
| AGENT_PET_PORT | 7799 | 本地服务端口 |
| AGENT_PET_NODE | 自动探测 | node 可执行文件 |
