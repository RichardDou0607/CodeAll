# 变更日志（文档与契约）

## 2026-10-05

### 契约 v1.2（Lead 冻结，docs/00-interface-contract.md）
- **计数口径统一**：**16 个 type 字符串 / 16 行**（v0.1 文本误写「14 种」；v1.2 又把 step.*/tool.* 拆成独立行，故行数与 type 数均为 16）。
- **必填标注规则**写入 §2.3：`*` 必填、`?` 可选、未标注 = 必填。
- **审批/提问强制关联 ID**：`approval.request/resolved` 必填 `requestId`；找不到未决项计 `orphanApprovals`/`orphanAnswers`（≤不再按 FIFO 猜）。
- **控制帧概念**：`ctl = hello | ack | decide | snapshot`（与事件区分）；补 ack 超时/重试、版本不匹配回包、`resumeAfter` 续传。
- **超时拆分为两条独立规则**：§4.4 的 45 s 判连接（source 离线并清聚合）、§4.5 的 10 min 清会话（基准 `lastStateChangeTs`，心跳不刷新）。
- **状态枚举统一**：`agent.status.state` 仅 `idle|thinking|working|waiting|error`（`done` 为本地过渡态）。
- **新增 §4.7 瞬态/持久错误**：`step.end/tool.result(error)` = `transient-error`（TTL 2 s）；`turn.end(error)`/`error.raised(fatal)` = 持久；连续 3 次瞬态升级。
- **会话级例外条款**：`turn.end(aborted)`/`session.end(aborted)` 只改该会话状态，不打断其他会话的 `waiting`。
- **Phase 1 只读**：明确桌宠不回写任何决定；Phase 2 通过 `canDecide` 能力协商才允许 `ctl:decide`。
- **工作框保证（§8）**：`pet.snapshot` 必须含 `now`/`counters`/`clearedPending`；新增 `sessions[].title/workspace/lastTool/elapsedMs/pending` 与顶层 `degradedSources`；会话行渲染规则（首行 40 px + 会话行 28 px × 最多 5 行 + `+N` 脚注）。
- **`observes` 能力协商（§5.2.1）**：适配器声明实际能产生的事件族，工作框据此隐藏不可用指标。
- **`unknownEvents` 语义澄清**：只统计不在 §3 的 16 个 type 内的类型；已知但 no-op 的事件计 `noop`。
- **Windows 命名管道更正**为 `\\.\pipe\agent-pet-<source>`；socket 增加单实例锁文件。

### 用户方向更新
- **产品主界面 = 工作框（Work Frame）**：默认悬浮卡片；首行显示状态/动作/计时/未决，其下每会话一行；**宠物形象默认关闭**，可选开启（用户 2026-10-05 确认）。
- 内存验收口径定为 `phys_footprint` 合计（RSS 参考）。
- 分发方式倾向 DMG 直分发（`macOSPrivateApi` 与 App Store 审核冲突，见 R-12）。

### 任务与产出
- T1 技术栈 spike（Swift/Tauri/Electron）、T2 产品规格、T3 后端适配矩阵、T5 风险登记册、T7 DSH 桥接验证、T8 工作框规格 均已完成；T4 路线图与 T6 独立验收进行中。
- 独立验收（docs/99）首轮报出的 4 个 P0 + 16 个 P1 已在 v1.2 逐条闭环（详见 docs/99 的 v1.2 复验节）。

### 修复（2026-10-05 下午，悬浮窗三问题：选会话投递 / 新建会话 / 子代理误识别）

**demo/framed.mjs**
- 插件探测端点 `/state` → **`/health`**（插件只有 /health，原探测永远 404 → canCreate/canOpen/canInput 恒 false、直投恒不可用）；能力位从 `capabilities` 子对象归一化。
- `POST /api/input` 接受可选 **`sessionId`**（支持前缀），`resolveTarget` 校验目标必须是已知**主**会话，子代理目标 404 拒绝；`deliverInput(text, targetId)` 显式目标优先，重发沿用原目标。
- 子代理不再混入会话列表：snapshot 的 `sessions`/`catalog.history` 过滤 `kind==='subagent'`；项目摘要新增 `mainCount/subagentCount`；`pluginTargetSession` 跳过子代理；日志跟随默认目标改为「最新主会话日志」（原按 mtime 全局挑最新会选中子代理日志）。

**demo/window.html**
- 新增**投递目标选择**：点击会话行（实时/历史）选中为投递目标（高亮 + composer 顶部目标行，点击目标行恢复自动）；发送携带 `sessionId`；陈旧目标自动回退自动。
- 项目下拉显示主会话数；子代理行双重过滤。

**plugins/dsh-pet/index.js**
- **HMR 竞态修复**：dispose 改为 inode 对照只删自己的 socket、锁加 token 区分同进程新旧实例（原 dispose 无条件 unlink 会删掉后继实例的 socket，造成「内核在听、文件不在」的孤儿，插件活着却 ENOENT 不可达）；锁心跳定时器每 5s 自检 socket 文件，丢失自动重绑。
- **投递顺序改为 agents 优先**：desktop profile 进程内直调 `sessionController.prompt` 必丢 cancellation signal（`signal.throwIfAborted` 抛 undefined，DSH 侧问题），实测 `agents.get/resume + followup` 在 desktop 与 /tmp 预演均真实送达；prompt 降级为回退并保留诊断。
- `buildCatalog` 跳过子代理（live 按 delegationDepth/parent，磁盘按 header.origin）。
- 新增 `POST /diag`（服务句柄/方法探测 + prompt 形态试验）与 socket 同目录 `plugin-debug.log` 生命周期日志。

**实测（真实 desktop profile，2026-10-05 15:4x–16:0x）**：`/api/new` 经 `sessionController.create` 建会话 ✅；`/api/open` 经 `resolveAgent` 定位（前缀匹配）✅；`/api/input` 显式 sessionId 经 `agents.followup` 送达并落盘会话日志 ✅；子代理目标被拒 ✅；`node plugins/dsh-pet/probe.mjs all` 全绿 ✅。注意：插件代码更新需重启 DSH（宿主进程内模块缓存，patch 变更只重新 apply）。

### 追加修复：悬浮窗页面「未连接」（token 注入损坏脚本，2026-10-05 16:0x）

- **根因**：服务端注入 token 用 `html.replace('__PET_TOKEN__', TOKEN)`，而该占位符在页面里的**首次出现是 `window.__PET_TOKEN__` 的属性名**（非字符串字面量），被替换成 `window.<hex>`——数字开头的非法标识符 → 整个内联脚本 `SyntaxError` → SSE/render 均未运行，页面停在「未连接」。渲染自检此前只跑占位符版本，抓不到该问题。
- **修复**：字符串字面量改用独立占位符 `'__PET_TOKEN_VALUE__'`（页面中唯一出现），服务端只替换带引号的这一处（`demo/window.html` + `demo/framed.mjs`）。
- **防回归**：`demo/test-window.mjs` 新增断言「token 注入后脚本仍可执行」（22 项断言全过）；浏览器实测：SSE 连接、聚合状态/会话行/主会话计数渲染、点击选投递目标、控制台零报错。

### 修复与增强（2026-10-05 16:1x：新建会话落错项目 / 置顶可关 / 一键安装）

1. **新建会话落进指定项目**（两个根源都修了）：
   - 插件 `createSession`：DSH 的 create 只带 `cwd` 时**不会**把会话挂进 workspace（界面归到默认项目）。现先 `workspaceRegistry.resolveByPath/create` 拿到 workspace，优先带 `workspaceId` 创建（DSH 内部会 attachSession），agents.create 回退路径手动 `attachSession`；带 workspaceId 被拒时退回纯 cwd。预演实测：`/new` 返回 `workspaceId`，且会话出现在 workspace 的 `sessionIds` 里。**注意：需重启 DSH 加载新插件代码后生效。**
   - 外壳注入的 `wireNewHint`：能力位 `canCreate=true` 后不再接管「新建会话」按钮（原先一次点击会触发两次 `/api/new`——页面 handler + explainNew 的 `cwd:''`——多出一个落进默认项目的会话）。
   - 附带发现：`workspaceRegistry.create` 对不存在的目录会失败，因此 /api/new 的 cwd 必须是已存在的项目目录（UI 里列出的都是真实项目，不受影响）。
2. **置顶可关**：窗口默认 `alwaysOnTop=false`（可被其他窗口正常覆盖）；标题栏新增 📌 按钮随时切换置顶（偏好记忆在 localStorage）；远程能力补 `core:window:allow-set/is-always-on-top`。已重建并替换运行中的外壳（日志确认 `WINDOW_SHOWN always_on_top=false`）。
3. **一键启用**：`apps/shell/run.sh --install` 构建并安装到 `/Applications`，以后从启动台/Spotlight 打开「AgentPet」即可（外壳自动拉起本地服务）；README 快速开始已更新。

### 会话列表 = DSH 左侧列表（workspace 注册表为准），2026-10-05 16:4x

**口径变更**：悬浮窗的项目/会话列表不再按磁盘扫描自由组织，改以 **DSH 左侧会话列表的唯一真相源**（`~/.dsh/storages/workspace.json`，只读）为准：
- 项目 = 注册表 workspace，顺序 = `global.workspaceIds`（= DSH 侧栏顺序）；成员 = 各 `workspace.sessionIds`（保留注册顺序）；已归档会话不显示。
- 子代理彻底消失：注册表本就不含子代理，另有目录 kind + 插件 `session.start` 新增的 `origin`/`delegationDepth` 字段双保险（后者零延迟，不等 5s 目录缓存）。
- 未注册进任何 workspace 的主会话（如旧版 cwd-only 创建的）归入末尾「未归入项目」组，不打乱注册表项目成员。
- `pet.heartbeat`/`sessionId='backend'` 的来源级帧不再被画成会话行（修掉名为 backend 的幽灵行）。

**配套修复**（上一轮分析报告的四点方案）：
1. 项目过滤改按 **projectKey**（workspaceId）匹配：曾按 `label===项目名` 过滤，label 是目录名、项目名是 workspace 标题，口径不一致 → 选中项目后实时行 100% 消失（实测 10 行→0 行）。快照的实时行/历史行/项目现在都带 `projectKey`，前端匹配之（旧快照回退 cwd 匹配）。
2. 渲染抗竞态：`#sessions` 与项目下拉 innerHTML **内容不变不重写**。此前每 ~1.2s 全量替换（2s 心跳 + 每事件），mousedown/mouseup 之间节点被换 → click 落到容器被吞（「点不中会话行」实测主因之一）。
3. `/api/new` 对不存在的 cwd 先 `mkdir -p`：`workspaceRegistry.create` 对不存在目录会失败，导致会话落不进项目。
4. 插件 `session.start` 携带 `origin`/`delegationDepth`；`adapters/session-catalog.mjs` 新增 `readWorkspaceIndex()`（order/byId/byPath/sessionOwner/archived/pinned）。

**验证**：`test-window.mjs` 25 项断言全过（新增 projectKey 过滤/未注册组/注入执行）；实测：项目下拉=DSH 侧栏顺序+未归入组、选中 agent综合管理平台 只显示其 1 个注册会话、无 backend/子代理行、6 连点目标切换全部生效。注意：DSH 重启后插件才会在新建时挂 workspace（旧模块 cwd-only 创建的会话会进「未归入项目」组）。

### 启动方式落地 + 多 Agent 接入计划（2026-10-05 22:1x）

- **免命令行启动（已实测）**：`apps/shell/run.sh --install` 一次性装入 /Applications（并注册 LaunchServices）；日常从 启动台/Spotlight 打开「AgentPet」即全自动（外壳自拉 demo/framed.mjs、连 DSH 插件、出窗口）。开机自启可选：系统设置 → 登录项 添加 AgentPet。注意：仓库移动后需重跑 --install（编译期路径定位）。
- **新增 docs/21-multi-agent-adoption-plan.md**：多 Agent（Claude Code / Codex / ACP）接入总体计划——复用契约 v1.3 多源设计与 KNOWN_AGENTS 扩展点；M-A/B 观察适配（映射草案基于本机 292 Claude 转录 + 32 Codex rollout 实测）→ M-C 多源目录/UI → M-G 打包常驻 → M-D/E 控制（tmux 注入 / `--resume -p` / `codex exec`，方案待 spike）→ M-F ACP 杠杆；含排期（W1–W4+）与风险对策。

## 2026-10-06

### 多 Agent 接入计划升级 v2（docs/21）
- **全盘软件盘点**（§1 新增）：PATH/npm/brew + /Applications Info.plist + AS 数据目录 + 进程四路核对，确认本机 11 项 agent 相关软件，逐项标注版本/证据/数据位置/接入分级（A 核心 / B 新增 / C 观望 / D 元信息 / E 排除）。
- **后端清单扩充**：新增 Kimi Code 1.0.4（M-H，先 spike 数据位置）、OpenCode（M-I，首选 ACP、备选 opencode.db 只读快照）、AgentOS M1 自研 CLI（M-J，兼作控制通道实验场）、CC Switch 供应商元信息（M-K）。
- **排除项成文**（§1.3）：Claude.app/ChatGPT.app（无本机观察通道）、影刀 RPA（范式不符）；Codex++/Nowdex/CC Switch 定性为壳/工具而非 agent 本体。
- **阻塞项发现**：codex CLI 与 opencode CLI 当前均不在 PATH（仅存数据目录与桌面壳）——M-E 落地前需恢复；观察通道不受影响。
- **新增里程碑** M-H/M-I/M-J/M-K 与排期调整（W3 加 Kimi spike，W4 加 OpenCode，W5+ ACP/AgentOS）；风险表增补 3 条（Electron 存储不稳、第三方壳目录分叉、卸载残留误接入）。

### 多 Agent 接入计划 v3（同日，用户方向确认）
- **首批接入范围锁定（用户指定）**：DSH（已完成）+ Claude Code + Codex + **Kimi Code（M-H 由 P1 提入首批）**；W1 即排 Kimi 数据定位 spike，W2 末目标改为**四源同窗演示**。当前仅更新计划，未启动开发。
- **终局架构定性（§6 新增）**：AgentPet = Agent 总控，**双域模型**——本地域直接控制各 agent 软件；远端域经 AgentOS（自研执行体，每台远端服务器一个实例）同时控制多台服务器。远端机器不装各家桌面 agent，AgentOS 是远端唯一汇聚入口。
- **M-J 重构为三步轨道**：J1 本地观察（提前至 W4，兼作控制通道彩排）→ J2 远端观察（SSH 只读，Phase 3）→ J3 远端控制（`ssh <host> agent -s` 白名单投递，Phase 3）。
- **source 命名规范提案**：远端 AgentOS 用 `agentos@<host>`，per-(source, sessionId) seq 天然隔离，契约 v1.3 无破坏性变更（待 Lead 确认写入附录）。
- **安全红线成文（§6.4）**：总控不存储/不代理 SSH 凭证；远端投递仅 `agent` 子命令白名单；远端回传仅状态级字段。
- **风险表 v3 增补 3 条**：远端链路抖动误判离线（断连=链路中断≠会话结束）、远端命令注入/越权、多主机规模（首版 ≤5 台预算）。
- **README 同步**：产品定位改为「工作框 / Agent 总控」（观察+控制+远端）；目标表新增 Phase 3 行。

### 本地域开发：软件四态面板（2026-10-06，代码）
- **新增 `adapters/local-agents.mjs`**：本机 agent 软件四态探测（DSH / Claude Code / Codex / Kimi Code / AgentOS M1 / OpenCode）。三级探测全只读：安装 = App 包/CLI/配置目录存在性（cc-switch 同款思路），运行 = 每轮单次 `ps axo pid,ucomm,args` + 每 agent 一条收窄正则（大小写敏感防误匹配 Claude.app），连接 = 观察通道 45s 内有数据（对齐契约 §4.4；DSH 插件 socket = 真连接，由 framed 注入）。本机实测 38ms/轮。
- **framed.mjs**：快照新增 `agents`/`agentCounts` 字段 + `GET /api/agents` 端点；3s 轮询，探测失败保持上次结果。
- **window.html**：新增「软件状态」面板（aggbar 与会话列表之间，可折叠）：每软件一行四态（已连接/已打开·未连接/未打开/未下载）+ 版本 + 通道（插件/日志）+ 进程数 + 上次活动相对时间；缺 agents 字段显示探测占位不报错。
- **test-window.mjs**：24 → 35 项断言（四态文案/通道/折叠/缺字段容错等 11 项新增），全部通过。
- **本机实测**：DSH 已连接（插件通道，5 进程）、Claude Code 已连接（日志通道）、Codex/Kimi Code/AgentOS/OpenCode 未打开（含版本与上次活动时间）。
- **注意**：正在运行的 AgentPet（7799）需重启外壳/服务才能加载新快照字段；window.html 是每请求读盘、刷新即生效。

### 人机交互总体方案 v1（2026-10-06，docs/55 新增）
- **双面模型**：常驻层（悬浮卡片，docs/51 全规格保留，只答「在干什么/多久了/等我没有」）+ 控制台层（demo/window.html 演进版，承载全部控制功能）；同源双视图、控制台可关、待办是唯一双向入口。
- **软件四态 × 动作表**：每态一个明确动作无死路——已连接=过滤其会话、已打开未连接=差异化连接指引、未打开=启动（只启动不代装）、未下载=安装指引+里程碑；探测失败显式 ⚠ 不回退。
- **选择模型三规则**：行点击=设投递目标；过滤器只影响显示不影响目标（目标被过滤时黄色警示条，替换现状的静默回退——列为 P0 投递安全项）；「打开」独立于选择。
- **术语统一**：队列用户文案只用 待投递/已送达/失败/已取消；toast ≤3s；删除 5s 可撤销。
- **新增 10 条 UX-A 验收断言** + 与现状差异清单（7 项，P0 两项：目标不静默回退、软件区可点联动）+ 与 51/50 冲突消解表 + 远端主机分组（Phase 3）与用户旅程。

### 多 Agent 观察适配落地：Claude Code / Codex / Kimi Code + 多源同窗（2026-10-06，代码，docs/21 M-A/M-B/M-C/M-H ✅）

- **新增 `adapters/claude-code-adapter.mjs`（M-A）**：`scanClaudeCatalog()`（窗口化目录：头 24KB + 尾 160KB，单行 >512KB 跳过；本机 11 项目 / 48 会话，中位 ~18ms）+ `followClaudeLogs()`（多文件字节偏移增量 tail，1.2s 轮询，截断重建自愈，启动从 EOF 起不回放）+ `mapClaudeLine()` 纯函数（user→turn.start、tool_use→tool.call（category 复用 categoryOf）、end_turn→turn.end(ok)、turn_duration→turn.end、api_error→error.raised(fatal:false)、custom-title/ai-title/agent-name→session.meta；sidechain 行逐行忽略）。元信息：标题三级回退、模型（assistant.message.model，CC Switch 供应商可见）、版本、cwd（行内权威，目录名有损兜底）。
- **新增 `adapters/codex-adapter.mjs`（M-B）**：`scanCodexCatalog()`（首行 session_meta 实测 20~51KB → 头窗口 96KB；本机 13 主 + 19 子代理，中位 ~19ms）+ `followCodexLogs()`（首遇文件读 session_meta：权威 sessionId + 子代理判定，**子代理 rollout 整文件跳过**，防幽灵实时行）+ `mapCodexLine()`（task_started→turn.start、function_call/custom_tool_call→tool.call、output→tool.result、task_complete→turn.end(ok)+message(截断280)、turn_aborted→turn.end(aborted)、session_meta→session.start）。**Codex++ 通路验证：全部 rollout originator="Codex Desktop"，落同一 `~/.codex/sessions`，单 root 覆盖。**
- **新增 `adapters/kimi-code-adapter.mjs`（M-H Step 1+2）**：spike 结论——Kimi Code 无 JSONL/SQLite/日志，会话仅在 Chromium LevelDB（键名 `session_<uuid>` 等，只扫键名不解码 value）→ 按风险分级**降级**：`scanKimiStatus()` 存活 + 近似会话计数（≈9，显式 approximate）+ mtime 连接判定；`observes=['session.heartbeat']`，不产生会话行/事件（红线：降级不伪造）。
- **`demo/framed.mjs`（M-C）**：`multiCatalog()` 三源合并（5s 缓存，合计 ~55ms）；快照 projects 带 `sources[]`；claude/codex 会话按 cwd 挂靠 DSH workspace（未命中则 `path:<cwd>` 自立组）；历史行跨源合并（截 40）；`followClaudeLogs`+`followCodexLogs` 与 DSH tail/插件共用同一 `applyEvent` 状态机；**投递目标守卫**——非 DSH 会话：UI 黄色警示 + 服务端 `resolveTarget` 404 拦截（M-D/M-E 未落地说明），自动挑目标仅限 DSH 主会话；`/api/catalog` 三源合并视图（perSource 统计）、`/api/open` 跨源定位并如实说明。
- **`demo/window.html`**：历史行来源列改 `s.source`；Kimi 近似计数进四态面板（≈N 个会话）；非 DSH 目标行黄色警示；空态/底注/帮助文案多源化。
- **`adapters/local-agents.mjs`**：kimi-code 补 LevelDB activity（连接判定生效）+ 会话计数（30s 缓存）。
- **测试**：新增 `scripts/multi-source-check.mjs`（19 项断言全绿：MA1–7 / MB1–6 / MH1–2 / MC1–4，MC 组起真实 framed 实例验证多源快照与投递拦截）；`demo/test-window.mjs` 35 → 38 项全绿（历史来源列 / Kimi 计数 / 非 DSH 目标警示与颜色 / DSH 目标正常态）。
- **实测**：本会话自身被 Claude 跟随器实时观察（running · 运行命令 · glm-5.3）；`鹈鹕测试变体策划[dsh+claude-code+codex]` 同 cwd 三源归并同窗；对 claude 会话投递被 404 + 明确原因拒绝。
- **文档**：docs/21（M-A/M-B/M-C/M-H 标 ✅ + 落地形态 + §5 现状快照更新）、docs/40（Kimi Code 补行：§0 表 #12 + §3.11 [A] 证据）、README（多源演示命令）。
- **已知既有问题（与本次无关）**：`scripts/check-fixtures.mjs` 对 `fixtures/session-replay.pet.jsonl` 的乱序窗口断言在改动前的基线上即失败（乱序窗口 ts 跨度 5797ms > 2000ms，非连续 seq），留待 fixture 重新录制修复。

### Kimi Code 升级 A 路径 + Codex CLI 恢复（2026-10-06 下午，代码）

- **勘误（M-H spike 误判根因）**：上午结论「Kimi 会话仅在 Electron LevelDB → 降级」有误——探测命令 `ls -d ~/.kimi* ~/kimi*` 因 `~/kimi*` 无匹配被 zsh 整体中止，`~/.kimi-code/` 从未被列出。Kimi Code 实为 CLI-first 架构，agent 核心写文件级数据；LevelDB 只是前端层缓存。
- **`adapters/kimi-code-adapter.mjs` 重写（A 路径）**：`scanKimiCatalog()`（state.json 整读 + wire 头/尾窗口，本机 4 项目 / 9 会话 ~4.4ms；标题/titleKind/cwd/模型(modelAlias)/思考档/归档过滤）+ `followKimiLogs()`（`agents/main/wire.jsonl` 多文件增量 tail；非 main agent 流 = 子代理整文件跳过）+ `mapKimiLine()`（turn.prompt→turn.start、loop tool.call/result→tool.call/result、turn.ended(completed/cancelled)→ok/aborted、**interaction.request/resolved 原生审批对（同 id 配对）**、agent.message.appended→message.assistant(280)、turn.step.retrying→error.raised 瞬态）+ `scanKimiLegacyCount()`（LevelDB 计数降为第三层兜底）。state.json 的 lastPrompt（用户原文）不读取。hooks 通道（app.asar 实测 20 事件、command 型、config.toml [hooks]）留作授权升级项。
- **Codex CLI 恢复（M-E 前置解除）**：`/usr/local` 无写权限 → `npm i -g --prefix ~/.local @openai/codex` → `~/.local/bin/codex` v0.160.1，`codex login status` 确认复用既有 auth.json（API key）已登录。本机 CLI 三件套齐：claude（~/.local/bin）/ kimi（~/.kimi-code/bin/kimi）/ codex。
- **`adapters/local-agents.mjs`**：kimi-code 安装证据 + `~/.kimi-code` 与 CLI 路径、processRe 匹配 kimi CLI、activity 加 sessions 目录（core）并保留 LevelDB（兜底）；会话计数改为目录精确（LevelDB 兜底才标 ≈）；codex 版本探测（npm package.json，实测 v0.160.1）。
- **`demo/framed.mjs`**：multiCatalog 四源（+kimi）；`followKimiLogs` 接入同一状态机；/api/catalog perSource 加 kimi-code；快照 source 标注四源。
- **`demo/window.html`**：Kimi 会话计数精确/近似条件显示；底注与帮助文案更新为四源。
- **测试**：`scripts/multi-source-check.mjs` 19 → 26 项全绿（新增 MK1–9：A 路径目录/元信息/性能/wire 映射含审批对/非降级 observes/LevelDB 兜底仍在；MC1 升级为要求四源历史行）；`demo/test-window.mjs` 38 项全绿。
- **实测**：`agent综合管理平台[dsh+claude-code+kimi-code]` 三源同项目；浏览器实测 23 项目 / 92 会话同窗、7 条 KIMI 历史行（真实标题/模型/思考档/状态）、四态面板 kimi-code 精确计数 9、控制台零报错。
- **文档**：docs/21（M-H 勘误+A 路径落地、M-E 前置解除、§5 快照与 CLI 三件套）、docs/40（§0 表 #12 与 §3.11 重写，含勘误记录）、README。

### 控制层落地：Claude Code / Codex / Kimi Code 投递·新建·打开全通（2026-10-06，代码，docs/21 M-D/M-E/M-H 控制 ✅）

- **新增 `adapters/cli-control.mjs`**：三后端统一控制通道——投递（tmux 服务在跑则 `send-keys -l` 到「该 cwd 里跑着对应 CLI」的 pane；否则无头续会话 detached spawn：`claude --resume <id> -p` / `codex exec resume <id>` / `kimi -S <id> -p`，输出落 `~/.agent-pet/cli-control/*.log` 0600）；新建/打开（tmux window / Terminal.app osascript 新窗口，参数全 shell-quote）。安全边界：只走官方 CLI 能力，不注入不绕权（各 CLI 权限模式照常生效）。
- **两个实测坑与修复**：① 宿主进程带 `ANTHROPIC_*/CLAUDE*` 环境变量时无头 claude 报 "Not logged in"（内部 BASE_URL 抢了 settings.json 优先级）→ spawn 前净化环境（剥 `ANTHROPIC_/CLAUDECODE/CLAUDE_CODE_` 前缀），CC Switch 供应商配置正常生效；② `codex exec` 在非 git 目录被 "Not inside a trusted directory" 挡 → 非 git cwd 附加 `--skip-git-repo-check`（仅跳过 git 检查，沙箱/审批不动）。
- **`demo/framed.mjs`**：resolveTarget 返回 source 并放行三后端目标；deliverInput 按来源路由（DSH=插件/队列，CLI 后端=deliverControl）；`/api/new` 接受 `source` 走 `newCliSession`（Terminal/tmux 新窗口）；`/api/open` 对 CLI 会话真实打开（Terminal resume）；capabilities 增加 `cliChannels`，canInput/canCreate/canOpen 随 CLI 通道点亮；`resolveSessionAny` 补上 kimi 源（曾致 404）。
- **`demo/window.html`**：目标行由「暂不支持投递」警示改为「经 CLAUDE-CODE CLI 投递」通道标注（默认色）；新建按钮按项目 sources 自动挑后端（DSH 插件优先，否则 CLI）；hint 三模式（cmd/cli/manual）；帮助页补控制层与安全边界说明。
- **测试**：`scripts/multi-source-check.mjs` 26 → 28 静态项（MD1/2 控制通道与语法表；MC4 改为能力位）+ `--live` 真实投递 3 项（MD3/ME3/MH3：各挑**最小**旧会话发一条「只回复 ok」，等待会话文件字节增长验证控制→观察闭环）——**31 项全绿，三家真实闭环全部打通**；`demo/test-window.mjs` 40 项全绿（CLI 通道场景：按钮可用 + hint 模式 + 目标行通道标注）。
- **实测**：浏览器点击 CLAUDE-CODE 历史行 → 「投递目标：demo · 经 CLAUDE-CODE CLI 投递」；canInput/canCreate/canOpen 全亮，cliChannels 三家齐。
- **文档**：docs/21（M-D/M-E ✅ 落地 + M-H 控制层 + §5 快照「观察+控制四源全通」）、README。

### 操作界面全面改版：迷你悬浮条 + App 界面双形态（2026-10-06，UI）

- **新增 `demo/mini.html`（新悬浮框，外壳默认入口 `/`）**：参考 Codex mini(pet) 的单行形态——状态点 + 状态·动作·计时·未决 单行进度；一行内三级切换：agent 软件（全部/DSH/CLAUDE/CODEX/KIMI）→ 项目 → 会话（级联过滤，实时会话带 ● 且来源可辨：`标题 · SRC`）；无选中会话时回退聚合行；⤢ 展开为 App。
- **`demo/window.html` 重构为 App 界面（`/window.html`）**：**顶部** agent 软件切换 tab + 聚合状态；**左侧** 项目列表（含进行中计数，点击过滤）+ 软件四态面板；**中部** 会话列表（实时+历史，来源列 + 项目名进 meta——任何一行都能分辨「哪个会话 × 哪个项目 × 哪个 agent 软件」）；**底部** 会话控制（投递目标 + 输入 + 队列 + 新建/历史）。
- **队列行为变更**：只显示未完成项（待投递/投递中/失败）——**成功送达的消息不再显示**，改为发送后在 note 闪一次「已送达 ✓ via …」；磁盘审计日志（input-queue.jsonl）仍完整保留。
- **双形态切换**：mini ⤢ ↔ App 「▤ 迷你条」；Tauri 外壳内自动调窗口尺寸（mini 360×44 / App 980×640，经 `set_size` 能力，浏览器演示优雅降级）。外壳启动页重定向到 `/` → 默认即迷你条。
- **顺手修**：聚合态 `working` 缺中文文案/配色（两页都补「工作中」绿色；此前顶部一直显示英文 working）。
- **测试**：`demo/test-window.mjs` 重写为 App 断言 24 项；新增 `demo/test-mini.mjs` 9 项——全绿。浏览器实测：mini 42 会话可选、自动选中活跃会话；App 顶部切 CLAUDE（项目 23→11、实时 2→1、历史 30→16）、左侧点项目（agent综合管理平台 · 2 进行）、行选中目标全链路可用。
- docs/55 人机交互方案的双面模型与新形态的对应关系待 v2 修订（常驻层=迷你条、控制台层=App）。

### 双窗口并存 + 迷你条动态机制 + 原生窗口控制（2026-10-06 晚，UI/shell）

- **App 界面与迷你条改为两个窗口并存**（如 Codex 软件本体与 pet 的关系，不再同窗口跳转）：
  - 外壳（tauri.conf）新增 `app` 窗口（1000×680，原生标题栏），main=迷你条（380×46）；capabilities 放行双窗口。
  - 迷你条 ⤢ = `show+set_focus` app 窗口；App 红色关闭按钮 = 隐藏不销毁（CloseRequested → prevent_close + hide，⤢ 可再唤出）；托盘新增「显示 App 界面」。
  - lib.rs：start_url_watcher 双窗口化（REMOTE_COMMITTED[main]/[app]）；REMOTE_INJECT 按 `agentpet-solid` meta 跳过透明化（App 窗口用原生标题栏，不再注透明 CSS）；webui/app.html 引导页（探活优先，避免与 main 引导页双拉服务进程）。
- **迷你条改动态单行机制**：始终显示「优先级最高（等你确认 > 出错 > 运行 > 思考）→ 最新」的会话，其余隐藏；⟳ 按钮轮换锁定（环回一圈恢复自动）；出现 waiting/error 紧急会话时自动抢占回最新；行内容 = `来源 · 标题 · 项目 · 模型 · 状态 · 计时 · ⏳`（可分辨会话×项目×agent）。无实时会话时显示聚合行。
- **App 用 macOS 原生窗口控制**：decorations=true（红=隐藏/黄=缩放/绿=全屏），移除自绘标题栏按钮。
- **拖拽 bug 修复**：根因是外壳注入脚本只认 `.titlebar` 挂 mousedown 拖拽，新版式没有该元素。迷你条改为自挂 mousedown → start_dragging（整条可拖，按钮除外），App 走原生标题栏。
- **验证**：cargo check 干净；`run.sh --install` 重建安装；受控启动日志确认 `REMOTE_COMMITTED[main]+[app]`、REMOTE_IPC_OK、单服务进程（app 引导页探活优先生效）；浏览器实测迷你条动态机制（自动跟随 CLAUDE 运行中会话 → ⟳ 锁定 DSH → 环回自动）；test-mini 重写 11 项、test-window 调整后 24 项全绿。
