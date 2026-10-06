# Agent 工作框 / 桌宠（Agent Desktop Pet）

> 一个常驻桌面的**工作框 / Agent 总控**：统一**观察与控制**本机各个 AI Agent（DeepSeek Harness、Claude Code、Codex、Kimi Code…），并经 AgentOS 控制多台远端服务器（终局方向，[docs/21 §6](./docs/21-multi-agent-adoption-plan.md)）；宠物形象是框内的**可选**陪伴元素。
> 规划文档集状态：**DRAFT（2026-10-05）**，由 Agent Teams 并行产出（1 位 Lead + 6 名队友，各自独立写作用域）。所有事实标注了来源：本机实测 / 官方文档 URL，未验证项显式标注。

## 一、两阶段目标

| 阶段 | 周期 | 目标 | 判定标准 |
|---|---|---|---|
| **Phase 1** | W1–W8 | **DeepSeek 工作框 demo**：真实 DSH 会话驱动工作框状态变化，可 5 分钟演示 | [70-team-and-metrics.md](./docs/70-team-and-metrics.md) Gate 1 |
| **Phase 2** | W9–W20 | **多 Agent 工作框**：Claude Code / Codex / Kimi Code / ACP 等适配器 + 适配器 SDK + 皮肤/商业化 + 分发 | [70-team-and-metrics.md](./docs/70-team-and-metrics.md) Gate 2 |
| **Phase 3（方向）** | W21+ | **远端 AgentOS 舰队**：总控经 AgentOS（每台远端服务器一个实例）同时观察与控制多台远端服务器 | [21-multi-agent-adoption-plan.md §6](./docs/21-multi-agent-adoption-plan.md)（方向已定，验收待细化） |

## 二、已确认的关键决策（2026-10-05）

1. **产品形态**：默认 = **悬浮卡片**，首行固定显示「状态 + 当前动作 + 计时 + 未决审批」，其下**每个会话一行**；**宠物形象默认关闭**，可选开启。
2. **技术栈**：**Tauri v2**（.app 4.0 MB、空闲 `phys_footprint` 57.1 MB、透明+置顶+点击穿透+socket→JSONL→状态全链路本机跑通）；备选纯 Swift+AppKit（Windows 归零）；Electron 作为备选 B。
3. **事件契约**：`docs/00-interface-contract.md` **v1.2 冻结**（16 个 type 字符串 / 16 行、Hub 独占状态机与计时、Phase 1 只读、控制帧 ctl、瞬态/持久错误）。
4. **DSH 事件获取**：主路径 = Cordis 本地插件（进程内 <1 ms，patch 热重载已实测，**需用户授权改一行配置**）；**兜底 = 会话日志多帧 zstd 增量 tail（p50 247 ms，零侵入，已交付脚本）** → 路线图按「兜底先跑通」安排，不阻塞。
5. **内存验收口径**：`phys_footprint` 合计（RSS 仅作参考）。
6. **分发**：优先 DMG 直分发（`macOSPrivateApi` 与 App Store 审核存在冲突，见风险登记册 R-12）。

## 三、现在就有的可运行演示（2026-10-06）

> 完整演示说明与「诚实边界」见 [demo/README.md](./demo/README.md)。**已跑通的是数据链路（真实 DSH 会话 → 规范事件 → 状态机 → 工作框卡片/悬浮窗）与悬浮窗输入队列；Tauri 真·桌面外壳与常驻 Hub 守护进程尚未实现**（路线图 M0–M3）。**多源观察已上线（M-A/M-B/M-C/M-H）：Claude Code 转录与 Codex rollout 只读接入，与 DSH 会话同窗并列；Kimi Code 按 LevelDB 降级为四态面板（存活 + 近似计数）。**

```bash
# ★ 悬浮窗（多源 / 多项目 / 多会话状态 + Agent·模型·思考程度 + **软件四态面板** + 缩减输入框）——最接近最终形态的演示
#   桌面窗口版（推荐，日常使用）：一键安装后从启动台/Spotlight 打开
apps/shell/run.sh --install           # 首次：构建并装进 /Applications；以后直接打开「AgentPet」即可（外壳自动拉起服务）
node demo/framed.mjs --port 7799    # 本地服务：DSH 日志tail/插件 + Claude Code 转录tail + Codex rollout tail + SSE
open http://127.0.0.1:7799/         # 悬浮窗页面（demo/window.html）
node demo/test-window.mjs           # 悬浮窗渲染自检（38 项断言）
node adapters/session-catalog.mjs   # DSH 会话目录（~20ms）
node adapters/claude-code-adapter.mjs    # Claude Code 会话目录（本机 11 项目 / 48 会话，~18ms）
node adapters/codex-adapter.mjs          # Codex 会话目录（13 主会话 / 19 子代理自动排除，~19ms）
node adapters/kimi-code-adapter.mjs      # Kimi Code 会话目录（A 路径：state.json + wire 事件流，~4ms；--status 看四态数据）
node adapters/local-agents.mjs      # 软件四态探测：已连接 / 已打开·未连接 / 未打开 / 未下载（~40ms）
node adapters/cli-control.mjs --selftest # 控制通道自检：claude/codex/kimi 投递·新建·打开（Terminal 机制验证）
node scripts/multi-source-check.mjs # 多源适配验收（28 项静态 + --live 3 项真实投递闭环，共 31 项）

# 其它演示
node demo/frame.mjs                 # 终端实时工作框：跟随你正在跑的 DSH 会话（约 400ms 刷新）
open demo/frame.html                # 浏览器可视化：自包含单文件，548 条真实事件 + 17 条合成多会话事件
node demo/record-replay.mjs         # 录制真实会话 → fixtures/session-replay.pet.jsonl
node demo/frame.mjs --replay fixtures/session-replay.pet.jsonl --speed 8   # 离线回放
node demo/test-html.mjs             # 可视化页自检（8 项断言）
```

**悬浮窗输入说明**：默认只读 —— 输入进本地队列（`~/.agent-pet/input-queue.jsonl`，0600、超 200 条/1MB 自动轮转）并显示「待投递」，队列项可**复制 / 重发 / 删除 / 一键清空**；要自动送达 DSH，需要授权挂载一个只增不删的 DSH 插件（或设置 `PET_INPUT_CMD`），详见 [demo/README.md](./demo/README.md#-输入如何真正送达-dsh当前是本地队列)。本地服务（127.0.0.1）的**写接口需带 token**（`~/.agent-pet/token`，0600，页面自动注入；curl 见 demo/README），并有 Host 校验防线。

## 四、文档索引

| 文件 | 内容 | 负责人 |
|---|---|---|
| [docs/00-interface-contract.md](./docs/00-interface-contract.md) | **规范事件契约 v1.2**（冻结）：事件/控制帧、16 个 type、状态机真值表、传输层、工作框保证 | Lead |
| [docs/10-architecture.md](./docs/10-architecture.md) | 总体架构、ADR、模块拆分、工作框模块、NFR、与 DSH 的边界 | Lead |
| [docs/20-roadmap.md](./docs/20-roadmap.md) | 两阶段里程碑（M0–M10）、关键路径、工作量估算、Demo 脚本 | roadmap-synth |
| [docs/21-multi-agent-adoption-plan.md](./docs/21-multi-agent-adoption-plan.md) | **多 Agent 接入计划 v3**：首批锁定 DSH/Claude Code/Codex/Kimi Code；本机盘点 11 项；**总控双域模型**（本地多 agent 直控 + 远端 AgentOS 执行体，§6）；观察→目录→控制里程碑、排期与风险 | Lead |
| [docs/30-implementation-stack.md](./docs/30-implementation-stack.md) | 技术栈对比与实测（Tauri/Swift/Electron）、骨架目录、适配器 SDK 形态 | pet-runtime-scout |
| [docs/35-dsh-pet-bridge.md](./docs/35-dsh-pet-bridge.md) | DSH 事件获取 5 条路径实测（插件/日志 tail/hooks/SDK/ MCP）、映射表、上游需求 | dsh-bridge-researcher |
| [docs/40-adapters.md](./docs/40-adapters.md) | 10 个后端的适配矩阵、P0/P1/P2 排序、观测能力与降级、漂移证据 | adapter-recon |
| [docs/50-product-spec.md](./docs/50-product-spec.md) | 状态机细化、交互、资产管线与授权、角色与文案、商业化、验收清单 | product-experience |
| [docs/51-work-frame-spec.md](./docs/51-work-frame-spec.md) | **工作框规格**：悬浮卡片/窄条/宠物三形态、信息层级、交互、验收 | product-experience |
| [docs/55-interaction-design.md](./docs/55-interaction-design.md) | **人机交互总体方案 v1**：双面模型（常驻卡片 + 控制台）、软件四态×动作表、选择模型三规则、队列术语统一、键盘总表、空态矩阵、UX-A 验收 | Lead |
| [docs/60-risk-register.md](./docs/60-risk-register.md) | 风险登记册（21 条）、合规与隐私、竞品、Pre-mortem | product-experience |
| [docs/70-team-and-metrics.md](./docs/70-team-and-metrics.md) | 团队分工、Sprint 节奏、Gate 1/2 验收指标、度量 | Lead |
| [docs/90-research-notes.md](./docs/90-research-notes.md) | 各队友的原始证据（命令、输出、来源 URL） | 全体 |
| [docs/99-verification-report.md](./docs/99-verification-report.md) | 独立验收报告（契约审阅 + 跨文档交叉审阅 + 复现命令） | contract-verifier |

## 五、可运行资产

| 路径 | 说明 |
|---|---|
| [demo/](./demo/README.md) | **演示**：悬浮窗（window.html + framed.mjs）、终端实时工作框、浏览器可视化（frame.html）、录制/回放与自检脚本 |
| [fixtures/contract-sample.pet.jsonl](./fixtures/contract-sample.pet.jsonl) | 契约样本（37 事件 + 3 控制帧）：16 个 type 字符串、6 状态、审批超时、乱序、未知事件 |
| [fixtures/session-replay.pet.jsonl](./fixtures/session-replay.pet.jsonl) | 真实 DSH 会话录制（548 条规范事件，2026-10-05 11:56–12:49） |
| [scripts/check-fixtures.mjs](./scripts/check-fixtures.mjs) | 契约一致性自检（帧分类、必填字段、枚举、seq、requestId 配对、真值表回放） |
| [scripts/replay-check.mjs](./scripts/replay-check.mjs) | 独立实现的状态机回放校验器（可用于 CI 门禁） |
| [scripts/dsh-session-to-pet.mjs](./scripts/dsh-session-to-pet.mjs) | DSH 会话日志（多帧 zstd）→ 规范事件 |
| [adapters/_reference/dsh-log-tail.mjs](./adapters/_reference/dsh-log-tail.mjs) | DSH 日志增量 tail 参考实现（含 hello/ack 握手、半帧处理） |
| [adapters/_reference/hub-minimal.mjs](./adapters/_reference/hub-minimal.mjs) | **最小 Hub 原型**（约 90 行）：契约状态机 + 计数器，可直接跑 fixture 证明契约可实现 |
| [schema/pet-event.schema.json](./schema/pet-event.schema.json) + [validate-pet-event.mjs](./schema/validate-pet-event.mjs) | 事件与控制帧 JSON Schema 与零依赖校验器 |
| [spikes/](./spikes/README.md) | 三条技术栈的最小可运行验证（Swift/AppKit、Tauri v2、Electron）+ 独立核对工具 |

```bash
# 快速自检（无需安装依赖，全部在本机实测通过）
node scripts/check-fixtures.mjs          # 契约一致性（16/16 type、6 状态、聚合终态）
node scripts/replay-check.mjs --selftest # 状态机回放 + 负例（v1.2 分支）
node schema/validate-pet-event.mjs fixtures/contract-sample.pet.jsonl
node adapters/_reference/hub-minimal.mjs fixtures/contract-sample.pet.jsonl  # 最小 Hub 原型
node scripts/dsh-session-to-pet.mjs ~/.dsh/sessions/**/session-*/session.v4.jsonl.zstd  # 真实 DSH 日志 → 规范事件
```

## 六、下一步（需人工确认/授权的三件事）

1. **授权插件挂载**：在 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加一行 `insert`（只增不删，HMR 热重载，不需重启 DSH）→ 事件延迟从 ~250 ms 降到 <1 ms。未授权时走日志 tail 兜底，功能不受影响。
2. **Live2D / Spine 授权核验**（本机网络不可达，未核验）：决定是否会用到需授权的运行时；MVP 方案为分层帧动画，不依赖授权。
3. **Windows 验证机器**：Phase 2 前需要一台 Win11 机器验证透明 + 置顶 + 点击穿透 + 命名管道（`\\.\pipe\agent-pet-<source>`）。

> 构建残留（`spikes/*/target`、`node_modules`，约 1.3 GB）**已清理**（`.gitignore` 已覆盖）；需要复现 spike 时按 [spikes/README.md](./spikes/README.md) 的命令重新构建（Tauri 首次构建约 47 s、Electron 依赖下载约 42 s）。
