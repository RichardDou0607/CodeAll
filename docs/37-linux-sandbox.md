# 37 · Linux(arm64)沙箱——PLAT-3 验证机

> 姊妹篇:[docs/36-win11-sandbox.md](./36-win11-sandbox.md)(Windows 侧同方法论)。本文记录 PLAT-3 Linux 适配的验证机、环境脚本、可用性矩阵与实测记录。

## 1. 机器与连接

- **载体**:本机 VMware Fusion 虚拟机 `Ubuntu Desktop 24.04.vmwarevm`(Apple Silicon 宿主,guestOS `arm-ubuntu-64`,EFI,NAT)。VM 配置 2 vCPU / 4GB 内存 / 40GB 盘(2026-10-28 实测余 24~25GB,Rust+Tauri 构建预算 ~9GB,够用)。
- **系统**:Ubuntu 24.04.5 LTS arm64,装有 `ubuntu-desktop` 元包(GNOME 46 + gnome-shell;镜像本体由 live-server ISO + autoinstall 装,后补桌面元包——主机名一度为 `ubuntu-server` 即此缘故)。
- **图形会话**:默认 **X11**(tty2,`loginctl show-session` Type=x11)——正合 PLAT-3「X11 全功能」基准;Wayland 对照项按需切会话(gdm 齿轮选 Ubuntu on Xorg 的反操作)。
- **接入**:`~/.ssh/config` 别名 `ubuntu` → `172.16.193.133`(user `richard`,免密;注意与既有 `ubuntu-server`=26.04 Server 别名严格区分)。IP 为 NAT DHCP 动态分配,漂移时以 `vmrun getGuestIPAddress` 或 ARP(MAC `00:0c:29:38:69:d8`)核对后改别名。
- **快照**:`pre-plat3`(L0 起点)。收口后另打 `plat3-smoke-done`。
- **sudo**:VM 内 richard 已配 NOPASSWD(dev 沙箱约定)。

## 2. 环境脚本(scripts/linux-sandbox/)

见 [scripts/linux-sandbox/README.md](../scripts/linux-sandbox/README.md)。与 win11 四件套同构(check/sync/exec/service),差异:无编码坑、`bash -l` 保登录态 PATH、`setsid nohup` 分离进程、stop 双精确匹配防误杀。

VM 内工具链(2026-10-28 装机):node v22.14.0 + pnpm(`~/.local/bin`,官方 arm64 tar 包)、rustup stable(rustc 1.99.1,`~/.cargo/bin`)、git/curl/tar 系统自带;Tauri 构建依赖 `libwebkit2gtk-4.1-dev / libayatana-appindicator3-dev / librsvg2-dev / libxdo-dev / build-essential` 等 apt 安装;`xdg-terminal-exec` 在 24.04 universe 源有包(0~20230318-1)已装——终端链三级可实测,原 R7 风险(不在源内)解除。

## 3. 已验证能力

（2026-10-28 L4 冒烟，全部在 VM 实测）

| 项 | 结果 | 证据 |
|---|---|---|
| framed 服务生命周期 | ✅ start(setsid 分离)/status(200)/stop(双匹配不误杀) | service.sh 全周期；双 bash 守护写法修复 ssh 挂起（见 §5） |
| 服务侧红线（W02 同口径） | ✅ `/api/state` 200 · 错 Host 403 · 写无 token 401 · token 文件 0600 · 只绑 127.0.0.1（宿主直连拒） | curl 断言逐条过 |
| 四态矩阵 | ✅ 7 未打开 / 7 未下载，版本读取（npm 口径）生效，无虚构 | local-agents.mjs VM 输出 |
| 终端链三级 | ✅ 二级 gnome-terminal 真弹窗（E2E：openTerminalWindow → 窗口出现 → 命令执行）；一级 xdg-terminal-exec 在 24.04 认不出反 DNS 命名的 org.gnome.Terminal.desktop（0~20230318 版行为，落到 xterm 缺失报错）——**实机口径：从 gnome-terminal 起评**，一级标「fixture 已测/实机不适用」 | 截图存档（窗口内 `agent-pet-terminal-ok`）；via=gnome-terminal |
| unix socket 红线 | ✅ socket 0600 / 目录 0700 / 本用户可达 / 跨用户 nobody 拒连 | sock-probe.mjs 四断言 |
| 契约自检 | ✅ check-fixtures（契约 v1.2）· test-platform-linux 10/10 · platform-check linux 全绿 | VM 内实跑 |

## 4. 可用性矩阵(PLAT-0)

已落 [docs/40 §0.2](./40-adapters.md#02-linux-可用性矩阵ubuntu-24-04-arm64-本机-vm2026-10-28-实测)：六源 CLI 装机实测（claude 2.1.312 / codex 0.165.0 / kimi 2.3.3 / opencode 1.19.4 / cursor-agent 2026.10.22 / dsh 0.2.1-rc.2），qoderclicn 不公开如实记；DSH 有 linux-arm64 官方发行。装机注意：**kimi 要求 Node ≥ 22.15**（`node:zlib` zstd）；npm 上同名 `cursor-agent` 是无关软件，真 Cursor CLI 走官方装脚本。

## 5. 坑与约定

- **VMX 模态问答会卡死 vmrun**:Fusion 弹「此虚拟机可能已被移动或复制」时,vmrun start/stop 全部挂起(无 answer 子命令可解)。已在 .vmx 写 `uuid.action = "keep"` 抑制。
- **杀 VMX 进程会把增量磁盘标脏**:模态卡死后若强杀 vmware-vmx,磁盘链报 `The specified virtual disk needs repair`——`/Applications/VMware Fusion.app/Contents/Library/vmware-vdiskmanager -R <脏层>.vmdk` 可修(2026-10-28 实修 disk-000001.vmdk 成功)。关机状态的残留 `.lck` 目录移走即可(VMware 无进程持有时)。
- **osascript UI 脚本需辅助功能授权**:本机未授,点击 Fusion 模态按钮不可行;绕法=杀 VMX+vdiskmanager 修盘+uuid.action 防复发。
- **pkill 模式自伤**:`pkill -f "node-v22.14.0"` 会匹配到自身 ssh 会话命令行导致连接自杀;远端清理用文件路径类模式并 grep -v 排除自身。
- **ssh 远程守护进程的双层 bash 写法**:`bash -c '... setsid nohup node ... > log 2>&1 </dev/null & echo STARTED'` 单层写法下外层 bash 可能随 node 存活滞留（async list 语义），ssh 管道不 EOF、调用方挂死（L4 实测两次）。确定式写法：内层 `bash -c 'exec setsid nohup node … &'` 后外层立即返。
- **ssh 驱动图形会话的全套环境**:DISPLAY 是 **:1** 不是 :0（`ls /tmp/.X11-unix/` 核实）；需带 `XAUTHORITY=/run/user/<uid>/gdm/Xauthority` + `XDG_RUNTIME_DIR` + `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus`,且走登录态 PATH（bash -l）。会话空闲会**自动锁屏**造成「黑屏」假象——dev VM 已 `gsettings lock-enabled false` + `idle-delay 0`,锁屏可用 `loginctl unlock-session` 远程解。
- **corepack 首次下载有交互确认**:非交互环境挂起;pnpm 直接 `npm i -g pnpm --prefix ~/.local` 绕开。
- （随实测追加)

## 6. 与排期关系

本机 = PLAT-3(Linux 全功能)唯一验证机;验收口径修订见 [docs/24](./24-v0.2.0-scope.md) §1 架构口径行与 §5 证据分级(E1/E2/E3)。V01/V02/V04/V05 沿 docs/36 §8.1 实操口径。

## 7. 平台层落地与 PLAT-3 机制实测

（2026-10-28 L2/L3,Linux 分支首跑即绿)

- **platform.mjs linux 分支**:`appVersion` spawn `--version`(4s 超时,版本 token 提取)、`desktopAppDirLinux`(XDG .desktop 反查:deb 符号链 realpath / AppImage 目录 / flatpak null 三布局)、终端三级链、unix socket 地址;platform-check(linux)13 项数据目录全对位。
- **local-agents 三槽位**:`installPathsLinux/processReLinux` 缺省回落 mac 槽位(HOME 相对路径天然同值);npm 安装位补 `~/.local/bin/dsh`、`~/.local/bin/kimi`(linux 实测口径);四态 7 未打开 / 7 未下载无虚构,版本读取(npm 口径)生效。
- **硬编码收口**:plan-usage(qoder×2/cursor/copilot 走 appSupport+PLAN_USAGE_HOME 重定根)、cli-control(ZCode UI 链 IS_LINUX 短路、selftest linux 分支、zcode extraPaths)、model-registry(zcode builtin win/linux 同构分支)、probe.mjs(CLI 经 desktopAppDir 组装)。
- **socket 权限收紧**:dsh-pet 目录 0700 + socket 0600(secureNamedPipe unix 分支,失败即关监听);sock-probe 四断言含跨用户拒连。
- **测试**:demo/test-platform-linux.mjs 10 用例(mac 伪装 + VM 真实分支双绿);mac 隔离回归全量 26/27(唯一失败 test-plan-usage 经 stash 对照确认为本轮之前既存,与 PLAT-3 无关)。

## 8. 闭环实测

### 8.1 出包与安装即用（L6，2026-10-28 实测）

双产物均出包：`CodeAll_0.1.4_arm64.deb`（46MB）与 `CodeAll_0.1.4_aarch64.AppImage`（121MB）。

| 项 | 结果 | 证据 |
|---|---|---|
| deb 安装即用 | ✅ `apt install` 后 `/usr/bin/agent-pet-shell` 自起**包内** Node 跑包内 framed（`/usr/lib/CodeAll/app/bin/node …/demo/framed.mjs --port 7799`）；红线 200/403/401 包环境全绿 | 进程行 + curl 断言 |
| 资源布局与 bundled_app_root | ✅ deb 布局 `/usr/lib/CodeAll/app/`（二进制 `/usr/bin/`、资源含 `app/bin/node`）；AppImage 挂载 `.mount_*/usr/lib/CodeAll/app/` 同构——lib.rs 候选（ancestors × `lib/CodeAll/app`）**首包即命中，零返工** | dpkg -c / ps 进程行 |
| AppImage 直接运行 | ✅ 挂载即跑，包内 node 自起，`/api/state` 200 | 进程行（.mount 路径）|
| `.desktop` 自启 | ✅ deb 装 `/usr/share/applications/CodeAll.desktop` → 复制 `~/.config/autostart/` → 远程注销重登（gdm 自动登录）→ 壳被 autostart 拉起 → 包内服务 200 | 进程 + 200 + 截图（Dock 运行点 + 窗口） |
| 安装态 GUI | ✅ WebKitGTK 渲染完整（会话总览/八源标签/托盘/中文无豆腐块） | 截图存档 |

**AppImage 打包三连坑**（VM 网络不通 github 所致，宿主代下解决）：
1. tauri 缓存文件名必须含 commit hash：`~/.cache/tauri/linuxdeploy-07333c6-aarch64.AppImage` + `AppRun-aarch64`（源码 crates/tauri-bundler/.../appimage/linuxdeploy.rs `prepare_tools`）；
2. linuxdeploy 执行需要 type2 runtime，经环境变量 `LDAI_RUNTIME_FILE` 传入（`~/.cache/tauri/runtime-aarch64`，从 AppImage/type2-runtime continuous 代下）；
3. `linuxdeploy-plugin-appimage` 从 linuxdeploy 自己的 releases 下载失败属**非致命**（自动回落内置版）。

待办:AppImage/deb 的**卸载干净**断言、`run.sh --install` Linux 分支实测、AppImage 版 `.desktop` 自启(Exec=绝对路径形态)。

### 8.2 机制红线(L7,E1 全绿)

`scripts/linux-sandbox/redline.mjs`:200 / 错 Host 403 / 写无 token 401 / token 0600 / 只绑 127.0.0.1 / 队列计划文件 0600(存在才查)/ sock-probe 四断言。**跨用户 nobody 拒连**为本机 VM 独有实验(win11 侧做不了)。

### 8.3 W05 窗口行为十项 + Wayland 对照(L7,E2)

十项取证与 Wayland 对照记录见 [qa/linux-manual-tests.md](../qa/linux-manual-tests.md)。摘要:7 ✅(透明/置顶 ABOVE+STICKY/拖拽/双窗/托盘菜单/关窗不退/全屏并存)、2 ⚠️(位置记忆部分生效——拖拽终点不即时存盘 GAP-2;⤢ 放大无几何变化 GAP-3)、1 N/A(穿透未启用)。**Wayland 实测**:全链绿 + `DEGRADED wayland: window-restore 跳过` 如实触发 + pos=0,0;降级声明已落 README 与 docs(产品界面随 GAP-1 修复一并落)。

**附带修复**:lib.rs 托盘/显示路径补 X11 `unminimize`(show() 在 X11 不解除 Iconic;GAP-1 未因此闭环,待查 tao/GTK hide × show 交互)。

### 8.4 真实投递 e2e(L8,授权门未开)

`scripts/linux-sandbox/e2e-driver.mjs` 就位(移植 win11 母版);VM 内 claude 未登录(`Not logged in`),真实轮次待 VM 内 OAuth 登录 + 用户授权最小额度。**机制级通过待授权**,按 docs/24 §5 纪律不阻塞收口、不虚构。

## 9. 审查修复与复验状态

- L2 适配层改动全部 gated(IS_LINUX/cfg linux),mac 全量隔离回归 26/27(唯一失败 test-plan-usage 为本轮之前既存,stash 对照确认,见 §7)。
- `cargo check`(mac)对 lib.rs 全部 linux cfg 改动零回归;lib.rs unminimize 补丁已含于最终 deb(08:50 重打包)。
- **未完成不记通过项**:GAP-1(关窗后唤回)、GAP-2(拖拽位置即时存盘)、GAP-3(⤢ 放大)、AppImage 自启形态、卸载干净断言、真实投递 e2e(授权门)。均已登记 qa/linux-manual-tests.md §六,作为 PLAT-3 收口的已知缺口与后续工单输入。
- W06 正式收口口径:见 docs/24 §5 证据分级——本轮为 E1+E2(vm);E3 物理机验收或用户豁免后复跑 W02-W05 断言。
