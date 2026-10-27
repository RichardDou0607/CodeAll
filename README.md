# CodeAll（Agent 工作框 / 总控）

> 一个常驻桌面的**工作框 / Agent 总控**。当前开发目标是与 Claude Code、Codex、Kimi Code 的 CLI 会话及已授权的 DeepSeek Harness 会话对话；已有的多源观察、用量和 ZCode 实验能力保留。**当前排期（2026-10-17 定向、10-19 增补）：v0.1.1 性能优化补丁线（仅 macOS，[docs/25](./docs/25-v0.1.1-scope.md)）＋ 其上追加的 v0.1.2 用量链路与刷新补丁（[docs/27](./docs/27-v0.1.2-scope.md)）＋ v0.1.3 手动停止状态补丁（[docs/28](./docs/28-v0.1.3-scope.md)）＋ v0.1.4 Coding Plan 订阅面板（[docs/29](./docs/29-v0.1.4-scope.md)）；v0.2.0 跨平台 Windows/Linux（[docs/24](./docs/24-v0.2.0-scope.md)）；v0.3.0 桌面端信息传输通道攻坚（v0.2.0 后启动，[docs/26](./docs/26-v0.3.0-scope.md)），均未发布不构成承诺**；计费、远端 AgentOS 与手机端仍是暂停排期的方向，不属于当前交付承诺。
>
> 当前对外可下载：**v0.1.4（2026-10-27，独立安装包）**。CLI 与 DS Harness 对话闭环的 v0.1.0 收口验收（V01–V06）已在源码层完成（证据：[qa/v0.1.0-acceptance-2026-10-10.md](./qa/v0.1.0-acceptance-2026-10-10.md)），正式版本待跨平台（v0.2.0）与整体形态完成后发布。已有观察/用量等功能仍在，但不构成新增开发承诺。

> English readers: see the full **English version → [English](#english)** at the bottom of this page.

## 〇、下载安装（macOS · Apple Silicon）

从 [GitHub Releases](https://github.com/RichardDou0607/CodeAll/releases) 下载 **v0.1.4** 的 `CodeAll_0.1.4_aarch64.dmg`，拖入 /Applications 即用：**安装包自带本地服务与 Node 运行时，不依赖源码仓库，也无需先装 Node 或其它任何依赖**（各家 Agent 软件本体当然需要各自安装并登录）。

```bash
# 首次打开：应用为 ad-hoc 签名、未经过 Apple 公证，macOS 门禁会拦截一次——任选其一：
xattr -cr /Applications/CodeAll.app     # 方式一：终端移除隔离属性后正常打开
# 方式二：在「应用程序」里右键 CodeAll → 打开 → 再点「打开」
# 较新 macOS 若仍拦截：系统设置 → 隐私与安全性 → 仍要打开
```

观察会话与用量仍可用；本轮重点是 Claude Code/Codex/Kimi Code **CLI 主会话**与 DSH 已授权插件会话的定向对话。DSH 未挂插件时仅观察/入队，不宣称已投递；ZCode app-server 控制为实验能力，不列入 v0.1.0 必过通道。开发模式（从源码运行）见下节。

## 一、已实现的能力（v0.1.0，全部本机实测）

### 观察（只读，零侵入，不碰凭证）

| 能力 | 说明 |
|---|---|
| **八源会话同窗** | DSH（workspace 注册表）/ Claude Code（转录 JSONL）/ Codex（rollout）/ Kimi Code（state.json + wire 事件流）/ ZCode（sqlite WAL 只读并发）/ OpenCode（opencode.db 只读，CLI 与桌面共用）/ Qoder（main.sqlite 结构化列，不读消息原文）/ Cursor（桌面 composer + CLI chats 双源）——统一目录、状态、标题、模型、思考档 |
| **软件四态面板** | 每个软件一行：未下载 → 未打开 → 已打开·未连接 → 打开·已连接；CLI 与桌面端**拆行**（进程按路径特征分家），带版本、进程数、会话计数、活跃度 |
| **会话三档视图** | 活跃 / 完成 / 隐藏（1 小时无活动自动归档，手动隐藏可叠加且有「手动」徽标与一键恢复）；子代理会话自动排除、计数不掺水 |
| **会话形态标注** | CLI / 桌面端 / IDE 三形态端到端标注（会话级 + 软件行级），形态筛选联动项目侧栏 |
| **实时事件流** | 回合边界、工具调用/结果、审批请求（Kimi 原生审批对、Claude/Codex 等价映射）→ 悬浮条与 App 界面秒级可见 |

### 控制（显式不越权）

| 能力 | 说明 |
|---|---|
| **CLI 定向投递** | Claude Code / Codex / Kimi Code / OpenCode（opencode run --session）/ Qoder（qoderclicn -p -r，CLI 与桌面会话可互接）/ Cursor CLI（cursor-agent -p --resume）：向明确 session ID 续接；2.5s 启动快速失败检测。进程启动不等于回合成功，终态与回复仍需核对；ZCode 独立管道保留为实验能力；Cursor 桌面会话无外部通道——只入队如实说明，不宣称已投递 |
| **新建 / 打开会话** | 已有 CLI 与 DSH 插件路径保留；不是 v0.1.0 的核心发布门槛，也不等于桌面 App 原生创建 |
| **输入队列** | 本地队列（`~/.agent-pet/input-queue.jsonl`，0600、自动轮转）只留未完成项，可复制/重发/删除/清空 |
| **DSH 投递（需授权）** | 挂载 dsh-pet 插件（只增不删配置），服务直连插件向指定会话投递；插件离线时只入队列，绝不绕凭证或执行无目标命令 |

### 用量与计费地基

| 能力 | 说明 |
|---|---|
| **六源 Token 计数** | Agent × 模型 × 自然日 × 形态 精确累计（60s 慢缓存 + 文件级增量，1.1GB 转录不进热路径）；子代理消耗归入父会话；OpenCode 双账本对账（message.tokens ≡ session_v2 累计）；Qoder/Cursor 客户端不落盘 token——如实降级不虚估 |
| **缓存命中率** | 每源/每模型命中率（input 语义按厂商分家：Anthropic 不含 cache / OpenAI 含），与官方 UI 对过账（ZCode「今日消耗」基准） |
| **时间窗 + 日历** | 当日/7 日/30 日切换；用量日历热力与逐日明细；会话行内 tok in/out |
| **Coding Plan 订阅面板 + 独立订阅页（v0.1.4）** | 15 家主流厂商「订阅身份 × 本地用量 × 配额/余额」：GLM Coding Plan（entitlement + model_usage 按 provider 精确拆分，**5h 滚动窗精确归属**）、DeepSeek（余额即配额，逐日/逐事件成本）、Cursor/Copilot（本地档位字段）、Claude/Codex/Kimi/Qoder（登录态/API 计费形态如实标注）、未安装厂商盘点；独立「订阅」页卡片式展示五时间窗（5h/今日/7日/30日/全部）+ 限额 + 刷新口径；凭证值不读、账号打码、云端配额不虚报 |

### 桌面外壳（Tauri v2）

| 能力 | 说明 |
|---|---|
| **双窗口并存** | 迷你条（透明、可拖拽、动态单行轮换）+ App 窗口（原生红黄绿控制）同时常驻；⤢ 唤出 / ✕ 收起不退出 |
| **全屏并存** | 迷你条 `CanJoinAllSpaces + FullScreenAuxiliary`——App 进原生全屏后迷你条仍留在桌面（置顶 📌 时浮于全屏之上） |
| **战术终端主题** | 亮/暗/跟随系统；CodeAll 品牌与五家原始软件图标 |
| **一键安装** | `apps/shell/run.sh --install` 装进 /Applications，日常 Spotlight 一键启动，外壳自动拉起本地服务 |

### 安全红线（贯穿实现）

写接口全部带 token（`~/.agent-pet/token`，0600，页面自动注入）+ Host 校验；一切观察只读（写库探测被明确拒绝并断言）；无头投递不越权（build 档）；不读用户 prompt 原文（Kimi lastPrompt 不读）；队列与计划文件 0600。

## 二、快速开始

```bash
apps/shell/run.sh --install           # 首次：构建并装进 /Applications；以后 Spotlight「CodeAll」即可
node demo/framed.mjs --port 7799    # 本地服务：八源观察 + CLI 控制通道 + SSE（外壳未起时可手动）
open http://127.0.0.1:7799/           # 迷你条；/window.html = App 界面（浏览器可同源访问）

# 回归与验收（当前基线全绿）
node demo/test-window.mjs             # App 界面渲染自检（85 项断言）
node demo/test-window-actions.mjs     # 交互行为回归（14 项）
node demo/test-mini.mjs               # 迷你条渲染自检（12 项）
node demo/test-open-routing.mjs       # 打开路由回归（CLI 走 Terminal、DSH/未知 ID 交插件）
node demo/test-follow-budget.mjs      # 跟随器预算回归（mtime 优先 + LRU 淘汰，claude/codex/kimi）
node demo/test-service-hardening.mjs  # 服务健壮性（请求体上限/异常响应/ID 解码 + 日志目录容错 + SSE 心跳）
node demo/test-bundle-service.mjs     # 独立安装包暂存回归（全部相对导入均存在）
node demo/test-usage-calendar.mjs     # 用量日历自检
node demo/test-plan-usage.mjs         # Coding Plan 订阅面板回归（身份/隐私/账本/窗口/UI）
node scripts/multi-source-check.mjs         # 扩展多源检查（含 ZCode 性能阈值；非当前发布门槛）
node scripts/catalog-check.mjs        # 会话目录验收（16 项）
node adapters/local-agents.mjs        # 软件四态探测（CLI 表格 / --json）
node adapters/cli-control.mjs --selftest   # 控制通道自检（投递·新建·打开）

# 其它演示
node demo/frame.mjs                   # 终端实时工作框；--replay 可离线回放录制
node scripts/check-fixtures.mjs       # 契约一致性（16/16 type、6 状态）
node scripts/replay-check.mjs --selftest   # 状态机回放 + 负例
```

`multi-source-check.mjs --live` 会向真实 Agent 会话投递并消耗模型额度，**不作为默认自检**；本轮最小发布验收与安全测试命令见 [docs/23](./docs/23-v0.1.0-scope.md)。

**运维口径**：`demo/framed.mjs` 代码更新后**必须重启服务/应用**才生效（外壳只在端口无监听时拉起，页面自动刷新不覆盖 Node 进程内存）。DSH 投递由服务直接探测已授权插件，不依赖 `PET_INPUT_CMD`；旧安装包不自动获得源码修复，需完成最终包复验。

## 三、文档索引

| 文件 | 内容 |
|---|---|
| [docs/00-interface-contract.md](./docs/00-interface-contract.md) | **规范事件契约 v1.2**（冻结）：事件/控制帧、状态机真值表、传输层 |
| [docs/10-architecture.md](./docs/10-architecture.md) | 总体架构、ADR、模块拆分、NFR |
| [docs/20-roadmap.md](./docs/20-roadmap.md) | 原始两阶段里程碑（M0–M10）、关键路径、SDK 冻结锚点 |
| [docs/21-multi-agent-adoption-plan.md](./docs/21-multi-agent-adoption-plan.md) | **多 Agent 接入计划 v3**：接入里程碑 M-A…M-U、§6 双域模型（本地直控 + 远端 AgentOS） |
| [docs/22-post-release-roadmap.md](./docs/22-post-release-roadmap.md) | 原后续构建任务，现已暂停排期 |
| [docs/23-v0.1.0-scope.md](./docs/23-v0.1.0-scope.md) | v0.1.0 真相源（已收口）：CLI + DSH 对话范围、优先级与发布验收 |
| [docs/24-v0.2.0-scope.md](./docs/24-v0.2.0-scope.md) | **当前真相源（v0.2.0）**：Windows/Linux 跨平台范围、优先级与发布验收 |
| [docs/25-v0.1.1-scope.md](./docs/25-v0.1.1-scope.md) | **真相源（v0.1.1）**：性能优化 + CLI 后台化收口范围与验收（仅 macOS，先行） |
| [docs/26-v0.3.0-scope.md](./docs/26-v0.3.0-scope.md) | **真相源（v0.3.0）**：桌面端信息传输通道攻坚（全量 spike 后择优落地，v0.2.0 后启动） |
| [docs/27-v0.1.2-scope.md](./docs/27-v0.1.2-scope.md) | 真相源（v0.1.2）：分钟兜底刷新 + 用量扫描四级增量（PERF-7）范围与验收 |
| [docs/28-v0.1.3-scope.md](./docs/28-v0.1.3-scope.md) | 真相源（v0.1.3）：手动停止 ≠ 出错（契约 v1.4 aborted 会话态）范围与验收 |
| [docs/29-v0.1.4-scope.md](./docs/29-v0.1.4-scope.md) | **当前真相源（v0.1.4）**：Coding Plan 订阅使用情况面板（15 家厂商：身份 × 本地用量 × 配额/余额）范围与验收 |
| [docs/40-adapters.md](./docs/40-adapters.md) | 后端适配矩阵（含 Cursor/Copilot/ACP 行）、观测能力与降级 |
| [docs/50-product-spec.md](./docs/50-product-spec.md) / [51](./docs/51-work-frame-spec.md) / [55](./docs/55-interaction-design.md) | 产品规格、工作框三形态、人机交互总体方案 |
| [docs/53-tauri-shell.md](./docs/53-tauri-shell.md) | Tauri 外壳实现（双窗口、Space 行为、内存口径） |
| [docs/CHANGELOG.md](./docs/CHANGELOG.md) | 变更日志（按日、按特性，含验收记录） |
| [demo/README.md](./demo/README.md) | 演示说明与「诚实边界」（输入如何送达 DSH 等） |
| [spikes/](./spikes/README.md) | 技术栈验证（Swift/AppKit、Tauri v2、Electron） |

## 四、当前开发任务

[v0.1.0 对话收口](./docs/23-v0.1.0-scope.md) 的 V01–V06 已于 2026-10-10 全部验收通过（CLI 指定会话收发、DSH 授权插件收发、误投/失败/重发保护、崩溃窗口记录与最终 macOS 安装包复验）。**当前排期（2026-10-17 用户定向，10-19 增补 v0.1.2）**：**v0.1.1 性能优化 + CLI 后台化收口**先行（[docs/25](./docs/25-v0.1.1-scope.md)，仅 macOS、功能语义零变化，PERF-0 基线 → PERF-1 快照脏标记 → PERF-2 日志增量读 → 其余按带宽，约 5.5～9.5 人日）；**v0.1.2 用量链路与刷新补丁**（[docs/27](./docs/27-v0.1.2-scope.md)：MRF-1 分钟兜底刷新修复空闲滞留 + PERF-7 用量扫描四级增量——事件循环让出/检查点跨重启/增长文件尾读/ZCode 水位，perf-verify 17/17）；**v0.2.0 Windows/Linux 跨平台**主线（[docs/24](./docs/24-v0.2.0-scope.md)：平台抽象层 → 双平台全功能 → 三平台安装包，发布门槛 W01–W07，与 v0.1.x 同代码区、v0.1.2 收口后 PLAT 合流）；**v0.3.0 桌面端信息传输通道攻坚**（[docs/26](./docs/26-v0.3.0-scope.md)，v0.2.0 后启动：SPIKE-1～5 全量 spike 出证据卡 → 按证据择优落地 1～2 家）。v0.1.0 验收登记的遗留小修排 v0.2.1。更多 Agent（ACP）、计费、远端和手机端仍保留在 [历史待办](./docs/22-post-release-roadmap.md)。原则不变：能力落地且完成验收，才进入对外保证。

## 五、许可证

本项目采用 [PolyForm Noncommercial License 1.0.0](./LICENSE)（源码可用 · 非商业用途免费；不属于 OSI 开源定义）。界面中的各家 Agent 图标为其各自所有者的商标。

## English

> CodeAll is a resident desktop **work-frame / agent cockpit**. The current development goal is conversation with Claude Code, Codex and Kimi Code CLI sessions, plus authorized DeepSeek Harness sessions; existing multi-source observation, usage tracking and ZCode experimental capabilities are retained. **Current schedule (set 2026-10-17, v0.1.2 added 10-19): v0.1.1 performance patch line (macOS only, [docs/25](./docs/25-v0.1.1-scope.md)) plus the follow-on v0.1.2 usage-pipeline & refresh patch ([docs/27](./docs/27-v0.1.2-scope.md)), the v0.1.3 manual-stop state patch ([docs/28](./docs/28-v0.1.3-scope.md)) plus the v0.1.4 Coding Plan panel ([docs/29](./docs/29-v0.1.4-scope.md)); v0.2.0 cross-platform Windows/Linux ([docs/24](./docs/24-v0.2.0-scope.md)); v0.3.0 desktop-app transmission-channel push (starts after v0.2.0, [docs/26](./docs/26-v0.3.0-scope.md)) — none released yet, no commitment**; billing, remote AgentOS and mobile remain paused and are not part of the current delivery promise.
>
> Current public download: **v0.1.4 (2026-10-27, standalone installer)**. The v0.1.0 acceptance for the CLI & DS Harness conversation loop (V01–V06) is complete at source level (evidence: [qa/v0.1.0-acceptance-2026-10-10.md](./qa/v0.1.0-acceptance-2026-10-10.md)); a formal release comes after cross-platform (v0.2.0) and the overall product shape are done. Existing observation/usage features remain available but are not a new development commitment.

### 0 · Download & Install (macOS · Apple Silicon)

Download the **v0.1.4** `CodeAll_0.1.4_aarch64.dmg` from [GitHub Releases](https://github.com/RichardDou0607/CodeAll/releases) and drag it into /Applications: **the installer ships its own local service and Node runtime** — no repo checkout or Node installation required (each agent product itself still needs to be installed and signed in by you).

```bash
# First launch: the app is ad-hoc signed and not notarized, macOS Gatekeeper blocks it once — pick one:
xattr -cr /Applications/CodeAll.app     # Option 1: remove the quarantine attribute in Terminal
# Option 2: right-click CodeAll in Applications → Open → Open
# On newer macOS, if still blocked: System Settings → Privacy & Security → Open Anyway
```

Session observation and usage tracking remain available; the focus is directed conversation with Claude Code / Codex / Kimi Code **CLI main sessions** and authorized DSH plugin sessions. With no DSH plugin mounted, DSH is observe/queue only — delivery is never claimed; ZCode app-server control is experimental and not part of the v0.1.0 guaranteed path. For development mode (running from source), see the next section.

### 1 · Implemented Capabilities (v0.1.0, all verified on this machine)

#### Observe (read-only, zero intrusion, no credentials touched)

| Capability | Description |
|---|---|
| **Five-source session view** | DSH (workspace registry) / Claude Code (transcript JSONL) / Codex (rollout) / Kimi Code (state.json + wire event stream) / ZCode (sqlite WAL, read-only, concurrent) — unified directory, status, title, model, thinking tier |
| **Four-state software panel** | One row per product: not downloaded → not running → running · not connected → running · connected; CLI and desktop apps are **split into separate rows** (processes distinguished by path), with version, process count, session count and liveness |
| **Three-tier session views** | Active / done / hidden (auto-archived after 1 h idle; manual hiding stacks, with a "manual" badge and one-click restore); sub-agent sessions are excluded and never inflate counts |
| **Session form labels** | End-to-end CLI / desktop / IDE labeling (session level + software row level); form filter drives the project sidebar |
| **Live event stream** | Turn boundaries, tool calls/results, approval requests (Kimi native approval pairs, Claude/Codex equivalent mapping) → visible on the mini bar and App UI within seconds |

#### Control (explicitly no overreach)

| Capability | Description |
|---|---|
| **CLI directed delivery** | Claude Code / Codex / Kimi Code: continue an explicit session ID; 2.5 s fast-fail detection on launch. Process start ≠ turn success — final state and reply still need verification; the ZCode pipeline remains experimental |
| **New / open sessions** | Existing CLI and DSH plugin paths are kept; not a core v0.1.0 release gate, and not the same as desktop-app-native creation |
| **Input queue** | Local queue (`~/.agent-pet/input-queue.jsonl`, 0600, auto-rotated) keeps only unfinished items; copy / resend / delete / clear |
| **DSH delivery (authorized)** | With the dsh-pet plugin mounted (adds config only, never removes), the service talks to the plugin directly for the selected session; when the plugin is offline, messages only queue — credentials are never bypassed and no target-less command ever runs |

#### Usage & Billing Foundation

| Capability | Description |
|---|---|
| **Five-source token counting** | Precise accumulation by Agent × model × calendar day × form (60 s slow cache + file-level increments; 1.1 GB transcripts stay off the hot path); sub-agent consumption is attributed to the parent session |
| **Cache hit rates** | Per source / per model hit rate (input semantics split by vendor: Anthropic excludes cache / OpenAI includes), reconciled against official UIs (ZCode "today's consumption" baseline) |
| **Time windows + calendar** | Today / 7 d / 30 d switching; usage calendar heatmap with daily detail; per-session tok in/out rows |
| **Coding Plan panel + dedicated subscriptions page (v0.1.4)** | 15 mainstream vendors: plan identity × local usage × quota/balance — GLM Coding Plan (entitlement cache + per-provider exact split, **exact 5h rolling window**), DeepSeek (balance-as-quota with per-day/per-event cost), Cursor/Copilot (local SKU fields), Claude/Codex/Kimi/Qoder (sign-in / API-billing state as-is), plus not-installed vendors; a dedicated Subscriptions page shows five time windows (5h/today/7d/30d/all) + limits + refresh semantics per plan card; credential values never read, accounts masked, cloud-only quotas honestly marked |

#### Desktop Shell (Tauri v2)

| Capability | Description |
|---|---|
| **Two coexisting windows** | Mini bar (transparent, draggable, rotating single-line) + App window (native traffic lights), both resident; ⤢ to summon / ✕ to collapse, neither quits |
| **Fullscreen coexistence** | Mini bar uses `CanJoinAllSpaces + FullScreenAuxiliary` — when the App goes native fullscreen the mini bar stays on the desktop (floats above fullscreen when pinned 📌) |
| **Tactical terminal theme** | Light / dark / follow system; CodeAll branding and the five original product icons |
| **One-click install** | `apps/shell/run.sh --install` installs into /Applications; daily launch via Spotlight; the shell auto-starts the local service |

#### Security Red Lines (throughout the implementation)

All write endpoints require a token (`~/.agent-pet/token`, 0600, auto-injected by pages) plus Host validation; all observation is read-only (write-to-store probes are explicitly rejected and asserted); headless delivery never escalates privileges (build tier); user prompt text is never read (Kimi lastPrompt is not read); queue and schedule files are 0600.

### 2 · Quick Start

```bash
apps/shell/run.sh --install           # First time: build and install into /Applications; afterwards just Spotlight "CodeAll"
node demo/framed.mjs --port 7799    # Local service: five-source observation + CLI control channel + SSE (manual start when the shell is not running)
open http://127.0.0.1:7799/           # Mini bar; /window.html = App UI (same-origin accessible from a browser)

# Regression & acceptance (current baseline all green)
node demo/test-window.mjs             # App UI render self-check (85 assertions)
node demo/test-window-actions.mjs     # Interaction behavior regression (14 items)
node demo/test-mini.mjs               # Mini bar render self-check (12 items)
node demo/test-open-routing.mjs       # Open-routing regression (CLI → Terminal; DSH/unknown IDs → plugin)
node demo/test-follow-budget.mjs      # Follower budget regression (mtime-first + LRU eviction; claude/codex/kimi)
node demo/test-service-hardening.mjs  # Service hardening (body limits/error responses/ID decoding + log-dir faults + SSE heartbeat)
node demo/test-bundle-service.mjs     # Standalone bundle staging regression (all relative imports present)
node demo/test-usage-calendar.mjs     # Usage calendar self-check
node demo/test-plan-usage.mjs         # Coding Plan panel regression (identity/privacy/ledger/windows/UI)
node scripts/multi-source-check.mjs         # Extended multi-source check (incl. ZCode perf threshold; not a current release gate)
node scripts/catalog-check.mjs        # Session catalog acceptance (16 items)
node adapters/local-agents.mjs        # Four-state software probe (CLI table / --json)
node adapters/cli-control.mjs --selftest   # Control channel self-test (deliver · new · open)

# Other demos
node demo/frame.mjs                   # Terminal live work-frame; --replay for offline playback
node scripts/check-fixtures.mjs       # Contract consistency (16/16 types, 6 states)
node scripts/replay-check.mjs --selftest   # State-machine replay + negative cases
```

`multi-source-check.mjs --live` sends messages to real agent sessions and consumes model quota — **it is not a default self-check**; the minimal release acceptance and safety test commands are in [docs/23](./docs/23-v0.1.0-scope.md).

**Ops note**: after `demo/framed.mjs` code changes you **must restart the service/app** for them to take effect (the shell only starts the service when the port is free; page auto-refresh does not reload the Node process). DSH delivery is handled by the service probing the authorized plugin directly — it does not depend on `PET_INPUT_CMD`; old installers do not automatically receive source fixes — final package re-verification is required.

### 3 · Docs Index

| File | Content |
|---|---|
| [docs/00-interface-contract.md](./docs/00-interface-contract.md) | **Spec event contract v1.2** (frozen): event/control frames, state-machine truth table, transport |
| [docs/10-architecture.md](./docs/10-architecture.md) | Overall architecture, ADRs, module split, NFRs |
| [docs/20-roadmap.md](./docs/20-roadmap.md) | Original two-phase milestones (M0–M10), critical path, SDK freeze anchors |
| [docs/21-multi-agent-adoption-plan.md](./docs/21-multi-agent-adoption-plan.md) | **Multi-agent adoption plan v3**: milestones M-A…M-U, §6 dual-domain model (local direct control + remote AgentOS) |
| [docs/22-post-release-roadmap.md](./docs/22-post-release-roadmap.md) | Original follow-up build tasks, scheduling now paused |
| [docs/23-v0.1.0-scope.md](./docs/23-v0.1.0-scope.md) | v0.1.0 truth source (closed out): CLI + DSH conversation scope, priorities and release acceptance |
| [docs/24-v0.2.0-scope.md](./docs/24-v0.2.0-scope.md) | **Current truth source (v0.2.0)**: Windows/Linux cross-platform scope, priorities and release acceptance |
| [docs/25-v0.1.1-scope.md](./docs/25-v0.1.1-scope.md) | **Truth source (v0.1.1)**: performance optimization + CLI backgrounding closure (macOS only, goes first) |
| [docs/26-v0.3.0-scope.md](./docs/26-v0.3.0-scope.md) | **Truth source (v0.3.0)**: desktop-app transmission-channel push (full spikes, then land 1–2 by evidence; after v0.2.0) |
| [docs/27-v0.1.2-scope.md](./docs/27-v0.1.2-scope.md) | **Current truth source (v0.1.2)**: minute fallback refresh + four-level incremental usage scanning (PERF-7) |
| [docs/28-v0.1.3-scope.md](./docs/28-v0.1.3-scope.md) | Truth source (v0.1.3): manual stop ≠ error (contract v1.4 aborted session state) scope and acceptance |
| [docs/29-v0.1.4-scope.md](./docs/29-v0.1.4-scope.md) | **Current truth source (v0.1.4)**: Coding Plan panel (15 vendors: identity × local usage × quota/balance) scope and acceptance |
| [docs/40-adapters.md](./docs/40-adapters.md) | Backend adapter matrix (incl. Cursor/Copilot/ACP rows), observation capabilities and degradation |
| [docs/50-product-spec.md](./docs/50-product-spec.md) / [51](./docs/51-work-frame-spec.md) / [55](./docs/55-interaction-design.md) | Product spec, work-frame three forms, human-machine interaction plan |
| [docs/53-tauri-shell.md](./docs/53-tauri-shell.md) | Tauri shell implementation (dual windows, Spaces behavior, memory accounting) |
| [docs/CHANGELOG.md](./docs/CHANGELOG.md) | Changelog (per day, per feature, incl. acceptance records) |
| [demo/README.md](./demo/README.md) | Demo notes and "honesty boundaries" (how input reaches DSH, etc.) |
| [spikes/](./spikes/README.md) | Tech-stack validation (Swift/AppKit, Tauri v2, Electron) |

### 4 · Current Development

The v0.1.0 conversation loop ([docs/23](./docs/23-v0.1.0-scope.md)) passed all V01–V06 acceptances on 2026-10-10 (CLI directed send/receive, DSH authorized plugin send/receive, mis-delivery/failure/resend protection, crash-window records and final macOS installer re-verification). **Current schedule (set by the owner on 2026-10-17, v0.1.2 added 10-19)**: **v0.1.1 performance + CLI-backgrounding closure** goes first ([docs/25](./docs/25-v0.1.1-scope.md), macOS only, zero semantic change, ~5.5–9.5 person-days); **v0.1.2 usage-pipeline & refresh patch** ([docs/27](./docs/27-v0.1.2-scope.md): MRF-1 minute fallback refresh fixing idle staleness + PERF-7 four-level incremental usage scanning — event-loop yielding / restart checkpoint / grown-file tail reads / ZCode watermark, perf-verify 17/17); **v0.2.0 Windows/Linux cross-platform** is the main line ([docs/24](./docs/24-v0.2.0-scope.md): platform abstraction → full functionality on both platforms → three-platform installers, release gates W01–W07; PLAT merges after v0.1.2 closes since both touch the same code); **v0.3.0 desktop-app transmission-channel push** starts after v0.2.0 ([docs/26](./docs/26-v0.3.0-scope.md): SPIKE-1…5 evidence cards, then land 1–2 vendors by evidence). Leftover fixes registered in the v0.1.0 acceptance are scheduled for v0.2.1. More agents (ACP), billing, remote and mobile remain in the [historical backlog](./docs/22-post-release-roadmap.md). Unchanged principle: a capability enters the public guarantee only after it is implemented and accepted.

### License

[PolyForm Noncommercial License 1.0.0](./LICENSE) — free for any noncommercial use (source-available, not OSI open source). Third-party agent logos are trademarks of their respective owners.
