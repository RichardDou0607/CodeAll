# CodeAll（Agent 工作框 / 桌宠）

> 一个常驻桌面的**工作框 / Agent 总控**。当前开发目标是与 Claude Code、Codex、Kimi Code 的 CLI 会话及已授权的 DeepSeek Harness 会话对话；已有的多源观察、用量和 ZCode 实验能力保留。**跨平台（Windows/Linux）是当前开发方向（v0.2.0 进行中，见 [docs/24](./docs/24-v0.2.0-scope.md)，未发布不构成承诺）**；计费、远端 AgentOS 与手机端仍是暂停排期的方向，不属于当前交付承诺。
>
> 当前已发布：**v0.1.0（2026-10-10）**，v0.1.0-alpha（2026-10-08）之后按 [docs/23-v0.1.0-scope.md](./docs/23-v0.1.0-scope.md) 收口 **macOS 的 CLI 与 DS Harness 对话闭环**，V01–V06 发布验收已全部通过（证据：[qa/v0.1.0-acceptance-2026-10-10.md](./qa/v0.1.0-acceptance-2026-10-10.md)）。已有观察/用量等功能仍在，但不构成新增开发承诺。

## 〇、下载安装（macOS · Apple Silicon）

从 [GitHub Releases](https://github.com/RichardDou0607/CodeAll/releases) 下载 `CodeAll_0.1.0_aarch64.dmg`，拖入 /Applications 即用：**安装包自带本地服务与 Node 运行时，不依赖源码仓库，也无需先装 Node 或其它任何依赖**（各家 Agent 软件本体当然需要各自安装并登录）。

```bash
# 首次打开：安装包未做开发者证书签名，macOS 会拦截一次——任选其一：
xattr -cr /Applications/CodeAll.app     # 方式一：终端执行后正常打开
# 方式二：在「应用程序」里右键 CodeAll → 打开 → 再点「打开」
```

观察会话与用量仍可用；本轮重点是 Claude Code/Codex/Kimi Code **CLI 主会话**与 DSH 已授权插件会话的定向对话。DSH 未挂插件时仅观察/入队，不宣称已投递；ZCode app-server 控制为实验能力，不列入 v0.1.0 必过通道。开发模式（从源码运行）见下节。

## 一、已实现的能力（v0.1.0，全部本机实测）

### 观察（只读，零侵入，不碰凭证）

| 能力 | 说明 |
|---|---|
| **五源会话同窗** | DSH（workspace 注册表）/ Claude Code（转录 JSONL）/ Codex（rollout）/ Kimi Code（state.json + wire 事件流）/ ZCode（sqlite WAL 只读并发）——统一目录、状态、标题、模型、思考档 |
| **软件四态面板** | 每个软件一行：未下载 → 未打开 → 已打开·未连接 → 打开·已连接；CLI 与桌面端**拆行**（进程按路径特征分家），带版本、进程数、会话计数、活跃度 |
| **会话三档视图** | 活跃 / 完成 / 隐藏（1 小时无活动自动归档，手动隐藏可叠加且有「手动」徽标与一键恢复）；子代理会话自动排除、计数不掺水 |
| **会话形态标注** | CLI / 桌面端 / IDE 三形态端到端标注（会话级 + 软件行级），形态筛选联动项目侧栏 |
| **实时事件流** | 回合边界、工具调用/结果、审批请求（Kimi 原生审批对、Claude/Codex 等价映射）→ 悬浮条与 App 界面秒级可见 |

### 控制（显式不越权）

| 能力 | 说明 |
|---|---|
| **CLI 定向投递** | Claude Code / Codex / Kimi Code：向明确 session ID 续接；2.5s 启动快速失败检测。进程启动不等于回合成功，终态与回复仍需核对；ZCode 独立管道保留为实验能力 |
| **新建 / 打开会话** | 已有 CLI 与 DSH 插件路径保留；不是 v0.1.0 的核心发布门槛，也不等于桌面 App 原生创建 |
| **输入队列** | 本地队列（`~/.agent-pet/input-queue.jsonl`，0600、自动轮转）只留未完成项，可复制/重发/删除/清空 |
| **DSH 投递（需授权）** | 挂载 dsh-pet 插件（只增不删配置），服务直连插件向指定会话投递；插件离线时只入队列，绝不绕凭证或执行无目标命令 |

### 用量与计费地基

| 能力 | 说明 |
|---|---|
| **五源 Token 计数** | Agent × 模型 × 自然日 × 形态 精确累计（60s 慢缓存 + 文件级增量，1.1GB 转录不进热路径）；子代理消耗归入父会话 |
| **缓存命中率** | 每源/每模型命中率（input 语义按厂商分家：Anthropic 不含 cache / OpenAI 含），与官方 UI 对过账（ZCode「今日消耗」基准） |
| **时间窗 + 日历** | 当日/7 日/30 日切换；用量日历热力与逐日明细；会话行内 tok in/out |

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
node demo/framed.mjs --port 7799    # 本地服务：五源观察 + CLI 控制通道 + SSE（外壳未起时可手动）
open http://127.0.0.1:7799/           # 迷你条；/window.html = App 界面（浏览器可同源访问）

# 回归与验收（当前基线全绿）
node demo/test-window.mjs             # App 界面渲染自检（85 项断言）
node demo/test-window-actions.mjs     # 交互行为回归（14 项）
node demo/test-mini.mjs               # 迷你条渲染自检（12 项）
node demo/test-open-routing.mjs       # 打开路由回归（CLI 走 Terminal、DSH/未知 ID 交插件）
node demo/test-follow-budget.mjs      # 跟随器预算回归（mtime 优先 + LRU 淘汰，claude/codex/kimi）
node demo/test-service-hardening.mjs  # 服务健壮性（日志目录不可写不崩 + 无 DSH 日志仍有 2s 心跳）
node demo/test-usage-calendar.mjs     # 用量日历自检
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
| [docs/40-adapters.md](./docs/40-adapters.md) | 后端适配矩阵（含 Cursor/Copilot/ACP 行）、观测能力与降级 |
| [docs/50-product-spec.md](./docs/50-product-spec.md) / [51](./docs/51-work-frame-spec.md) / [55](./docs/55-interaction-design.md) | 产品规格、工作框三形态、人机交互总体方案 |
| [docs/53-tauri-shell.md](./docs/53-tauri-shell.md) | Tauri 外壳实现（双窗口、Space 行为、内存口径） |
| [docs/CHANGELOG.md](./docs/CHANGELOG.md) | 变更日志（按日、按特性，含验收记录） |
| [demo/README.md](./demo/README.md) | 演示说明与「诚实边界」（输入如何送达 DSH 等） |
| [spikes/](./spikes/README.md) | 技术栈验证（Swift/AppKit、Tauri v2、Electron） |

## 四、当前开发任务

[v0.1.0 对话收口](./docs/23-v0.1.0-scope.md) 的 V01–V06 已于 2026-10-10 全部验收通过（CLI 指定会话收发、DSH 授权插件收发、误投/失败/重发保护、崩溃窗口记录与最终 macOS 安装包复验）。**当前开发：v0.2.0 Windows/Linux 跨平台**（[docs/24](./docs/24-v0.2.0-scope.md)，2026-10-10 用户定向恢复历史排期 W3）：平台抽象层 → 双平台全功能 → 三平台安装包，发布门槛 W01–W07；v0.1.0 验收登记的遗留小修排 v0.2.1。更多 Agent、计费、远端和手机端仍保留在 [历史待办](./docs/22-post-release-roadmap.md)。原则不变：能力落地且完成验收，才进入对外保证。
