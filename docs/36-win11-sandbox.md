# 36 · Win11 远端沙箱（v0.2.0 验证机）

> 2026-10-27 建成接入。docs/24 PLAT-0 要求的「Win11 x64 可远程操作验证机」由这台**远端实体机**承担；
> 本地 Fusion 装 Win11 虚拟机的备选路线已暂停（Fusion「Get Windows 11」向导选中文语言源时
> ESD→ISO 转换必失败——`Error while extracting tar file`，实测两次；必须选 English en-us 才行，
> 若将来恢复该路线须改用英文源）。

## 1. 机器与连接

| 项 | 值 |
|---|---|
| 机器 | 笔记本 LAPTOP-4IUHJJDD（联想 83DF） |
| 系统 | Windows 11 家庭中文版 x64，build 26300 |
| 硬件 | i9-14900HX 24 核 · 31.7GB 内存 · C 盘 80GB+ 空闲 |
| 组网 | Tailscale（账号 RichardDou0607@）：Mac `richardmacbook-air` ⇄ 笔记本 `laptop-4iuhjjdd`，同机构网直连约 8ms，SSH 全链路 <1s |
| 连接 | `ssh win11`（~/.ssh/config 别名：HostName laptop-4iuhjjdd，User admin，id_ed25519 免密） |
| 图形保底 | UU远程（网易）——需要人看屏幕时用，日常自动化走 SSH |

## 2. 环境脚本（scripts/win11-sandbox/）

| 脚本 | 用途 |
|---|---|
| `check.mjs` | 体检：连接/系统/工具链/Agent CLI 矩阵；node+tar 缺失才计失败 |
| `sync.sh` | 源码同步到 `C:\Users\admin\codeall`（tar over ssh，排除构建产物后约 3MB；覆盖式不删对端多余文件） |
| `exec.sh` | 工作区内执行命令；`--ps` 走 PowerShell（中文不乱码） |
| `service.sh` | 沙箱上 `demo/framed.mjs` 的 start/status/stop/log（WMI 分离进程，断开 ssh 不死） |

环境变量：`WIN11_HOST`（默认 win11）、`WIN11_DEST`（默认 `C:\Users\admin\codeall`）、`WIN11_PORT`（默认 7799）。

## 3. 已验证能力（2026-10-27 实测）

- `check.mjs` 全绿：node v24.17.0 / npm / git 2.45 / bsdtar 3.8.9（System32 自带）/ curl.exe / VS Code。
- `sync.sh`：3.3MB · 924 文件，含 apps/shell 的 Tauri 源码（target/resources/artifacts 除外）。
- `node scripts/check-fixtures.mjs` 在 Windows 上**通过**（契约 v1.2 全部检查）——纯 Node 代码跨平台无碍。
- `demo/framed.mjs --port 7799` 在 Windows 上**跑通**：`/api/state` HTTP 200；服务只绑 `127.0.0.1` +
  Host 校验（安全红线在 Windows 同样生效，从 Mac 不可直接访问，探活走 `service.sh status`）。
- **DSH 观察开箱即用**：沙箱服务立刻观察到本机 DSH 会话（`cwd: D:\桌面\插件工厂`，数据源
  `C:\Users\admin\.dsh\sessions\...`）——DSH 观察通道无需改造即跨平台。
- `adapters/local-agents.mjs`（四态探测）在 Windows 跑通（扫描 642ms）。

## 4. 可用性矩阵初步（PLAT-0 第一手数据）

| 源 | 状态（2026-10-27） | 数据路径（Windows） |
|---|---|---|
| DSH | 已安装，有历史会话（~44h 前） | `C:\Users\admin\.dsh` |
| Claude Code CLI | 已装（npm 全局，`AppData\Roaming\npm\claude.ps1`），~3h 前活跃 | 转录在 `~/.claude`（探测口径待接） |
| Codex CLI | 已装，~67 天前活跃 | `C:\Users\admin\.codex` |
| Kimi CLI | 已装（`~/.kimi-code/bin/kimi.exe`） | `C:\Users\admin\.kimi-code` |
| ZCode | 已装，**9 会话、49s 前活跃** | `C:\Users\admin\.zcode` |
| OpenCode | 已装，**87 会话、3s 前活跃**（正被真实使用） | `C:\Users\admin\.local\share\opencode` |
| Qoder / Cursor CLI | 未安装 | — |

注意：`local-agents.mjs` 在 Windows 上把部分已装 CLI 误判为「未下载」——其安装探测路径
（`~/.local/bin` 等）是 macOS/Linux 口径，Windows 的 npm 全局路径与进程特征适配是 **PLAT-2 的工作项**，
本表已按实况人工校正。**（同日已修复：平台抽象层落地，见 §7。）**

## 5. 坑与约定（写代码前必读）

- **cmd + GBK**：沙箱默认 shell 是 cmd，中文输出必乱码。远程命令统一
  `powershell -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; …"`；读文件加
  `-Encoding UTF8`；**写文件**显式 `-Encoding UTF8`。
- **cmd 嵌套引号**：`powershell -Command "…"` 内层再出现双引号会被 cmd 截断——内层字符串一律用
  单引号 + 拼接（`($t + '=OK')`），不用 `"$t=OK"`。
- **后台进程**：`Start-Process` 起的进程会随 ssh 会话出问题（且 `-FilePath` 遇 node 路径空格即败）；
  用 `Invoke-CimMethod Win32_Process Create`（父进程是 WmiPrvSE，断连不死）——见 `service.sh start`。
- **tar 同步**：Mac 侧必须 `COPYFILE_DISABLE=1`，否则 bsdtar 往包里塞 `._*` AppleDouble 垃圾条目。
- 沙箱是**真实个人笔记本**：只推源码、不装无关软件、测试完 `service.sh stop` 收摊。

## 6. 与排期的关系

- PLAT-0 的 Win11 侧「可远程操作验证机」**就绪**（本机 = 本文机器）。
- PLAT-2「Windows 全功能」在其上开发：路径/进程特征适配（§4 误判即工单）、`wt.exe` 终端投递、
  Tauri Win 外壳（源码已随 sync.sh 到位，`pnpm tauri build` 待 Windows 侧装 Rust 工具链）。

## 7. 平台层落地与 PLAT-2 机制实测（2026-10-27 第二轮）

PLAT-1 平台抽象层 `adapters/platform.mjs` 落地并同步到本机实测，PLAT-2 的服务侧机制项（观察 + 控制）全链通过：

| 项 | 实测结果 |
|---|---|
| 平台快照自检 `scripts/platform-check.mjs` | mac/win 双平台通过；PE 版本读取（DSH 0.2.1.0 / ZCode 3.16.2.8769 / Kimi 1.0.4.0，注册表反查 D 盘安装目录） |
| 四态探测（PLAT-2 工单修复） | claude/codex/kimi/zcode/opencode 全部正确识别；CLI 与桌面拆行正确（MSIX Claude+Claude-3p 内置 CLI ↔ npm CLI；Codex 桌面 = MSIX ChatGPT.exe）；ZCode 9 会话 / OpenCode 87 会话与 §4 矩阵一致 |
| 观察源 | dsh 24 / claude 3 / codex 48 / zcode 9 / opencode 87（kimi 无会话如实 0）；`check-fixtures` 通过；framed `/api/state` 200、目录 58 项目热身正常 |
| 控制通道 | 五家 CLI 全部解析成功；`--version` 实测经解包 spawn 全部 exit=0（claude→包内原生 exe、codex→node+js、kimi/opencode→原生 exe）；`--selftest` 终端链 wt.exe 新标签 ✅ |
| 插件通道 | 命名管道 `\\.\pipe\agent-pet-dsh-plugin` 地址正确；DSH 未挂插件时如实报不可用（ENOENT→降级） |

发现与口径：

- **zcode npm shim 的 junction 已损坏**（`node_modules\zcode-cli` 指向失效目标）——该机 ZCode 真身是桌面 App（D:\ZCode）；CLI 解析会诚实降级为 cmd 兜底，且 ZCode 投递本就走 app-server 管道，不经此路径。
- **Windows 注册表 Uninstall 的 DisplayName 带版本号**（"DeepSeek Harness 0.2.1-rc.2"）——反查用「精确 + 前缀」双匹配；**MSIX 应用不进 Uninstall 表**（Claude/Codex 桌面用其数据目录作安装证据）。
- **Cursor 桌面不在 Uninstall 注册表**（装在非标准目录）——用 `%APPDATA%\Cursor` 数据目录作证据，版本如实缺省。
- 命名管道 ACL 的跨用户语义仍未实测（沙箱单用户环境无对照），PLAT-2 验收时补。
- 真实模型投递轮次（V01/V02/V04 同口径）按验证纪律**留待用户授权**，本轮只做机制级验证（`--version` 零额度消耗）。
- Tauri Win 外壳（lib.rs 窗口行为 + NSIS 安装包）不在本轮：需 Windows 侧 Rust 工具链，装包前另行确认。

## 8. PLAT-2 闭环实测（2026-10-27 第三轮，用户授权真实轮次）

### 8.1 真实投递闭环（专用测试目录 `C:\Users\admin\pet-e2e-test`，最小额度）

| 项 | 结果 |
|---|---|
| V01 新建会话 | ✅ claude 新建成功（`-p --output-format json`，~48s/轮，$0.107/轮） |
| V02 定向投递 + 上下文连续 | ✅ `deliverViaCli` 无头续会话（解包 spawn 包内原生 exe），转录内出现暗号「蓝鲸」 |
| V04 同 cwd 双会话隔离 | ✅ 会话 A 再投仍答「蓝鲸」，会话 B 保持自己的「已记住」 |
| V05 失败可辨 | ✅ 假会话 ID → `ok:false / cli-exit`（claude 自报 "--resume requires a valid session ID"），无假成功 |
| codex（第二家） | ⚠️ 环境阻塞：投递消息确实写入 rollout（user_message 落盘 = 管道通），但模型回合不完成——该机 codex 用 API key 且**直连 OpenAI 不可达**（网络层挂起，与 stdin 无关：空文件重定向同样挂） |
| kimi（第二家） | ⚠️ 该机 Kimi 账号 **429 suspended**（org 被停），CLI 如实报错；恢复账号或换 opencode 可补测 |

### 8.2 命名管道 ACL（红线实测）

用句柄 `GetSecurityInfo` 读 DACL SDDL：

```
D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;BA)(A;;FR;;;WD)(A;;FR;;;AN)
```

- SYSTEM / Administrators：完全控制（FA）；**Everyone(WD) / Anonymous(AN)：只读（FR）**。
- 即默认 ACL 下其它用户能连管道但写不进——HTTP-over-pipe 需要双向读写，跨用户客户端 `GENERIC_READ|WRITE` 打开被拒。**红线成立**（libuv/Node 命名管道默认描述符语义确认）。跨用户「只读连接」的实际危害面与「创建第二账号实测」留待有需要时补。

### 8.3 Tauri Windows 外壳与 NSIS 安装包

- **构建**：沙箱装 VS Build Tools 2022（MSVC 14.44 + Win11 SDK 26100，winget）；`npx tauri build --bundles nsis` 通过（增量 4m39s）。产物 **`CodeAll_0.1.4_x64-setup.exe`（24.2 MiB）**。
- **捆绑**：bundle-service 产 89.2MB 暂存（16 适配器 + demo 资产 + dsh-pet 插件 + **Windows node.exe**）——node 复制改 `process.execPath` 优先 + Windows PATH 口径。
- **lib.rs 适配**：打包布局按平台解析（mac Contents/Resources/app；Windows 安装目录 `\app`，兼容 `\resources\app`）、node 解析（`bin\node.exe` + Program Files + PATH `;`）、日志打开 `explorer /select`、补 `mouse_down_can_move_window` 非 mac 兜底（首次 Windows 编译暴露）。mac `cargo check` 零回归。
- **安装实测**：`/S` 静默安装 exit=0 → `AppData\Local\CodeAll\{agent-pet-shell.exe, app\, uninstall.exe}`，布局全对。
- **W02 服务侧红线（全部通过）**：包内 `app\bin\node.exe` 起 `app\demo\framed.mjs` → 127.0.0.1:7799 LISTENING；`/api/state` 200；**错 Host → 403**；**写接口无 token → 401**（读接口免 token 为既有设计，写鉴权是红线本体）。
- **GUI 窗口（待人工）**：ssh 非交互会话里 WebView2 建窗失败（`0x80070578 无效的窗口句柄`——Windows GUI 必须在交互桌面会话；计划任务拉起方案被安全策略拦截，属合理防护）。**壳的双击启动与 W05 窗口行为（透明/置顶/拖拽/托盘）需在那台机器桌面会话人工验证**。
