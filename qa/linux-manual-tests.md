# Linux 手工验收清单(PLAT-3 · Ubuntu 24.04 arm64 本机 VM)

> 姊妹篇:[qa/win11-manual-tests.md](./win11-manual-tests.md)。证据等级:E1 脚本断言 / E2 本机 VM 截图自动化(docs/24 §5 修订口径)。
> 执行日期:2026-10-28(X11 基准;Wayland 对照见 §三)。

## 一、壳启动

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 双击/安装后启动,迷你条出现 | ✅ | 截图(迷你条渲染于壁纸之上);进程行 `/usr/lib/CodeAll/app/bin/node …/demo/framed.mjs`(包内 Node 自起) |
| 2 | 包内 node 进程可见 | ✅ | `ps`:node 路径 = 包内;`/api/state` 200 |
| 3 | 托盘图标出现 | ✅ | 顶栏「C」图标(gnome-appindicator);TRAY_READY 日志 |

## 二、W05 窗口行为十项(X11)

| # | 项 | 结果 | 证据/说明 |
|---|---|---|---|
| 1 | 透明(圆角,四角透出桌面) | ✅ | 截图:条贴壁纸渲染,ARGB(Depth 32);圆角处壁纸可见 |
| 2 | 置顶(📌 切换) | ✅ | 点击后 `_NET_WM_STATE_ABOVE` 出现(xprop 前后对照)+ UI 高亮;条底态带 `_NET_WM_STATE_STICKY`(all-workspaces,lib.rs set_visible_on_all_workspaces 生效) |
| 3 | 拖拽 | ✅ | xdotool 按住拖动:(450,352)→(900,622),xwininfo 实证 |
| 4 | 位置记忆 | ⚠️ 部分 | 重启后恢复到**已存位置**(window.json 483,368)而非默认居中——持久化+恢复机制工作;但拖拽终点未即时存盘(Wayland/X11 下 tao Moved 事件与 mutter 交互式移动的接线缺口),恢复值与拖拽终点有偏差 |
| 5 | 点击穿透 | N/A | 当前壳未启用穿透(设计:仅 spike 验证过);如启用按 docs/24 降级阶梯另测 |
| 6 | 放大(⤢ 360×340 ⇄ 720×680) | ⚠️ 待查 | ⤢ 点击有焦点态但无几何变化(shell_toggle_size 未见于日志,疑注入 IPC 路径);注:340 高度实为紧凑态设计尺寸 |
| 7 | 双窗口常驻 | ✅ | 迷你条 + App 窗口同列(xdotool search);截图 |
| 8 | 托盘菜单 | ✅ | 菜单五项全渲染:显示悬浮窗/显示 App 界面/隐藏悬浮窗/打开服务日志/退出(截图) |
| 9 | 关窗隐藏不退 | ✅(带缺口) | 点标题栏 X:窗口转 IsUnMapped 但 X 窗口对象与进程存活;**缺口**:两条关闭路径(X 按钮/_NET_CLOSE_WINDOW)均未触发应用层 CloseRequested 日志,托盘「显示 App 界面」(TRAY_SHOW_APP 已达,show+unminimize 已执行)未能恢复上屏——GAP-1,待查(疑 tao/GTK hide × tauri show 交互);重启壳可恢复 |
| 10 | 全屏并存 | ✅ | gnome-terminal 最大化铺满,迷你条浮于其上(ABOVE+STICKY 生效,截图) |

## 三、Wayland 对照(GNOME 46 / mutter 46.2)

| 项 | 结果 | 证据 |
|---|---|---|
| 壳启动全链 | ✅ | journal:SETUP→TRAY_READY→WINDOW_SHOWN→REMOTE_COMMITTED→REMOTE_IPC_OK 全绿 |
| 位置恢复降级门 | ✅ | **`DEGRADED wayland: window-restore 跳过`** 日志(is_wayland_session gate 生效);WINDOW_SAVED pos=0,0(无全局坐标的预期) |
| 渲染 | ✅ | 截图:迷你条落左上(0,0)+ App 窗口完整 UI |
| 声明 | ✅ 落位 | README Linux 节 + docs/37 §8:Wayland 下位置记忆/全局坐标类操作降级(恢复跳过、坐标记 0,0),置顶/穿透按 docs/24:16 降级阶梯 |

## 四、红线(安装包环境,E1)

`node scripts/linux-sandbox/redline.mjs` 全绿:200 / 错 Host 403 / 写无 token 401 / token 0600 / 只绑 127.0.0.1 / 队列计划文件 0600(存在才查)/ sock-probe 四断言(socket 0600、目录 0700、本用户可达、**跨用户 nobody 拒连**)。

## 五、真实投递 e2e(L8,授权门)

- `scripts/linux-sandbox/e2e-driver.mjs` 已就位(移植 win11 母版,V01/V02/V04/V05 判定平台无关)。
- **门未开**:VM 内 claude CLI 未登录(`Not logged in · Please run /login`)。真实轮次待:①VM 内 OAuth 登录;②用户授权最小额度。此前 docs/37 §8 标「机制级通过待授权」,不阻塞发布收口。

## 六、已知缺口/待查(不阻塞本轮收口)

- **GAP-1** 关窗后托盘/按钮唤不回 App 窗口(见 W05-9);lib.rs 已补 X11 `unminimize`(必要非充分)。
- **GAP-2** 拖拽终点不即时存盘(位置记忆偏差,W05-4)。
- **GAP-3** ⤢ 放大按钮无几何变化(W05-6)。
- **环境坑**:VMware VM 只重启 X 会话不重启整机 → webkit2gtk 全系白屏(连 epiphany 同病),整机重启恢复——VM 环境特性,非产品 bug,已记 docs/37 §5。
