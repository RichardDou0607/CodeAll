# 00 · Agent 悬浮窗事件接口契约 v1.4（Phase 1 / Phase 2 共用）

> 状态：**FROZEN v1.4**（2026-10-19）。上一版：v1.3（2026-10-05）。
> **v1.4 变更（手动停止 ≠ 出错）**：`aborted` 由「落 `idle`」改为独立会话态 **`aborted`（手动停止）**——用户中断（ESC / 停止按钮）此前在实现里被工具取消错误顶成 `transient-error` 永不过期，观感即「一直出错」。`tool.result` 的 `status` 词汇新增 `aborted`（工具被用户取消，如 ZCode 的 `"… was cancelled"` 错误文本）；`turn.end` / `step.end` / `session.end` 的 `aborted` 分支统一置会话态 `aborted`。`aborted` 为中性终态：优先级与 `done` 同级、不计入错误、非进行中。渲染层文案「手动停止」。
> **v1.3 变更（多项目 / 多会话）**：新增两个事件类型 —— `session.meta`（Agent 软件名 / 模型 / 思考程度 / 预设 / 标题）与 `session.activity`（**粗粒度**活动摘要，禁止步骤明细）；控制帧新增 `catalog.get` / `catalog` / `session.open` / `session.new`；`ack` 增加 `canCatalog` / `canOpen` / `canCreate` 能力位；§8 增加目录视图所需契约保证。
> 说明：事件里的 `v` 仍为 **1**（纯增量字段，向后兼容）。
> **v1.2 新增用户方向**：桌宠的**主界面是「工作框（Work Frame）」**——常驻小窗，主职责是**显示 agent 状态与进度**，宠物形象是框内的可选陪伴元素（详见 [50-product-spec.md](./50-product-spec.md)）。契约因此补充：`session.start` 携带 `startedAt`、`session.end` 携带 `endedAt`（供工作框显示时长/计时）；`sessionIdle` 语义明确为「会话级 idle」。
> 本文件是 `agent-desktop-pet`（Agent 桌宠）项目所有适配器、Hub、渲染层之间的唯一接口真相源。
> 证据来源：本机 DSH 0.2.0-rc.2 运行时（`@deepseek-ai/dsh-session` 的 `KNOWN_SESSION_EVENT_TYPES`、`@deepseek-ai/dsh-hook-protocol`、`@deepseek-ai/dsh-hooks-claude-code`/`-codex` README）。
> v1.1 变更（响应独立验收报告 `docs/99-verification-report.md` 的 P0）：统一事件计数口径（§3）；补全必填标注（§2.3）；审批/提问强制关联 ID（§3.3）；补桌宠→适配器控制帧与握手/续传语义（§5、明确 Phase 1 只读）；拆解 45 s 与 10 min 两条超时（§4.4、§4.5）；补完整「type × 分支 → 状态」真值表（§4.2）；明确 `seq` 作用域与去重键（§2.4）；补 `agent.status` 覆盖规则（§3.4）。

---

## 1. 设计目标

1. **适配器极薄**：每个 Agent 后端只负责「原生事件 → 规范事件」，不含任何动画/情绪逻辑。
2. **失去连接不崩**：任何后端断开时，桌宠退化为 idle，不得白屏、不得卡死。
3. **可离线重放**：同一份规范事件流可录制（`*.pet.jsonl`）并回放，用于开发、测试、演示。
4. **隐私默认最强**：只传事件元数据 + 截断摘要，绝不整段上传对话正文；所有云端能力可关闭。
5. **向前兼容**：未知事件类型必须被忽略并计数（`unknownEvents` 计数器），不得抛异常。
6. **Phase 1 只读**：桌宠与 Hub **不向任何 Agent 后端写回决定**（审批/回答一律由后端自身产生）。写回能力在 Phase 2 通过 `canDecide` 能力协商开启（§5.4）。

---

## 2. 事件信封与帧格式

### 2.1 事件信封
所有规范事件都是单行 JSON（JSONL，UTF-8，`\n` 结尾）：

```jsonc
{
  "v": 1,                              // 契约主版本号，破坏性变更才 +1；v1.1 文档修订不改变此值
  "seq": 42,                           // per-(source, sessionId) 单调递增，从 0 开始
  "ts": 1791172500273,                 // Unix ms（事件发生时刻，不是收到时刻）
  "source": "dsh",                     // 后端 ID：dsh | claude-code | codex | cursor | acp | …
  "sessionId": "session-0a1b2c3d-…",   // 后端原生会话 ID（不透明）；后端级事件为 null
  "workspace": "/Users/x/proj",        // 工作目录，未知为 null
  "agent": { "name": "DSH", "version": "0.2.0-rc.2" },  // 可选
  "type": "tool.call",                 // 规范事件类型，见 §3
  "data": { },                         // 类型专属载荷，见 §3
  "privacy": { "redacted": true, "fields": ["text"] }    // 可选：本事件被脱敏的字段名
}
```

### 2.2 控制帧（与事件区分）
控制帧**没有 `type` 字段**，改用 `ctl`，避免与事件混淆：

```jsonc
{ "ctl": "hello",  "contract": 1, "source": "dsh", "adapterVersion": "0.1.0", "resumeAfter": 41,
  "observes": ["turn.*","step.*","tool.*","approval.*","session.*"] }   // 观测能力等级（v1.2 新增，可选）
{ "ctl": "ack",    "contract": 1, "ok": true, "heartbeatMs": 15000, "canDecide": false,
  "canCatalog": true, "canOpen": true, "canCreate": false }   // v1.3 能力协商：目录 / 打开已存在会话 / 新建会话
{ "ctl": "ack",    "contract": 1, "ok": false, "error": "unsupported-contract" }
{ "ctl": "decide", "requestId": "req-7", "decision": "allow" }   // Phase 2 才允许（§5.4）
{ "ctl": "catalog.get" }                                              // v1.3：请求项目/会话目录
{ "ctl": "catalog", "projects": [ { "projectId": "…", "cwd": "/Users/x/proj", "sessions": [ { "sessionId": "…", "title": "…", "agentName": "DSH", "model": "deepseek-flash", "reasoningEffort": "max", "state": "idle", "updatedAt": 1791…, "live": false } ] } ] }
{ "ctl": "session.open", "sessionId": "…" }                           // v1.3：打开已存在会话（★ 需要适配器具备 open 能力）
{ "ctl": "session.new",  "cwd": "/Users/x/proj", "agents": ["dsh"] }   // v1.3：在指定项目新建会话（★ 需要适配器具备 create 能力）
```

### 2.3 必填规则（全文档统一）
- 每张 data 表里：**标 `*` = 必填**，**标 `?` = 可选**；**未标注 = 必填**。
- 信封必填：`v`、`seq`、`ts`、`source`、`sessionId`（可为 `null`）、`workspace`（可为 `null`）、`type`、`data`。
- 单事件序列化后 **≤ 8 KB（口径：8192 个 UTF-8 字节，含换行符，不含行分隔后附加内容）**；超限时由**适配器**负责截断 `data.summary`/`data.text`（**不得截断多字节字符的中间字节**，截断后必须仍是合法 JSON），并在 `privacy.fields` 标注被截断字段。
- Hub 侧兜底：若仍收到 >8 KB 的行，**丢弃该行**并计 `oversizedDropped`（不得崩溃、不得截断后继续当作有效事件），同时在健康计数里暴露给工作框。

### 2.4 顺序、去重、乱序
- **`seq` 作用域**：per-`(source, sessionId)` 单调递增；后端级事件（`pet.heartbeat`、`sessionId=null`）使用 `sessionId = "backend"` 这一保留值。
- **去重键**：`(source, sessionId, seq)`；重复到达的事件**丢弃**并计 `duplicates`（不覆盖、不报错）。
- **乱序缓冲**：窗口 = **2 s 或 32 条，先到者触发冲刷**；窗口内按 `seq` 排序后应用。
- **窗口外迟到**：仍接受（不丢数据），但打标 `outOfOrder=true` 并计 `lateEvents`；应用规则见 §4.6（不得让状态倒退到更早的迁移）。

---

## 3. 规范事件类型（v1 冻结：**16 种 type 字符串 / 16 行**）

### 3.1 生命周期

| type | data 载荷（`*` 必填 / `?` 可选） | 触发语义 | 桌宠行为 |
|---|---|---|---|
| `session.start` | `nativeSessionId*`, `startedAt*`（Unix ms）, `workspace?`, `agentName?`, `agentVersion?`, `title?` | 一个新会话出现 | 工作框新增一行会话卡片并开始计时；宠物唤醒动画（可关） |
| `session.end` | `nativeSessionId*`, `endedAt*`（Unix ms）, `reason*`: `done\|aborted\|error\|unknown`, `durationMs?`, `summary?` | 会话结束 | 工作框结束计时并归档该卡片；`reason=error` → **持久 `error`**（§4.7，非 3 s 瞬态）；`done` → `done` 2 s 后 `idle`；`aborted` → `aborted`（**手动停止**，v1.4）；`unknown` → `idle` |
| `pet.heartbeat` | `nativeSessionId?`（可为 `null`）, `load?`: 0..1（缺省 0），`sessionCount?` | 保活 / 负载上报 | 呼吸节奏随 `load` 微调；**不改变状态、不计入状态超时**（§4.5） |

### 3.2 推理与步骤

| type | data 载荷 | 触发语义 | 桌宠行为 |
|---|---|---|---|
| `turn.start` | `turnId*`, `inputKind*`: `user\|system\|webhook\|unknown` | 一轮对话开始 | → `thinking`，出现「思考云」 |
| `turn.end` | `turnId*`, `status*`: `ok\|aborted\|error`, `durationMs?`, `summary?` | 一轮结束 | `ok` → `done` → 2 s 后回 `idle`；`error` → `error`；`aborted` → `aborted`（**手动停止**，v1.4） |
| `step.start` | `turnId*`, `stepId*`, `index*` | 模型单步（一个工具批次）开始 | → `working`；进度环计数 |
| `step.end` | `turnId*`, `stepId*`, `index*`, `status*`: `ok\|error\|aborted`, `durationMs?` | 单步结束 | `status=error` → `error`；`aborted` → `aborted`（**手动停止**，v1.4）；否则停留当前状态 |
| `message.assistant` | `turnId*`, `text*`（**已截断/脱敏** ≤280 字符）, `truncated*`: bool | 助手输出 | 气泡显示（节流 ≥1.5 s/次），打字机效果；**不改变状态** |
| `tool.call` | `callId*`, `toolName*`, `category*`: `read\|write\|exec\|net\|other`, `risk*`: 0..3, `summary?` | 工具开始执行 | → `working`；按 `category` 播动作（exec=敲键盘 / read=翻书 / write=写字 / net=天线） |
| `tool.result` | `callId*`, `status*`: `ok\|error\|denied\|aborted`, `durationMs?`, `summary?` | 工具结束 | `ok` → 星星特效；`error` → 乌云 2 s + `error` 状态；`denied` → 摊手（**不改变状态**）；`aborted`（v1.4）→ `aborted`（**手动停止**：工具被用户取消——适配器据错误签名判定，如 ZCode 的 `"… was cancelled"`） |

### 3.3 审批与提问（强提醒）

| type | data 载荷 | 触发语义 | 桌宠行为 |
|---|---|---|---|
| `approval.request` | `requestId*`, `kind*`: `command\|file-write\|network\|permission\|other`, `summary*`, `risk*`: 0..3, `callId?`, `expiresAt?` | 后端等待用户批准 | **强提醒**：置顶/居中 + 抖动 + 提示音（可关）；→ `waiting` |
| `approval.resolved` | `requestId*`, `decision*`: `allow\|deny\|timeout`, `latencyMs?`, `nativeOutcome?`（后端原生结论，见下） | 审批有结果 | 松口气动画；`timeout` → **瞬态 `transient-error` 1.5 s** 后回登记前状态（§4.7）；`allow`/`deny` → 回登记前状态 |
| `user.question` | `questionId*`, `text*`（截断）, `options?`: string[] | 后端向用户提问或由工具向用户提问 | 与审批同级的强提醒；→ `waiting` |
| `user.answer` | `questionId*`, `choice*`, `custom?` | 提问得到回答 | 点头；→ 回到提问前状态（缺省 `working`） |

> **配对规则**：`approval.resolved` 必须用 `requestId` 与其 `approval.request` 配对；找不到未决请求时**忽略并计 `orphanApprovals`**（不得猜 FIFO）。`user.answer` 同理（`orphanAnswers`）。
> **有损折叠（v1.2 澄清）**：后端原生结论多于契约三值时按此折叠——`rejected`/`cancelled`/`denied` → `deny`；`unavailable`/`expired` → `timeout`；其余 `allow`。折叠有信息损失（`rejected` 与 `cancelled` 不可区分、`unavailable` 被记为超时略偏乐观），因此适配器**可**在 `nativeOutcome` 里透传原值供 UI 显示与诊断（可选字段，不参与状态机）。
> **边界**：需要「允许/拒绝」决定的用 `approval.*`；只是让用户提供信息（自由文本或选项）用 `user.question/answer`。两者可同时未决，聚合状态都为 `waiting`（§4.3）。

### 3.4 健康与元信息

| type | data 载荷 | 说明 |
|---|---|---|
| `agent.status` | `state*`: `idle\|thinking\|working\|waiting\|error`, `detail?`, `force?`: bool（缺省 false） | 后端**主动**给出的粗粒度状态。**覆盖规则**：仅在 (a) 10 s 内有效、(b) 其优先级 **≥** 当前聚合优先级，或 `force=true` 时生效；被拒绝时计 `overrideRejected`。**不支持** `done`/`blocked`（`done` 是本地过渡态，见 §4.1）；**不改变会话元信息**（模型/思考程度用 `session.meta`） |
| `session.meta`（v1.3 新增） | `agentName?`, `agentVersion?`, `provider?`, `model?`, `reasoningEffort?`, `agentPreset?`, `title?`, `nativeSessionId*` | 会话的**元信息**：Agent 软件名、模型、思考程度、预设、标题。同一字段可重复上报（后者覆盖前者）。**不改变状态机状态**（no-op 语义），只更新工作框头部展示与目录条目 |
| `session.activity`（v1.3 新增） | `nativeSessionId*`, `text*`（≤80 字符摘要）, `kind*`: `thinking\|tool\|reply\|waiting\|error\|done` | **粗粒度活动摘要**（示例：「运行命令」「读取文件」「思考中」）。契约明确：**不得包含步骤序号、工具参数、命令原文、文件内容**；工作框的会话行只显示该摘要，不显示步骤明细 |
| `session.end` | `nativeSessionId*`, `endedAt*`（Unix ms）, `reason*`: `done\|aborted\|error\|unknown`, `durationMs?`, `summary?` | 会话结束 | 工作框结束计时并归档该卡片；`reason=error` → **持久 `error`**（§4.7，非 3 s 瞬态）；`done` → `done` 2 s 后 `idle`；`aborted` → `aborted`（**手动停止**，v1.4）；`unknown` → `idle` |
| `error.raised` | `scope*`: `session\|tool\|llm\|adapter`, `message*`（截断）, `code?`, `fatal*`: bool | `fatal=true` → 桌宠显示「离线」角标并置该 source 为 `error`；`fatal=false` → 记录但不改变状态 |

> **不做**（v1 明确排除）：token 逐字流、完整对话正文、文件内容、shell 全量 stdout、账号/密钥类信息。

---

## 4. 状态机（唯一权威：**Hub**）

> 渲染层**没有**业务状态：它只渲染 Hub 广播的快照（`pet.snapshot`，§5.3）。这与 `docs/10-architecture.md` ADR-2 一致。

### 4.1 状态集合
六个展示状态：`idle`、`thinking`、`working`、`waiting`、`error`、`done`；另有一个**中性终态** `aborted`（v1.4：用户手动停止，优先级与 `done` 同级、不计错误、非进行中）。
- `done` 是**本地过渡态**（由 `turn.end(ok)` 触发，2 s 后自动回 `idle`），后端不能用 `agent.status` 直接设置它。
- `aborted` 由 `turn.end` / `step.end` / `tool.result` 的 `aborted` 分支与 `session.end(reason=aborted)` 置位，直到该会话出现下一轮事件；渲染为「手动停止」。
- 后端能上报的状态集合是 §3.4 的 5 个（不含 `done`）。

### 4.2 完整真值表（type × 分支 → 状态）

| 事件 | 分支 | 状态变化 |
|---|---|---|
| `session.start` | — | 该**会话** → `thinking`；聚合状态取各会话最高优先级（§4.3） |
| `session.end` | `done` | 该**会话** → `done`（2 s → `idle`）；聚合按 §4.3 重算 |
| `session.end` | `aborted` | 该**会话** → `aborted`（**手动停止**，v1.4；**不得**因此打断其他会话的 `waiting`，聚合按 §4.3 重算） |
| `session.end` | `unknown` | 该**会话** → `idle`（立即；聚合按 §4.3 重算） |
| `session.end` | `error` | 该**会话** → `error`（3 s → `idle`） |
| `pet.heartbeat` | 任意 | **no-op**（不改变状态） |
| `turn.start` | — | → `thinking` |
| `turn.end` | `ok` | → `done`（2 s → `idle`） |
| `turn.end` | `error` | → **持久 `error`**（该会话；直到下一轮成功事件或 45 s 离线清理） |
| `turn.end` | `aborted` | 该**会话** → `aborted`（**手动停止**，v1.4；**例外条款**：会话级状态变更不走优先级比较，聚合状态按 §4.3 重算。「用户按 ESC 中断」不会把其他会话的 `waiting` 顶掉，也不显示为错误） |
| `step.start` | — | → `working` |
| `step.end` | `ok` | no-op |
| `step.end` | `error` | → `transient-error`（**TTL 2 s**，随后自动回该会话上一个稳定状态；见 §4.7） |
| `step.end` | `aborted` | 该会话 → `aborted`（**手动停止**，v1.4；同 `turn.end(aborted)` 的例外条款） |
| `message.assistant` | — | **no-op** |
| `tool.call` | — | → `working` |
| `tool.result` | `ok` | no-op |
| `tool.result` | `error` | → `transient-error`（TTL 2 s → 上一个稳定状态；`risk=3` 或连续 3 次失败时升级为**持久 `error`**，直到出现成功事件） |
| `tool.result` | `denied` | no-op（摊手特效） |
| `tool.result` | `aborted`（v1.4） | → `aborted`（**手动停止**：工具被用户取消——如 ZCode 中断时在飞工具落盘 `"… was cancelled"` 错误签名；**不计错误、不触发瞬态/持久 error**） |
| `approval.request` | — | → `waiting`（登记未决） |
| `approval.resolved` | `allow`/`deny` | → 回到登记前状态（缺省 `working`） |
| `approval.resolved` | `timeout` | → `error`（1.5 s → 登记前状态） |
| `user.question` | — | → `waiting`（登记未决） |
| `user.answer` | — | → 回到登记前状态（缺省 `working`） |
| `agent.status` | 通过 §3.4 覆盖规则 | → 该 `state`；被拒 = no-op |
| `error.raised` | `fatal=true` | → `error`（持续，直到该 source 有成功事件或离线清理） |
| `error.raised` | `fatal=false` | **no-op** |

### 4.3 优先级与并发
- 优先级（高→低）：`waiting > error > working > thinking > done > idle`。
- 高优先级可立即打断低优先级；低优先级不得打断高优先级，只能在其退出后生效。
- **多会话聚合**：对每个会话独立维护状态与超时，聚合状态 = 所有会话中**优先级最高**者；UI 用「一个桌宠 + N 个徽标」表达。`waiting` 一旦出现即整体进入 `waiting`（只要有未决审批/提问）。
- **未决登记表**：`requestId`/`questionId` → { 登记前状态, 起始时间 }；每个未决项独立计入 `waiting`。

### 4.4 离线判定（45 s，针对 source）
- 规则：某 `source` **45 s 内未收到任何帧**（事件或控制帧）→ 标记该 source `offline`：清空其全部会话聚合与未决登记，聚合状态回落到剩余 source 的最高优先级（无则为 `idle`），UI 显示「离线」角标。
- 该判定与 §4.5 的超时**是两条独立规则**，不存在「45 s 内必须回 idle」与「10 min 才回 idle」的矛盾：45 s 判定的是**连接**，10 min 清理的是**会话**。

### 4.5 会话陈旧清理（10 min，忽略心跳）
- 计时基准是 **`lastStateChangeTs`**（最后一次真正改变状态的事件时刻），`pet.heartbeat` **不刷新**它。
- 某会话 10 min 内无状态变化 → 清理该会话的未决登记、置回 `idle` 并计 `stale`（防止后端静默死亡导致永久「忙碌」）。

### 4.6 乱序与迟到
- 窗口内逆序（§2.4）→ 排序后应用，收敛性与顺序投递一致。
- 窗口外迟到事件被接受后：不得使聚合状态**倒退**（例如 `approval.resolved` 迟到于其 `approval.request` 之后到达时，若原 request 已被清理则按 `orphanApprovals` 忽略；若未决项仍在，则正常配对并把状态回退到登记前状态——这是允许的，因为它是配对逻辑而非状态倒退）。

---

### 4.7 `transient-error` 的具体规则（v1.2 新增）
- `step.end(error)`、`tool.result(error)`、`approval.resolved(timeout)` 属于**瞬态错误**：置 `transient-error` 并启动 TTL（`step/tool` = 2 s，`approval timeout` = 1.5 s），到期自动回**该会话上一个稳定状态**（`thinking`/`working`/`idle`）。
- `turn.end(error)`、`session.end(error)`、`error.raised(fatal=true)` 属于**持久错误**：保持 `error`，直到该会话出现新的成功事件（`turn.start`/`step.start`/`tool.result(ok)`）或被清理。
- 计数：TTL 到期恢复计 `recoveredErrors`；升级为持久错误计 `escalatedErrors`。工作框（§8）必须能区分这两种错误（瞬态=黄色一闪，持久=红色常驻）。
- 定义「失败连击」：同一会话连续 3 次瞬态错误（间隔 <60 s）→ 升级为持久错误。

## 5. 传输层（Transport）

### 5.1 通道

| 通道 | 方向 | 用途 | 备注 |
|---|---|---|---|
| Unix domain socket `$TMPDIR/agent-pet/<source>.sock` | 双向（Phase 1 实际只走 →Hub） | 主通道 | 行分隔 JSONL；**单实例**：同目录写 `<source>.lock`（pid + 心跳时间戳），已有存活锁则拒绝启动（不 unlink 他人 socket）；Windows 命名管道 `\\.\pipe\agent-pet-<source>`（本地命名管道命名空间；Windows 实测待补） |
| WebSocket `ws://127.0.0.1:<port>/pet` | 双向 | 备用（跨进程/WSL/调试） | 默认关闭；仅监听 127.0.0.1 |
| JSONL 文件 `~/.agent-pet/records/<source>-<date>.pet.jsonl` | Hub → 磁盘 | 录制、回放、取证 | 轮转 20 MB × 7 天；`--replay` 可回放 |

### 5.2 握手与续传
1. 适配器连接后立即发 `{"ctl":"hello","contract":1,"source":"dsh","adapterVersion":"…","resumeAfter":<lastSeq|null>}`。
2. Hub 在 **3 s 内**回 `{"ctl":"ack",…}`；`ok=false` 时适配器必须停止发送事件、打印可读错误并退出（非 0）。
3. 适配器等 ack 的超时 3 s、重试 2 次（指数退避），仍失败则记日志退出，由守护进程按 §5.5 重启。
4. `resumeAfter` 非空时，Hub 只接受 `seq > resumeAfter` 的事件，其余计 `duplicates`。
5. 控制帧一律带 `ctl` 且无 `type`，消费方必须先判 `ctl` 再判 `type`。

### 5.2.1 观测能力等级（`observes`，v1.2 新增）
- 适配器在 `hello` 中声明它**实际能产生**的事件族（glob 形式）；Hub 据此在工作框上**隐藏**该后端不支持的指标（例如 DSH 无 `step.*` 时就不显示步骤进度），而不是显示空白或 0。
- 缺省（不声明）= 全部 16 种 type 都可能出现（契约 §3 的 16 个 type 字符串）。
- 该声明**不改变**契约必填字段；纯粹是 UI 降级依据。

### 5.3 Hub → 订阅者快照
Hub 向桌宠（及其他订阅者）广播 `pet.snapshot`（同样是 JSONL 行）：

```jsonc
{ "ctl": "snapshot", "ts": 1791172501000, "agg": "waiting",
  "sessions": [ { "source": "dsh", "sessionId": "session-…", "state": "waiting", "since": 1791172500000,
                  // v1.2 工作框必需字段（Hub 补齐，全部可选但工作框默认渲染）：
                  "title": "修复登录超时", "workspace": "/Users/x/proj", "lastTool": "npm test",
                  "elapsedMs": 21000, "pending": 1 } ],
  "degradedSources": [],   // v1.2：守守护重启失败/降级中的 source（与 offlineSources 区分：offline=完全无事件，degraded=能收事件但有缺口）
  "bubble": { "kind": "approval", "text": "要执行 npm test，允许吗？", "requestId": "req-7" },
  "effect": "alert", "unknownEvents": 0, "offlineSources": [],
  // v1.2：工作框所需的最小投影（Hub 保证字段存在）
  "now": { "turnId": "t-9", "stepIndex": 3, "startedAt": 1791172490000, "elapsedMs": 21000, "lastTool": "npm test" },
  "counters": { "unknownEvents": 0, "lateEvents": 0, "duplicates": 0, "orphanApprovals": 0,
                "overrideRejected": 0, "recoveredErrors": 0, "escalatedErrors": 0, "stale": 0 },
  "clearedPending": [ { "kind": "approval", "requestId": "req-3", "clearedAt": 1791172000000, "reason": "stale" } ] }
```

### 5.4 反向通道与能力协商（Phase 2）
- Phase 1：**只读**。适配器在 ack 中声明 `canDecide:false`；桌宠 UI 的审批卡片只显示「后端正在等待你的决定」并高亮到后端窗口/终端，**不提供**允许/拒绝按钮。
- Phase 2：适配器声明 `canDecide:true` 后，Hub 才转发 `{"ctl":"decide","requestId":…,"decision":"allow|deny"}`；每次写回必须二次确认（用户可见），并记录审计日志。

### 5.5 崩溃与守护
适配器崩溃 → Hub 指数退避重启（1s→2s→4s…≤60s），连续 5 次失败标记 `degraded` 并在 UI 显示；Hub 崩溃 → 由桌宠外壳拉起并恢复快照（`~/.agent-pet/state`）。

---

## 6. 映射表（后端 → 规范事件）

> 逐条映射、字段抽取与缺口见 [40-adapters.md](./40-adapters.md)；DSH 的实测路线见 [35-dsh-pet-bridge.md](./35-dsh-pet-bridge.md)。

| 规范事件 | DSH（Phase 1） | Claude Code | Codex | 通用 ACP |
|---|---|---|---|---|
| `session.start` | 会话日志首行 `session` / 目录创建 | `SessionStart` hook | `SessionStart` hook | `session/new` |
| `turn.start/end` | `turn/start`、`turn/end` | `UserPromptSubmit` / `Stop` | 同左 | prompt 请求/响应边界 |
| `step.start/end` | `step/start`、`step/end` | ✗ | ✗ | ✗（可推断） |
| `message.assistant` | `assistant/message` | ✗（transcript 兜底） | ✗ | 通知流 |
| `tool.call/result` | `tool/call`、`tool/result` | `PreToolUse`/`PostToolUse` | 同左 | `tool_call` 通知 |
| `approval.request/resolved` | `approval/asked`、`approval/decided` | `PermissionRequest`（DSH 桥未支持） | ✗ | permission 请求 |
| `user.question/answer` | 用户提问工具事件（项目内映射） | ✗ | ✗ | `elicitation/create`（**只有它映射到本行**；`session/request_permission` 属于上一行的 `approval.*`，不得重复映射） |
| `agent.status` | `goal/change`、`agent/inbox/spliced` 等派生 | 派生 | 派生 | 派生 |
| `error.raised` | `llm/retry`、`tool/result(status=error)` | `PostToolUseFailure`（未桥接） | ✗ | 错误响应 |

---

## 7. 验收标准（契约层，可执行）

1. **fixture 回放**：给定 `fixtures/*.pet.jsonl`，离线模式必须复现全部 6 个状态与 5 类特效；fixture 需覆盖 **§3 的 16 行 / 16 个 type 字符串**（3.1~3.4 全部条目）。
2. **离线兜底**：`kill -9` 任一后端 → 45 s 内该 source 标记离线、聚合状态回落（§4.4）；UI 无崩溃、无残留「忙碌」。
3. **未知类型**：注入未知 `type` 1000 条 → `unknownEvents` +1000，无异常、无内存增长（RSS 漂移 <5%）。
   **`unknownEvents` 语义（v1.2 澄清）**：只有**不在 §3 的 16 个 type 字符串之内**的类型计入；已知 type 但不改变状态（`pet.heartbeat`、`message.assistant`、`tool.result(ok|denied)`、`step.end(ok)`）**不计入**，它们走 no-op 路径并计 `noop`。
4. **乱序收敛**：窗口内乱序投递 → 最终状态与顺序投递一致；跨窗口迟到 → 计 `lateEvents`，最终状态合法（不倒退）。
5. **契约一致性**：适配器单测断言输出覆盖 §2.1 必填字段与 §3 各 type 的必填 data 字段（含 `requestId`/`questionId` 配对），并覆盖 §4.2 真值表的每个分支。
6. **心跳语义**：只有 `pet.heartbeat` 的 10 min 静默会话必须被 `stale` 清理（§4.5），同时不得因心跳而误判「活跃」。

---

## 8. 工作框（Work Frame）与契约的关系

### 8.0 多项目 / 多会话（v1.3）
- **目录视图**：Hub（或本地服务）通过 `ctl:catalog` 提供「项目 → 会话」两级结构；每个会话条目至少含 `sessionId / title / agentName / model / reasoningEffort / state / updatedAt / live`。
- **元信息展示**：会话行必须能显示 **Agent 软件名 + 模型 + 思考程度**（如 `DSH · deepseek-flash · thinking:max`），来源为 `session.meta` 或目录条目（目录优先，实时事件覆盖）。
- **打开已存在会话**：`ctl:session.open` 仅在适配器声明 `canOpen:true` 时可用；否则 UI 必须把该动作置灰并给出原因（能力协商，不得静默失败）。
- **新建会话**：`ctl:session.new`（含 `cwd`、可选 `agentName/model/reasoningEffort/agentPreset`）仅在 `canCreate:true` 时可用；新建成功后必须回一个 `session.start` + `session.meta`，UI 才能把它加进会话列表。
- **同一窗口多项目**：窗口必须支持任意数量项目/会话；分组规则：按项目折叠、项目内按 `updatedAt` 倒序；`live=true` 的会话排在最前并显示实时状态。
- **安全边界**：目录只读（`.dsh/sessions/**` 不做任何写入）；**不得持有或使用 DSH 的浏览器会话密钥**（`~/.dsh/.credentials.yaml`）来绕过权限；打开/新建一律通过适配器（Cordis 插件）在 DSH 自身进程内完成。


> 用户方向（2026-10-05）：**桌宠的主界面是「工作框」——一个常驻的窄条小窗，主职责是显示 agent 状态与进度；宠物形象是框内的可选元素。** 契约为此提供以下保证：

1. **可渲染性**：Hub 的 `pet.snapshot`（§5.3）是工作框的**唯一数据源**，包含：聚合状态、每会话 `state/since/title/workspace/lastTool/elapsedMs/pending`、当前轮次/步骤、`elapsedMs`、最近工具、未决审批、计数器、`offlineSources` 与 `degradedSources`。
   **会话行渲染规则（用户已确认）**：卡片首行 40 px + **每个会话一行 28 px**；`MAX_SESSION_ROWS = 5`（**只数会话行，不含首行**），第 6 个会话起折叠为 `+N` 脚注（高 22 px）；窗口高度 = 40 + 28×min(N,5) + (N>5 ? 22 : 0)。
2. **无状态推断**：工作框**不做**任何时间推断（例如「已经卡了多久」），一切时长由 Hub 提供 `elapsedMs`/`since`，避免多客户端显示不一致。
3. **降级可见**：`offlineSources`/`degradedSources` 非空时，工作框必须显式标注「离线/粗略模式」，不得假装一切正常。
4. **最小可读语义**：**首行 40 px（可配 36–48 px）必须表达：状态灯 + 状态文本 + 当前动作 + 计时 + 未决审批计数**；每个会话行 28 px 表达「会话标识 + 该会话状态 + 该会话计时/最近动作」。窄条形态 = 只有首行（320×40）；更高形态按 §8.1 公式展开（见产品文档 docs/51）。

## 9. 版本与变更流程
- 本文件任何改动 = 一个 PR：含「兼容性影响 + 受影响适配器/fixture 清单 + 回归结果」，Lead 批准后方可合并。
- 主版本 `v` 只在破坏性变更时 +1；文档修订（如 v0.1→v1.1）不改变事件里的 `v`。
- 变更历史见 `docs/CHANGELOG.md`。
