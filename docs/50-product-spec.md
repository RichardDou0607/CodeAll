# 50 · 桌宠产品规格（状态机 / 交互 / 资产 / 角色 / 商业化）

> 负责人：队友 B（product-experience）｜状态：**DRAFT v0.2**（2026-10-05，对齐契约 **v1.1**）
> 基线：[`docs/00-interface-contract.md`](./00-interface-contract.md)（**FROZEN v1.1**，2026-10-05）§2 信封/控制帧、§3 事件（16 个 type 字符串 / 16 行 / 16 行）、§4 状态机（**Hub 权威**）、§5 传输与 `canDecide` 能力协商；架构约束：[`docs/10-architecture.md`](./10-architecture.md)（DRAFT v0.9，ADR-2「渲染层无业务状态」）。

| 本轮（v0.2）依赖与待回填状态 | 状态 | 影响本文哪几节 |
|---|---|---|
| [`docs/10-architecture.md`](./10-architecture.md) | ✅ DRAFT v0.9 | §1 已改为「Hub 权威 · 桌宠只渲染 `pet.snapshot`」 |
| [`docs/40-adapters.md`](./40-adapters.md) | ✅ DRAFT v1 | §5.2 事件通路、§5.3 写回 Gate、§9 已回填（DSH 16 类中 12 类可达） |
| [`docs/30-implementation-stack.md`](./30-implementation-stack.md) | ⏳ 仍为占位 | §3.1 性能列、§3.2 理由 3、§11-D（性能）待回填 |
| [`docs/35-dsh-pet-bridge.md`](./35-dsh-pet-bridge.md) | ⏳ 未产出 | §5.2「DSH 事件获取主路径」的最终形态待回填 |
| [`docs/20-roadmap.md`](./20-roadmap.md) | ⏳ 仍为占位 | §3.3 的 M0–M6、§11 的「M2 全绿」口径待对齐 |
| [`docs/70-team-and-metrics.md`](./70-team-and-metrics.md) | ✅ DRAFT | §11 的验收责任人用其角色名（外壳/Hub/设计/QA） |
> 证据分级：**[实测]** = 本机命令输出或 GitHub/Steam 官方 API 返回值（附命令/URL）；**[原文]** = 官方 LICENSE 原文引用；**[假设]** = 产品假设，需后续验证；**[未验证]** = 未取得可核验证据。
> 全文不改变 `00` 契约；与契约的冲突/建议统一写在 §8「建议变更」。

---

## 1. 状态机细化（Hub 权威 · 桌宠只渲染快照）

### 1.0 职责边界（对齐契约 v1.1 §4 与 docs/10 ADR-2）

- **Hub 独占状态机**：会话聚合、优先级、未决登记、超时清理、乱序收敛全部在 Hub；Hub 通过 `pet.snapshot`（契约 §5.3）广播 `{agg, sessions[], bubble, effect, unknownEvents, offlineSources[]}`。
- **桌宠渲染层没有业务状态**：只做三件事——① 按 `snapshot.agg` 播放状态动画；② 按 `snapshot.bubble` 显示气泡/审批卡片；③ 按 `snapshot.effect` 播一次性特效。**禁止**在渲染层重新解释事件流或自造状态（v0.1 的「渲染层权威」写法已废弃）。
- 因此本文 §1.2 分两层写：**A. Hub 侧规则**（契约已定，产品只提要求与验收）与 **B. 渲染侧表现规则**（本规格新增，只影响动画观感，不影响状态真相）。

### 1.1 六个展示状态与呈现

| 状态 | 进入条件（契约 v1.1 §4.2 真值表） | 形象动作 | 主色（徽标/眼睛） | 气泡 | 停留 |
|---|---|---|---|---|---|
| `idle` | 初始；`session.end(aborted/unknown)`；`turn.end(aborted)`；`step.end(aborted)`；§4.4/§4.5 清理后；`done` 停留结束 | 呼吸、眨眼、偶尔张望 | 中性灰蓝 | 无 | — |
| `thinking` | `session.start`、`turn.start` | 摸下巴 + 头顶「思考云」 | 蓝 | 「在想…」（可选） | 300 ms |
| `working` | `step.start`、`tool.call`；`approval.resolved(allow/deny)` 回到登记前状态（缺省 `working`） | 按 `tool.category` 播动作（exec=敲键盘 / read=翻书 / write=写字 / net=天线） | 绿 | 工具摘要（节流） | 300 ms |
| `waiting` | `approval.request`、`user.question`（登记未决，键 = `requestId`/`questionId`） | 举手 + 抬手心，**不做循环卖萌** | 琥珀 | 审批卡片（不自动消失，**无允许/拒绝按钮**，见 §5.3） | 不自动退出；直到配对结果或 §4.4/§4.5 清理 |
| `error`（**持久**） | `turn.end(error)`（常驻）、`session.end(reason=error)`（3 s → 该会话 `idle`）、`error.raised(fatal=true)`（常驻到该 source 有成功事件或离线清理）；**升级**：同一会话 60 s 内 3 次瞬态失败 → 持久（计 `escalatedErrors`） | 头顶乌云 / 摊手 | **红（常驻）** | 一句话结论 + 下一步 | 常驻（直到成功事件/清理） |
| `transient-error`（**瞬态**，契约 v1.2 §4.7） | `step.end(error)`、`tool.result(error)`（TTL **2 s**）；`approval.resolved(timeout)`（TTL 1.5 s）→ 到期自动回该会话**上一个稳定状态**（计 `recoveredErrors`） | 头顶小乌云 + 黄色一闪 | **黄** | 「重试中」 | 2 s / 1.5 s |
| `done` | `turn.end(ok)`、`session.end(done)` —— **本地过渡态** | 点头 / 小跳 | 绿松 | 「这轮好了」+ 可选摘要 | 2 s，随后 `idle` |

**no-op 事件（有特效、不改状态，契约 §4.2）**：`pet.heartbeat`、`message.assistant`、`tool.result(ok|denied)`、`step.end(ok)`、`error.raised(fatal=false)`。

附加两条：
- 后端能用 `agent.status` 上报的状态只有 **5 个**（`idle|thinking|working|waiting|error`，契约 §3.4）；`done` **不能**由后端设置，是本地过渡态。
- `offline` **不是状态**，是 source 级角标（契约 §4.4）：判定的是「连接」，不是「会话状态」。

### 1.2 打断、聚合与覆盖规则

**A. Hub 侧（契约 v1.1 已定，产品只提要求）**

1. **优先级**：`waiting > error > working > thinking > done > idle`（契约 §4.3）。高可立即打断低；低不得打断高，只在高退出后生效。
2. **多会话聚合**：每会话独立维护状态与超时；聚合状态 = 所有会话中优先级最高者（契约 §4.3）。**任一会话**（含非前台）出现未决审批/提问 → 整体 `waiting`。
3. **未决登记表**：键 = `requestId`（审批）/ `questionId`（提问），值为「登记前状态 + 起始时间」；每个未决项独立计入 `waiting`（契约 §4.3）。`approval.resolved`/`user.answer` **必须**按 ID 配对；配不上时忽略并计 `orphanApprovals`/`orphanAnswers`（**禁止 FIFO 猜测**，契约 §3.3）。
4. **`agent.status` 覆盖规则**（契约 §3.4）：仅当 ①10 s 内有效、且 ②其优先级 **≥** 当前聚合优先级，或 `force=true` 时才生效；被拒计 `overrideRejected`。→ 产品含义：后端**不能**用 `agent.status` 把 `waiting` 压掉，审批提醒不会因为后端「自认为在忙」而消失。
5. **乱序与迟到**（契约 §2.4/§4.6）：窗口内（2 s 或 32 条，先到者冲刷）按 `seq` 排序后应用；窗口外迟到仍接受但不得让聚合状态**倒退**；去重键 = `(source, sessionId, seq)`，重复计 `duplicates`。
6. **`waiting` 的粘性**：`waiting` 期间 `tool.result(error)`、`error.raised(fatal=false)` 是 no-op → 状态保持 `waiting`，错误降级为徽标红点与面板条目（用户此刻必须先处理审批）。例外：`error.raised(fatal=true)` → `error` + 「离线」角标。

**B. 渲染侧（本规格新增，只影响观感，**不影响**状态真相）**

7. 状态切换一律 **120 ms 交叉淡出**，禁止硬切；同优先级刷新只换 `detail` 文案与徽标，不重启动画（避免「抽搐感」）。
8. **防抖**：`turn.start` 后 300 ms 内的 `step.start` 会带来 thinking→working 的视觉抖动。渲染层在 300 ms 内只播一次切换动画；若 Hub 快照在此期间连续变化，以**最后一个快照**为准（渲染层不做状态推断）。
9. **记录**：渲染层把收到的快照序列写入本地环形缓冲（最近 500 条，字段 `{ts, sessionId, from, to}`），供面板与崩溃取证；只存状态名与时间，不存任何内容。

### 1.3 超时与清理：两条**独立**规则（契约 v1.1 §4.4 / §4.5）

> v0.1 曾据旧契约写下「45 s 回 idle 与 10 min 回 idle 矛盾」；v1.1 已拆解为两条互不冲突的规则：**45 s 判连接，10 min 清会话**。

| 规则 | 契约依据 | 阈值与计时基准 | 触发动作 | 用户可见性 |
|---|---|---|---|---|
| **R1 source 离线** | §4.4 | 某 `source` **45 s 内未收到任何帧**（事件**或**控制帧） | 清空该 source 的全部会话聚合与未决登记；聚合状态回落到剩余 source 的最高优先级（无则 `idle`） | 「离线」角标 + 该 source 徽标变灰 |
| **R2 会话陈旧清理** | §4.5 | 某会话 **10 min 无状态变化**；基准 = `lastStateChangeTs`，**`pet.heartbeat` 不刷新它** | 清理该会话的未决登记、置回 `idle`、`stale++` | **必须留痕（不得静默）**：面板「已清理」条目 + 菜单栏角标计数 +（可配）系统通知 |
| **R3 会话沉寂（产品层，非契约）** | — | 会话 30 min 无 `turn.*` | `sleep` 姿态（`idle` 的子表现，不新增状态） | 睡觉动画、帧率降半 |

- **「waiting 不被静默丢弃」的落点**（v0.1 建议 C3 已在 v1.1 采纳为 §4.5 的独立清理规则）：R1/R2 都会清空未决登记，因此产品侧必须**显式让用户看见**——
  1. 菜单栏图标保留琥珀色 + 计数，直到用户点开确认（不随清理变灰）；
  2. 面板「待办」页列出「因 10 分钟无活动被清理的审批/提问」，含时间、后端、`requestId`（可跳回后端窗口）；
  3. 清理事件可配系统通知（默认开，勿扰「完全静默」档下仅保留 1+2）。
- **心跳语义**：`pet.heartbeat` 是 no-op，只用于保活与负载展示，**不计入** R2 的状态变化（契约 §4.5、§7.6）——即「只有心跳的会话」必须被 R2 清理，且不得因心跳被误判为活跃。
- **计数器可见**（面板「诊断」页）：`stale`、`unknownEvents`、`duplicates`、`lateEvents`、`orphanApprovals`、`orphanAnswers`、`overrideRejected`、`offlineSources`。

### 1.4 多会话聚合的 UI 表达：一个桌宠 + N 徽标

- **数据来源（契约 §5.3）**：徽标、气泡、特效全部由 `pet.snapshot` 驱动（`agg` = 聚合态，`sessions[]` = 每会话状态与 `since`，`bubble` = 当前要显示的气泡/审批卡，`offlineSources[]` = 离线角标）。渲染层不维护第二份会话表。
- **徽标形态**：桌宠右侧竖排 12 px 圆点，最多显示 5 个；超过显示 `+N`。每个圆点内部为 2 px 状态色环。
- **分组**：同一 `source`（dsh / claude-code / codex…）的会话共享一条 3 px 的左侧色条，色条带后端首字母（D / C / X）。
- **排序**：`waiting` 最上（脉冲动画）→ `error` → `working` → `thinking` → `done` → `idle`；同级按最近事件时间倒序。
- **颜色语义**：灰=idle、蓝=thinking、绿=working、琥珀=waiting、红=error。**不只依赖颜色**（色盲友好）：等待=实心、工作=半实心、思考=空心、完成=对勾点、错误=叉号点。
- **交互**：hover 徽标 → 该会话迷你卡（后端名 / workspace 末段 / 最近事件 / 已运行时长 / `seq` 是否断档）；点击 → 打开面板并高亮该会话；点击卡片「跳转」→ 唤起对应 agent 窗口（DSH 用 `open` 打开其窗口，见 §5）。
- **N ≥ 4**：桌宠切换到「管家」姿态（节奏 ×1.3，同时最多显示 1 条气泡，避免刷屏）。
- **气泡归属**：多后端时气泡前缀 `[DSH]` / `[CC]`；多会话同后端时前缀 workspace 末段（如 `[桌宠]`）。

### 1.5 勿扰模式（DND）

三档，全局单开关（右键菜单 / 菜单栏 / 快捷键 `⌥⌘Z` 循环）：

| 档位 | 气泡 | 声音 | 抖动/置顶 | 批准类强提醒 | 徽标脉冲 |
|---|---|---|---|---|---|
| 关闭（默认） | 全部 | 开 | 是 | 全量 | 是 |
| 专注 | 仅审批/错误 | 关 | 仅审批 `risk≥2` | 降级（气泡+脉冲） | 是 |
| 完全静默 | 无 | 关 | 否 | 仅菜单栏图标变琥珀 | 否（图标闪一次） |

- **豁免策略（关键）**：`approval.request`、`user.question`、`error.raised(fatal=true)` 在**任何档位**都不会被完全吞掉——最少保留菜单栏图标状态 + 徽标红点 + 面板待办计数；§1.3 的 R1（45 s 离线）/R2（10 min 清理）清空未决登记后，这份可见痕迹**继续保留**直到用户确认。
- **勿扰只调「打扰强度」，不改「有无未决」的事实**：Phase 1 的审批卡片本身**没有**允许/拒绝按钮（契约 §5.4 只读），勿扰档位只影响气泡、声音与抖动，不会改变「后端仍在等你」这一状态。理由：桌宠存在的第一价值是「告诉你 agent 卡在等你」，静默它就是自我否定。
- `risk` 分级豁免：`risk≥2` 的审批在「专注」档仍可发声（可配置关闭）。
- **自动 DND（可选，Phase 1.1）**：检测到前台全屏应用 / 屏幕共享 / 正在录音（麦克风占用）时自动进入「专注」。检测手段（macOS：`CGWindowListCopyWindowInfo` 判定全屏窗口、`NSWorkspace` 前台应用、CoreAudio 设备占用）均**未验证**，Phase 1 先做手动开关 + 「全屏时半隐藏」（见 2.10）。
- **跟随系统专注模式**：macOS Focus 状态是否可被第三方 App 读取**未验证**（验证方法：在 15.x/26 上尝试 `NSWorkspace`/Focus Status API，需 `com.apple.developer.focus-status` entitlement）。Phase 1 不依赖它。

### 1.6 夜间 / 午休行为

- 默认时间窗（可配置、可关闭）：夜间 `23:00–08:00`，午休 `12:00–13:30`（本地时区，支持跨天）。
- 窗口内行为：动画帧率 12 fps → 6 fps、呼吸周期 ×2、气泡默认不弹（排队）、声音关闭（除非审批 `risk≥2` 且用户开启夜间豁免）、桌宠滑到屏幕角落缩为 60%。
- **不丢事件**：窗口内事件只累积计数与最高优先级；窗口结束时弹一条「唤醒摘要」，例如「你休息时：完成 3 轮、1 个审批还在等你」。摘要只含计数与状态，不含对话正文（呼应契约 §1.4 隐私目标）。
- 夜间遇到 `waiting`：不叫醒（除非配置「审批必唤醒」），但菜单栏图标与徽标始终保持琥珀。
- **首次启动引导**第 5 步提供这三档时间的确认，避免默认打扰。

### 1.7 首次启动引导（Onboarding，5 步，可跳过）

| 步 | 内容 | 失败降级 |
|---|---|---|
| 1 | 欢迎 + 选角色（默认角色 + 2 个免费皮肤预览） | 无 |
| 2 | 权限说明与申请：通知（可选）、辅助功能（仅全局快捷键/穿透切换需要）、开机自启（默认否） | 拒绝 → 功能降级并说明差异，绝不反复弹窗 |
| 3 | 发现本机已装的 agent（扫描 `/Applications`、`~/.claude`、`~/.codex`、`~/Library/Application Support` 等已知路径）→ 展示将要写入的 hooks 配置 **diff**，用户确认后安装适配器 | 写入失败 → 展示可复制的命令 + 文档链接 |
| 4 | 演示模式：用内置 `fixtures/demo.pet.jsonl` 回放 20 秒事件流（思考→工具→审批→完成），让用户立刻看到桌宠反应；**不真实触发任何 agent** | 回放失败 → 播放静态动画 + 文字说明 |
| 5 | 偏好：吸边位置、点击穿透（默认关）、勿扰档位、夜间/午休时间、开机自启 | 全部取默认值 |

- 引导全程 ≤90 秒，可 Esc 退出；`--replay` 相同演示可在设置里重播（契约 §5 文件通道）。
- 首次启动不做任何网络请求（离线可用为默认）。

---

## 2. 交互清单

> **界面定位（用户已确认，2026-10-05）**：主界面 = **工作框**（默认悬浮卡片：首行固定 40 px + 每会话一行 28 px，窗口高度 = `40 + 28×min(N,5) + (N>5 ? 22 : 0)`，契约 §8.1）；**宠物层默认关闭**，是可选的独立拖拽图层。本节及以下各节中的「桌宠」一律读作「工作框（含可选宠物层）」；工作框专属规格（三形态线框、会话行、验收 27 条）见 [`docs/51-work-frame-spec.md`](./51-work-frame-spec.md)。
> 每条都可写成测试用例（验收列即最小断言）。快捷键默认值见 2.7。

| # | 交互 | 触发 | 行为 | 边界条件 | 验收（可测） |
|---|---|---|---|---|---|
| 2.1 | 拖拽 | 左键按住身体拖动 | 跟手（≤16 ms 延迟感）、拖动时播放「被拎起」姿态、松手 300 ms 内判定吸边 | 拖动中不响应点击/双击；拖到屏幕外时夹在可视区内 | 拖动 100 次，松手后桌宠 100% 落在可视区；拖动期间 CPU 增量 <3% |
| 2.2 | 吸边 | 松手时距屏幕边缘 <80 px | 吸附到左/右/下边缘；吸边后只露 60% 身体；鼠标靠近 120 ms 内自动「探头」 | 顶部菜单栏区域不吸附（避免遮挡图标） | 四边各测 10 次，吸附位置误差 ≤4 px |
| 2.3 | 点击穿透 | 右键菜单 / `⌥⌘P` | 开启后桌宠不接收鼠标事件（macOS `setIgnoreMouseEvents(true, {forward:true})` 语义） | 穿透时必须有「退出路径」：菜单栏图标常驻 + `⌥⌘P` 再按一次恢复；菜单栏图标显示「穿透中」角标 | 穿透开启后，点击桌宠所在坐标的底层窗口能收到事件（用文本编辑器验证可见字符输入）；再按 `⌥⌘P` 恢复 |
| 2.4 | 右键菜单 | 右键框体 | **15 项**（完整清单见 [docs/51](./51-work-frame-spec.md) §4.4）：切换形态（卡片/窄条/宠物）/ 展开全部会话 / 待办页 / 显示宠物图层 / 勿扰三档 / 静音 / 点击穿透 / 锁定位置 / 置顶层级 / 选择屏幕 / 复制最近事件（脱敏）/ 打开日志目录 / 设置 / 检查更新 / 退出 | 各形态下菜单项按可用性灰显但不隐藏（位置稳定）；「显示宠物图层」默认关闭 | **15 项齐全**；每项都可点且无崩溃；关闭宠物图层后其余 14 项仍全部可用 |
| 2.5 | 气泡样式 | 任意可产生文案的事件 | 位置：默认头顶，超出屏幕上沿则移到下方；宽 ≤320 px，最多 2 行，超出省略；13 px 字号、12 px 圆角、跟随系统深色模式；正文最多 60 个全角字符（渲染层截断，不改契约的 ≤280） | 同时只显示 1 条，新事件替换（审批类不替换，改为入队）；点击气泡 → 打开对应会话 | 连续注入 10 条 `message.assistant`：气泡切换 ≤10 次且**节流 ≥1.5 s/次**（契约 §3.2） |
| 2.6 | 审批强提醒 | `approval.request` / `user.question`（经 `pet.snapshot.bubble` 下发） | 序列：① 气泡滑入 120 ms ② 窗口置顶 + 从边缘滑到当前屏幕中央偏下可视区 ③ 抖动 3 次（±4 px，400 ms）④ 提示音（可关，默认开）⑤ 菜单栏图标变琥珀 + 徽标脉冲 ⑥ 30 s 未响应重复抖动+声音，最多 3 次（间隔 30/60/120 s） | **不自动关闭**（借鉴 clawd-conduit 的教训：自动关闭会让用户以为自己拒绝了）；**卡片不提供允许/拒绝按钮**（契约 §5.4 Phase 1 只读）：文案 =「后端正在等待你的决定」+「跳到窗口」；`expiresAt` 到期由后端决定结果 | 注入 `approval.request` → 3 s 内出现气泡+置顶+声音；卡片上**只有跳转**、无 allow/deny 控件（截图/无障碍树断言）；`approval.resolved` → 气泡消失并播「松口气」；`approval.resolved` 无配对 `requestId` → 计 `orphanApprovals` 且状态不变 |
| 2.7 | 快捷键 | 见下表 | 全局快捷键需「辅助功能」权限；未授权时降级为「仅桌宠聚焦时生效」并提示 | 与用户既有快捷键冲突时，设置页显示冲突并允许改键 | 每个快捷键在「有权限/无权限」两种状态下都不得崩溃；无权限时给出明确提示 |
| 2.8 | 开机自启 | 设置 / 引导第 5 步 | macOS 用 `SMAppService`（Login Items）注册；**默认关闭** | 关闭时不得残留 LaunchAgent；卸载时清理注册项 | 开启→重启（或 `launchctl` 查询）后进程自动启动；关闭后不再启动 |
| 2.9 | 多屏 | 系统 | 默认跟随鼠标所在屏幕；设置可锁定到某屏；屏幕拔插后 500 ms 内重新定位并保证可见 | 屏幕分辨率变化后不得停留在旧坐标（可能不可见） | 拔掉外接屏 → 桌宠出现在主屏可视区（模拟 `NSApplication.didChangeScreenParametersNotification` 验证） |
| 2.10 | 全屏应用共存 | 检测到前台全屏窗口 | 全屏应用自动收为窄条（320x40，仅首行，四项信息仍可读）+ 静音 + 帧率降半；退出全屏 1 s 内恢复原形态与位置（用户已确认，以 [docs/51](./51-work-frame-spec.md) §4.1 为准） | 不抢焦点、不打断全屏动画；用户可关掉这个自动行为 | 全屏视频播放时工作框不遮挡字幕区且 CPU 占用下降；退出全屏 1 s 内恢复原形态、高度与位置 |
| 2.11 | 可访问性 | 系统设置 | 支持「减弱动态效果」（Reduce Motion → 关闭抖动/位移，仅保留透明度变化）、VoiceOver 标签（"DSH 桌宠，当前状态：等待审批"）、徽标形状+颜色双编码 | 开启 Reduce Motion 后不得有位移/抖动动画 | 打开 Reduce Motion → 审批提醒不含位移，仍有声音+气泡+菜单栏变化 |
| 2.12 | 国际化 | 设置 | 首发 zh-CN / en；文案表外置为 JSON（可被皮肤包覆盖） | 缺失键回退 en，不得显示 key | 切换语言后所有 UI 文案（含菜单、气泡）无残留中文 |

### 2.7 快捷键默认表

| 快捷键 | 作用 | 是否需辅助功能权限 |
|---|---|---|
| `⌥⌘P` | 切换点击穿透 | 是（全局注册） |
| `⌥⌘Z` | 循环勿扰档位 | 是 |
| `⌥⌘J` | 跳到最近一条未决审批/提问对应的后端窗口（**只跳转，不批准**） | 是 |
| `⌥⌘K` | 打开面板「待办」页（全部未决 + 被清理记录） | 是 |
| `⌥⌘B` | 显示/隐藏桌宠 | 是 |
| `⌥⌘1..5` | 展开第 N 个会话徽标 | 否（桌宠聚焦时） |
| `Esc` | 关闭气泡/迷你卡 | 否 |

> **Phase 1 是只读**（契约 v1.1 §1.6 / §5.4）：桌宠与 Hub 不向任何后端写回决定，适配器在 `ctl:ack` 中声明 `canDecide:false`，因此**不存在** `⌥⌘A/N` 这类批准/拒绝快捷键；`⌥⌘J` 只做「唤起后端窗口/终端」。Phase 2 仅在 `canDecide:true` 且经用户二次确认后才可能出现（默认关闭，见 §5.3）。

---

## 3. 资产管线：Live2D vs Spine vs 帧动画 vs VRM 3D

### 3.1 对比表

| 维度 | Live2D Cubism | Spine | 帧动画 / APNG / WebP 序列 | VRM 3D（three-vrm） |
|---|---|---|---|---|
| 授权与商用 | Cubism SDK 组件走 **Live2D Open Software License**；Cubism Core 走 **Live2D Proprietary Software License**；**年营收 >1000 万日元的事业者必须签 Cubism SDK Release License（出版许愿契约）** [原文] | Spine Runtimes License（2025-04-05 版）：允许集成，但「**each user of the Products must obtain their own Spine Editor license**」——即终端用户需各自持有编辑器许可 [原文] | 素材自制或 CC0/CC-BY（自有版权最干净）；运行时零授权成本 | 引擎 three.js(MIT) + three-vrm(MIT)（**未验证**具体版本与许可证文本）；**模型本身**受 VRM Public License 1.0 约束，能否商用取决于每个模型自带的 License Settings [原文] |
| 对「分发型桌宠」的适配结论 | 可用，但须监控营收阈值 | **MVP 淘汰**：要求每个终端用户自购编辑器许可，商业模式不可行（除非取得企业授权，**未验证**是否有该条款） | **推荐** | 模型授权逐个确认，成本高 |
| 制作成本（1 个角色 6 个动作） | 立绘 + 绑骨 + 表情 ~5–15 人日（**[假设]**，行业经验区间，未实测） | 同量级，绑定工具链更重 | 1–3 人日/套（像素或扁平矢量） | 建模 + 绑定 ~5–20 人日（**[假设]**） |
| 运行时体积 | Core（wasm/js）~1.5 MB + 模型 2–8 MB | 运行时 <1 MB + 模型 1–5 MB | 每动作 20–60 帧 × 512² WebP ≈ 0.3–1.5 MB；6 动作 ≈ 2–8 MB | 模型 20–80 MB + 引擎 ~0.6 MB |
| 性能（空闲） | WebGL 每帧轻量，实测前标记 **[未验证]**；行业经验 CPU <1%、内存 60–120 MB | 极轻 | 最轻：可低至 CPU ~0%、GPU 接近 0（静态帧时暂停渲染） | 最重：持续 GPU 占用、内存 200 MB+ |
| 跨平台 | Web / Native SDK 齐全，好 | 运行时覆盖广 | 任何 UI 技术都能播（WASM/Canvas/CSS） | 需 WebGL2，好 |
| 换肤/社区生态 | 最大（大量画师与模型平台，如 nizima 等，**未验证**具体平台条款） | 中等，偏游戏 | 最自由（像素风社区成熟，参见 BongoCat 的模型库） | 中等（VRM 生态活跃，参见 Desktop Mate / Mate-Engine） |
| 表现力上限 | 高（呼吸、物理摆动、口型） | 高（游戏级骨骼） | 中低（除非分层部件 + 程序化变换） | 最高（真 3D、可环绕、可投放道具） |
| 与「桌面陪伴感」的匹配 | 高 | 中 | 中高（像素风在开发者群体接受度高） | 高（但更「重」） |

**关键证据（原文/实测）**
- Live2D：`https://github.com/Live2D/CubismWebSamples/blob/develop/LICENSE.md`（2026-10-05 经 `https://cdn.jsdelivr.net/gh/Live2D/CubismWebSamples@develop/LICENSE.md` 抓取原文，200 OK，2648 字符）。原文：「*All business* users must obtain a Cubism SDK Release License. "Business" means an entity with the annual gross revenue more than ten million (10,000,000) JPY for the most recent fiscal year.」官方许可入口（URL 引自该文件，**本机未能直连**）：`https://www.live2d.com/en/download/cubism-sdk/release-license/`、`https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html`、`https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html`。
  - 网络注意：**本机对 `www.live2d.com` 的解析被劫持**（`curl -v` 显示解析到 223.26.52.12 且证书 SAN 不匹配；http 跳转到 `https://bl4.kkarhw.cn`）→ 上述 live2d.com 链接**未在本机验证可达**，需在干净网络复核。
- Spine：`https://github.com/EsotericSoftware/spine-runtimes/blob/4.2/LICENSE`（2026-10-05 经 jsDelivr 抓取原文，1469 字符，署名「Last updated April 5, 2025」）。Spine 编辑器价格页 `https://esotericsoftware.com/spine-purchase` **本机不可达，价格未验证**。
- VRM：`https://vrm.dev/en/licenses/1.0/`（2026-10-05 本机实测 200，18697 字符）。要点：VRM 文件的授权由「每个模型自带的 License Settings + VRM Public License 1.0」共同决定，含商用/改変/再分发开关。
- 市场先例（2026-10-05 实测，见 §7）：BongoCat（Tauri + Live2D，⭐23,790，Apache-2.0）、Desktop Mate（Steam 免费 + 角色 DLC）、Mate-Engine（⭐3,738，自述为 Desktop Mate 的免费替代 + 自定义 VRM）。

### 3.2 MVP 推荐（0–8 周）：**分层帧动画（WebP/APNG 序列 + 程序化变换）**

理由：
1. **授权零风险**：自有/外包美术的帧序列不引入 SDK 授权阈值与「终端用户需自购编辑器」这类结构性问题。
2. **交付速度**：1 名美术 1–3 人日即可产出 6 个状态动作；Live2D/VRM 的绑定与调试会挤占 MVP 的关键路径。
3. **性能预算友好**：与 T1 的「空闲内存 ≤150 MB」目标匹配（**依赖 docs/30 结论，待回填**）；静态帧时可完全暂停渲染。
4. **可演进**：渲染层抽象为 `PetRenderer` 接口（`loadSkin / playClip(clipId, {loop, fade}) / setState(state) / hitTest(x,y)`），Phase 2 可插入 Live2D/VRM 渲染器而不动行为层。
5. 姿态表现力用「分层部件 + 程序化变换」补足：身体 1 层 + 眼睛 1 层 + 道具 1 层 + 特效（星星/乌云/汗滴）独立层，即可做出 90% 的「有反应」质感（同类项目 clawd-pet/clawd-on-desk 即用像素帧动画达到 ⭐6,364 的接受度，2026-10-05 实测）。

MVP 资产规格（可直接给美术）：
- 动作集：`idle`（呼吸循环 24 帧 @12fps）、`think`（12 帧循环）、`work_exec`（敲键盘 16 帧循环）、`work_read`、`work_write`、`work_net`、`wait`（举手，12 帧循环 + 2 帧脉冲）、`error`（8 帧 + 乌云 12 帧）、`done`（16 帧一次性）、`sleep`（24 帧循环）、`drag`（6 帧）、`drop`（8 帧）。
- 规范：画布 512×512（@2x 输出 1024），WebP 有损 q=80，单动作 ≤60 帧，纹理 ≤2048²，总资产 ≤12 MB。

### 3.3 六个月演进方案

| 时间 | 动作 | 触发条件（Gate） |
|---|---|---|
| M0–M2 | 帧动画 MVP + `PetRenderer` 接口冻结 | MVP 验收清单通过（§11） |
| M3 | 上线「皮肤包 v1」格式（`skin.json` 描述状态→动作映射 + 文案表），开放社区投稿 | 至少 3 个外部皮肤提交 |
| M4 | 接入 **Live2D 渲染器**（作为可选 Pro 渲染后端，先行评估 SDK Release License 触发线：年营收是否 >1000 万日元） | 营收阈值未触发 **或** 已签署 Release License |
| M5 | 接入 VRM/3D 渲染器（瞄准 Desktop Mate / Mate-Engine 用户的「3D 桌宠」心智） | 3D 皮肤有明确付费需求（皮肤众筹/预售 ≥100 单） |
| M6 | 渲染器插件化 + 「角色市场」v1（分成 70/30） | 审核流程与版权证明模板就绪 |

---

### 3.4 MVP 资产规范（可验收）

> 目标：把「分层帧动画 + `PetRenderer` 抽象」变成设计、客户端、QA 三方都能照着执行与判定的规范。**设计交付即按此结构打包**；`agent-pet asset check` 是 CI 门禁。

**A. 目录与命名（皮肤 = 一个 zip）**

```
assets/skins/<skinId>/            # skinId：小写 a-z0-9-，全局唯一，如 xiaoshen-default
  skin.json                       # 皮肤清单（见 B），UTF-8，≤64 KB
  character.png                   # 预览/立绘 512×512 PNG-24，透明背景
  clips/<clipId>/
    frame-000.webp … frame-0NN.webp   # 3 位零填充、从 000 连续、无缺号
    clip.json                     # { "fps": 12, "loop": true, "anchor": [0.5, 1.0], "hitbox": [x,y,w,h] }
  fx/<fxId>.webp                  # 一次性特效（星星/乌云/汗滴/挥手）
  audio/<sfxId>.m4a               # 提示音（可选，≤200 KB，响度归一化 -20 LUFS）
```

- 皮肤包文件名：`<skinId>-<semver>.zip`；包内必须含 `skin.json` + `LICENSE.txt` + `sha256.txt`（逐文件校验和）。
- **禁止任何可执行内容**：`.js/.mjs/.node/.dylib/.so/.sh/.command/.app` 一律拒绝安装（对应 §6.3 与 `docs/60` R-10）。

**B. `skin.json`（最小字段，多余字段忽略）**

```jsonc
{ "schema": 1, "id": "xiaoshen-default", "name": "小深·默认", "version": "1.0.0",
  "author": "…", "license": "CC-BY-4.0",
  "canvas": { "w": 512, "h": 512, "scale": 2 },
  "states": { "idle": "idle", "thinking": "think", "working": "work_exec",
              "waiting": "wait", "error": "err", "done": "done" },
  "locales": { "zh-CN": "text.zh-CN.json", "en": "text.en.json" } }
```

**C. clip 规范**

| 项 | 规范 |
|---|---|
| 画布 | 512×512；@2x 素材 1024×1024 下采样；锚点 `[0.5, 1.0]`（脚底中心），保证不同 clip 不跳位 |
| 帧率 | 循环动作 12 fps；一次性动作（`done`/`drop`）24 fps |
| 帧数 | 单 clip ≤60 帧；`idle` 24 帧循环；`done` ≤16 帧 |
| 命名 | `frame-%03d.webp`，连续无缺号（`asset check` 断言） |
| 格式 | **WebP 有损 q=80，保留 alpha**；GIF/APNG 只作导入源，由构建脚本转码 |
| 色彩 | sRGB；透明背景；深色桌面（#111）下角色描边对比度 ≥3:1 |
| 体积 | 单 clip ≤1.5 MB；整皮肤 ≤12 MB |
| 必填 clipId（12） | `idle` `think` `work_exec` `work_read` `work_write` `work_net` `wait` `err` `done` `sleep` `drag` `drop` |
| 可选 clipId | `fx_star` `fx_cloud` `fx_sweat` `fx_wave`（缺失时用内置矢量特效兜底） |

**D. 导出与运行时预算**

- 导出链：设计源（Figma/AE）→ PNG 序列 → `cwebp -q 80`（或 sharp）→ 打包脚本；**源文件不入包**。
- 校验命令：`agent-pet asset check assets/skins/<id>` → 校验尺寸/帧率/命名连续性/体积/必填 clip/校验和/禁止文件类型；失败输出可读原因并以非 0 退出。
- 运行时：clip 懒加载 + LRU；**全部解码后常驻内存 ≤80 MB**；切换皮肤时释放上一皮肤（验收见 §11-H）。
- 渲染接口（`PetRenderer`，冻结于 M2）：`loadSkin(skinDir)` / `playClip(clipId, {loop, fadeMs})` / `setState(state)` / `hitTest(x,y)` / `dispose()`。Live2D/VRM 渲染器实现同一接口（§3.3 的 M4/M5）。

**E. 本节自带验收（同时收录进 §11-H）**

- [ ] 3.4-1 `agent-pet asset check` 对内置皮肤退出码 0；对缺 `wait` clip 的包退出码 ≠0 且指出缺失项
- [ ] 3.4-2 含 `.js` 的皮肤包被拒绝安装，UI 提示「皮肤包不允许可执行文件」
- [ ] 3.4-3 12 个必填 clip 全部存在且帧号连续（脚本断言，0 缺号）
- [ ] 3.4-4 切换皮肤后常驻内存回落到切换前 ±10 MB（无泄漏）
- [ ] 3.4-5 深色桌面（#111）截图取色：角色描边对比度 ≥3:1

## 4. 角色设定（1 页）

### 4.1 名字候选

| 候选 | 由来 | 优点 | 风险 |
|---|---|---|---|
| **小深** | 取自 DSH 的「深」，友好且直接 | 与 Phase 1 品牌一致；两个字好念；中英皆可（Shen） | 与 DSH 强绑定，Phase 2 多 agent 时略窄 |
| **墨墨** | 「墨水/墨迹」→ 写代码的意象 | 中性、可爱、不油；跨 agent 通用 | 重名率高 |
| **阿灯** | 桌宠像一盏「状态灯」 | 直接传递产品价值（状态指示） | 略工具化，人格感弱 |

> 推荐：**小深**（Phase 1 品牌协同）→ Phase 2 更名成本高，故名字在 MVP 上线前必须定稿（决策点见 §10）。

### 4.2 形象

一只 8 cm 高的圆润「桌面小精灵」（非人类、非真实动物）：
- 身体：深蓝到青绿的渐变豆形；哑光质感，边缘 1 px 亮描边（深色桌面上可辨识）。
- 头顶：一根 3 段式小天线 —— 直立=在线，弯曲=离线/暂停，闪烁=正在联网工具。
- 眼睛：两个大圆点，颜色即状态色（灰/蓝/绿/琥珀/红）；`waiting` 时变成两个「！」形状。
- 背后：一个小背包（工具），`working` 时背包灯亮。
- 道具：键盘（exec）、书（read）、笔（write）、天线（net）、云朵/雨（error）、星星（成功）。
- 禁止：拟人化性征、暴露服装、任何品牌 logo、政治/宗教符号（同时服务内容审核，见 §6.3）。

### 4.3 性格与语气规则

- 性格：**靠谱的搭子**。干活时安静，出问题时先给结论，不抢话、不卖萌、不说教、不油腻。
- 自称「我」，称用户「你」；不说「主人/您」。
- 口头禅（≤3 个，避免复读感）：「收到。」「交给我。」「这步稍慢，正常。」
- 语气规则：
  1. 单条 ≤14 个全角字符（长内容一律截断 + 「…」）。
  2. 全条最多 1 个感叹号；不用连续标点（`!!!`、`。。。`）。
  3. 不用网络梗、颜文字不超过 1 个、「喵/啦/嘛」类语气词不超过 1 个。
  4. 报错先说结论再说下一步（「测试挂了 3 个，我看看是哪个」）。
  5. 不评价用户（不说「你又忘了」）；不做无法验证的承诺（不说「肯定没问题」）。
  6. 敏感信息（密钥、完整路径、邮箱、token）永不进入气泡。
  7. 同一会话内同一文案 10 分钟内不重复（去重表 50 条 LRU）。

### 4.4 气泡文案示例（24 条，覆盖 6 类）

**思考（thinking）**
1. 在想…（长时间时替换为「这个有点绕，等我理一下」）
2. 让我先看两眼代码。
3. 有几种改法，我挑个稳的。
4. 嗯……这里的依赖有点多。

**工具执行（working）**
5. 跑一下测试。
6. 在读 `{{file}}`。（`{{file}}` 只取文件名，不显示全路径）
7. 改完了，顺手格式化。
8. 正在装依赖，会慢一点。

**等待审批（waiting）**
9. 这一步要你点头：`{{tool}}`。
10. 要删文件了，我不擅自动手。
11. 有个选择要你定：A 还是 B？
12. 我在等你，不急（但 agent 停了）。

**出错（error）**
13. 测试挂了 3 个，我看看是哪个。
14. 这一步被拒了，换条路。
15. 网络抽风了，我重试一次。
16. 卡住了，需要你看一眼日志。

**完成（done）**
17. 这轮好了。
18. 全部通过，交给你验收。
19. 收工，改动在 `{{n}}` 个文件里。
20. 搞定了，我歇会儿。

**长任务（>5 min，含进度与安抚）**
21. 这个要跑一会儿，你先忙。
22. 已经 12 分钟了，还在跑，正常。
23. 进度 3/7，没卡住。
24. 跑完了，用时 18 分钟。

> 文案实现要求：文案表外置 JSON，支持变量（`{{file}}`、`{{n}}`、`{{tool}}`）；同一类至少 3 条随机不重复；所有变量在渲染前做脱敏（只保留 basename、截断 24 字符）。

---

## 5. Phase 1 与 DSH 的集成触点

### 5.1 DSH 本机事实（[实测]，2026-10-05）

| 事实 | 证据（命令 / 路径） |
|---|---|
| DSH Desktop 版本 0.2.0-rc.2，Electron 应用 | `/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "/Applications/DeepSeek Harness.app/Contents/Info.plist"` → `0.2.0-rc.2`；`Contents/Resources/app.asar` 115.8 MB；`lib/main.js`、`lib/preload-*.cjs` |
| 桌面运行时信息 | `app.asar!/dsh/desktop-runtime.json`：`version 0.2.0-rc.2`、`hostProtocolVersion 4`、`nodeVersion 24.18.1`、`pnpmVersion 11.7.0`、`platform darwin`、`arch arm64` |
| Host 进程形态 | `@deepseek-ai/dsh-desktop-host` package.json description：「Private Node-mode host process for the Electron desktop application」；依赖 `dsh-host-webserver`、`dsh-client-connection`、`dsh-jobs`、`dsh-schedule` |
| 插件体系 | `@deepseek-ai/cordis` 4.0.4 + `cordis-plugin-loader`；客户端有 `dsh-client-ui-slots`（UI 插槽）、`dsh-client-ui-plugin-manager`、`dsh-client-hmr` → 存在官方客户端插件扩展点 |
| 钩子协议 | `@deepseek-ai/dsh-hook-protocol` 0.2.0-rc.2（README.zh.md）：「**只有 command 钩子会运行；`http`、`mcp_tool`、`prompt` 与 `agent` handler 会被跳过并给出警告**」；退出码 2 = 阻塞并展示 stderr；其他退出码=非阻塞失败；「Claude Code 钩子可以请求确认而非直接阻塞；**Codex 桥接不呈现此选项**」 |
| 桥接包 | `dsh-hooks-claude-code`、`dsh-hooks-codex` 存在；`hook/invoked`/`hook/result` 是「仅日志」会话事件（非 surface 事件） |

### 5.2 三个集成触点

1. **菜单栏/托盘（Phase 1 必做，由桌宠 App 自己提供）**
   - 桌宠 App 常驻菜单栏图标：状态色点 + 待办计数 + 快速菜单（勿扰、穿透、面板、退出）。
   - 不依赖 DSH 提供托盘：本次静态检索 DSH asar 的 `lib/` 只有 `main.js` 与 `preload-*.cjs`，**未发现 Electron `Tray` 的使用**（结论限定为「本次检索未发现」，非否定性证据）。
   - **不把 DSH 图标加进菜单栏**（避免和 DSH 自身 UI 抢位置/混淆品牌）。

2. **桌面悬浮层（Phase 1 必做）**
   - 桌宠是**独立进程 + 独立窗口**（透明、无边框、置顶、可穿透），不注入 DSH 渲染进程。
   - 事件通路（契约 v1.1 §5）：DSH command hook / 会话日志 tail → 适配器进程 → Unix socket `$TMPDIR/agent-pet/dsh.sock`（`ctl:hello` → Hub `ctl:ack`）→ **Hub 状态机** → `pet.snapshot` → 桌宠渲染层。
   - 好处：DSH 崩溃/升级不影响桌宠；桌宠崩溃不影响 DSH；同一适配器可复用到 Phase 2 其他后端。
   - 已回填（[`docs/40-adapters.md`](./40-adapters.md) DRAFT v1，§2）：DSH 侧 **16 类规范事件中 12 类可达（9 类 1:1）**；**离线会话日志**（`~/.dsh/sessions/<cwd 转义>/<sessionId>/session.v4.jsonl.zstd`，只读、零侵入）是默认降级路径，**hooks 是增强路径**（需用户同意写配置）。主路径最终形态待 [`docs/35-dsh-pet-bridge.md`](./35-dsh-pet-bridge.md) 实测结论（**未产出**）。

3. **可选备选形态：DSH 客户端插件内的「状态槽」**（Phase 1 不做，记录备选）
   - 利用 `dsh-client-ui-slots` 在 DSH 界面内放一个小状态块。优点：零窗口管理成本；缺点：离开 DSH 窗口就看不到 → 与「桌宠」的核心价值（余光可见）不符。结论：**仅作为降级形态**（例如企业环境禁止常驻悬浮窗时）。

### 5.3 是否允许「在桌宠上直接回话」——范围界定

**Phase 1（契约 v1.1 §1.6 / §5.4 明确）：只读，不写回。** 适配器在 `ctl:ack` 里声明 `canDecide:false`；Hub **不转发** `ctl:decide`。

| 能力 | v1 | 理由 / 契约依据 |
|---|---|---|
| 显示审批/提问及其风险摘要 | ✅ | 契约 §3.3 `approval.request` / `user.question` |
| 卡片文案「后端正在等待你的决定」+ 风险标签 | ✅ | 契约 §5.4 规定的 Phase 1 表现 |
| 点击卡片 / `⌥⌘J` 跳到对应后端窗口或终端并高亮 | ✅ | 契约 §5.4 要求「高亮到后端窗口/终端」 |
| 复制建议命令/上下文到剪贴板 | ✅ | 不改变 agent 状态，且用户仍需自己去批准 |
| 「允许/拒绝」按钮、`⌥⌘A/N` 直接批准 | ❌ | 契约 §1.6：Phase 1 只读；§5.4：`canDecide:false` 时 UI **不提供**允许/拒绝按钮 |
| 在桌宠上输入文本并发送给 agent | ❌ | 违反契约 §1.4 与 §3.3「不做」清单 |

**Phase 2 写回 Gate（契约 §5.4，五个条件全满足才可开）**：
1. 适配器在 `ctl:ack` 声明 `canDecide:true`（后端确实支持写回）；
2. Hub 才转发 `{"ctl":"decide","requestId":"…","decision":"allow|deny"}`；
3. 每次写回都有**用户可见的二次确认**（不可撤销操作再加一道「输入确认」）；
4. 写审计日志（时间 / 后端 / `requestId` / 决定 / 确认方式）；
5. **默认关闭**，需用户在设置里显式开启「允许桌宠代为决定」。

**产品红线**：即使 Phase 2，也**不**为 `risk=3`（删除/覆盖类破坏性操作）提供一键批准，只保留「跳转」；写回 UI 必须显示「你正在代替后端做决定」。

---

## 6. 商业化（Phase 2）

### 6.1 免费 / Pro 切分

> **切分原则（工作框优先，2026-10-05 用户确认形态后重排）**：免费版必须是**完整可用**的工作框（首行四项 + 会话行 + 离线/降级角标 + 待办页，永久免费）；Pro 卖「并行度（多后端）+ 主题 + 历史/诊断」；**宠物层的角色/皮肤是并列变现点之一，不是唯一**（详见 [`docs/51-work-frame-spec.md`](./51-work-frame-spec.md) §6）。

| 能力 | 免费 | Pro |
|---|---|---|
| 单后端（DSH） | ✅ | ✅ |
| **工作框核心**（首行四项 + 会话行 + 离线/降级角标 + 待办页） | ✅（**永久免费**） | ✅ |
| 多后端并行（DSH + Claude Code + Codex + Cursor…） | 最多 2 个后端 | 不限 |
| 状态与**审批强提醒** | ✅（永久免费） | ✅ |
| **工作框主题**（配色/材质/紧凑度/多屏布局预设） | 内置 2 套 | 全部主题 + 自定义导入 |
| **统计与诊断**（会话数、审批次数、被阻塞时长、`stale`/`unknownEvents`/`lateEvents`…） | 近 7 天 | 全历史 + 导出 CSV |
| 宠物层（可选）· 内置角色 | 1 个 | 全部内置角色 |
| 宠物层 · 第三方皮肤/角色 | 每周轮换试用 1 个 | 全部 + 优先领取 |
| 宠物层 · 渲染后端 | 帧动画 | + Live2D / VRM |
| 团队看板 / 审计日志（企业） | ❌ | 企业版 |
| 遥测 | 默认关闭（同免费版） | 默认关闭 |

**原则**：**安全/可用性相关能力永不放付费墙**（审批提醒、离线兜底、隐私开关）。付费只卖「表现力、并行度、历史与团队协作」。

### 6.2 定价假设（区间 + 依据）

| 形态 | 价格假设 | 依据 |
|---|---|---|
| 买断 Pro（个人） | **¥68–98**（一次性，含 2 个大版本更新） | 参照 Steam 已实测的角色 DLC 单价 **$11.99（≈¥85）** —— `store.steampowered.com/api/appdetails?appids=<id>&cc=us`，对 4 个 DLC appid（3533450 / 3681420 / 3929250 / 4145000）分别查询，2026-10-05 实测均为 `final_formatted=$11.99`（原价 $14.99）；Desktop Mate 本体免费（`is_free=true`，24 个 DLC） |
| 年订阅 Pro | **¥38–58/年** | 低于买断价，用于覆盖 Live2D 渲染器与角色授权成本 |
| 单角色/皮肤包 | **¥18–38** | 低于 Steam 同类 DLC；对标移动端皮肤定价习惯（**[假设]**） |
| 角色市场分成 | 创作者 **70%** / 平台 30% | 行业常见区间（App Store 70/30）**[假设]** |
| 企业版（团队状态看板 + 审计） | **¥25–45/席/月**（≥10 席起） | 需与 T4 路线图的企业功能范围对齐，**[假设]**，待验证 |
| 付费意愿风险 | 高 | 同类工具现状（2026-10-05 实测）：BongoCat ⭐23,790 Apache-2.0 免费、clawd-on-desk ⭐6,364 AGPL-3.0 免费、OpenPetsHQ/openpets ⭐1,261 MIT 免费、alterhq/openpets ⭐98 MIT 免费、agentpet ⭐376 MIT 免费 → **开发者桌宠品类以免费开源为主，直接功能付费意愿低**，收入更可能来自「皮肤/角色」与「企业」 |

> **定价决策点**：MVP 上线后 4 周内做一次「假设价格页」A/B（不做真实支付，只统计点击意愿），用真实数据替换上述假设。

### 6.3 皮肤/角色市场

- 载体：`skin.json` + 资产包（zip），带签名与校验和；本地安装即离线可用。
- 审核（必须项，与风险登记册 R-10 对应）：版权证明（作者声明 + 原创性承诺）、禁止未标注的 AI 生成、禁止真人肖像/在世画师风格临摹、内容分级（默认全年龄）、禁政治/宗教/色情/暴力、禁止内置可执行代码（皮肤包只允许声明式 JSON + 图片/音频）。
- 分发：官方市场（审核 + 分成）+ 侧载（用户自负责任，UI 明示风险）。

### 6.4 与 agent 厂商的合作模式（按优先级）

1. **官方适配器认证**：向 DSH / Anthropic / OpenAI 提交适配器，争取「Works with X」标识与文档互链（零成本、最高杠杆）。
2. **联合分发**：作为 agent 桌面端的推荐伴侣应用出现在其插件/集成目录（参照 OpenPets 的 `/integrations` 页面做法）。
3. **企业版捆绑**：把桌宠的「团队状态看板/审计」卖给已经在用 agent 的团队（真需求：谁在等审批、谁被阻塞多久）。
4. **平台预装/合作皮肤**：与 agent 厂商联名角色（收益分成），参照 Desktop Mate 的 IP DLC 模式。

### 6.5 隐私承诺（写进产品页与设置页）

1. **本地优先**：事件只在 `127.0.0.1` / Unix socket 与本地文件之间流动；核心功能完全离线可用（BongoCat 也以此为核心卖点）。
2. **不读对话正文**：只处理契约 §3 的元数据与 ≤280 字符摘要；契约 §3.3「不做」清单是硬边界。
3. **遥测默认关闭**：安装时明确询问（opt-in），关闭时零网络请求；开启后只上报匿名计数（状态迁移次数、崩溃栈）。
4. **一键清除**：设置页提供「清除全部本地记录」（`~/.agent-pet/records`、状态日志、缓存）。
5. **无账号可用**：不注册、不登录即可使用全部核心功能。
6. **开源适配器 SDK**：适配器与契约实现开源，可审计（差异化优势，直接回应「往我电脑里塞了什么」的疑虑）。

---

## 7. 竞品与可借鉴点（Phase 2 视角，2026-10-05 实测）

| 产品 | 事实（GitHub API 实测 / 官方页） | 差异 | 可借鉴点 |
|---|---|---|---|
| **Clawd on Desk** `github.com/rullerzhou-afk/clawd-on-desk` | ⭐6,364、AGPL-3.0、JS、2026-10-05 仍在推送；自述支持 Claude Code/Codex/Cursor 等 | 单桌宠多后端，功能最全的同类；AGPL 传播性限制商业复用 | 「内置主题 + 自定义主题 + 导入 Codex Pet 动画包」的皮肤策略；跨平台（Win/macOS/Ubuntu）打包 |
| **clawd-conduit** `github.com/ssssssanjiu/clawd-conduit` | ⭐180、MIT；「all 15 hook events」、`Cmd+Shift+Y/N` 桌面上批准、**权限卡片永不自动关闭** | 只做「接线层」，依赖 Clawd | 审批卡片不自动消失、快捷键就地批准（我们 v1 只做跳转）、参数取舍（`permissionBubbleAutoCloseSeconds: 0`） |
| **BongoCat** `github.com/ayangweb/BongoCat` | ⭐23,790、Apache-2.0、Rust（Tauri）、README 明确「Live2D + 完全开源 + 无数据收集 + 离线可跑」 | 交互陪伴型（无 agent），非状态型 | **Tauri + Live2D 的可行性已被 2.3 万星验证**；「模型可替换」与离线隐私叙事 |
| **OpenPets（HQ 版）** `github.com/OpenPetsHQ/openpets` | ⭐1,261、MIT、TS；自述「Local first, desktop companion platform with animated pets, **plugin SDK** and coding-agent integrations」、MCP server | 与我们的 Phase 2 定位最接近（平台化 + plugin SDK） | 插件 SDK 的接口设计、MCP 作为统一接入面的做法 |
| **OpenPets（原生 macOS 版）** `github.com/alterhq/openpets` | ⭐98、MIT、Swift；菜单栏 App + MCP + CLI 共享同一只宠物；要求 macOS 14+ | Swift 原生、单机 macOS | 「菜单栏 + CLI + MCP 三入口共享一只宠物」的架构；`OpenPetsKit` 可嵌入 SDK 的封装思路 |
| **UniPet** `github.com/ydyangdan/UniPet` | ⭐38、MIT、JS；自述「connectors send facts, while UniPet owns behavior, bubbles, and rendering」、localhost 协议（HTTP/WebSocket） | 架构与我们契约几乎同构（事实/表现分离） | 直接印证契约 §1.1「适配器极薄」的正确性；`unipet agent add <x>` 的接入引导体验 |
| **AgentPet** `github.com/ntd4996/agentpet` | ⭐376、MIT、Swift；菜单栏监控每个 agent 实时状态 + 桌宠；「被真实工作量喂养」的 tamagotchi 成长系统 | 单机 macOS、成长系统 | 「菜单栏总览 + 桌宠情感化」双通道；把 token/会话数变成 XP 的留存机制 |
| **Desktop Mate** `store.steampowered.com/app/3301060/` | Steam API 实测 `is_free=true`，24 个 DLC；实测 4 个角色 DLC 均 **$11.99**（原价 $14.99） | 纯陪伴 3D 桌宠（VRM + 官方 IP 联动），与 agent 无关 | **商业化范式：本体免费 + 角色/IP DLC 收费**；3D 桌宠的用户心智已被教育 |
| **Mate-Engine** `github.com/shinyflvre/Mate-Engine` | ⭐3,738、2026-01-20 最后推送；自述为 Desktop Mate 的免费替代 + 自定义 VRM | 同类 3D 替代品 | 「自定义 VRM」是社区强需求 → 支撑我们 M5 接入 3D 的计划 |
| **cc-haha** `github.com/NanmiCoder/cc-haha` | ⭐14,863、MIT、TS；本地优先的 Claude Code/agent 桌面工作台（多 agent、worktree、skill 市场） | 不是桌宠，是工作台（竞争「用户注意力」） | 「本地优先 + 多 agent 管理」的定位；skill/插件市场的运营方式 |
| **Vibe Kanban** `github.com/BloopAI/vibe-kanban` | ⭐28,264、Apache-2.0、Rust；2026-09-19 仍在推送 | 看板式 agent 编排 | 「多 agent 并行时要一个统一视图」的需求已被 2.8 万星验证 |

**结论（对产品定位的影响）**：
1. 「agent 状态桌宠」不是空白市场：≥8 个同类项目，头部（clawd-on-desk）已 6.3k 星 —— 差异化必须落在**跨后端广度 + 契约化的适配器 SDK + 隐私默认最强 + 桌面端体验（多屏/全屏/点击穿透/审批可得性）**，而不是「又一个会动的宠物」。
2. 该品类**普遍免费开源** → 商业模型必须走「皮肤/角色 + 企业」，见 §6.2。
3. 已有项目大多用 hooks 直连单一 agent → 我们的契约化中间层（一次适配、多后端复用）是结构性优势。

---

## 8. 建议变更（对 `00-interface-contract.md` 的意见，**未擅自修改契约**）

> 本节在 v0.2 改为**跟踪表**：v0.1 提出的 C1–C4 已被 Lead 在契约 v1.1 中处理（对应 `docs/99-verification-report.md` 的 C-01/C-03/C-04/C-12）；仍开放的建议标 ⏳。

| # | 位置 | v0.1 的问题 | v1.1 状态 | 本规格的落点 |
|---|---|---|---|---|
| C1 | §3 标题 vs 表格 | 「14 种」与实际 16 个 `type` 字符串不符（**v1.2 已改为「16 个 type 字符串 / 16 行」**） | ✅ **已采纳**：§3 标题改为「16 种 type 字符串 / 16 行」，§7.1/§7.5 按 16 个计数 | §1.1 按 §4.2 真值表重写；§11-A1/A6 覆盖 16 行 |
| C2 | §3.4 vs §4 | `agent.status` 枚举含 `blocked`，状态机含 `done`，两套不一致 | ✅ **已采纳**：§3.4 枚举收敛为 5 个（去 `done`/`blocked`）；§4.1 明确 `done` 是本地过渡态 | §1.1 表下「后端可上报 5 个状态」+ §1.2-A4 |
| C3 | §4 超时兜底 | waiting 会被 10 min 兜底**静默丢弃** | ✅ **已采纳**：拆成 §4.4（45 s 判连接）与 §4.5（10 min 清会话）两条独立规则 | §1.3：R1/R2/R3 + 「必须留痕」三条产品要求 |
| C4 | §3.4 `agent.status` | 无作用域；10 s 覆盖可压掉 `waiting` | ✅ **已采纳**：§3.4 补覆盖规则（10 s 内 且 优先级≥当前，或 `force=true`；被拒计 `overrideRejected`） | §1.2-A4：审批提醒不会被后端「自认为在忙」压掉 |
| C5 | §3.2 `message.assistant` | `text` ≤280 字符对桌宠气泡过长（屏幕上 2 行 ≈60 全角字符） | ⏳ **未采纳**（不改契约） | §2.5：渲染层截到 60 字，保留 `truncated` 语义 |
| C6 | §3 缺「用户已读/关闭气泡」回执 | 桌宠无法把「用户看到了」回执给 Hub/适配器（影响通知去重与调度） | ⏳ **未采纳**（v1.1 用 `pet.snapshot.bubble` 表达「显示什么」，但没有回执方向） | 记入 Phase 2 备选：建议加回执帧 |
| C7 | §5 传输层 | socket 权限位与路径长度未定义（macOS `sun_path` 上限 104 字节；默认权限可能被同机其他用户读取） | ⏳ **部分采纳**：v1.1 §5.1/§5.2 保留路径约定，仍未写权限位 | 已在 [`docs/60`](./60-risk-register.md) R-06 作为安全要求 |
| **C8（v0.2 新提）** | §4.4/§4.5 vs §5.3 | R1/R2 会清空未决登记，但 `pet.snapshot` **不含**「被清理的未决项」历史 → §1.3 的「必须留痕」只能由桌宠本地拼凑，Hub 重启或桌宠晚启动就会丢 | ✅ **已采纳（方案①）**：v1.2 `pet.snapshot.clearedPending[]`（含 `kind/requestId/clearedAt/reason`） | §1.3 的可见性保证、§11-B7、[docs/51](./51-work-frame-spec.md) §3.3 |
| **C9（v1.2）** | 契约 §4.1/§4.7 | 六个展示状态里没有「瞬态错误」，而错误实际分两类（2 s 一闪 vs 常驻） | ✅ **已采纳**：§4.7 定义 `transient-error`（TTL 2 s/1.5 s）+ 持久 `error` + 3 连击升级；计 `recoveredErrors`/`escalatedErrors` | **本轮已对齐**：§1.1 表拆成 `error`（持久红）与 `transient-error`（瞬态黄 2 s）两行 |
| **C10（v1.2）** | 契约 §5.3 | 工作框会话行需要会话名/工作目录/该会话时长与最近动作，`sessions[]` 原本只有 `{source, sessionId, state, since}` | ✅ **已采纳**：`sessions[]` 补可选 `title?/workspace?/lastTool?/elapsedMs?/pending?` | [docs/51](./51-work-frame-spec.md) §5.1 会话行、§2.1 分区表（原 G7） |
| **C11（v1.2）** | 契约 §8.3 vs §5.3 | 降级标注要求提及 `degradedSources`，但快照示例没有该字段 | ✅ **已采纳**：`pet.snapshot.degradedSources[]` 新增，与 `offlineSources` 区分（offline=完全无事件；degraded=有事件但有缺口） | [docs/51](./51-work-frame-spec.md) §3.5 角标表（原 G1） |
| **C12（v1.2）** | 契约 §5.3 | 首行 `⏳N` 需要未决总数，快照原本只有单条 `bubble` | ✅ **已采纳**：每会话 `pending` 计数；首行 `⏳N` = Σ `sessions[].pending` | [docs/51](./51-work-frame-spec.md) §3.3（原 G2） |
| **C13（v1.2）** | 契约 §8.1 vs §8.4 | §8.1 已写「首行 40 px + 每会话行 28 px、`MAX_SESSION_ROWS=5`（不含首行）、高度 = `40+28×min(N,5)+(N>5?22:0)`」，但 §8.4 仍写「窄条 36–48 px」 | ⏳ **仅表述待统一**：建议 §8.4 引 §8.1 的公式（产品侧已按「首行 40 px（可配 36–48）+ 每会话行 28 px」表述，不再照抄） | [docs/51](./51-work-frame-spec.md) §2.1/§2.3（原 G8） |
| **C14（QA 裁决）** | §50 §2.4 / §2.10 / §11-C3 / §11-H | QA 测试计划（[qa/test-plan.md](../qa/test-plan.md) §6.2）发现三处与工作框规格不一致：右键菜单项数、全屏行为、资产验收是否阻塞 M2 | ✅ **已裁决并落地（2026-10-05，Lead）**：① 菜单以 [docs/51](./51-work-frame-spec.md) §4.4 为准 = **15 项**（§2.4 与 §11-C3 已改）；② 全屏以 §51 §4.1 为准 = **自动收窄条 + 退出恢复**（§2.10 已改）；③ §11-H1..H5 **不阻塞 M2**，移入 M3（皮肤包 v1），已在 §11-H 加说明 | 本文 §2.4/§2.10/§11-C3/§11-H；QA 侧 T-37/T-38/T-60..T-64 |

---

## 9. 依赖与 TODO（待回填）

- [x] **docs/40（队友 C）** ✅ 已完成（DRAFT v1）→ 已回填 §5.2/§5.3：DSH **16 类中 12 类可达（9 类 1:1）**；离线日志（只读零侵入）为默认降级路径、hooks 为增强路径；Claude Code/Codex/Cursor/Copilot 的 hooks 需写用户配置（属「需同意安装」）。
- [x] **docs/10（Lead）** ✅ DRAFT v0.9 → §1 已按 ADR-2 改为「Hub 权威」；本文 §1.0 明确渲染层边界。
- [x] **docs/70（Lead）** ✅ DRAFT → §11 责任人用其角色名（外壳 / Hub / 设计 / QA）。
- [ ] **docs/30（队友 A，占位）**：空闲内存/CPU/包体积实测值 → 待回填 §3.1 性能列、§3.2 理由 3、§11-D；渲染技术栈主选需与本文 §3.2 的「分层帧动画 + `PetRenderer`」一致（冲突时以 T1 实测为准并回来改 §3）。
- [ ] **docs/35（队友 D，未产出）**：DSH 事件获取主路径（日志 tail vs 插件 vs hook）→ 待回填 §5.2 的最终形态。
- [ ] **docs/20（Lead/T4，占位）**：里程碑切分 → §3.3 的 M0–M6 与 §11 的「M2 全绿」口径需对齐。
- [ ] **docs/60（本文档作者，T5）**：风险条目与本文决策的双向引用。
- [ ] 待验证：Live2D SDK Release License 的具体费用档位（本机无法访问 live2d.com，DNS 被劫持）；Spine 编辑器价格页；three-vrm 版本与许可证文本；macOS Focus 状态可读性。

## 10. 需要 Lead 决策的点

1. **角色名定稿**（小深 / 墨墨 / 阿灯）——影响品牌、皮肤包命名空间与 §3.4 的 skinId 命名。
2. **C8（新）**：R1/R2 清理未决项后的留痕来源——建议采纳 §8-C8 的方案 ①（pet.snapshot 增 clearedPending[]），否则 §1.3 的可见性承诺会随 Hub 重启丢失。
3. **MVP 渲染方案确认为「分层帧动画 + PetRenderer 抽象」**（§3.2/§3.4 已给出可验收规范；若 T1 实测偏向 Live2D 首发，需回来重算授权与工期）。
4. **Phase 2 写回的红线**是否写进对外承诺：本文建议 risk=3（破坏性操作）**永不**提供一键批准，只在 Phase 2 对 risk≤2 且 canDecide=true 开放。
5. **付费模型**先做皮肤/角色还是先做 Pro 功能（本文建议先皮肤/角色，理由是同类产品普遍免费）。
6. ~~契约 C1/C2/C3/C4~~ → 已在契约 **v1.1** 解决（见 §8 跟踪表），无需再决策。

---

## 11. MVP 验收清单（可勾选、可测试）

> 使用方式：每条都能写成一个自动化用例或一次人工检查。**Gate 1（W8）前本清单必须全绿**；排期里程碑见 [`docs/20`](./20-roadmap.md) §2（注意：本文 §3.3 的 M0–M6 是**渲染器演进编号**，与 docs/20 的排期 M 编号不同义）；责任人角色沿用 [`docs/70`](./70-team-and-metrics.md)（外壳 / Hub / 设计 / QA）；资产类验收见 §3.4。
> 记法：`[ ]` 未验证 / `[x]` 通过；括号内为验证手段。

### A. 契约一致性（契约 §7）
- [ ] A1 用 `fixtures/*.pet.jsonl` 离线回放，复现全部 6 个状态与 5 类特效（`pet --replay fixtures/contract-sample.pet.jsonl` + 录屏比对）
- [ ] A2 `kill -9` 任一后端 → **45 s 内**该 source 被标记离线、其会话聚合与未决登记被清空、聚合状态回落到其他 source（无则 `idle`），无崩溃（脚本 + 观察快照流；契约 §7.2 / §4.4）
- [ ] A3 注入 1000 条未知 `type`：`unknownEvents +1000`、无异常、**RSS 漂移 <5%**（契约 §7.3 的阈值；脚本 + `ps` 采样）
- [ ] A4 打乱 2 s 窗口内事件顺序投递，最终状态与顺序投递一致；跨窗口迟到计 `lateEvents` 且**最终状态不倒退**（契约 §7.4；T6 的 `replay-check.mjs`）
- [ ] A5 单事件序列化 ≤8 KB；超限时 `data.summary` 被截断且 `privacy.fields` 标注（适配器单测）
- [ ] A6 适配器输出覆盖 §3 全部必填字段 `v/seq/ts/source/sessionId/workspace/type/data`，且 §3 的 **16 行 / 16 个 type 字符串**各有 fixture（契约 §7.5）
- [ ] A7 **审批配对**：`approval.resolved` 用 `requestId` 配对成功才改变状态；无配对 → 计 `orphanApprovals` 且状态不变（构造「先 resolved 后 request」乱序用例）
- [ ] A8 **心跳语义**（契约 §7.6）：只发 `pet.heartbeat` 的会话 10 min 后被 `stale` 清理，且心跳不刷新 `lastStateChangeTs`（时钟加速）
- [ ] A9 **`agent.status` 覆盖规则**：低优先级状态不覆盖 `waiting`（计 `overrideRejected`）；`force=true` 时生效；超过 10 s 的旧状态不生效
- [ ] A10 **握手与只读**：适配器发 `ctl:hello{contract:1,resumeAfter}` → 3 s 内收到 `ctl:ack{ok:true,canDecide:false}`；`ok:false` 时适配器停止发送并以非 0 退出（契约 §5.2/§5.4）

### B. 状态机
- [ ] B1 `waiting` 不被 `tool.result(error)`/`error.raised(fatal=false)` 打断；`fatal=true` 例外（fixture 注入）
- [ ] B2 `waiting` 期间低优先级事件不改变全局状态（stateLog 断言）
- [ ] B3 **R2 清理（§4.5）**：停止注入事件 10 min 后该会话回 `idle`、`stale=1`，且**留痕三条全部生效**——①菜单栏琥珀计数保留 ②面板列出「被清理的审批」含 `requestId` ③（默认开）系统通知；用户确认后痕迹才消失
- [ ] B7 **R1 与 R2 独立**：只有心跳、无状态变化时，45 s 不触发离线，但 10 min 必定触发 R2 清理（两条规则互不干扰）
- [ ] B4 `turn.start` 后 300 ms 内 `step.start` 只产生一次可见切换（stateLog 计数 = 1）
- [ ] B5 两个会话并发（一个 `working`、一个 `waiting`）→ 全局 `waiting`，徽标 2 个且 waiting 置顶
- [ ] B6 `done` 停留 2 s 回 `idle`；`error` 停留 1.5 s；`turn.end(error)` 3 s（计时断言）

### C. 交互
- [ ] C1 拖拽 100 次全部落在可视区；四边吸边位置误差 ≤4 px（自动化 UI 测试）
- [ ] C2 点击穿透开启后底层窗口收到点击事件；`⌥⌘P` 可恢复；菜单栏显示「穿透中」角标（手工 + 自动化各一次）
- [ ] C3 右键菜单 **15 项**齐全、逐项点击无崩溃（清单以 [docs/51](./51-work-frame-spec.md) §4.4 为准）
- [ ] C4 连续注入 10 条 `message.assistant`：气泡节流 ≥1.5 s/次且同时仅 1 条（时间戳断言）
- [ ] C5 `approval.request` 后 3 s 内出现气泡+置顶+抖动+声音；无响应则 30 s 后再次提醒（最多 3 次）；**卡片上不存在 allow/deny 控件**（无障碍树/截图断言，契约 §5.4 只读）；`approval.resolved` 后气泡消失
- [ ] C6 勿扰「完全静默」下审批仍保留：菜单栏琥珀 + 徽标红点 + 面板待办计数（截图比对）
- [ ] C7 夜间窗口（23:00–08:00）内气泡不弹、声音关闭、帧率 ≤6 fps；窗口结束弹出唤醒摘要
- [ ] C8 前台全屏应用时桌宠半隐藏 + 静音；退出全屏 1 s 内恢复原位

### D. 性能（与 [docs/30](./30-implementation-stack.md) 指标对齐，**待回填**）
- [ ] D1 空闲 5 min：内存 ≤150 MB、CPU ≤1%（`ps -o rss,%cpu` 采样 30 次取中位数）
- [ ] D2 桌宠运行前后，DSH 首字响应无可测劣化（各 10 次取平均，差值 <100 ms）
- [ ] D3 动画播放时 GPU 占用 <10%，静态帧时接近 0（Activity Monitor GPU 栏）
- [ ] D4 常驻 24 h 无内存增长（RSS 漂移 <10%）

### E. 稳定性与安装
- [ ] E1 桌宠崩溃后 5 s 内自动重启，且不影响 DSH（`kill -9` 桌宠进程 + 观察）
- [ ] E2 DSH 被杀/重启：45 s 内该 source 标记「离线」角标且聚合状态回落（契约 §4.4），DSH 重启后适配器自动重连 socket/日志 tail
- [ ] E3 适配器安装：写 hooks 前有备份 + diff 确认 + 幂等（重复执行 2 次结果相同）+ 一键回滚（恢复文件与原文件 `shasum` 一致）
- [ ] E4 卸载：无残留 LaunchAgent、无残留 socket、agent 配置已回滚；`~/.agent-pet` 由用户选择保留/删除
- [ ] E5 首次启动引导 ≤90 s 可完成、可跳过；全程 tcpdump 抓包 0 外连

### F. 隐私与合规
- [ ] F1 默认配置下运行 24 h：抓包确认 0 出网连接
- [ ] F2 录制文件权限 `0600`、目录与 socket 目录 `0700`、socket `0600`（`stat -f "%Sp %N"`）
- [ ] F3 全部 fixture 与真实录制做敏感信息正则扫描（`sk-`/`ghp_`/`AKIA`/绝对路径/token）→ 0 命中
- [ ] F4 一键清除后 `~/.agent-pet/records` 为空，面板不再显示历史
- [ ] F5 遥测关闭时无 payload；开启时设置页可预览并可导出「我发送过的数据」

### G. 可访问性与国际化
- [ ] G1 开启「减弱动态效果」后无位移/抖动动画（仅透明度变化）
- [ ] G2 VoiceOver 能朗读当前状态与待审批数量
- [ ] G3 zh-CN / en 切换无残留 key；缺键回退 en

### H. 资产管线（规范见 §3.4）

> **裁决（2026-10-05，Lead）：H1-H5 不阻塞 M2**，随宠物层一起移入 **M3（皮肤包 v1）** 里程碑。理由：宠物层已默认关闭，M2 的锚点是「真实 DSH 会话驱动工作框」；资产验收在工作框跑通后再做。QA 用例标签见 [qa/test-plan.md](../qa/test-plan.md) §2.8（T-60..T-64 标注「M3 前」）。
- [ ] H1 `agent-pet asset check assets/skins/<id>` 对内置皮肤退出码 0；对缺 `wait` clip 的包退出码 ≠0 并指出缺失项
- [ ] H2 含 `.js/.sh/.command` 的皮肤包被拒绝安装，UI 提示「皮肤包不允许可执行文件」
- [ ] H3 12 个必填 clip 全部存在、帧号从 000 连续无缺号、单 clip ≤1.5 MB、整皮肤 ≤12 MB（脚本断言）
- [ ] H4 切换皮肤后常驻内存回落到切换前 ±10 MB（无泄漏）；全部 clip 解码常驻 ≤80 MB
- [ ] H5 深色桌面（#111）截图取色：角色描边对比度 ≥3:1

---

### 附：本文档的实测命令与来源（全部 2026-10-05，Asia/Shanghai）

- DSH 版本与 bundle：`/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "/Applications/DeepSeek Harness.app/Contents/Info.plist"`；`app.asar` 头部解析脚本（见 `docs/90-research-notes.md` 队友 B 段）。
- DSH 钩子协议：`app.asar!/dsh/node_modules/@deepseek-ai/dsh-hook-protocol/README.zh.md` 与 `package.json`。
- Live2D 许可原文：`https://cdn.jsdelivr.net/gh/Live2D/CubismWebSamples@develop/LICENSE.md`（200，2648 字符）。
- Spine 许可原文：`https://cdn.jsdelivr.net/gh/EsotericSoftware/spine-runtimes@4.2/LICENSE`（200，1469 字符）。
- VRM 许可：`https://vrm.dev/en/licenses/1.0/`（200，18697 字符）。
- 竞品元数据：`https://api.github.com/repos/<owner>/<repo>`；`https://api.github.com/search/repositories?q=...`。
- Desktop Mate 价格：`https://store.steampowered.com/api/appdetails?appids=3301060&cc=us&l=english`（`is_free=true`、24 DLC）与 `appids=3533450|3681420|3929250|4145000`（`$11.99`）。
- npm 下载量（品类早期信号）：`https://api.npmjs.org/downloads/point/last-month/uni-pet` → 40；`.../clawd-pet` → 39（2026-09-04～2026-10-03）。
