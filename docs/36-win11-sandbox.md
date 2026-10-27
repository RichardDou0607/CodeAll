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
本表已按实况人工校正。

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
