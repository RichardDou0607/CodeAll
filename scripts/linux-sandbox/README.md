# linux-sandbox — Linux(arm64)验证机环境脚本

PLAT-3 Linux 适配的验证机工作流，方法论与 [../win11-sandbox](../win11-sandbox) 同一套（check → sync → exec → service → e2e），载体换成本机 VMware Fusion 的 arm64 Ubuntu Desktop 24.04 VM。

## 约定

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `LINUX_HOST` | `ubuntu` | ssh Host 别名（~/.ssh/config 免密；VM NAT 172.16.193.133） |
| `LINUX_DEST` | `~/codeall` | 远端工作区（允许 ~ 前缀，远端 shell 展开） |
| `LINUX_PORT` | `7799` | framed 服务端口 |

与 win11 的差异：无 GBK/编码坑（全部明文 bash，不需要 base64/EncodedCommand）；PATH 敏感命令统一走 `bash -l`（node/rust 装在 `~/.local/bin`、`~/.cargo/bin`，由 `.profile` 注入）；分离进程用 `setsid nohup`（对位 WMI Create）；stop 沿用 win11 §9 收紧语义——监听端口 PID 与命令行 `demo/framed.mjs` 双匹配才杀。

## 脚本

- `check.mjs` — 体检：连接 / 系统 / **GUI 会话类型（loginctl，防 ssh env 误判）** / 工具链 / 六源 Agent CLI 矩阵 / 桌面 App .desktop 反查 / DSH 目录。通过标准：ssh + node + git 即 exit 0；CLI 缺失只记矩阵数据（docs/24 PLAT-0 输入）。
- `sync.sh` — 源码同步（tar over ssh，排除清单与 win11 版一致）。
- `exec.sh` — 工作区内执行一条命令（`./exec.sh "node --version"`）。
- `service.sh` — `start [端口] / status / stop / log [行数]`（framed 服务管理）。
- `sock-probe.mjs` — 插件通道 unix socket 权限探针（0600/0700 + 跨用户拒连；对位 win11 acl-probe）。*（L2 落地）*
- `e2e-driver.mjs` — claude 真实投递闭环 V01/V02/V04/V05（沿用 docs/36 §8.1 口径）。*（L8 落地，需授权额度）*

## 一次完整验收轮

```
node check.mjs → ./sync.sh → ./service.sh start
  → ./exec.sh "node scripts/platform-check.mjs"（机制级）
  → e2e-driver（真实投递，需用户授权额度）
  → sock-probe（socket 红线）→ ./service.sh stop 收摊
```
