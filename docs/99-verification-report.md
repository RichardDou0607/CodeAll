# 99 · 独立验收报告（T6 / contract-verifier）

> 状态：**进行中（增量更新）** —— 本轮已完成「契约自身审阅」+「独立校验器/状态机消费者」两节。
> 依据：`docs/00-interface-contract.md`（FROZEN）、`docs/10-architecture.md`（DRAFT v0.9）。
> 冻结对象：契约 **v1**（文档 rev v0.1，2026-10-05）。
> 作者：contract-verifier（队友 E，独立验收）。**本报告只报告问题，不代改任何他人文件。**

## 0. 复现环境

| 项 | 实测值 | 命令 |
|---|---|---|
| 操作系统 | Darwin arm64 / macOS 27.0.1 | `uname -sm; sw_vers -productVersion` |
| Node | v24.18.0 | `node -v` |
| jq | `/usr/bin/jq`，jq-1.7.1-apple | `command -v jq && jq --version` |
| 工作目录 | `/Users/demo/Desktop/agent桌宠` | `pwd` |

---

## 1. 结论摘要（TL;DR）

> **【v1.2 复验结论（第二轮，最新）】** 契约 v1.2 已采纳 v1.1 报告的全部 4 个 P0：C-04（§4.4/§4.5 拆分）、C-05（`requestId` 强制配对）、C-06（§1.6/§5.4 Phase 1 只读）、C-26（§2.2 控制帧）均已闭环，跨文档 P0（X-01/X-02、Z-01）亦已闭环。**结论：可以进入 Phase 1 开发**，需在 M1 内修完 7 项未闭环（C-16/C-30、C-19、C-25、X-03、Y-01、W-04、V-01，均为 P2/P1 文档级）与新增的 C-28（计数口径）。逐项闭环状态见 **§9.4**；v1.2 真值表逐分支复验见 **§9.1**；fixture 与 schema 的版本漂移见 **§9.2/§9.3**。

> 以下 §1.1–§1.5 为 **v1.1 基准**的历史摘要，保留以便追溯。

1. **契约目前不建议作为 Phase 1 开发冻结基线**：契约自身 **4 个 P0**（C-04/C-05/C-06/C-26）+ **16 个 P1** + 7 个 P2（共 27 条）；跨文档另有 **2 个 P0**（X-01 状态机归属、X-02 45 s 错引）与 **1 个 P0 级口径冲突**（Z-01，与 C-04 同源，已蔓延到 docs/50、docs/60、docs/70 与 §7.2 共 4 种说法）。
2. 最硬的 6 个问题（4 个契约 P0 + 2 个跨文档 P0）：
   - **C-04**：§7.2「kill -9 → 45 s 内回 idle」与 §4「非 idle 状态 10 min 无事件才回 idle」直接矛盾（实测：630 s 空档中桌宠会一直保持 thinking 到第 600 s）。
   - **C-05**：`approval.request/resolved` 的 `callId` 是**可选**字段，没有必填的关联 ID → 多个未决审批时无法配对（实测乱序场景中 `uncorrelatedApprovals=1` 且最终状态与顺序投递**不一致**）。
   - **C-06**：§5 传输层**没有「桌宠 → 适配器」的控制通道**（只有一行 ack），审批结果无法回到后端 → §3.3 的 `approval.resolved`/`user.answer` 只能是后端自产，桌宠在 Phase 1 只能是旁观者，这一点必须写清楚。
   - **X-01**：契约 §4 标题「状态机（**渲染层**唯一权威）」与 `docs/10-architecture.md` ADR-2「**Hub 独占**状态机，渲染层无业务状态」直接冲突。
   - **Z-01**：`docs/50` §1.3 说「45 s 只打离线角标、10 min 才回 idle」，而它自己的 §11 A2/E2 与 `docs/70` Gate 1 又要求「45 s 内回 idle」——一个 Gate 指标在同一批交付物里有 4 种口径。
   - **C-26**：契约没有「控制帧」概念，但黄金 fixture 已使用 `ctl: hello/ack/snapshot` 三条 —— 同一份 fixture，我的校验器判 3 行非法（exit 1），T7 的校验器判 0 非法（3 条 controlFrames）。验收自动化目前**无据可依**。
3. 契约表格与正文的计数不符：§3 标题写「14 种」，展开后是 **16** 个 type 字符串（14 行）——T3 与 T7 都按 16 实现，docs/40 §8.1 也独立建议改为「16 个 type 字符串（14 个语义行）」；只有 docs/50 §8-C1 建议反向合并成 14（需 Lead 裁决）。
4. 独立校验器/消费者 `scripts/replay-check.mjs` 已跑通并用于全部现存交付物：自造 26 行样例 26/26 通过（覆盖 §3 全部 16 个 type）、6 条负例 6/6 被拒；T3 fixture 40 行经 jq 与自研脚本双重校验（事件帧 37/37 合法、16/16 已知 type、3 条未知、乱序批次回放收敛）；T7 校验器与我结论一致（34 已知 + 3 未知 + 3 控制帧）。
5. **仍未完成的部分（依赖未就绪，见 §7）**：`docs/20`、`docs/30` 两份文档的交叉审阅（截至本次更新仍是 111/112 B 占位符）；§5 真实 socket 握手、§7.2 真机 `kill -9`、§7.3 千条未知事件内存增长等需要真实实现的验收项。

---

## 2. 契约审阅：`docs/00-interface-contract.md` 自身的缺陷

严重度定义：**P0** = 自相矛盾 / 无法验收 / 会导致互不兼容的两套实现；**P1** = 会导致返工或实现分歧；**P2** = 表述与细节。

| ID | 级别 | 位置 | 一句话问题 |
|---|---|---|---|
| C-01 | P1 | §3 标题（L47）+ §7.1（L139） | 「14 种 type」与实际 16 个 type 字符串不符 |
| C-02 | P1 | §3.2–§3.4（L57–L82） | 只有 §3.1（L51 表头）标了必填 `*`，其余 13 个 type 的必填集无法推导 |
| C-03 | P1 | §3.4（L80）vs §4（L90–L100） | `agent.status.state` 含 `blocked`，但状态机六态含 `done`——两套枚举不一致 |
| C-04 | **P0** | §2（L43）/§7.2（L140）vs §4（L102） | 45 s 离线判定与 10 min 超时兜底矛盾 |
| C-05 | **P0** | §3.3（L72–L74） | 审批请求没有必填关联 ID，`resolved` 无法配对；`kind` 无取值域 |
| C-06 | **P0** | §5（L109–L115） | 缺少「桌宠 → 适配器」反向通道，审批决定/回答无法回传 |
| C-07 | P1 | §5（L115） | 握手 ack 语义不完整（时机、失败形态、超时重试、断线续传、如何与事件区分） |
| C-08 | P1 | §2（L42） | 乱序缓冲「2s / 32 条」无冲刷策略与窗口外迟到事件处理规则 |
| C-09 | P1 | §2（L26 注释） | `seq` 作用域含糊（per-source 还是 per-session）、去重键未定义 |
| C-10 | P1 | §3.1（L55）vs §5（L115） | `pet.heartbeat.nativeSessionId` 标必填，但握手时可能还没有会话 |
| C-11 | P1 | §2（L43）vs §4（L102） | 心跳是否算「新事件」未定义，直接影响 §4 防呆是否失效 |
| C-12 | P1 | §3.4（L80）vs §4（L100） | `agent.status` 的 10 s 覆盖可压掉更高优先级的 `waiting` |
| C-13 | P1 | §4（L89–L98）vs §3 各表 | 事件→状态真值表不完整（一半事件没有定义迁移） |
| C-14 | P1 | §3.1（L54）/§3.3（L73）/§4（L97） | error 停留时长 3 s / 1.5 s / 2 s 三套，`resolved(allow)` 回到哪个状态图里没画 |
| C-15 | P1 | §2（L40）vs §7.5（L143） | 「必填」与「字段必须存在」两套口径；§7.5 断言集不含 `sessionId/workspace` |
| C-16 | P2 | §2（L41） | 8 KB 是字节还是字符未定义；截断责任（发送方/接收方）未定义 |
| C-17 | P2 | §5（L113） | 录制文件 `<date>` 格式、「20 MB × 7 天」口径、回放时间基准未定义 |
| C-18 | P2 | §5（L111） | Windows 命名管道写法 `\\?\pipe`、socket 目录权限/陈旧文件清理/双实例冲突未定义 |
| C-19 | P2 | §6（L130–L131） | ACP 的同一个 `session/request_permission` 被映射到两个不同语义的规范事件 |
| C-20 | P2 | §7.1（L139）/§7.3（L141） | 「5 类特效」未枚举；`unknownEvents` 无对外暴露方式 → 两条验收都无法判定 |
| C-21 | P2 | 文档头（L1）vs §2（L25）/§5（L115） | 文档 v0.1 与线上 `v:1`、ack `contract:1` 无对应关系 |
| C-22 | P1 | §4（L103） | 多会话聚合只定义了 `waiting`；其余状态谁赢、低优先级如何「排队退出」未定义 |
| C-23 | P1 | §3.3（L72–L74） | `approval.request` 与 `user.question` 的语义边界（何时用哪个、同时未决怎么办）未定义 |
| C-24 | P1 | §3.2/§3.3（L57–L74）vs §2（L40） | 多数事件的 data 不含会话标识，而 envelope 的 `sessionId` 允许为 null → 归属丢失 |
| C-25 | P2 | §3.3（L73） | `approval.resolved.decision` 三值对 DSH 原生四值有损（deny 混淆「用户拒绝」与「渠道取消」） |
| C-26 | **P0** | §2（L21–L43）/§5（L115） | 契约未定义**控制帧**（`hello`/`ack`/`snapshot`），但项目的黄金 fixture 已使用 3 条 → 两个独立校验器对同一文件给出不同判定 |
| C-27 | P1 | §3.1（L53–L55）vs 黄金 fixture | §3.1 把 `session.start.data.source` 标为必填（与 envelope.`source` 重复），fixture 未提供；`pet.heartbeat.data.nativeSessionId` 在 fixture 中为 `null` 却标必填 |
| C-28 | P1 | §3 标题（L66）、§5.2.1（L196）、§7.1（L247）、§7.3（L250） | v1.2 表格已拆成 **16 行**，但正文仍写「14 种 type / 16 行」——数字与表格不符（实测 16 行 / 16 个 type 字符串） |
| C-29 | P2 | §4.2（L143、L146） | 「回到登记前状态」未定义「未决期间该会话又发生别的状态变更」的情形；且登记前状态可能是 `transient-error`（瞬态态），回退到瞬态态语义不成立 |
| C-30 | P2 | §2.3（L56） | 8 KB 上限仍未说明 UTF-8 字节还是字符数、截断责任方（C-16 未闭环） |

### 逐条详情与建议修法

**C-01 [P1] 「14 种」计数错误（§3 标题 L47）**
- 证据（可复现，真实输出）：
```
$ sed -n '/^## 3\./,/^## 4\./p' docs/00-interface-contract.md | grep -c '^| `'
14
$ sed -n '/^## 3\./,/^## 4\./p' docs/00-interface-contract.md | grep '^| `' | sed 's/^| //; s/ |.*//' | tr -d '`*' | tr '/' '\n' | sed 's/^ *//; s/ *$//' | grep -v '^$' | sort -u | wc -l
16
```
  16 个 type：`session.start, session.end, pet.heartbeat, turn.start, turn.end, step.start, step.end, message.assistant, tool.call, tool.result, approval.request, approval.resolved, user.question, user.answer, agent.status, error.raised`（`step.start/end`、`user.question/answer` 各占一行但含两个 type）。
- 影响：T3 的 `fixtures/contract-sample.pet.jsonl` 要求「覆盖全部 14 种 type」、T7 的 JSON Schema 要求「含 14 种 type 的 data 分支」、§7.5 的一致性测试，三处验收口径全部悬空。
- 建议：§3 标题改为「16 个 type（14 行）」；§7.1/§7.5 明确按 16 个 type 字符串计数。

**C-02 [P1] 必填标注只覆盖 §3.1（L51）**
- 证据：§3.1 表头是「data 载荷（**必填 \***）」，而 §3.2/§3.3/§3.4 的表头是「data 载荷」「data 载荷」「说明」，无 `*`、也无 `?` 约定。
- 影响：`tool.call.toolName/callId`、`approval.request.summary`、`user.question.questionId` 是不是必填无法判定 → JSON Schema 的 `required` 只能猜。
- 建议：全表统一「必填标 `*`、可选标 `?`」，或在 §2 加一句「未标 `?` 即必填」并回填各表。

**C-03 [P1] `blocked` 与 `done` 两套状态枚举（L80 vs L100）**
- 证据：§3.4 `agent.status.state` = `idle|thinking|working|waiting|blocked|error`；§4 优先级 = `waiting > error > working > thinking > done > idle`。
- 实测（我的消费者）：遇到 `agent.status(state="blocked")` 时只能丢弃并计数（`invalidAgentStatus=1`），因为 §4 没有 `blocked` 状态；反向地，后端无法用 `agent.status` 报告 `done`。
- 建议：统一枚举；若保留 `blocked`，在 §4 补 `blocked`（优先级建议与 `waiting` 同级或更高）并说明与 `done` 的关系。

**C-04 [P0] 45 s 离线 vs 10 min 兜底（L43/L140 vs L102）**
- 证据：§2「渲染层 45 s 收不到任何事件即判定后端离线」；§7.2「撤销任一后端进程（`kill -9`）→ 45 s 内桌宠回 `idle`」；§4「任何非 idle 状态在 10 min 内没有新事件 → 强制回 `idle`」。
- 实测（自造样例，最后一个非 idle 状态起于 seq=18，随后 630 s 无事件）：
```
--- §7.2 冲突检测（45s 离线判定 vs §4 的 10 min 兜底）---
  ⚠️ [thinking] 起于 seq=18：非 idle 持续 600s > §7.2 的 45s（§4 却允许到 600s）
```
- 影响：§7.2 是契约级验收标准，按现文本实现必然失败。
- 建议：拆成两条规则——「45 s 无任何事件 → 置 `offline`/`idle`（§2 离线判定，同时清空该 source 的会话聚合）」「10 min 无事件 → 清理会话聚合与未决审批并记 `stale`」。`docs/10-architecture.md` §5.1-4 已按 45 s 写（并错引 §3.4），需同步改引 §2。

**C-05 [P0] 审批缺少必填关联 ID（L72–L74）**
- 证据：`approval.request` 的 `callId?` 与 `approval.resolved` 的 `callId?` 都是可选；`user.question` 有必填 `questionId`，但审批侧没有对应的 `requestId`。
- 实测（乱序对照 D：`resolved` 先到并被应用，`request` 迟到）：
```
[seq=2] thinking → working   // approval.resolved(allow)[未匹配] → 回到 working
[seq=1] working → waiting    // approval.request → waiting（强提醒）
最终状态（接收顺序）= waiting ; 最终状态（顺序投递基线）= working → §7.4 收敛: 不一致 ❌
计数: {"uncorrelatedApprovals":1, ...}
```
  即：没有关联 ID 时，消费方只能靠 FIFO 猜（我的实现即如此兜底），多审批并发时必然错配。
- 建议：`approval.request` 增加必填 `requestId`，`approval.resolved` 必填 `requestId`；`callId` 降级为可选关联信息；补 `kind` 枚举（如 `command|file-write|network|question|other`）；定义「无匹配 resolved」的处理（忽略 + `orphanApprovals` 计数）。

**C-06 [P0] 缺少桌宠 → 适配器的反向通道（L109–L115）**
- 证据：§5 表格三行方向分别是「适配器 → 桌宠」「适配器 → 桌宠」「桌宠 → 磁盘」；正文只定义了桌宠回一行 ack。
- 影响：如果桌宠 UI 上能点「允许/拒绝」，这个决定**没有任何通道**回到后端；如果不能点，则 §3.3「强提醒」「`user.answer` 答案回来时点头」必须明确为「纯观察，决定由后端产生」。两种理解会导出完全不同的 M1 范围。
- 建议：二选一并写进契约：(a) Phase 1 只读——明确 `approval.resolved`/`user.answer` 仅由适配器产生，桌宠不回传；(b) 增加「桌宠 → 适配器」消息表（`{"cmd":"approval.decide","requestId":...,"decision":"allow"}`）并定义能力协商（适配器在 ack 中声明 `canDecide`）。

**C-07 [P1] 握手 ack 语义不完整（L115）**
- 未定义项：ack 在「收到即回」还是「版本校验后回」；版本不匹配的回包形态（例如 `{"ack":false,"contract":1,"error":"unsupported"}`）；适配器等 ack 的超时与重试；断线重连的续传协商（§2 提到 seq「用于去重/断线补发」，却没有 `resume` 消息）；ack 是唯一无 `type` 的下行消息，而 §2 规定「所有规范事件」都是 JSONL——接收方如何区分 ack 与事件。
- 实测风险：我的校验器会把无 `type` 的 ack 行判为「缺少必填字段 type」。
- 建议：把 ack 定义为带 `{"ctl":"ack","contract":1,"ok":true}` 形态的独立控制帧；补版本不匹配回包、等待超时（如 3 s）、重连续传（`{"ctl":"hello","source":...,"resumeAfter":42}`）。

**C-08 [P1] 乱序缓冲策略（L42）**
- 证据：只写了「窗口 2s / 32 条」，没有说两个阈值哪个先触发、冲刷后如何排序、窗口外迟到事件怎么办。
- 实测（`--selftest` 的 C/D 对照，真实输出见 §3.4）：
  - 窗口内逆序（跨度 1.5 s ≤ 2 s）→ 收敛 ✅（§7.4 在「窗口内」前提下成立）；
  - 跨窗口逆序（跨度 3 s > 2 s，且后到的是更早的事件）→ 最终状态 waiting vs 基线 working，**不收敛** ❌。
- 影响：§7.4 的文本自洽（它写了「打乱窗口内顺序」），但生产环境的窗口外迟到必须显式规定，否则「偶尔抖动」会变成永久错误状态（如上例中 pending 永不释放 → 需等 10 min 兜底）。
- 建议：补「窗口外迟到事件：丢弃并计 `lateEvents`」或「接受但标记 `outOfOrder=true`」；并规定冲刷触发条件为「先满足者」。

**C-09 [P1] `seq` 作用域与去重键（L26）**
- 证据：注释写「该后端会话内单调递增，从 0 开始；用于去重/断线补发」，§2 顺序保证又写「同一 `sessionId` 内按 `seq` 送达」。到底是 per-source 还是 per-(source, sessionId)？去重键是什么？重复 `seq` 怎么处理（丢弃？计数？覆盖？）都没写。
- 实测：我的消费者按 `(sessionId, seq)` 去重（`deduped` 计数），并在应用顺序上检测到非单调时报问题。
- 建议：明确 `seq` 为 per-`(source, sessionId)` 单调、去重键 `(source, sessionId, seq)`、重复事件丢弃并计 `duplicates`。

**C-10 [P1] 无会话时的心跳（L55 vs L115）**
- 证据：§3.1 `pet.heartbeat` 的 `nativeSessionId*` 标必填；§5 又说连接后可以「立即发 `session.start`（**或** `pet.heartbeat`）」。适配器刚起来、后端还没开会话时，没有 `nativeSessionId` 可填。`load` 未标必填、缺省值未定义。
- 建议：`nativeSessionId` 允许 `null`（心跳是「后端级」事件），或改为 `sessionCount`；明确 `load` 缺省 0。

**C-11 [P1] 心跳算不算「新事件」（L43 vs L102）**
- 若算：持续心跳的静默后端永远不会触发 §4 的 10 min 兜底（防呆失效）；若不算：§2 的 45 s「收不到任何事件」与之冲突。
- 建议：区分 `lastAnyEventTs`（用于 45 s 离线判定）与 `lastStateChangeTs`（用于 10 min 兜底，忽略 `pet.heartbeat`）。

**C-12 [P1] `agent.status` 覆盖与优先级冲突（L80 vs L100/L101）**
- 证据：§3.4 说「与桌宠自推状态冲突时以本事件为准（10 s 内有效）」；§4 说优先级 `waiting > error > …`。若后端发 `agent.status(state=idle)` 而本地有未决审批，两条规则给出相反结果。
- 实测：我的消费者按 §3.4 让覆盖生效并记 `overrideConflicts`（自造样例中未出现冲突场景，逻辑已具备）。
- 建议：规定覆盖不得低于当前聚合优先级，或增加 `force: true` 才允许降级。

**C-13 [P1] 事件→状态真值表不完整（L89–L98）**
- 未定义的迁移：`agent.status`、`error.raised`（fatal / 非 fatal）、`message.assistant`、`session.end(reason=aborted|unknown)`、`turn.end(status=aborted)`、`user.answer`、`tool.result(status=denied)`、`step.end`、`tool.result`。
- 实测：我只能为这些分支自定规则并在报告中标注（见脚本内注释与 §3）。
- 建议：补一张「16 个 type × 各分支 → 状态」的完整真值表，明确「不改状态」的事件也要显式写 `no-op`。

**C-14 [P1] error 停留时长与 `allow` 的目标状态（L54/L73/L97）**
- `session.end(error)` 3 s、`approval.resolved(timeout)` 1.5 s、图中 `error ──2s──▶ idle`；`approval.resolved(allow)` 的箭头没有落点（图里只画了回到 `working` 的方向感）。
- 建议：给出一张 error dwell 表；明确 `allow` 后回到「之前的非 waiting 状态（working 或 thinking）」还是固定 `working`。

**C-15 [P1] 「必填」口径（L40 vs L143）**
- §2 先列 6 个必填字段，再说 `sessionId`/`workspace`「可为 null 但字段必须存在」；§7.5 的断言集又只有 6 个字段。
- 建议：分两档写「MUST 出现」与「MUST 非 null」，并把 §7.5 的断言集扩为「6 必填 + 2 必须出现」。

**C-16 [P2] 8 KB 口径（L41）** ——「序列化后」未说明 UTF-8 字节还是字符数（中文 280 字 ≈ 840 B，边界会分歧）；截断是发送方义务还是接收方拒收也没写。建议：明确「UTF-8 字节数 ≤ 8192，发送方保证；接收方超限拒收并计 `oversized`」。

**C-17 [P2] 录制/回放细节（L113）** —— `<date>` 格式（建议采纳 `docs/10` 的 `<YYYYMMDD>`，并注明本地时区）、「20 MB × 7 天」是 7 个文件还是保留 7 天、多 source 回放如何恢复全局时序、回放时 §4 的超时判定按「事件 ts 差」还是「墙钟」——最后一点直接决定 §7.1/§7.2 能否离线复现。

**C-18 [P2] 传输层细节（L111）** —— Windows 命名管道常见写法是 `\\.\pipe\<name>`（`\\?` 前缀用于文件路径）；另需规定 socket 目录权限（建议 0700/0600）、进程崩溃后陈旧 socket 的清理、同 `source` 双实例连接的处置（拒绝并提示？）。

**C-19 [P2] §6 映射表重复映射（L130–L131）** —— `approval.request/resolved` 行把 ACP 映射为「permission 请求」，`user.question` 行又把 ACP 映射为 `session/request_permission`；同一个原生能力对应两个语义不同的规范事件，Phase 2 无法据此实现。建议二选一，并在 §3.3 划清边界（见 C-23）。

**C-20 [P2] 无法判定的验收项（L139/L141）** —— §7.1 的「5 类特效」契约内无枚举（疑似：思考云/星星/乌云/汗滴/打字机）；§7.3 的 `unknownEvents` 计数器没有任何对外暴露方式（无诊断事件、无 CLI）。建议：§3 给出特效清单；新增 `pet.diagnostics`（或 `apps/cli doctor` 输出）暴露计数器。

**C-21 [P2] 版本号三套（L1/L25/L115）** —— 文档 `v0.1`、事件 `v:1`、ack `contract:1`。建议统一表述为「契约 v1（文档 rev 0.1）」，并说明 ack 的 `contract` 与事件 `v` 同源。

**C-22 [P1] 多会话聚合只写了 waiting（L103）**
- 未定义：A `working` + B `done` 谁赢？低优先级「排队到该状态退出」在多会话下何时算退出？
- 实测（我的实现：取各会话期望态中**优先级最高**者并持续重算）：A 处于 `waiting` 时，B 的 `turn.end(ok)`→`done` 不会把整体状态从 `waiting` 拉走；A 的 `approval.resolved(allow)` 后整体才回 `working`——与 §4 的意图一致且可复现。
- 建议：把「聚合 = 取最高优先级会话态」写成契约条文，并说明会话被移除（`session.end`）时立即重算。

**C-23 [P1] `approval.request` 与 `user.question` 的边界（L72–L74）**
- 两者都进 `waiting`、都强提醒，但解决事件不同（`approval.resolved` vs `user.answer`），且 `approval.request.kind` 无取值域。DSH 的权限询问该走哪条？两者同时未决时 UI 显示哪个？
- 实测（我的实现）：维护未决集合，任一未决即 `waiting`；全部解决才离开。
- 建议：明确 `approval` = 二值/多值裁决（allow/deny），`question` = 自由文本或选项回答；补 `kind` 枚举与「多未决时的 UI 呈现」规则（例如显示计数徽标）。

**C-24 [P1] 事件与会话的归属在 §3.2/§3.3 断裂（L57–L74 vs L40）**
- 证据：§2 允许 `sessionId: null`（「可为 null 但字段必须存在」，L40）；§3.2 里 `turn.start/turn.end` 的 data 带 `nativeSessionId`，但 `step.start/step.end`、`message.assistant` 只有 `turnId`；§3.3 的 `tool.call/result`、`approval.*`、`user.question/answer`、`error.raised` 的 data 都不带会话标识。
- 后果：一旦适配器把 envelope 的 `sessionId` 写成 null（合法），这些事件在 §4 多会话聚合下**无法归属任何会话**，「一个桌宠 + N 徽标」的聚合就退化为单一全局状态。
- 独立佐证：`docs/40-adapters.md` §8.3 在实现映射时独立发现同一问题（表述为「step 缺 nativeSessionId」）。
- 建议：二选一——(a) 规定「除 `pet.heartbeat` 外 envelope.sessionId 不得为 null」；(b) 给 §3.2/§3.3 的 data 补 `nativeSessionId`。

**C-25 [P2] `approval.resolved.decision` 三值有损（L73）**
- 证据：契约只有 `allow|deny|timeout`；`docs/40-adapters.md` §8.6 实测 DSH 原生为四值 `allowed-once|rejected|cancelled|unavailable`，其映射被迫把 `cancelled→deny`、`unavailable→timeout`。
- 后果：UI/统计无法区分「用户真的拒绝了」与「审批渠道被取消」，对「用户行为分析 + Pro 统计面板」是失真数据。
- 建议：v1.1 增加 `cancelled`，或允许 `data.nativeOutcome` 透传（向后兼容）。

**C-26 [P0] 控制帧（hello/ack/snapshot）在契约中不存在，但已进入黄金 fixture（L21–L43 vs L115）**
- 事实：`fixtures/contract-sample.pet.jsonl`（sha256 前 16 位 `f7acd859209bf83b`，2026-10-05 12:21:08，40 行）第 1、2、12 行是三条**非事件**控制帧：
`@
{"ctl":"hello","contract":1,"source":"dsh","adapterVersion":"0.1.0","resumeAfter":null}
{"ctl":"ack","contract":1,"ok":true,"heartbeatMs":15000,"canDecide":false}
{"ctl":"snapshot","ts":1791172509000,"agg":"waiting","sessions":[...],"bubble":{...},"effect":"alert","unknownEvents":0,"offlineSources":[]}
`@
- 契约现状：§2 只说「所有规范事件都是单行 JSON」（L21），§5 只给了一行 ack 示例（L115）；既没有 `ctl` 字段、也没有帧类型判别规则，更没有 `snapshot`（这与 §4「渲染层唯一权威」和 docs/10「Hub 独占状态机」的分歧同源，见 X-01）。
- 实测分歧（同一文件、两个独立校验器）：
`@
# 我的校验器（严格按契约 §2 字面）
$ node scripts/replay-check.mjs fixtures/contract-sample.pet.jsonl
行数 40 | 通过校验 37 | 失败 3 | 最大单行 381 B
exit=1
# T7 的校验器（已内建控制帧概念）
$ node schema/validate-pet-event.mjs fixtures/contract-sample.pet.jsonl
{"knownValid":34,"controlFrames":3,"unknownTypes":3,"malformedLines":0,"invalidKnown":0}
`@
  同一份「黄金 fixture」，一个判定为**非法**（CI 会红），一个判定为**全绿** —— 这就是 §7.1/§7.4 验收无法自动化的直接原因。
- 我的处理（不擅自「和稀泥」）：默认 `strict`（按契约字面，控制帧判非法），新增显式开关 `--control-frames=skip` 才跳过并计数；两种模式的真实输出都写进 §3.6。
- 建议：契约**正式定义控制帧**（建议用 `{"ctl":"hello"|"ack"|"snapshot"}` 做判别，事件帧保留 `v/seq/ts/source/type/data`；控制帧不得计入 `unknownEvents`），并把 `controlFrames` 计数写进 §7 验收。

**C-27 [P1] §3.1 的必填标注与黄金 fixture 不一致（L53–L55）**
- 证据（我的校验器告警，真实输出）：`第3行: §3.1 标注必填的 data.source 缺失`；`session.start` 的 data 里 `source` 与 envelope.`source` 重复，fixture 合理地省略了它。
- 另：`pet.heartbeat` 在 fixture 中写作 `{"nativeSessionId":null,"sessionCount":1}`，envelope 的 `sessionId` 用哨兵值 `backend` —— 即 T3/T7 已按 C-10 的建议把心跳做成「后端级」事件，而 §3.1 仍把 `nativeSessionId` 标为必填（值可为 null，但「必填」标签已失真）。
- 建议：§3.1 的必填集改为「envelope 已有的字段不在 data 重复」；`pet.heartbeat.data` 改为 `sessionCount`（或允许 `nativeSessionId: null` 并注明语义）。

---

## 3. 独立实现：`scripts/replay-check.mjs`

**声明**：本脚本由 contract-verifier **独立编写**，未复用 T3 的 `scripts/check-fixtures.mjs`（本轮编写期间该文件尚不存在）。职责：①信封校验（必填/类型/8 KB）；②按 §4 优先级 + 10 min 兜底 + 多会话聚合回放；③乱序缓冲（2 s / 32 条）；④输出状态迁移序列、`unknownEvents` 计数、乱序收敛判定。

### 3.1 命令

```bash
node scripts/replay-check.mjs --selftest                # 内置 20 行样例 + 6 负例 + 乱序对照 C/D
node scripts/replay-check.mjs fixtures/contract-sample.pet.jsonl   # 校验真实 fixture（待 T3 产出）
node scripts/replay-check.mjs --json <file>             # 机器可读
```

### 3.2 自测主样例真实输出（节选）

```
行数 26 | 通过校验 26 | 失败 0 | 最大单行 277 B
未知 type: future.thing.v2, pet.telemetry（2 条，已忽略并计数）
--- 状态迁移序列（按接收顺序 + 2s/32 条乱序缓冲）---
  [seq=0 ts=1791172500000] idle → thinking   // session.start → thinking
  [seq=2 ts=1791172502000] thinking → working   // step.start → working
  [seq=4 ts=1791172504000] working → waiting   // approval.request → waiting（强提醒）
  [seq=7 ts=1791172507000] waiting → working   // approval.resolved(allow) → 回到 working（若仍有未决则 waiting）
  [seq=14 ts=1791172514000] working → error   // turn.end(status=error) → error
  [seq=15 ts=1791172515000] error → idle   // session.end(done) → 移除会话
  [seq=18 ts=1791172532000] idle → thinking   // session.start → thinking
  [seq=20 ts=1791172534000] thinking → waiting   // user.question → waiting（强提醒）
  [seq=21 ts=1791172535000] waiting → working   // user.answer → 回到 working
  [seq=23 ts=1791172537000] working → error   // error.raised(fatal) → error（契约未定义状态迁移，见 C-13）
  [seq=24 ts=1791172539000] error → idle   // dwell:fatal 到期 → 回 idle
  [seq=24 ts=1791172600000] idle → thinking   // turn.start → thinking
  [seq=25 ts=1791173200000] thinking → idle   // §4 超时兜底：10 min 无事件 → 强制 idle
  [seq=25 ts=1791173230000] idle → working   // tool.call → working
--- 判定 ---
  最终状态（接收顺序）= working ; 最终状态（顺序投递基线）= working → §7.4 收敛: 一致 ✅
  迁移序列完全相同: 是 ✅
  计数: {"events":26,"unknownEvents":2,"stale":1,"invalidAgentStatus":1,"overrideConflicts":0,"uncorrelatedApprovals":0,"deduped":0,...}
--- §2 seq 单调性（按文件投递顺序，独立于乱序缓冲）---
  ✅ 每个 sessionId 内 seq 严格递增
--- §7.2 冲突检测（45s 离线判定 vs §4 的 10 min 兜底）---
  ⚠️ [thinking] 起于 seq=24：非 idle 持续 600s > §7.2 的 45s（§4 却允许到 600s）
--- §2 心跳缺口（相邻事件间隔 > 15s，适配器本应在此期间发 pet.heartbeat）---
  ⚠️ 2 处空洞，最长 630000 ms；Top3: 630000ms(turn.start → tool.call), 63000ms(error.raised → turn.start)
--- 契约/数据问题 ---
  · agent.status.state=blocked 是 §3.4 枚举值，但 §4 状态机六态中没有 blocked，无法映射（契约缺陷 C-03）
  · error.raised(fatal=false) 的状态语义未定义（§4 图无此迁移），本消费者忽略；seq=22
```

类型覆盖自检（同一命令）：
```
=== §3 类型覆盖自检 ===
  覆盖 16/16 个 type（含 §3 表格中 step.start/end、user.question/answer 的同名行）✅
```

**该样例覆盖**：§3 全部 **16/16** 个 type 字符串（脚本内含覆盖自检，见上方输出）、6 个状态全部出现（idle/thinking/working/waiting/error/done）、多会话（A/B/C）聚合、审批等待与放行、结构化提问与回答、未知 type ×2、10 min 兜底 ×1。样例文件由脚本写入临时目录（`/var/folders/.../pet-selftest-XXXX/selftest.pet.jsonl`），不污染仓库 `fixtures/`（该目录属 task-3 write scope）。

### 3.3 负例（应全部被拒绝）真实输出

```
=== 负例（应全部被拒绝）===
  ✅ 已拒绝 | 缺 data 字段 → 缺少必填字段 data
  ✅ 已拒绝 | seq 是字符串 → seq 必须是非负整数，实际 "0"
  ✅ 已拒绝 | type 非字符串 → type 必须是非空字符串
  ✅ 已拒绝 | sessionId 字段缺失 → 字段 sessionId 必须存在（可为 null）
  ✅ 已拒绝 | v=2 版本不匹配 → v=2 与本消费者支持的契约主版本 1 不匹配（§5 应拒收）
  ✅ 已拒绝 | 单事件 > 8KB → 序列化后 9129 B > 8 KB 上限（§2）
```

### 3.4 乱序对照实验（真实输出）

对照 C：窗口内逆序（`resolved` 先于 `request` 到达，跨度 1.5 s ≤ 2 s 窗口）→ **收敛**：
```
  [seq=0] idle → thinking      // session.start
  [seq=1] thinking → waiting   // approval.request（缓冲排序后按 seq 应用）
  [seq=2] waiting → working    // approval.resolved(allow)
  最终状态（接收顺序）= working ; 最终状态（顺序投递基线）= working → §7.4 收敛: 一致 ✅
```
对照 D：跨窗口逆序（`resolved` 先到并被应用、`request` 迟到 3 s 以上）→ **不收敛**：
```
  [seq=2] thinking → working   // approval.resolved(allow)[未匹配] → 回到 working
  [seq=1] working → waiting    // approval.request → waiting（强提醒）
  最终状态（接收顺序）= waiting ; 最终状态（顺序投递基线）= working → §7.4 收敛: 不一致 ❌
  计数: {"events":4,"uncorrelatedApprovals":1,...}
--- 契约/数据问题 ---
  · approval.resolved 未匹配到任何未决 approval.request（seq=2，callId="k1"）→ 契约 §3.3 允许 callId 缺省，无法可靠关联（缺陷 C-05）
```
结论：§7.4 的「窗口内」措辞是自洽的（对照 C 通过），但**窗口外迟到事件**没有契约规则，实测会留下永久 `waiting`（只能等 10 min 兜底）——对应缺陷 C-05 与 C-08。

### 3.5 自测过程中修掉的两个自身缺陷（用于说明验证的独立性）

1. 乱序缓冲最初实现为「先 push 再判断窗口并冲刷」，导致新事件被裹进旧缓冲提前应用，窗口内乱序**无法**纠正（对照 C 曾误判为不收敛）。已改为「先判断再冲刷、后入缓冲」。
2. §7.2 冲突检测的区间闭合逻辑 off-by-one，曾把 15 s 的忙碌区间报成 100 s。已改为按「进入/离开 idle」正确闭合。

---

### 3.6 T3 fixture 全量校验（task-6 验收项 1，真实输出）

> **更新（12:24）**：T3 于 12:21 更新了 fixture（sha256 前 16 位 `f7acd859209bf83b`，40 行 / 10,334 B）。新版**新增 3 条控制帧**，导致同一文件在两个独立校验器之间出现判定分歧；下方 39 行数据是 12:10 版的存档记录，最新复核见 §3.6.1。

**对象**：`fixtures/contract-sample.pet.jsonl`（39 行，T3 产出）。

**独立命令 A（jq 逐行审计，不复用 T3 脚本）**：
`@bash
F=fixtures/contract-sample.pet.jsonl
jq -c . "$F" > /dev/null && echo "所有行均为合法 JSON"     # → 所有行均为合法 JSON
wc -l < "$F"                                              # → 39
jq -r 'select((has("v") and has("seq") and has("ts") and has("source") and has("type") and has("data") and has("sessionId") and has("workspace"))|not) | .seq' "$F" | wc -l   # → 0（必填缺失行数）
jq -r '.type' "$F" | sort | uniq -c | sort -rn            # → 16 个已知 type + 3 个 x-unknown.*
awk '{print length($0)}' "$F" | sort -rn | head -1        # → 381（最大单行字节，≤ 8192）
`@

**独立命令 B（自研 replay-check.mjs）**：
`@
$ node scripts/replay-check.mjs fixtures/contract-sample.pet.jsonl
行数 39 | 通过校验 39 | 失败 0 | 最大单行 381 B
未知 type: x-unknown.foo, x-unknown.bar, x-unknown.event-v9（3 条，已忽略并计数）
--- 状态迁移序列（按接收顺序 + 2s/32 条乱序缓冲）---
  [seq=0 ts=1791172501000] idle → thinking   // session.start → thinking
  [seq=2 ts=1791172503000] thinking → working   // step.start → working
  [seq=8 ts=1791172509000] working → waiting   // approval.request → waiting（强提醒）
  [seq=9 ts=1791172510000] waiting → working   // approval.resolved(allow) → 回到 working
  [seq=13 ts=1791172514000] working → done   // turn.end(ok) → done
  [seq=15 ts=1791172516000] done → idle   // dwell:done 到期 → 回 idle
  [seq=15 ts=1791172516000] idle → thinking   // turn.start → thinking
  [seq=16 ts=1791172517000] thinking → working   // tool.call → working
  [seq=20 ts=1791172521000] working → waiting   // user.question → waiting（强提醒）
  [seq=21 ts=1791172522000] waiting → working   // user.answer → 回到 working
  [seq=23 ts=1791172524000] working → waiting   // approval.request → waiting（强提醒）
  [seq=24 ts=1791172525000] waiting → error   // approval.resolved(timeout) → error 1.5s
  [seq=26 ts=1791172528000] error → idle   // dwell:error 到期 → 回 idle
  [seq=26 ts=1791172531000] idle → thinking   // turn.start → thinking
  [seq=28 ts=1791172531400] thinking → working   // step.start → working
--- 判定 ---
  最终状态（接收顺序）= idle ; 最终状态（顺序投递基线）= idle → §7.4 收敛: 一致 ✅
  迁移序列完全相同: 是 ✅
  计数: {"events":39,"unknownEvents":3,"stale":0,"invalidAgentStatus":0,"overrideConflicts":2,"uncorrelatedApprovals":0,...}
--- §2 seq 单调性（按文件投递顺序）---
  ⚠️ 1 处违反：第29条 sessionId=sess-demo-0001 seq=27 ≤ 前值 28
--- §7.2 冲突检测 ---  ✅ 无非 idle 状态持续 > 45s 的区间
--- §2 心跳缺口 ---     ✅ 无 > 15s 的空洞
--- 契约/数据问题 ---
  · error.raised(fatal=false) 的状态语义未定义（§4 图无此迁移），本消费者忽略；seq=22
  · seq 非单调：sessionId=sess-demo-0001 seq=27 前值=28（§2 要求单调递增）
  · agent.status 覆盖冲突：seq=32 覆盖态=working vs 会话聚合态=done（见 C-12）
  · agent.status 覆盖冲突：seq=38 覆盖态=working vs 会话聚合态=error（见 C-12）
`@

**对照 T3 任务书逐条判定**

| 要求（task-3 描述） | 实测 | 判定 |
|---|---|---|
| 20~40 行合法 v1 事件 | 39 行 | ✅ |
| 覆盖全部 type | 已知 type **16/16** + 3 个 `x-unknown.*` | ✅（但「14 种」口径歧义见 C-01） |
| 6 个状态迁移 | 迁移序列覆盖 idle/thinking/working/waiting/done/error 全部 6 态 | ✅ |
| 1 次审批超时 | `seq=24 approval.resolved(timeout)` → error 1.5 s → idle | ✅ |
| 1 批乱序事件 | 文件顺序 seq 28 先于 27（400 ms 间隔，在 2 s 窗口内），缓冲纠正后与顺序投递**完全一致** | ✅ |
| 3 条未知 type | `x-unknown.foo / x-unknown.bar / x-unknown.event-v9` | ✅ |
| 每行可被 jq 解析 | `jq -c .` 全部通过 | ✅ |

**但该 fixture 暴露了一个契约级问题（C-12 的具体化）**：最后一条事件是 `error.raised(fatal=true, scope=adapter, code=SOCKET_CLOSED)`（seq=38），而此前的 `agent.status(state=working)`（seq=31）仍在 §3.4 的 10 s 覆盖窗口内 → 按契约字面，桌宠**不会**立即显示 error，要等覆盖窗口结束才结算。即 T3 的 fixture 无法直接证明「fatal 错误立即可见」。

### 3.6.1 12:21 版复核（当前版本，含控制帧）

**命令与真实输出（严格模式 = 按契约 §2 字面）**：
`@
$ node scripts/replay-check.mjs fixtures/contract-sample.pet.jsonl
行数 40 | 通过校验 37 | 失败 3 | 最大单行 381 B
未知 type: x-unknown.foo, x-unknown.bar, x-unknown.event-v9（3 条，已忽略并计数）
控制帧（非事件，契约 §2 未定义）: hello, ack, snapshot —— 见缺陷 C-26（strict 模式已判非法）
  第1行: 控制帧 ctl=hello：契约 §2 未定义控制帧（C-26），strict 模式判为非法
  第2行: 控制帧 ctl=ack：…
  第12行: 控制帧 ctl=snapshot：…
exit=1
`@
**命令与真实输出（--control-frames=skip，承认 §5 握手实践）**：
`@
$ node scripts/replay-check.mjs fixtures/contract-sample.pet.jsonl --control-frames=skip
行数 40 | 通过校验 40 | 失败 0 | 最大单行 381 B
未知 type: x-unknown.foo, x-unknown.bar, x-unknown.event-v9（3 条，已忽略并计数）
控制帧（非事件，契约 §2 未定义）: hello, ack, snapshot —— 见缺陷 C-26（已跳过）
  计数: {"events":37,"unknownEvents":3,"stale":0,"invalidAgentStatus":0,"overrideConflicts":0,"uncorrelatedApprovals":2,...}
  最终状态（接收顺序）= idle ; 最终状态（顺序投递基线）= idle → §7.4 收敛: 一致 ✅
exit=0
`@
**与 T7 校验器的对照**：`{"knownValid":34,"controlFrames":3,"unknownTypes":3,"malformedLines":0,"invalidKnown":0}` —— 34 + 3 未知 + 3 控制帧 = 40，与我 skip 模式的「事件帧 37 = 34 已知 + 3 未知」一致；两者对**事件帧**没有分歧，分歧只在「控制帧是否合法」（C-26）。

**新版 fixture 的另外三处「实现已跑到契约前面」的实证**：
1. **审批关联改用 `requestId`**：`{"seq":8,"type":"approval.request","data":{"requestId":"req-1",...,"callId":"call-2"}}` 与 `{"seq":9,"type":"approval.resolved","data":{"requestId":"req-1","decision":"allow","latencyMs":3100}}` —— `resolved` 不再带 `callId`，改用 `requestId` 关联；这正是本报告 C-05 的建议，但**契约 §3.3 里没有 `requestId`**，因此我的契约忠实实现把它记为 `uncorrelatedApprovals: 2`。
2. **心跳改为后端级**：`{"seq":0,"sessionId":"backend","data":{"nativeSessionId":null,"sessionCount":1}}` —— 对应 C-10/C-27。
3. **`seq` 按会话独立编号**：文件里出现两段 seq（第一个会话 0…13，第二个会话从 0 重新开始），并在同一会话内保留一处 400 ms 的乱序（seq 27 先于 26）—— 对应 C-09（per-(source,sessionId) 语义）与 §7.4 的乱序批次。

**结论**：fixture 本身质量高（40 行、16/16 已知 type、6 态、审批超时、乱序、3 条未知、3 条控制帧），但它已经**超出冻结契约的文本范围**（控制帧、`requestId`、后端级心跳、per-session seq 哨兵值）。这不是 T3/T7 的错——恰恰说明契约需要一次 v1.1 修订把实践固化，否则「按契约实现」与「按 fixture 验收」会持续互相打脸（C-26 的两个校验器分歧就是活证据）。



- **对象**：`schema/pet-event.schema.json`（32,530 B）、`schema/validate-pet-event.mjs`（8,921 B，T7 产出）。
- **实测**：
`@
$ node schema/validate-pet-event.mjs fixtures/contract-sample.pet.jsonl
{"file":"fixtures/contract-sample.pet.jsonl","knownValid":36,"unknownTypes":3,"malformedLines":0,"invalidKnown":0}
`@
- **结论**：36 已知 + 3 未知 = 39，与我的独立结论（39 行全部通过、3 条未知）**完全一致** ✅。T7 的 `KNOWN_TYPES` 同样是 **16** 个 type（脚本第 28–33 行），与 T3 一致 —— 两个互不通信的实现者对「14 还是 16」给出了相同答案，进一步说明 C-01 是文档口径问题而非实现分歧（但契约文本仍必须修正，否则 CI 门禁口径无据）。
- **未做**：我没有用 ajv 复核 T7 的 schema 语义（T7 已说明其校验器是 JSON Schema 2020-12 子集实现）；如需第三方独立性，建议在 CI 中加一条 ajv 校验（属 T7/QA 范围）。

## 4. 交叉审阅

### 4.1 `docs/10-architecture.md`（已完成；非 T6 指定清单但直接冲突，先行报告）

| ID | 级别 | 位置 | 冲突 |
|---|---|---|---|
| X-01 | **P0** | 契约 §4（L87）vs `10-architecture.md` §1/ADR-2（L7/L39） | 契约说状态机在**渲染层**且渲染层是唯一权威；架构说 **Hub 独占**状态机、渲染层只渲染快照。二者只能选一个 |
| X-02 | **P0** | `10-architecture.md` §5.1-4（L78） | 「45 s 无任何事件 → 桌宠回 idle（契约 §3.4/§4 兜底）」——既放大了 C-04 的矛盾，又错引 §3.4（`agent.status` 与离线无关），应引 §2 |
| X-03 | P1 | `10-architecture.md` §6（L98） | 「Hub 支持 1.x（次版本只允许加可选字段/新 type）」「适配器声明 `contract: 1`」：契约里没有次版本概念，`contract` 只出现在 Hub 的 ack 中（适配器侧声明不存在），新增 type 与「未知 type 忽略」的关系也没定义 |
| X-04 | P2 | `10-architecture.md` §4（L67）vs 契约 §5（L113） | 架构给了 `<YYYYMMDD>`、`state/<source>.json` 等更细的约定，建议回填契约（否则实现按各自理解落地） |

> 说明：X-01 影响最大——它决定 `packages/hub` 与 `apps/pet` 的职责边界、以及 §4 中出现的所有「渲染层」措辞是否需要改写。

### 4.2 `docs/70-team-and-metrics.md` 与 `README.md`（补充审阅，已完成）

| ID | 级别 | 位置 | 问题 |
|---|---|---|---|
| Y-01 | P1 | `70-team-and-metrics.md` §3 Gate 1（L41） | 「kill -9 DSH / 桌宠 / Hub 各一次…且 **45s 内恢复 idle**」——这是 C-04 的下游：按契约 §4 现文本实现，Gate 1 这一条**必然不达标** |
| Y-02 | P2 | `70-team-and-metrics.md` §3 Gate 1（L44） | 「契约 §7 五条验收全绿」被写成 Gate 1 的硬指标，但 §7.1 的「5 类特效」契约内无枚举、§7.3 的计数器无暴露方式（C-20）→ 该 Gate 目前无法判定 |
| Y-03 | P2 | `70-team-and-metrics.md` §1/§3 vs `10-architecture.md` ADR-2 | 「Hub 状态机」与契约 §4「渲染层唯一权威」同源冲突（X-01），70 号文档沿用了架构的措辞 |
| Y-04 | P2 | `README.md` 文档索引 | 索引未收录本报告（`docs/99-verification-report.md`），建议 Lead 补一行，否则验收结论不可发现 |

> Y-01/Y-02 说明 C-04 与 C-20 不只是文档瑕疵：它们已经进入团队的 Gate 定义，不修则 Gate 1 无法通过。

### 4.3 `docs/50-product-spec.md` 交叉审阅（已完成，479 行）

| ID | 级别 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| Z-01 | **P0** | §1.3（L39–L45）vs §11 A2（L419）/E2（L451） | **同一文档内两种 45 s 口径**：§1.3 L1 说 45 s 只打 `offline` 角标、状态不重置（L2 才在 10 min 回 idle）；但 A2/E2 的验收写成「45 s 内回 idle」。再叠加 §7.2 与 `docs/70` Gate 1，共出现 4 种口径 | 由 Lead 二选一后统一改全部文档（建议：45 s = 离线角标 + 清空该 source 聚合，10 min = 兜底回 idle，§7.2 相应改写） |
| Z-02 | P1 | §1.1（L21）+ §11 B6（L431） | 「error 停留 1.5 s；**turn.end(error) 3 s**」：契约里 3 s 属于 `session.end(error)`（§3.1），§4 图给的是 error→2 s；`turn.end(error)` 的时长契约**未定义**，而 B6 已把它写成验收断言 → 未确认数值被固化为测试 | 契约先补 error dwell 表（C-14），再回填本文 |
| Z-03 | P1 | §1.1（L21）+ §11 B1（L426） | 把 `tool.result(error)` 列为进入 `error` 的条件；契约 §3.3 只说它播「乌云 2 s」特效，§4 图无该迁移 | 同 C-13：契约补真值表，或产品侧改为「不改状态、仅特效」 |
| Z-04 | P2 | §1.1 waiting 行（L20） | 「不自动退出（见 1.4）」交叉引用错位：waiting 自动退出规则在 §1.3 L2，§1.4 是多会话徽标 UI | 改为「见 §1.3 L2」 |
| Z-05 | P2 | §1.2.3（L30） | 「不排队堆积，只保留每会话最近 1 条 `pendingState`…否则丢弃并计 `droppedTransitions`」是契约没有的队列语义（契约只说「排队到该状态退出」） | 建议回填契约，否则两台实现会对同一事件流产生不同迁移序列（fixture 可检出） |
| Z-06 | P2 | §1.4（L54） | 「点击卡片『跳转』→ 唤起对应 agent 窗口（DSH 用 `open` 打开其窗口）」未标 [假设]/[未验证]，且无 DSH 支持按会话定位的证据 | 标注 [未验证] + 验证方法，或降级为「打开 DSH 主窗口」 |
| Z-07 | P2 | §7 竞品表（L359–L371） | 抽样复核：BongoCat ⭐23,790/Apache-2.0、clawd-on-desk ⭐6,364/AGPL-3.0 与 GitHub API 实测**完全一致**（2026-10-05）→ 该表 [实测] 分级可信 ✅ | — |
| Z-08 | **P1（佐证）** | §8（L382–L390） | docs/50 §8 独立提出 C1–C7 七条契约修改建议，其中 C1/C2/C3/C4/C5/C6/C7 分别对应本报告的 **C-01/C-03/C-04（产品侧）/C-12/C-16/C-06/C-18** —— 两个互不通信的实现者独立发现同一批缺陷 | 分歧点：C1 建议「把 `user.question/answer` 并入 approval 家族（凑成 14）」，本报告建议「标题改为 16」。我倾向后者：合并 type 是破坏性变更，且 T3/T7 已按 16 实现；该分歧需 Lead 裁决 |
| Z-09 | P2 | §5.3（L286–L298） | 已明确「Phase 1 不做写回，只做看+跳」，即 C-06 的**产品侧答案已经存在**，但契约 §5 仍未写 | 回填契约 §5：声明 Phase 1 为单向（适配器→桌宠），桌宠不回传决定 |

### 4.4 `docs/60-risk-register.md` 交叉审阅（已完成，234 行）

| ID | 级别 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| W-01 | P2 | §2 敞口分布（L45） | **算术自相矛盾**：正文写「高（≥15）**7 条**：R-01、R-02、R-03、R-05、R-08、R-09、R-13、R-14（**8 条**…）」；按表中 P×I 实数为**高 8 条**、**中 12 条**（R-04/06/07/10/11/12/15/16/17/18/19/20），正文却写「中 11 条」 | 改为「高 8 条、中 12 条、低 0 条」 |
| W-02 | P2 | R-12（L35） | 引用「契约 **§0** 已定」——契约没有 §0，三步流程写在文件头引言（L3） | 改引「契约文件头说明」 |
| W-03 | P1 | R-17（L40） | 「45 s 心跳缺失判离线、10 min 强制回 idle（**契约 §4**）」：45 s 出自 §2 而非 §4；且与 §7.2、docs/50 §1.3、docs/70 Gate 1 构成四种口径（见 Z-01/C-04） | 随 C-04 一并统一 |
| W-04 | P2 | §4.2（L100） | 「`workspace` 可配置为『只保留末段』」与契约 §2 envelope 语义（工作目录全路径；未知为 null）不同；若实现，录制/回放/取证与 fixture 断言会不一致 | 契约补 `workspacePrivacy` 开关，或明确禁止改写 envelope 字段 |
| W-05 | P2 | R-06（L29） | 把契约 §5 的「轮转 20 MB × 7 天」当确定事实引用——这正是 C-17 的歧义点（7 个文件 vs 保留 7 天） | 契约澄清后回填 |
| W-06 | P2 | §5 竞品表（L150–L151） | 抽样复核：前两行（clawd-on-desk、BongoCat）星标/许可与 GitHub API 实测一致 ✅ | — |
| W-07 | P2 | §4.1 数据流图（L81–L84） | 图中事件路径为「适配器 → 桌宠渲染层」（与契约 §5 一致），但 `docs/10` 的架构是「适配器 → **Hub** → 快照 → 渲染层」 | X-01 的下游表现，随 X-01 一并统一 |

### 4.5 `docs/40-adapters.md` 交叉审阅（已完成，690 行）

| ID | 级别 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| V-01 | **P1** | §0 TL;DR（L16）vs §4（L459–L463） | **ACP 的优先级自相矛盾**：TL;DR 写「通用 ACP … **P1**（高杠杆）」，§4 打分表写「**P0-3**」。另外 §4 的 P0/P1/P2 列与「优先级分」列不构成单调关系（ACP 11.0 记 P0-3，Cursor 12.1 只记 P1-1，Gemini 11.0 记 P2）——打分公式已声明是启发式，但结论列无法由分数复算 | 统一 ACP 为 P1 或 P0；在 §4 加一列「是否受分数约束」或直接给出人工调整理由 |
| V-02 | P2 | §0 TL;DR（L13）vs `docs/10` O-5（L128） | docs/10 的待决策项写「P0 适配器名单（Claude Code / Codex / **Cursor** 谁先）」，暗示 Cursor 可能是 P0；docs/40 把 Cursor 定为 P1-1（无本机验证 + GUI 场景） | 由 T4 路线图定稿时统一 |
| V-03 | P1（佐证） | §8.1（L595） | **独立复现 C-01**，且给出与 docs/50 不同的解法：建议「§3 定义 **16 个 type 字符串**（14 个语义行），验收以 16 为准」——与本报告一致，与 docs/50 C1「合并成 14」相反。两个后端实现者（T3/T7）也都按 16 实现 | Lead 裁决时建议采纳「16 字符串 / 14 行」表述，避免破坏性合并 |
| V-04 | P2（佐证） | §8.9（L603） | 提出「乱序窗口内必须是某个连续 `seq` 区间的**排列**，窗口结束后 seq 续接」——正是 C-08 缺失的可判定规则，建议原样写进契约 | 采纳 |
| V-05 | P2（佐证） | §8.10（L604） | 提出在握手 ack 中声明能力（`{"ack":true,"contract":1,"capabilities":["lifecycle","tools","approvals"]}`），使「进程级后端」的降级体验可被渲染层识别——直接补上 C-06/C-07 的缺口 | 采纳（与 C-06 建议的反向通道方案合并设计） |
| V-06 | P2 | §8.2（L596） | 「任务书与 §6 都写『DSH 桥仅支持 6 个』，实测 README 为 **7** 个（多 `SubagentStart`），被忽略 23 个」——契约 §6 表格本身没有写 6 个，因此不是契约正文冲突，但 **T7 任务书的前提数字需要更正** | Lead 在汇总时更正任务书口径 |
| V-07 | P2 | §8.5/§8.6/§8.8（L599–L602） | 另外三条契约缺口（`tool.result.durationMs` 必填性、`decision` 四值有损、`agent.status` 多会话语义）分别对应本报告 **C-02 / C-25 / C-12+C-22** → 三方独立佐证 | 随对应缺陷一并修 |
| V-08 | P2 | 附录 B（L677–L690） | 未验证项清单（10 条）与 [U] 标记体系完整，未发现「把推测写成结论」的段落；抽查 §2.5 覆盖率结论与 §0/§9 一致 | — |



### 4.6 `docs/20`、`docs/30`（**未完成：依赖未产出**）

截至本次更新，`20-roadmap.md`（111 B）、`30-implementation-stack.md`（112 B）仍是占位符（`wc -c` 实测）；`docs/50`、`docs/60`、`docs/40` 已于本轮完成审阅（见 §4.3/§4.4/§4.5）。剩余两份文档的交叉审阅在 `task-6` ready 后补做。

---

## 5. 已通过项（附命令与实测）

| # | 结论 | 命令 | 证据 |
|---|---|---|---|
| P-01 | 环境满足验收需要（node/jq 齐备） | `node -v; command -v jq && jq --version` | v24.18.0 / jq-1.7.1-apple |
| P-02 | 契约信封可被独立实现无歧义解析 | `node scripts/replay-check.mjs --selftest` | 26/26 行通过校验，§3 类型覆盖 16/16 |
| P-03 | §2 必填/类型校验可执行 | 同上「负例」节 | 6/6 负例被拒（缺字段、类型错、超 8 KB、v 不匹配） |
| P-04 | §1.5 未知 type 忽略并计数 | 同上 | `unknownEvents: 2`，无异常 |
| P-05 | §4 多会话聚合（waiting 优先）符合契约 | 同上主样例 | A 在 waiting 时 B 的 working/done 未改变整体状态 |
| P-06 | §4 10 min 超时兜底可复现 | 同上 | `stale: 1`，第 600 s 强制回 idle |
| P-07 | §2 乱序缓冲在窗口内可纠正（§7.4 前提成立） | `--selftest` 对照 C | 收敛 ✅ |
| P-08 | §2 单事件 8 KB 上限可校验 | 同上 | 9129 B 被拒 |
| P-09 | 文件模式可定位坏行并返回非 0（供 CI 门禁） | `node scripts/replay-check.mjs /tmp/pet-verify/sample.pet.jsonl` | 「行数 6 / 通过 4 / 失败 2」，第 1、6 行给出原因；exit=1；自测干净时 exit=0 |
| P-10 | **T3 fixture 事件帧全量校验通过** | `jq -c . fixtures/contract-sample.pet.jsonl` + `node scripts/replay-check.mjs fixtures/contract-sample.pet.jsonl --control-frames=skip` | 40 行中事件帧 37/37 合法、16/16 已知 type、3 条未知、最大单行 381 B、6 态全出现、1 次审批超时、乱序批次回放收敛（见 §3.6.1，附 sha256 与时间戳） |
| P-11 | **与 T7 校验器交叉一致** | `node schema/validate-pet-event.mjs fixtures/contract-sample.pet.jsonl` | `knownValid:36, unknownTypes:3, malformedLines:0, invalidKnown:0`，与我的独立结论一致 ✅（§3.7） |
| P-12 | 外部 [实测] 声明抽样复核为真 | `web_fetch api.github.com/repos/{ayangweb/BongoCat, rullerzhou-afk/clawd-on-desk}` | ⭐23,790/Apache-2.0 与 ⭐6,364/AGPL-3.0，与 docs/50 §7、docs/60 §5 的数字**完全一致** ✅ |
| P-13 | **两个独立校验器对同一 fixture 的判定分歧已定量化** | `node scripts/replay-check.mjs fixtures/contract-sample.pet.jsonl`（strict）与 `node schema/validate-pet-event.mjs fixtures/contract-sample.pet.jsonl` | 我：37 通过 / 3 非法（控制帧），exit=1；T7：34 已知 + 3 未知 + 3 控制帧、0 非法。事件帧结论一致，分歧仅在控制帧合法性 → 契约缺口 C-26 的活证据 |
## 6. 未验证项（明确未做，避免误读为「已验证」）

| # | 项 | 原因 |
|---|---|---|
| N-01 | ~~`fixtures/*.pet.jsonl` 全量校验~~ **已完成**（见 §3.6/P-10）：39/39 通过 | — |
| N-02 | 交叉审阅 `docs/50`、`docs/60`、`docs/40`、`docs/10`、`docs/70` —— **已完成** | — |
| N-03 | **`docs/20`、`docs/30` 交叉审阅** | 两份文档已于 12:33 前后产出（78 KB / 36 KB），但本轮聚焦 v1.2 复验（Lead 指派），**尚未审阅**；`task-4` 仍在进行中 |
| N-04 | §5 传输层真实 socket 握手 / ack 往返 | 无实现（Hub 未开始编码）；本次仅做文本层审阅 |
| N-05 | §7.2 真机 `kill -9` 演练 | 无实现；本次用离线模拟证明「规则本身」的矛盾 |
| N-06 | §7.3 注入 1000 条未知事件的内存增长 | 需要真实渲染层；本次只验证计数语义（未知类型忽略+计数已通过） |
| N-07 | T7 schema 的 **ajv 全语义**复核 | T7 自述其校验器为 JSON Schema 2020-12 子集；本次只做同 fixture 的结论交叉（一致），未跑 ajv |
| N-08 | 心跳 15 s 语义的真实适配器行为 | 无实现；本次仅统计 fixture 中的心跳空洞（contract-sample 无空洞） |

## 7. 阻塞与依赖（本轮）

- `task-6` 在 12:21 时仍为 `pending / ready=false`：依赖 `task-1`（进行中）、`task-2`（已完成）、`task-3`（进行中）、`task-7`（进行中）、`task-4`（未开始）—— 只要有一项未完成，`task-6` 就不会 ready，因此本轮**不 claim**（按 Lead 指示）。
- 依赖产出后已就地补做（不等 ready）：`fixtures/contract-sample.pet.jsonl` 全量校验（§3.6）、T7 schema 交叉校验（§3.7）、`docs/40`/`50`/`60` 交叉审阅（§4.3–§4.5）。
- 仍然缺：`docs/20`（78 KB）、`docs/30`（36 KB）交叉审阅 —— 两份文档已产出，`task-4` 仍在进行中、`task-6` 仍未 ready；待 ready 后由本报告增量补齐（这也是 task-6 的最后一块）。
- 本报告为**增量文件**：后续更新保留已有编号（C-01…C-25、X-、Y-、Z-、W-、V-），新增条目继续编号。

## 8. 复现命令清单

```bash
# 环境
node -v; uname -sm; sw_vers -productVersion; command -v jq && jq --version

# 契约 §3 计数（C-01）
sed -n '/^## 3\./,/^## 4\./p' docs/00-interface-contract.md | grep -c '^| `'                    # → 14 行
sed -n '/^## 3\./,/^## 4\./p' docs/00-interface-contract.md | grep '^| `' \
  | sed 's/^| //; s/ |.*//' | tr -d '`*' | tr '/' '\n' | sed 's/^ *//; s/ *$//' \
  | grep -v '^$' | sort -u | wc -l                                                              # → 16 个 type

# 契约内部矛盾（C-03/C-04/C-11/C-12）
grep -n 'blocked\|10 min\|45 s\|优先级\|以本事件为准' docs/00-interface-contract.md

# 独立校验器 + 状态机消费者（全部自测）
node scripts/replay-check.mjs --selftest
node scripts/replay-check.mjs --selftest > /tmp/pet-verify/selftest.out 2>&1; wc -l /tmp/pet-verify/selftest.out

# fixture 全量校验（T3 产物，sha256 前 16 位 f7acd859209bf83b / 40 行 / 2026-10-05 12:21）
node scripts/replay-check.mjs fixtures/contract-sample.pet.jsonl                    # strict（契约字面）：3 条控制帧判非法 → exit 1
node scripts/replay-check.mjs fixtures/contract-sample.pet.jsonl --control-frames=skip  # 跳过控制帧：40/40 通过 → exit 0
node schema/validate-pet-event.mjs fixtures/contract-sample.pet.jsonl              # T7 校验器（内建控制帧）：34 已知 + 3 未知 + 3 控制帧
jq -c . fixtures/contract-sample.pet.jsonl > /dev/null && echo 所有行均为合法 JSON
```

## 9. 契约 v1.2 复验（第二轮，Lead 指派）

> 触发：Lead 将契约升级为 **v1.2**（docs/00-interface-contract.md，FROZEN v1.2），要求按 v1.2 复验真值表分支、fixture 与 schema。
> 工具：`scripts/replay-check.mjs` 已按 v1.2 重写（控制帧 `ctl`、§2.3 必填规则、§3.3 `requestId` 配对与 orphan 计数、§4.7 瞬态/持久错误、§4.4/§4.5 双超时、§4.6 迟到不倒退、§7.3 noop 语义）。
> 复现：`node scripts/replay-check.mjs --selftest` / `node scripts/replay-check.mjs fixtures/contract-sample.pet.jsonl`

### 9.1 v1.2 真值表分支复验结果（自造样例，逐条构造）

| §4.2/§4.7 分支 | 构造方式 | 实测结果（真实输出） | 判定 |
|---|---|---|---|
| `tool.result(error)` → 瞬态 | 分支样例 seq3 | `working → transient-error → working`（TTL 2 s 到期，`recoveredErrors=1`） | ✅ |
| 连续 3 次瞬态（<60 s）→ 持久 error | 主样例 seq4/6/8 | 第 3 次直接 → `error`（`escalatedErrors=1`） | ✅ |
| `turn.end(error)` → 持久 error | fixture seq24 | `waiting → error`，随后 `turn.start` 清除（`error → thinking`） | ✅ |
| `step.end(error)` → 瞬态 TTL | fixture seq29–31 | `working → transient-error → working` | ✅ |
| `turn.end(aborted)` 会话级例外 | 主样例 seq24、分支 seq8 | 该会话 → `idle`，整体仍停在 `waiting`（未被顶掉） | ✅ |
| `step.end(aborted)` 例外 | 主样例 seq20 | 会话 → `idle`，不影响其它会话 | ✅ |
| `approval.resolved(timeout)` | fixture seq23 | `waiting → error`（1.5 s TTL）→ 登记前状态 | ✅ |
| `approval.resolved` 无配对 → orphan | 主样例 seq12 | 忽略、状态不变、`orphanApprovals=1`（不猜 FIFO） | ✅ |
| `user.answer` 无配对 → orphan | 主样例 seq15 | `orphanAnswers=1` | ✅ |
| `agent.status` 低优先级无 force → 拒绝 | 主样例 seq16、fixture seq31 | `overrideRejected=1` 且状态不变 | ✅ |
| `agent.status(..., force:true)` | 主样例 seq17 | 覆盖生效 10 s | ✅ |
| `error.raised(fatal=true/false)` | 主样例 seq31/32、fixture seq38 | 持久 `error` / no-op | ✅ |
| `pet.heartbeat` no-op 且**不刷新** §4.5 计时 | 主样例 22 条心跳、分支 22 条心跳 | 心跳持续期间会话仍被 `stale` 清理（`stale=1`） | ✅ |
| §4.4 45 s source 离线（边沿触发） | 分支样例 claude-code | `offline=1`，清空该 source 聚合与未决，其它 source 不受影响 | ✅ |
| §4.4 误判防护 | 初始 hello 无 `ts` | 修复后不再把控制帧缺省 0 当时间戳 → 无假离线 | ✅（本轮修掉的自身缺陷） |
| §4.5 10 min 会话陈旧 | 心跳保活 700 s | `stale=1`，清理未决并回 `idle` | ✅ |
| §4.6 窗口外迟到 | 分支样例 seq 3 后到 seq 2 | `lateEvents=1`，状态不倒退 | ✅ |
| §2.4 重复 seq | 分支样例 seq 3 二次到达 | `duplicates=1`，丢弃不报错 | ✅ |
| §2.2 控制帧 | hello/ack/snapshot | 不进入事件统计，`observes` 被解析 | ✅ |
| §7.3 noop 语义 | 心跳/消息/step.end(ok)/denied | 计 `noop`，不计入 `unknownEvents` | ✅ |
| 未知 type | 主样例 `x-future.type` | `unknownEvents=1` | ✅ |
| 负例（11 条） | 缺 `requestId`/`risk`、非法枚举、`agent.status=done`、未知 ctl 等 | 11/11 全部被拒绝 | ✅ |

**结论**：v1.2 的真值表分支**可被独立实现并逐条复现**；本轮未发现「规则不可实现」的分支。唯一无样例行的是 §2.2 的 `decide` 帧（Phase 2 专用）：代码路径会告警，但样例未覆盖（诚实标注）。

### 9.2 fixture 按 v1.2 全量校验（task b）

- 对象：`fixtures/contract-sample.pet.jsonl`，sha256 前 16 位 `f7acd859209bf83b`，40 行，2026-10-05 12:21（作者：队友 C）。
`@
$ node scripts/replay-check.mjs fixtures/contract-sample.pet.jsonl
行数 40 | 通过校验 37 | 失败 3 | 最大单行 381 B
帧分类: 事件帧 32 | 未知 type 3 | 控制帧 2 (hello,ack)
  第3行: session.start.data 缺必填字段 startedAt（§3 + §2.3「未标注=必填」）
  第12行: 控制帧缺字段 contract
  第37行: session.end.data 缺必填字段 endedAt（§3 + §2.3「未标注=必填」）
exit=1
`@
- **事件语义全部通过**：6 态齐（idle/thinking/working/waiting/error/done）、§7.4 收敛（接收顺序 = 顺序基线 = `idle`，迁移序列完全相同）、`lateEvents=1`（有意乱序批次）、`overrideRejected=1`、`recoveredErrors=1`、`unknownEvents=3`（符合 v1.2 §7.3 新语义）。
- **3 处不符均为 v1.2 新增要求**（版本漂移，非作者失误）：`session.start.startedAt`、`session.end.endedAt`、控制帧 `contract`。补齐即可全绿。

### 9.3 schema 与 v1.2 的一致性（task c）

| 检查项 | 结果 |
|---|---|
| schema 自我声明基线 | ❌ 第 5 行写「覆盖契约 **v1.1**」 |
| 4 种控制帧 `$defs` | ✅ 有 `controlFrame` |
| `approval.request.requestId` 必填 | ✅ 有 |
| `agent.status` 五态（无 done/blocked） | ✅ 有 |
| `session.start.startedAt` / `session.end.endedAt` | ❌ grep **0 命中**（v1.2 新增必填未落地） |
| T7 校验器对 fixture 的判定 | ⚠️ `{"knownValid":34,"controlFrames":3,"unknownTypes":3,"malformedLines":0,"invalidKnown":0}` —— 对 v1.2 **假阴性**，发现不了缺 `startedAt`/`endedAt`/`contract` |
| 结论 | schema 需按 v1.2 升级（补 startedAt/endedAt + 控制帧 contract 必填 + 可选 observes）；§4.4/§4.5/§4.7 属语义规则，不应硬塞 JSON Schema |

`@
$ node schema/validate-pet-event.mjs fixtures/contract-sample.pet.jsonl
{"file":"fixtures/contract-sample.pet.jsonl","knownValid":34,"controlFrames":3,"unknownTypes":3,"malformedLines":0,"invalidKnown":0}
`@

### 9.4 v1.1 报告各项的闭环状态（v1.2 基准）

| 项 | 状态 | 依据（实测） |
|---|---|---|
| C-01 计数口径 | 🟡 部分 | 已改口径但改成错误的「14 种 type / 16 行」→ **C-28** |
| C-02 必填标注 | ✅ | §2.3 统一规则；实测立即抓出 fixture 2 处缺字段 |
| C-03 blocked/done | ✅ | §3.4 五态；§4.1 说明 done 为本地过渡态 |
| C-04 45 s vs 10 min | ✅ | §4.4/§4.5 拆分，两条规则均可复现 |
| C-05 审批配对 | ✅ | `requestId` 必填 + `orphanApprovals` |
| C-06 反向通道 | ✅ | §1.6 只读 + §5.4 `canDecide`/`decide` |
| C-07 握手 ack | ✅ | §5.2（3 s ack、重试 2 次、`ok:false`、`resumeAfter`、先判 ctl） |
| C-08 乱序窗口 | ✅ | §2.4 先到者冲刷 + §4.6 迟到规则 |
| C-09 seq 作用域 | ✅ | §2.4 per-`(source,sessionId)` + 去重键 + `backend` 保留值 |
| C-10 心跳无会话 | ✅ | §3.1 `nativeSessionId?`/`sessionCount?` |
| C-11 心跳与超时 | ✅ | §4.5 基准 `lastStateChangeTs`（实测心跳保活下仍 stale） |
| C-12 agent.status 覆盖 | ✅ | §3.4 优先级/force/`overrideRejected` |
| C-13 真值表 | ✅ | §4.2 全表，26 个分支逐一实现 |
| C-14 error 停留 | ✅ | §4.7 TTL + §4.2 时长 |
| C-15 必填口径 | ✅ | §2.3「未标注=必填」 |
| C-16 8 KB 口径 | ❌ | 仍未说明字节/字符与责任方 → **C-30** |
| C-17 录制细节 | 🟡 | docs/10 已用 `<YYYYMMDD>`；契约 §5.1 仍 `<date>` 与「20 MB × 7 天」 |
| C-18 传输细节 | 🟡 | `\\.\pipe\`、lock 单实例已补；权限位未写进契约 |
| C-19 ACP 重复映射 | ❌ | §6 仍把 `session/request_permission` 同时映射到 `approval.*` 与 `user.question` |
| C-20 特效/计数器 | 🟡 | §5.3 快照已含 `counters`；§7.1「5 类特效」仍未枚举 |
| C-21 版本号 | ✅ | 文档头 + §9 |
| C-22 多会话聚合 | ✅ | §4.3 明确取最高优先级（实测） |
| C-23 approval/question 边界 | ✅ | §3.3 边界段 + 配对规则 |
| C-24 data 会话归属 | 🟡 | `backend` 保留值缓解；未禁止非心跳事件 `sessionId=null` |
| C-25 decision 四值有损 | ❌ | 仍 `allow\|deny\|timeout` |
| C-26 控制帧 | ✅ | §2.2 定义 4 种 `ctl`；校验器默认接受 |
| C-27 §3.1 必填与 fixture 不一致 | ✅ | §3.1 去掉重复 `data.source`、心跳字段改可选 |
| X-01 状态机归属 | ✅ | 契约 §4 标题改为「唯一权威：Hub」，与 docs/10 ADR-2 一致 |
| X-02 docs/10 错引 | ✅ | docs/10 §5.1-4 已改引 §4.4 |
| X-03「1.x」次版本策略 | ❌ | docs/10 §6 仍写 `1.x`／适配器声明 `contract: 1`，契约无次版本概念 |
| X-04 目录约定 | 🟡 | `<YYYYMMDD>` 等未回填契约 |
| Y-01 docs/70 Gate 1 | ❌ | docs/70 L42 仍写「45s 内恢复 idle」，与 §4.4 措辞不符 |
| Y-02 docs/70「§7 五条」 | 🟡 | §7 现为 6 条验收 |
| Y-03 / Y-04 | ✅ | 措辞随 X-01；README 已收录本报告 |
| Z-01 docs/50 的 45 s | 🟡 | §1.3 已重写并说明拆分；§11 E2（L574）仍写「45 s 内回 idle」 |
| Z-02 / Z-03 错误语义 | ✅ | docs/50 已按 §4.7 重写（瞬态/持久两态） |
| Z-05 队列语义 | 🟡 | 产品侧规则明确，契约 §4.3 未写「每会话 1 条 pending + droppedTransitions」 |
| Z-09 只读范围 | ✅ | 契约 §1.6/§5.4 与 docs/50 §5.3 一致 |
| W-01 敞口算术 | ✅ | docs/60 已改为「高 8 / 中 13 / 共 21」 |
| W-03 R-17 引用 | 🟡 | 已引 §4，但「45 s 心跳缺失」应为「45 s 无任何帧」 |
| W-04 workspace 截断 | ❌ | 契约未补 `workspacePrivacy` |
| W-05 轮转口径 | ❌ | 随 C-17 |
| V-01 docs/40 ACP 优先级 | ❌ | docs/40 TL;DR（L17）仍 **P1**，§4（L472）仍 **P0-3** |
| V-03 / V-04 / V-05 | ✅ | 16 type 口径、乱序窗口排列规则、`observes` 均已进契约 |
| V-07 三条缺口 | 🟡 | durationMs / agent.status 已闭环；decision 四值未闭环（C-25） |

**统计**：✅ 闭环 26 项、🟡 部分 13 项、❌ 未闭环 7 项（C-16/C-30、C-19、C-25、X-03、Y-01、W-04、V-01 —— 均可在 30 分钟内修完）。

### 9.5 本轮新发现

- **C-28 [P1]**「14 种 type / 16 行」在 v1.2 已失真：实测 §3 表格 **16 行 / 16 个 type 字符串**（v1.2 把 `step.start`/`step.end`、`tool.call`/`tool.result` 拆成独立行）。受影响：契约 §3 标题（L66）、§5.2.1（L196）、§7.1（L247）、§7.3（L250），以及 docs/40 L5/L637、docs/50 头部。建议统一改为「**16 个 type 字符串 / 16 行**」。
- **C-29 [P2]** §4.2「回到登记前状态」缺边界规则：未决期间会话若又发生别的状态变更（实测 fixture seq=20、主样例 seq=25），「登记前状态」可能已被取代，甚至本身是 `transient-error`。我的实现采用保守规则（仅当会话仍停在 `waiting` 才回退，否则保留较新状态并计 `pendingRestoreSkipped`，实测 =1）。建议契约明确该规则，并规定登记时记录**稳定态**。
- **C-30 [P2]** 8 KB 口径（C-16）仍未闭环。
- **交付物层面（非契约缺陷）**：fixture 缺 3 个 v1.2 新增字段；T7 schema 仍按 v1.1 且对 v1.2 假阴性（§9.3）。

### 9.6 docs/20-roadmap.md 与 docs/30-implementation-stack.md 交叉审阅（task-6 收尾项）

| ID | 级别 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| R-01 | **P1** | docs/30 §5 对接表（L278） | 「心跳 15 s / 离线 45 s → **45 s 无任何事件 → 强制 `idle`；10 min 无事件 → 记录 `stale`**」与 v1.2 冲突：§4.4 的 45 s 是「该 **source** 离线并清空其会话/未决，聚合回落到其余 source（**不一定是 idle**）」；§4.5 的基准是 `lastStateChangeTs`（**无状态变化**，心跳不刷新），不是「无事件」 | 改为逐字引用 §4.4/§4.5 的两条措辞 |
| R-02 | P2 | docs/30 §5（L276） | 握手只写「连接后回写 `{"ack":true,"contract":1}`」，缺 v1.2 §5.2 的 `ctl:hello`（含 `observes`/`resumeAfter`）、ack 3 s 超时/重试 2 次、`ok:false` 分支 | 补 v1.2 握手时序 |
| R-03 | P2 | docs/30 §5（L277） | 仍写「契约写的是 `\\?\pipe\...`，**该前缀疑似笔误**，已列入 §8 建议」——v1.2 §5.1 已改为 `\\.\pipe\`，注记已过期 | 改为「v1.2 已修正」 |
| R-04 | **P1** | docs/20 §2.3-M5（L156）、docs/70 L42 | Gate1 验收仍写「`kill -9` … **45 s 内回 idle**」；同一份 docs/20 的 L107/L119 已用正确措辞「45 s 内 source 离线、聚合回落」→ **同文档自相矛盾**，且与 §4.4 不符（若另一 source 在 waiting，聚合不会是 idle） | 三处统一为 §4.4 措辞 |
| R-05 | P2 | docs/20 L94/L224/L530 | 仍写「16 行 / 14 种 type」（C-28 残留，见 §9.7） | 统一为「16 个 type 字符串 / 16 行」 |
| R-06 | P2 | docs/20 §8（L620） | 把 `degradedSources`、`noop` 计数器列为「契约 v1.2 的**下一次修订候选**」，但 v1.2 §5.3/§7.3 已定义 | 从候选清单移除或标注「v1.2 已落地」 |

**通过项（抽样复核）**：
- docs/30 的内存口径是全仓最扎实的一处：明确区分 RSS 与 `phys_footprint`、给出三栈实测区间与波动、建议「验收用 `phys_footprint` 合计 + 记录 RSS 参考」——docs/20 §3.3、docs/70 已采纳 ✅
- docs/30 有 17 处「未验证/未核验」标注且各带验证方法；docs/20 有 19 处【估算】/【假设】标注，未发现「把推测写成实测」✅
- docs/20 的三个锚点（M2 截止 W5、SDK 冻结 W14、Gate1 W8）与 docs/70 的 Gate 定义一致 ✅
### 9.7 C-28 修复残留（grep 复核，Lead 已修一部分）

Lead 已把契约 §3/§5.2.1/§7.1/§7.3 与 CHANGELOG 等改为「16 个 type 字符串 / 16 行」（`grep -rln '16 个 type 字符串'` 命中 5 个文件）。**但以下位置仍是旧口径**（`grep -rn '14 种'` 实测）：

| 文件 | 行 | 残留文本 |
|---|---|---|
| docs/20-roadmap.md | 94、224、530 | 「16 行 / 14 种 type」 |
| docs/35-dsh-pet-bridge.md | 353 | 「16 行 / 14 种 type」 |
| docs/40-adapters.md | 5、637 | 「16 行/14 种 type」「14 种 type / 16 行」 |
| docs/60-risk-register.md | 240 | 「§3 统一『14 种 type / 16 行』计数」 |
| docs/90-research-notes.md | 183 | 「覆盖 14 种 type / 16 行」 |
| README.md | 17、26、43 | 「14 种 type / 16 行」「14 种 type」 |
| schema/pet-event.schema.json | 5、133 | 「§3 的 14 种 type / 16 行」「（14 种 type）」 |
| scripts/check-fixtures.mjs | 10、31、325 | 「16 个 type 字符串 = 14 种 type / 16 行」 |

> 复现：`grep -rn '14 种' docs/*.md README.md schema/ scripts/ | grep -v 99-verification-report`（共 10 处，跨 8 个文件）
> 其中 schema 与 check-fixtures 的文案属于 task-10/task-11 范围；其余为文档残留。

### 9.8 三态闭环清单（供 Lead 汇总）

**A. 已闭环（30 项：v1.2 采纳且我用独立实现实测通过）**
C-02 必填规则、C-03 状态枚举、C-04 双超时拆分、C-05 requestId 配对、C-06 只读范围、C-07 握手/续传、C-08 乱序窗口、C-09 seq 作用域、C-10 心跳字段、C-11 心跳与超时、C-12 agent.status 覆盖、C-13 真值表、C-14 error 时长、C-15 必填口径、C-21 版本号、C-22 多会话聚合、C-23 approval/question 边界、C-26 控制帧、C-27 §3.1 必填、X-01 状态机归属、X-02 docs/10 错引、Y-03、Y-04、Z-02、Z-03、Z-09、W-01、V-03、V-04、V-05。

**B1. 队友进行中（task-10 / task-11，Lead 已派单）**

| 项 | 任务 | 内容 |
|---|---|---|
| fixture 3 处 | task-10（队友 C） | `session.start.startedAt`（L3）、`snapshot.contract`（L12）、`session.end.endedAt`（L37） |
| check-fixtures 文案 | task-10（队友 C） | 两处「契约 v1.1」版本标签（P2；Lead 实测 exit 0） |
| C-19 | task-10（队友 C） | §6 把 ACP `session/request_permission` 同时映射到 `approval.*` 与 `user.question` |
| C-25 | task-10（队友 C） | `decision` 三值对 DSH 四值（allowed-once/rejected/cancelled/unavailable）有损 |
| V-01 | task-10（队友 C） | docs/40 TL;DR（L17）写 ACP=**P1**，§4（L472）写 **P0-3**，自相矛盾 |
| schema + validator | task-11（队友 D） | 补 `startedAt`/`endedAt` 必填、控制帧 `contract` 必填、可选 `observes`；消除对 v1.2 的假阴性 |

**B2. Lead 已修 / 即将修 → 待我复验（4 项）**
C-28 计数口径（契约/35/40/50/90/20/60/CHANGELOG → 仍余 10 处，见 §9.7）、C-16/C-30（8 KB 口径，即将补入契约）、X-03（docs/10 §6 次版本策略改为「契约只有主版本」）、Y-01（docs/70 Gate1 改为「45 s 标记离线 + 聚合回落」）。

**C. 仍未闭环（无归属，需 Lead 指派；均不阻塞开发）**

| 项 | 级别 | 内容 |
|---|---|---|
| C-28 残留 | P1 | 8 个文件 10 处旧口径（§9.7） |
| R-01 | P1 | docs/30 L278 超时措辞与 §4.4/§4.5 冲突（实现者会照抄） |
| R-04 | P1 | docs/20 L156 + docs/70 L42 的「45 s 内回 idle」（与同文档 L107/L119 矛盾） |
| C-17 / W-05 | P2 | 契约 §5.1 录制 `<date>` 格式与「20 MB × 7 天」口径未定义 |
| C-18 | P2 | socket/目录权限位、陈旧 socket 清理未写进契约 |
| C-20 | P2 | §7.1「5 类特效」仍未枚举 |
| C-24 | P2 | 未禁止非心跳事件 `sessionId=null` |
| C-29 | P2 | 「回到登记前状态」在未决期间会话已变化时的规则 |
| C-31 | P2 | §5.3 `sessions[]` 字段「全部可选」vs §8「Hub 保证可渲染」 |
| R-02/R-03/R-05/R-06 | P2 | docs/30 握手/Windows 注记；docs/20 旧计数与修订候选清单 |
| X-04、W-03、W-04、Y-02、Z-01 尾巴、Z-05、V-07(部分) | P2 | 见 §9.4 明细 |
## 10. 结论：能否进入开发？

### 10.1 最终验收判定（task-6 完成时）

**结论：可以进入 Phase 1 开发（M1 可立即启动）。**

- task-6 的全部验收项已完成：fixture 全量校验（§3.6/§9.2）、独立状态机消费者与真值表复验（§3/§9.1）、契约审阅（§2）、交叉审阅 docs/10/20/30/35/40/50/51/60/70/README/CHANGELOG（§4/§9.6）、schema 与 T3/T7 工具交叉校验（§3.7/§9.3）。
- 4 个 v1.1 契约 P0 全部闭环并有实测证据；30 项已闭环、6 项在 task-10/11 修（队友进行中）、4 项 Lead 已修待复验、其余为 P2 文档级（§9.8 三态清单）。
- **不阻塞开发的项**：C-28 残留 10 处旧计数口径、R-01/R-04 两处超时措辞、C-17/C-18/C-20/C-24/C-29/C-31 等契约细节。
- **唯一需要在 M1 内闭环的工程项**：task-10（fixture 3 字段 + check-fixtures 版本标签 + C-19/C-25/V-01）与 task-11（schema 升 v1.2）；完成后由我复验一次即可转「全绿」。

### 10.2 v1.2 之后的历史结论（第二轮）

**可以进入 Phase 1 开发。** 依据：

1. v1.1 报告指出的 4 个契约 P0（C-04/C-05/C-06/C-26）在 v1.2 中全部闭环，且我用独立实现逐条复验通过（§9.1：26 个真值表分支 + 11 条负例）。
2. 跨文档 P0（X-01 状态机归属、X-02 错引、Z-01 的 45 s 口径）均已闭环；docs/50、docs/60 已按 v1.2 语义重写。
3. 剩余风险都是**文档级、可在 M1 期间消化**：7 项未闭环（C-16/C-30 8 KB 口径、C-19 ACP 重复映射、C-25 decision 四值、X-03 次版本策略、Y-01 docs/70 Gate 1 措辞、W-04 workspace 截断、V-01 docs/40 ACP 优先级）+ 新增 C-28（「14 种/16 行」计数失真，实际 16 行 / 16 type）。
4. 两处**交付物**待跟进（非契约缺陷）：fixture 缺 3 个 v1.2 新增字段（startedAt/endedAt/控制帧 contract）；T7 的 schema 仍按 v1.1 且对 v1.2 假阴性（§9.3）。
5. 进入 M1 的**前置条件**（建议作为 M1 第一周的 DoD）：修完 C-28 + 补 fixture 3 字段 + schema 升到 v1.2，这三件事都是小时级。

### 10.2 v1.1 基准的历史结论（保留追溯）

**当时不建议进入 Phase 1 编码**，理由：
**当前不建议进入 Phase 1 编码**，理由：

1. 契约自身 **4 个 P0**：**C-04** 让 §7.2 这条验收标准按现文本必然失败（且已蔓延成 4 种口径：契约 §7.2、docs/50 §1.3、docs/60 R-17、docs/70 Gate 1）；**C-05** 让审批关联在多并发下必然错配（fixture 已自行改用 `requestId`）；**C-06** 决定 M1 是否包含「在桌宠上回话」（docs/50 §5.3 已给出「Phase 1 只读」的产品答案，需回填契约）；**C-26** 让「按契约实现」与「按黄金 fixture 验收」互相矛盾（我的 strict 校验 exit=1 vs T7 的 controlFrames 全绿）。
2. 跨文档 **2 个 P0**：**X-01** 决定状态机归属（Hub vs 渲染层）——直接改变包结构与 §4 全部「渲染层」措辞；**X-02** 错引 §3.4 放大 C-04。**Z-01** 表明该矛盾已经进入 Gate 定义，不修则 Gate 1 无法通过。
3. **C-01/C-02/C-24/C-27** 让 fixture 与 JSON Schema 的验收口径无法判定（T3/T7 都已按 16 实现，只需改契约文本）；属于「先修 30 分钟、后省两天返工」。
4. 建议修复顺序：**C-26 → C-04 → C-05 → C-06 → X-01/X-02 → C-01 → C-02 → C-24 → C-07/C-08/C-09 → 其余 P1 → P2**。
5. 修完 4 个契约 P0 + X-01/X-02 + C-01/C-02 后即可进入 M1；其余 P1 可在 M1 期间随实现补齐（但必须在「适配器 SDK 冻结」前全部收敛）。
6. **正面结论**：契约的骨架（信封、§4 优先级与聚合、§7 验收）是可用且可独立实现的——独立实现的三方（我、T3、T7）在 16 个 type、未知事件计数、乱序收敛、fixture 事件帧校验上结论完全一致；本轮所有 P0 都是「文本与文本 / 文本与实现」的不一致，而非设计不可行。

---

### 变更记录

| 时间 | 内容 |
|---|---|
| 2026-10-05（本轮） | 建立报告；完成契约审阅（C-01…C-23）、`docs/10` 交叉审阅（X-01…X-04）、独立校验器与状态机消费者自测证据；记录 7 项未验证与阻塞 |
| 2026-10-05（第二次增量） | 补：fixture 全量校验（§3.6）、T7 schema 交叉校验（§3.7）、`docs/40/50/60` 交叉审阅（§4.3–§4.5）、契约新增 C-24/C-25、外部 [实测] 抽样复核、已通过项 P-10…P-12、未验证项与阻塞刷新 |
| 2026-10-05（第五次增量，task-6 完成） | claim task-6（rev4）；补 **docs/20、docs/30 交叉审阅**（§9.6，新增 R-01…R-06）、**C-28 残留 grep 复核**（§9.7，8 文件 10 处）、**三态闭环清单**（§9.8）；结论定为「可进入开发」；新增 C-31 |
| 2026-10-05（第四次增量，12:3x，**v1.2 复验**） | `@scripts/replay-check.mjs`@ 按 v1.2 重写并加分支专项自测；新增 **§9 契约 v1.2 复验**（真值表分支表、fixture、schema、**闭环状态表**、新发现 C-28/C-29/C-30）；结论更新为「可以进入开发」 |
| 2026-10-05（第三次增量，12:24） | T3 于 12:21 更新 fixture（+3 控制帧、`requestId` 关联、后端级心跳、per-session seq）：新增 **C-26 [P0]**（控制帧未定义，两个独立校验器判定分歧）与 **C-27 [P1]**（§3.1 必填标注与 fixture 不一致）；新增 §3.6.1、P-13；TL;DR 与结论刷新为 4 P0 / 16 P1 / 7 P2 |
