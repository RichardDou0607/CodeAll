# v0.1.0 后续构建任务（Post-Release Build Plan）

> **2026-10-09 当前裁决：本文五条工作流及 v0.2-v1.0 排期全部降为未排期待办。当前只执行 [23-v0.1.0-scope.md](./23-v0.1.0-scope.md)：macOS v0.1.0 的 CLI 与 DS Harness 对话闭环。下文保留历史方案供后续恢复，不再是当前开发承诺；文末「DEF · 审查遗留缺陷」为本次代码审查的缺陷登记（同样未排期、不阻塞当前收口）。**

> 制定日期：2026-10-08（用户定向）；**版本节奏重排：2026-10-08（用户定向）——v0.2 = Windows/Linux 跨平台（W3 提前），v0.3 = Cursor / OpenCode / Qoder 等软件接入（W2），v0.4 = 厂商 Coding Plan 监控（W1），W4 后移 v0.5 起**。定位：**CodeAll v0.1.0 首发之后的产品续作计划**，不替代 [20-roadmap](./20-roadmap.md)（原始两阶段计划）与 [21-multi-agent-adoption-plan.md](./21-multi-agent-adoption-plan.md)（多 Agent 接入，§6 双域模型仍是远端架构的真相源）；本文把五条新工作流落成可排期的任务，遵循 v0.1.0 确立的收敛原则——**能力落地才进软件列表，宣传不跑在实现前面**。
>
> 估算口径：单人全职折算人日；[U] = 未验证，需 spike 先行。

## 0. 总览与目标版本

| 工作流 | 主题 | 关键产出 | 原建议版本（当前暂停） |
|---|---|---|---|
| W1 BILL | **Coding Plan 计费展示** | 计费页：官方 API + 本地规则估算双路 | **v0.4**（BILL-4 多账号报表 v0.5） |
| W2 AGT | **更多 Agent 软件** | ACP 通道、OpenCode、Qoder、Cursor | **v0.3** |
| W3 PLAT | **Windows / Linux 适配** | 平台抽象层 + 双平台安装包 | **v0.2** |
| W4 RMT | **远端：原生AI操作系统 / AgentOS** | 本地→远端观察→远端控制三步（沿用 M-J） | v0.5(J1/J2) / v1.0(J3) |
| W5 MOB | **手机端** | PWA → 原生壳 + 推送 + 外网中继 | v0.5–v1.0 |

依赖关系：`W2-ACP → W2-OpenCode`；`W3-平台抽象 → 全部新适配器的 Windows/Linux 行`；`W4-J3 → W5-MOB4(外网中继)`；`W1 基本独立（只吃 usage-collect 既有真值）`。

---

## W1 · Coding Plan 计费展示（BILL）

### 现状地基（v0.1.0 已有）

`adapters/usage-collect.mjs`（M-U）已提供**本地 Token 真值**：五源 × Agent × 模型 × 自然日 × 形态（CLI/桌面/IDE）精确累计 + 缓存命中率 + 时间窗（当日/7 日/30 日）+ 日历热力。计费展示 = 在真值之上叠「**计划档位与价格语义**」与「**官方账单对账**」两层。

### 厂商计费数据源盘点（先 spike 后实现）

| 厂商 / 计划 | 官方数据源 | 可信度 | 备注 |
|---|---|---|---|
| DeepSeek（按量付费） | `GET /api/user/balance`（平台 API key，官方文档） | **[A] 文档确证** | 余额 + 用量，BILL-2 首选 |
| Z.AI / GLM Coding Plan | 桌面 App「今日消耗」页有官方口径；是否有开放 API | **[U]** | 以官方 UI 数字做对账基准（此前已对平 5.4 亿） |
| Anthropic Claude（Coding Plan） | Admin API（组织用量报表）对个人消费版计划的覆盖 | **[U]** | 5 小时滚动窗 + 周额度；个人计划 API 未公开文档化 |
| OpenAI / Codex 计划 | 组织 usage API；消费版 Codex 额度 | **[U]** | Codex 消费版额度接口未公开 |
| Kimi / Moonshot | 平台账单 API / CLI 计划口径 | **[U]** | Kimi Code CLI 与平台计费关系待确认 |

> 结论先行：**多数厂商的消费版 Coding Plan 没有公开计费 API**——所以架构必须是「官方 API（有则接）+ 本地规则估算（永远可用）」双路，官方数字用于校准规则，而不是被依赖。

### 里程碑

| ID | 任务 | 估时 | 验收 |
|---|---|---|---|
| BILL-1 | **计划配置模型 + 计费页骨架**：`~/.agent-pet/plans.json`（0600）描述每家计划：档位、额度（Token/请求）、额度窗口（5h 滚动 / 周 / 月）、重置规则、超限单价；计费页 = 用量真值 × 规则 → 额度环 + 窗口倒计时 + 费用估算 | 3～4 人日 | 手填一份真实计划，页面估算与手动核算一致；test-window 计费页断言 |
| BILL-2 | **官方 API 接入**：DeepSeek balance 先行（文档确证）；其余厂商 spike 后按 [A] 逐个接入 | 2 人日 + 每厂商 1～2 人日 | 每厂商一项「官方数字 vs 本地估算」对账断言进 multi-source-check |
| BILL-3 | **额度窗口与预警**：滚动窗口状态机（对齐 Claude 5h 窗语义）、重置倒计时、接近额度阈值提醒（迷你条 + 通知） | 2～3 人日 | 窗口翻转/预警的合成时间测试；不打扰性验证 |
| BILL-4 | **多账号与聚合报表**：同厂商多账号（如多个 coding plan）分别计量；月度报表导出 | 2 人日 | 多账号 fixture 回归 |

**红线**：厂商 API key 只存本地 0600 文件、只读调用、绝不经任何上报通道外发。

---

## W2 · 更多 Agent 软件接入（AGT）

> 顺序按杠杆率排：先做一次适配多家受益的 ACP，再做单品。

| ID | 任务 | 估时 | 要点 |
|---|---|---|---|
| AGT-1（=M-F） | **ACP 统一通道**：JSON-RPC over stdio 客户端（`initialize → session/new → session/prompt`，订阅 `session/update` 15 变体 + 审批） | 8～12 人日 | docs/40 §3.8/§4.6；一次适配覆盖所有 ACP agent；OpenCode 是第一个受益者 |
| AGT-2（=M-I） | **OpenCode**：ACP 首选；备选 `opencode.db` SQLite 只读快照（cp+只读，10s 轮询，不做 WAL tail）；CLI 控制通道按 `opencode` CLI 参数补齐；**落地后恢复 v0.1.0 移除的注册表行** | 2～4 人日（ACP 就绪后近乎免费） | docs/21 M-I；前置：确认 OpenCode CLI 回到 PATH / 仍在使用 |
| AGT-3 | **Qoder（阿里）**：spike 先行——数据位置（~/Library/Application Support/Qoder?）、有无 CLI / hook / ACP，全部 [U]；按 spike 结论走「日志/DB 只读 → hooks → CLI 控制」既有三级路径 | spike 1～2 人日 + 适配 4～6 人日 | 遵循 Kimi 教训（docs/21 M-H 勘误）：**先穷尽数据目录探测，再下「无文件级数据」结论** |
| AGT-4 | **Cursor**：hooks 通道（21 事件，docs/40 §3.3 [B] 证据）做观察；无 hook 时降级进程级（不虚构状态）；控制层 Cursor 无无头 CLI → 首版观察 + 四态行 | 6～8 人日 | `~/.cursor` 本机不存在，全部文档证据，漂移风险中高——hook schema 首轮实测后修订 |
| AGT-5（可选） | **GitHub Copilot CLI**：hook 载荷与 Claude 兼容（camel/Pascal 双命名），claude 适配器改造成本低 | 3～5 人日 | docs/40 §3.5；本机 `~/.copilot` 已有数据 [A] |

**通用要求**（每个新源）：契约映射表进 docs/40；multi-source-check 新增 M 组断言（目录/子代理/状态/性能/只读红线/--live 闭环）；四态面板注册行 + 原始图标（拿不到用 CodeAll 回退）；`SOURCE_META/SOURCE_LABEL/AGENT_TABS` 三处接线。

---

## W3 · Windows / Linux 适配（PLAT）

> 现状：Tauri v2 本身跨平台，但 **local-agents 探测（路径/进程/版本）、cli-control 终端机制、ZCode 等包路径都是 macOS 写死**。先抽平台层，再逐平台落地。

| ID | 任务 | 估时 | 要点 |
|---|---|---|---|
| PLAT-1 | **平台抽象层 `adapters/platform.mjs`**：installPaths 按 OS 给候选（Windows：%LOCALAPPDATA%/Programs、winget shim；Linux：/usr/bin、~/.local/share、flatpak/snap/AppImage）；进程快照（mac `ps axo` / Linux 同 / Windows `tasklist` 或 PowerShell CIM）；版本读取（PlistBuddy → PE 元数据 / .desktop）；终端启动链 | 3～4 人日 | 接口先行：所有适配器只调平台层，不写死 OS 分支 |
| PLAT-2 | **Windows 全功能**：cli-control 终端 → `wt.exe`/`start`；ZCode/Claude/Codex/Kimi 的 Windows 路径与进程特征；透明+置顶+点击穿透在 Win11 实测（README §六.3 的验证机要求仍有效）；NSIS/MSI 包 | 6～10 人日 | 命名管道（`\\.\pipe\agent-pet-*`）替代 unix socket 的桥接层 |
| PLAT-3 | **Linux 全功能**：终端链 xdg-terminal-exec → gnome-terminal → kitty；deb + AppImage；X11/Wayland 置顶与 skip-taskbar 差异实测；桌面自启（.desktop） | 5～8 人日 | Wayland 下点击穿透/置顶是最大不确定项，spike 先行 |
| PLAT-4 | **CI 矩阵与安装包流水线**：三平台构建 + 全量回归（远端仓库建立后上 GitHub Actions matrix） | 2～3 人日 | 依赖：仓库发布（当前无 remote） |

---

## W4 · 远端能力：原生AI操作系统 / AgentOS（RMT）

> 真相源不变：[21 §6](./21-multi-agent-adoption-plan.md) 双域模型——本地域直控各 agent 软件，**远端域经 AgentOS（每台远端服务器一个实例）控制**，`agentos@<host>` 与本地源完全并列；远端不装各家桌面 agent，AgentOS 是唯一汇聚点。用户自研的「原生AI操作系统」即远端执行体的宿主。

| ID | 任务 | 估时 | 要点 |
|---|---|---|---|
| RMT-1（=M-J1） | **本地 AgentOS 观察**：读 `~/agentos/.state/{agent,conv,ctx}` 纯文本状态 → 目录 + 事件；`agent -s` 单发验证投递链路（远端控制的本地彩排）；**恢复 v0.1.0 移除的 agentos 注册行** | 1～2 人日 | docs/21 M-J1；状态文件自研、零漂移 |
| RMT-2（=M-J2） | **远端观察**：SSH 只读 tail 远端 `~/agentos/.state/*`；source 命名 `agentos@<host>`；侧栏**主机分组头**（可折叠，本地会话之后，[55 §远端](./55-interaction-design.md)）；断线→该主机分组整体灰显「重连中」，本地不受影响 | 3～5 人日/台 | 验收（docs/21）：≥2 台远端同窗按 host 分组；拔网线触发离线判定 |
| RMT-3（=M-J3） | **远端控制**：输入投递走 `agent` 子命令白名单；AgentOS 既有安全模型全数生效（脱敏截断、sudo 拦截交还终端、NO_NEW_PRIVS、~/.ssh 零授权、总控不存凭证）；≤5 台预算（5～10s 轮询） | 4～6 人日 | 红线：总控不绕过、不存任何远端凭证；凭证只经用户 SSH agent |
| RMT-4 | **原生AI操作系统原生桥接 [U]**：待其暴露只读事件端口（docs/21 §6 [U] 项）后，以原生 API 替代 SSH tail，成为免运维的官方通道 | 待定 | 在其暴露端口前，SSH 路径完全够用 |

**主机管理 UI**（并入 RMT-2）：设置页新增「远端主机」——添加/删除 host、连通性指示、分组折叠记忆。

---

## W5 · 手机端（MOB）

| ID | 任务 | 估时 | 要点 |
|---|---|---|---|
| MOB-1 | **移动 PWA（`/m.html`）**：framed 新增移动视图（状态总览 / 会话列表 / 用量与计费 / 审批与队列）；局域网直连 + token；桌面端「配对二维码」（LAN IP + 一次性配对码换发 token） | 4～6 人日 | 复用既有 HTTP/SSE + token 鉴权，零新后端 |
| MOB-2 | **传输与鉴权加固**：局域网 TLS（自签 + 指纹钉扎）或至少 token 短期化 + 绑定设备；写接口（投递/审批）二次确认 | 2～3 人日 | 手机输入同样走 `mode=build` 类不越权通道 |
| MOB-3 | **原生壳 + 推送**：Expo/React Native 壳包 PWA；APNs/FCM 推「等待你批准 / 转出错 / 额度预警」（BILL-3 联动） | 5～8 人日 | 推送只在 waiting/审批/预警三类事件，杜绝噪音 |
| MOB-4 | **外网中继**：经用户自己的远端 AgentOS 主机做隧道/中继（依赖 RMT-3），不经任何第三方云 | 3～5 人日 | 与 §6 双域模型同构：中继也是「远端域」的一部分 |

---

## DEF · 审查遗留缺陷（未排期；缺陷修复项，非新功能）

> 来源：2026-10-09 全量代码审查。本轮已修并带回归：H1（打开路由按来源分流）、H2（跟随器预算 mtime 优先 + LRU 淘汰）、M2（日志/落盘失败不再带崩服务 + 进程级兜底）、M4（SSE 心跳与 DSH 日志解耦）——见 [CHANGELOG](./CHANGELOG.md) 与 [23 §5](./23-v0.1.0-scope.md)。本节只收「已定位、暂缓执行」的项：**不阻塞当前 v0.1.0 收口（V01–V06），随收口后恢复排期时一并处理**。ZCode 相关项按 [23 §1](./23-v0.1.0-scope.md) 的裁决属实验能力，不进入必过清单。

| ID | 任务 | 触发条件 | 实测证据 | 修复方向 | 验收 | 估时 |
|---|---|---|---|---|---|---|
| **DEF-1** | **ZCode 投递链把 HTTP 响应一并串行化**（审查 H3）：`demo/framed.mjs` 的 `zcodeDeliveryChain` 让下一条投递等待上一条回合的 `settle`（回合终态，上限 30min），而 `deliverInput` 直接 `return next`——响应被挂在整条链上。表现为：同一 ZCode 会话连发第二条时发送按钮/HTTP 长时间无响应；`/api/new` 的 ZCode 路径、`flushNewQueues` 重试同样被串；链为全局，发给另一个 ZCode 会话也会排队；与 demo/README「accepted 后返回 202 执行中」的文档语义不符 | 任一 ZCode 回合进行中再发一条（同会话或跨会话） | mock app-server（8.5s 迟到失败回合）：回合进行中发出的第二条 `POST /api/new` 响应 **8730ms**（对照基线 ~150ms）；静态复核 `return next` 与链上 `await item.settle` 同链 | 把「投递串行化」与「响应时机」拆开：`/api/input`、`/api/new` 入链后立即返回 202/pending（条目落 queued/pending），`settle` 与 `settleZcodeInput` 只在后台链完成；顺带评估把串行范围收窄为「按会话」而非全局，消除跨会话无谓排队 | `demo/test-zcode-control.mjs` 增并发用例：回合进行中发第二条，响应 ≤1s 且条目为 pending；终态后按既有语义移除/标失败；跨会话两条不互相阻塞 | 0.5～1 人日 |

补充说明：本次审查另记录若干中危/低危项——`adapters/cli-control.mjs` 中 `deliverViaZcodeUi`/account 回落分支/`selectionBefore` 回滚/`createViaZcodePipe` 等 WIP 死代码与失效的 `PET_ZCODE_UI_DELIVER` 开关（M1）；`/api/open`+`/api/new` 请求体无大小上限（`/api/input` 有 8KB/413，M3）；外壳注入脚本对当前 UI 空转与 `restore_window` 高度钳制（M5）；`demo/frame.mjs` 的 `.replaces?.('', '')` 拼写（当前恰好退化为原值）。这些项是否立项同样留待恢复排期时决定，默认不阻塞 v0.1.0。（原列的「缺进程级 unhandledRejection 兜底」已随 M2 修复，见表外说明。）

---

## 历史排期（2026-10-09 起暂停，保留估算）

| 原版本 | 内容 | 历史估算新增人日 |
|---|---|---|
| **v0.2** | PLAT-1/2/3（平台抽象 + Windows + Linux 全功能 + 安装包）+ PLAT-4（CI，视建仓时机） | ~15–24 |
| **v0.3** | AGT-1/2（ACP + OpenCode）+ AGT-4（Cursor hooks 观察）+ AGT-3 spike 与适配（Qoder） | ~14–22 |
| **v0.4** | BILL-1/2（计费骨架 + DeepSeek 官方 API）+ BILL-3（额度窗口预警） | ~10–16 |
| **v0.5** | RMT-1/2（本地 AgentOS + 远端观察）+ RMT-3（远端控制）+ MOB-1/2（PWA + 加固）+ BILL-4（多账号报表） | ~15–24 |
| **v1.0** | MOB-3/4（原生壳 + 推送 + 外网中继）+ RMT-4（原生桥接，视上游）+ SDK v1.0 冻结（对齐 20-roadmap W14 锚点） | ~10–16 |

> 上表为 2026-10-08 重排后的节奏：跨平台提前到 v0.2（W3 平台抽象先行，恰好解除后续全部新适配器的 Windows/Linux 依赖），更多软件集中在 v0.3，Coding Plan 监控集中在 v0.4；W4 远端整体后移至 v0.5 起，为前三版让出带宽。

## 风险登记（新增）

| 风险 | 影响 | 缓解 |
|---|---|---|
| 消费版 Coding Plan 普遍无公开计费 API | BILL 依赖估算 | 规则引擎为永远可用的基准层；官方 API 只做校准；对账断言防止估算漂移 |
| Cursor hook schema / Qoder 数据位置漂移（[U] 比例高） | AGT 返工 | spike 先行 + 降级路径（进程级观察不虚构状态） |
| Windows 透明/点击穿透与 macOS 行为差异 | PLAT-2 返工 | Win11 验证机先行实测（README §六.3）；不行则 Windows 首版退化为不透明迷你条 |
| Wayland 置顶/穿透限制 | PLAT-3 受限 | X11 全功能、Wayland 降级声明 |
| SSH 远端控制的命令注入面 | RMT-3 安全事故 | 只走 agent 子命令白名单；总控不存凭证；sudo 交还远端终端（§6.4 全数生效） |
| 手机外网暴露面 | MOB 安全 | 只经用户自管 AgentOS 中继，不经第三方云；写操作二次确认 |

## 与回归体系的关系

每个里程碑完成时：`multi-source-check`（含 `--live`）、`test-window`、`test-usage-calendar`、`usage-calendar-check` 全绿 + 新增专项断言；跨平台项（PLAT-2/3）在对应平台实机跑同一套验收（`platform-check.mjs` 待 PLAT-1 一并建立）。
