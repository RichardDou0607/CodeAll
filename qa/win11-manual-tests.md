# CodeAll Windows 实机测试清单(2026-10-27,配合 v0.1.4 NSIS 包)

> 适用机器:LAPTOP-4IUHJJDD(Win11 家庭中文版 x64)· 已装 `C:\Users\admin\AppData\Local\CodeAll\`
> 交付物:`D:\CodeAll\CodeAll_0.1.4_x64-setup.exe` + `D:\CodeAll\source\`
> 环境:/api 状态检查全部通过(桌面已解锁 · WebView2 155.0.4283.62 · 端口 7799 空闲 · 电源 100%)
> 远端配合:异常时截图发回;日志在 `C:\Users\admin\AppData\Local\com.agentpet.shell\logs\framed-server.log`(壳拉起的服务)与 `%TEMP%\agent-pet\`

## 一、壳启动(必测 · 2 分钟)

1. 双击**开始菜单 → CodeAll**(或 `C:\Users\admin\AppData\Local\CodeAll\agent-pet-shell.exe`)。
2. 预期:
   - 迷你条窗口出现(深色圆角卡片,无系统标题栏);
   - 几秒内任务管理器出现一个 `node.exe`(路径含 `AppData\Local\CodeAll\app\bin\node.exe`)= **包内服务自起**(W02 核心证据);
   - 托盘出现 CodeAll 图标。
3. 记录:窗口出现耗时、node.exe 是否出现、托盘是否有图标。
4. 备选验证(不开 GUI):PowerShell 跑
   `Invoke-WebRequest -UseBasicParsing http://127.0.0.1:7799/api/state`→ 200 即服务在。

## 二、W05 窗口行为(必测 · 5 分钟,docs/24 降级阶梯判定)

| # | 项 | 操作 | 预期(通过) | 若不符 |
|---|---|---|---|---|
| 1 | 透明 | 看迷你条四角 | 圆角外**透出桌面**(真透明) | 白/黑底 = 透明失败,记「降级」 |
| 2 | 置顶 | 点标题栏 📌;把其它窗口盖上来 | 📌 后迷你条浮在所有窗口上 | 记录现象 |
| 3 | 拖拽 | 按住迷你条标题栏空白处拖动 | 窗口跟手移动;松手后位置落盘 | 记录是否拖不动 |
| 4 | 位置记忆 | 拖到别处 → 退出(托盘退出)→ 重开 | 窗口回到上次位置 | — |
| 5 | 点击穿透 | (置顶时)点迷你条以外被覆盖区域 | 正常点到下层窗口 | 穿透从未实现属预期——只记录遮挡感 |
| 6 | 放大 | 点 ⤢ | 360×340 ⇄ 720×680 切换 | — |
| 7 | 双窗口 | 点 ⤢ 旁的展开/App 入口 | App 窗口(带系统标题栏)与迷你条**同时**存在 | — |
| 8 | 托盘 | 托盘右键 | 菜单:显示悬浮窗/显示 App/隐藏/打开服务日志/退出,各项可用 | — |
| 9 | 关窗行为 | 点 App 窗口 ✕ | 窗口隐藏、进程不退(迷你条仍在);托盘退出才真正退出 | — |
| 10 | 全屏并存 | 任意窗口进全屏 | 迷你条仍在桌面上可点 | Windows 无 Space 概念,如实记录即可 |

> 判定纪律(docs/24):透明/置顶/穿透若实测不行,产品走「不透明迷你条」降级并在 README 声明——**把实测现象原样记录**,不要自行下结论。

## 三、App 界面视觉(必测 · 3 分钟)

打开 App 窗口检查:字体渲染(中文无豆腐块)、会话列表/订阅页/图标(各家 logo)显示正常、暗色主题一致。有布局错乱拍照。

## 四、终端交互链(建议测 · 3 分钟)

前提:本机 claude CLI 已装(已确认)。
1. 在 App 界面找一个 claude 会话 → 点「打开」。
2. 预期:弹出 **Windows Terminal 新标签**,自动 `cd` 到会话目录并 `claude --resume <id>` 进入交互 TUI。
3. 记录:窗口是否弹出、TUI 是否正常渲染、会话是否真的续上(历史消息可见)。

## 五、真实投递(已验 ✅ 可跳过)

claude V01/V02/V04/V05 已在本机专用测试目录全过(2026-10-27,暗号连续/双会话隔离/失败如实报错)。
已知**不用测**:codex(该机直连 OpenAI 不可达)、kimi(账号 429 suspended)、qoder/cursor(未装)。

## 六、可选深挖(有 second account 时)

- 跨用户命名管道连接:建第二本地账号 → 从其会话 `dir \\.\pipe\agent-pet-dsh-plugin` + 写连接尝试,验证「只读可连、写被拒」(SDDL 已确认,此项为补充实证)。
- DSH 插件挂载:在 DSH 设置里安装 dsh-pet 插件 → 迷你条应显示「DSH 已连接(插件)」,事件流/直投可用(命名管道 `\\.\pipe\agent-pet-dsh-plugin`)。

## 七、异常取数

- 壳/服务日志:`C:\Users\admin\AppData\Local\com.agentpet.shell\logs\framed-server.log`
- 插件调试日志:`%TEMP%\agent-pet\plugin-debug.log`(插件挂载后)
- 四态/观察自检:在 `D:\CodeAll\source` 下跑 `node scripts\platform-check.mjs` 与 `node adapters\local-agents.mjs`
- 截图 + 现象文字发回,远端可 ssh 配合查。

## 已知边界(非缺陷,不必报)

- ssh/远程会话里双击无效(WebView2 须交互桌面)——本清单即为此而写。
- 迷你条若透明失败:按降级阶梯记录,不算安装包失败。
- ZCode npm shim 的 junction 在本机已损坏(桌面 App 才是真身);CLI 投递走 app-server 管道,不受影响。
