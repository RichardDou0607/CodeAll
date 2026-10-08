# CodeAll（Agent 工作框 / 桌宠）

> 一个常驻桌面的**工作框 / Agent 总控**：统一**观察与控制**本机各个 AI Agent（DeepSeek Harness、Claude Code、Codex、Kimi Code、ZCode），统计各厂商 Coding Plan 的 Token 用量，并经 AgentOS 连接远端服务器与「原生AI操作系统」（终局方向，[docs/21 §6](./docs/21-multi-agent-adoption-plan.md)）；宠物形象是框内的**可选**陪伴元素。
>
> 当前版本：**v0.1.0-alpha（2026-10-08，alpha 测试版）**——功能可用但仍在快速迭代，接口与数据格式可能调整。后续计划见 [docs/22-post-release-roadmap.md](./docs/22-post-release-roadmap.md)。

## 〇、下载安装（macOS · Apple Silicon）

从 [GitHub Releases](https://github.com/RichardDou0607/CodeAll/releases) 下载 `CodeAll_0.1.0_aarch64.dmg`，拖入 /Applications 即用：**安装包自带本地服务与 Node 运行时，不依赖源码仓库，也无需先装 Node 或其它任何依赖**（各家 Agent 软件本体当然需要各自安装并登录）。

```bash
# 首次打开：当前为 alpha 测试版、未做开发者证书签名，macOS 会拦截一次——任选其一：
xattr -cr /Applications/CodeAll.app     # 方式一：终端执行后正常打开
# 方式二：在「应用程序」里右键 CodeAll → 打开 → 再点「打开」
```

观察五源会话、用量统计开箱即用；向会话投递/新建/打开走 CLI 通道（需要对应 Agent 的 CLI 可用）；DSH 自动投递属进阶功能（需挂载插件，见 demo/README）。开发模式（从源码运行）见下节。

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
| **CLI 投递通道 ×4** | Claude Code / Codex / Kimi Code / ZCode：向既有会话无头投递（ZCode 显式 `--mode build` 压掉无头默认 yolo）；2.5s 快速失败检测，不谎报「已投递」 |
| **新建 / 打开会话** | tmux window 或 Terminal 新窗口打开对应 CLI（`--resume` / `-S`）；新建落指定项目目录 |
| **输入队列** | 本地队列（`~/.agent-pet/input-queue.jsonl`，0600、自动轮转）只留未完成项，可复制/重发/删除/清空 |
| **DSH 投递（需授权）** | 挂载 dsh-pet 插件（只增不删配置）+ `PET_INPUT_CMD` 接线后自动送达；未挂载时只入队列、绝不绕凭证 |

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
node demo/test-usage-calendar.mjs     # 用量日历自检
node scripts/multi-source-check.mjs --live  # 多源适配验收（63 项，--live 含四家真实投递闭环）
node scripts/catalog-check.mjs        # 会话目录验收（16 项）
node adapters/local-agents.mjs        # 软件四态探测（CLI 表格 / --json）
node adapters/cli-control.mjs --selftest   # 控制通道自检（投递·新建·打开）

# 其它演示
node demo/frame.mjs                   # 终端实时工作框；--replay 可离线回放录制
node scripts/check-fixtures.mjs       # 契约一致性（16/16 type、6 状态）
node scripts/replay-check.mjs --selftest   # 状态机回放 + 负例
```

**运维口径**：`demo/framed.mjs` 代码更新后**必须重启服务/应用**才生效（外壳只在端口无监听时拉起，页面自动刷新不覆盖 Node 进程内存）；从 Spotlight 直开 App 时 DSH 自动投递（`PET_INPUT_CMD`）不会接线，需经 `run.sh --restart-server` 或挂载插件后用 run.sh 启动——这是 [docs/22](./docs/22-post-release-roadmap.md) 待办之一。

## 三、文档索引

| 文件 | 内容 |
|---|---|
| [docs/00-interface-contract.md](./docs/00-interface-contract.md) | **规范事件契约 v1.2**（冻结）：事件/控制帧、状态机真值表、传输层 |
| [docs/10-architecture.md](./docs/10-architecture.md) | 总体架构、ADR、模块拆分、NFR |
| [docs/20-roadmap.md](./docs/20-roadmap.md) | 原始两阶段里程碑（M0–M10）、关键路径、SDK 冻结锚点 |
| [docs/21-multi-agent-adoption-plan.md](./docs/21-multi-agent-adoption-plan.md) | **多 Agent 接入计划 v3**：接入里程碑 M-A…M-U、§6 双域模型（本地直控 + 远端 AgentOS） |
| [docs/22-post-release-roadmap.md](./docs/22-post-release-roadmap.md) | **v0.1.0 后续构建任务**：计费展示 / OpenCode·Qoder·Cursor / Windows·Linux / 远端 AgentOS / 手机端 |
| [docs/40-adapters.md](./docs/40-adapters.md) | 后端适配矩阵（含 Cursor/Copilot/ACP 行）、观测能力与降级 |
| [docs/50-product-spec.md](./docs/50-product-spec.md) / [51](./docs/51-work-frame-spec.md) / [55](./docs/55-interaction-design.md) | 产品规格、工作框三形态、人机交互总体方案 |
| [docs/53-tauri-shell.md](./docs/53-tauri-shell.md) | Tauri 外壳实现（双窗口、Space 行为、内存口径） |
| [docs/CHANGELOG.md](./docs/CHANGELOG.md) | 变更日志（按日、按特性，含验收记录） |
| [demo/README.md](./demo/README.md) | 演示说明与「诚实边界」（输入如何送达 DSH 等） |
| [spikes/](./spikes/README.md) | 技术栈验证（Swift/AppKit、Tauri v2、Electron） |

## 四、后续开发计划（摘要，详见 [docs/22](./docs/22-post-release-roadmap.md)）

| 工作流 | 主题 | 首个里程碑 |
|---|---|---|
| **W1 BILL** | 各厂商 Coding Plan 计费展示：官方 API（DeepSeek balance 先行）+ 本地规则估算双路，额度环 / 窗口倒计时 / 预警 / 多账号 | BILL-1 计划配置模型 + 计费页（v0.2） |
| **W2 AGT** | OpenCode（ACP 通道，恢复注册行）、Qoder（spike 先行）、Cursor（hooks 观察）、Copilot CLI（可选） | AGT-1 ACP 统一通道（v0.2） |
| **W3 PLAT** | Windows / Linux 适配：平台抽象层（路径/进程/版本/终端）→ 双平台全功能 + 安装包 + CI 矩阵 | PLAT-1 平台抽象（v0.3） |
| **W4 RMT** | 远端能力：本地 AgentOS 观察 → SSH 远端观察（`agentos@<host>` 主机分组）→ 远端控制（子命令白名单，凭证零存储）；对接「原生AI操作系统」 | RMT-1 本地 AgentOS（v0.2） |
| **W5 MOB** | 手机端：移动 PWA（二维码配对）→ 原生壳 + 审批/额度推送 → 经自管 AgentOS 主机外网中继 | MOB-1 PWA（v0.5） |

版本节奏（单人折算）：**v0.2** 计费骨架 + ACP/OpenCode + 本地 AgentOS → **v0.3** Windows + Cursor → **v0.4** Linux + Qoder + 远端观察 + 额度预警 → **v0.5** 远端控制 + PWA → **v1.0** 原生手机壳 + 外网中继 + 适配器 SDK 冻结。

原则不变：**能力落地才进软件列表**（v0.1.0 首发 AgentOS/OpenCode 即按此移除，接入后回归注册表）。
