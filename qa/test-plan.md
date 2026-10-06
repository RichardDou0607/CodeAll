# QA · MVP 测试计划（工作框 + 契约 v1.2）

> 负责人：队友 B（product-experience）｜任务：task-9｜状态：**DRAFT v0.1**（2026-10-05）
> 输入基线：契约 [`docs/00-interface-contract.md`](../docs/00-interface-contract.md)（FROZEN **v1.2**）、架构 [`docs/10-architecture.md`](../docs/10-architecture.md)（DRAFT v0.9）、实现栈 [`docs/30`](../docs/30-implementation-stack.md)（占位）、适配矩阵 [`docs/40`](../docs/40-adapters.md)（DRAFT v1）、产品规格 [`docs/50-product-spec.md`](../docs/50-product-spec.md) §11（47 条）、工作框规格 [`docs/51-work-frame-spec.md`](../docs/51-work-frame-spec.md) §7（27 条）、团队角色 [`docs/70`](../docs/70-team-and-metrics.md)、独立验收 [`docs/99`](../docs/99-verification-report.md)。
> 目标：把 **27 + 47 = 74 条验收**合并去重成 **70 条可执行用例**，标注「现在就能自动验证 / 实现后可自动 / 必须手工」，并给出 CI 门禁。
> 本文只写 `qa/test-plan.md`，不修改任何他人文件；引用一律用相对链接。

---

## 0. 现状：今天就能跑的东西（2026-10-05 本机实测）

| 资产 | 路径 | 用途 |
|---|---|---|
| 契约样例 | [`fixtures/contract-sample.pet.jsonl`](../fixtures/contract-sample.pet.jsonl) | 40 行（37 事件 + 3 控制帧），覆盖 16/16 type、6 状态、3 条未知 type |
| 帧校验 | [`scripts/check-fixtures.mjs`](../scripts/check-fixtures.mjs) | 信封必填、≤8 KB、seq 稠密、配对、状态机回放（契约 v1.1 口径） |
| 独立校验+状态机消费者 | [`scripts/replay-check.mjs`](../scripts/replay-check.mjs) | 契约 **v1.2**：控制帧、`requestId` 配对、瞬态/持久 TTL、45 s 离线、10 min stale、迟到不倒退、`noop` |
| JSON Schema 校验器 | [`schema/validate-pet-event.mjs`](../schema/validate-pet-event.mjs) + [`schema/pet-event.schema.json`](../schema/pet-event.schema.json) | 逐行 schema 校验 + `--self-test` |
| 假适配器 | [`spikes/jsonl-feed/feed.mjs`](../spikes/jsonl-feed/feed.mjs) | 经 Unix socket 注入事件（`--socket`/`--scenario demo|unknown-storm`/`--count`/`--gap`/`--record`） |
| 外壳 spike | [`spikes/swift-appkit-pet/`](../spikes/swift-appkit-pet/)、[`spikes/tauri-pet/`](../spikes/tauri-pet/)、[`spikes/electron-pet/`](../spikes/electron-pet/) | 透明/置顶/穿透/socket 四硬需求的既有实现与 run 脚本 |
| 核对工具 | [`spikes/tools/`](../spikes/tools/) | `wininfo`（CGWindowList：layer/alpha/onscreen）、`pixelprobe`（PNG 像素 RGBA）、`tree-rss.mjs`（进程树 RSS）、`footprint-sum.sh`（phys_footprint） |

**实测命令与结果（可直接复现，退出码 0）**

```bash
cd "/Users/demo/Desktop/agent桌宠"
node scripts/check-fixtures.mjs                       # ✓ 全部检查通过（契约 v1.1）
node scripts/replay-check.mjs --selftest              # 16 type + v1.2 分支 + 11 条负例全部符合预期
node scripts/replay-check.mjs fixtures/contract-sample.pet.jsonl
node schema/validate-pet-event.mjs --self-test        # self-test OK（16 type + 4 种控制帧）
node schema/validate-pet-event.mjs fixtures/contract-sample.pet.jsonl
```

输出要点（原文摘录）：
- `check-fixtures`：`规范 type 覆盖 16/16 | 全部覆盖（16 个 type 字符串 / 16 行）`、`未知 type 事件 3 条`、`聚合覆盖状态=[idle, thinking, working, waiting, done, error]`。
- `validate-pet-event`：`{"knownValid":34,"controlFrames":3,"unknownTypes":3,"malformedLines":0,"invalidKnown":0}`。
- `replay-check --selftest` 负例全部拒绝：缺 `data`、`seq` 字符串、缺 `sessionId`、`v=2`、>8 KB（9161 B）、`approval.request` 缺 `requestId`、`tool.call` 缺 `risk`、`turn.end.status=done`、`agent.status=done`、未知 `ctl`。
- 本机可用工具：`/usr/bin/footprint`、`/usr/bin/jq`、`/usr/sbin/tcpdump`、`/usr/bin/swiftc`、`node v24.18.0`。

---

## 1. 用例标签与 CI 阶段

| 标签 | 含义 | 能否今天跑 |
|---|---|---|
| **A** 现在可自动 | 用现有 fixture/脚本即可判定，无需 Hub/外壳 | ✅ 是 |
| **B** 实现后可自动 | 需要 Hub/外壳（或 mock 服务端）就绪；断言已写明 | ⏳ 待实现 |
| **M** 手工 | 依赖系统权限、真实进程、像素取色、听觉或人类判断 | ⏳ 手工脚本见 §4 |
| **N** 长跑/风暴 | nightly 或发布前跑 | ⏳ nightly |

CI 三档：**PR（每次提交）** = A 类 + 静态门禁；**Nightly** = A + N + B 中已实现部分；**Release** = 全量 + M 清单。

> **措辞统一（Lead 裁决，2026-10-05）**：离线一律写「**45 s 标记该 source 离线 + 聚合回落**」（契约 §4.4），**不得**写「45 s 回 idle」；`idle` 只用于**会话级**回落（如 `turn.end(aborted)`、R2 清理）。

---

## 2. 用例矩阵（70 条）

> 表列含义：**ID | 用例与期望结果 | 来源（可追溯编号） | 标签 | 依赖 / 命令**。详细步骤只在 §3（UI 注入）与 §4（手工）展开。

### 2.1 契约与适配器（T-01 ~ T-12）

| ID | 用例与期望结果 | 来源 | 标签 | 依赖 / 命令 |
|---|---|---|---|---|
| T-01 | 离线回放 `contract-sample` 复现 **6 状态 + 16/16 type**；聚合覆盖 = `[idle, thinking, working, waiting, done, error]` | §11-A1、A6 | **A** | `node scripts/replay-check.mjs fixtures/contract-sample.pet.jsonl` |
| T-02 | 每一行通过 schema 校验；`invalidKnown=0`、`malformedLines=0` | §11-A6 | **A** | `node schema/validate-pet-event.mjs fixtures/contract-sample.pet.jsonl` |
| T-03 | 单事件 >8 KB 被拒绝并显示字节数；`summary/text` 截断时 `privacy.fields` 标注 | §11-A5 | **A** | `replay-check --selftest` 负例（已含 9161 B） |
| T-04 | 注入 1000 条未知 `type`：`unknownEvents=1000`、无异常、RSS 漂移 <5% | §11-A3 | **A**（RSS 部分 **N**） | `./spikes/swift-appkit-pet/run-spike.sh unknown-storm`；正式版：`feed.mjs --scenario unknown-storm --count 1000` |
| T-05 | 窗口内乱序收敛一致；跨窗口迟到计 `lateEvents` 且**状态不倒退** | §11-A4 | **A** | `replay-check --selftest`（§4.6 已覆盖） |
| T-06 | `approval.resolved` 无配对 → `orphanApprovals+1` 且状态不变（严禁 FIFO 猜测） | §11-A7 | **A** | `replay-check` 负例 + `fixtures/qa/orphan-approval.pet.jsonl`（§3 模板） |
| T-07 | 只有心跳的会话：45 s **不**判离线；10 min **必**被 `stale` 清理（心跳不刷新 `lastStateChangeTs`） | §11-A8、B7 | **A** | `replay-check --selftest`（§4.5 已覆盖） |
| T-08 | `agent.status` 覆盖规则：低优先级不改 `waiting`（`overrideRejected+1`）、`force=true` 生效、>10 s 失效 | §11-A9 | **A** | `replay-check fixtures/contract-sample.pet.jsonl`（`overrideRejected=1`） |
| T-09 | 握手：`ctl:hello{contract:1,resumeAfter}` → 3 s 内 `ctl:ack{ok:true,canDecide:false}`；`ok:false` 时适配器停发并以非 0 退出 | §11-A10 | **B** | 需 Hub 或 mock ack 服务端（建议 `qa/mock-hub.mjs`，见 §5） |
| T-10 | `observes` 缺族 → 对应指标**隐藏**（无 0/空白占位），且原因可查 | §51 §3.4 | **B** | 注入 `hello.observes=["turn.*","tool.*"]`（§3 CASE-UI-6） |
| T-11 | `kill -9` 后端 → **45 s 标记该 source 离线 + 聚合回落**（契约 §4.4），会话与未决清空，UI 无残留「忙碌」 | §11-A2 | **B/M** | 逻辑时间可用 `replay-check` 验证；真实进程见 §4-M2 |
| T-12 | 瞬态错误 TTL 2 s（`tool.result(error)`/`step.end(error)`）与持久错误（`turn.end(error)`）分支正确；同会话 60 s 内 3 次瞬态 → 升级 `escalatedErrors` | §11-B 新增分支、[§51 WF-15/16](../docs/51-work-frame-spec.md) | **A** | `replay-check`（§4.7 已覆盖 transient/持久/升级） |

### 2.2 状态机 / Hub（T-13 ~ T-20）

| ID | 用例与期望结果 | 来源 | 标签 | 依赖 / 命令 |
|---|---|---|---|---|
| T-13 | `waiting` 期间 `tool.result(error)`、`error.raised(fatal=false)` 不改变全局状态；`fatal=true` 例外 | §11-B1 | **A** | `replay-check fixtures/contract-sample.pet.jsonl` |
| T-14 | `waiting` 期间低优先级事件不改变全局状态（快照 `agg` 断言） | §11-B2 | **B** | 需 Hub 快照流 |
| T-15 | R2 清理后会话回 `idle`、`stale=1`，且**留痕三条**生效（菜单栏琥珀计数 / 面板列出被清理项含 `requestId` / 默认通知） | §11-B3 | **B+M** | 快照断言 + 菜单栏/通知人工确认（§4-M3） |
| T-16 | `turn.start` 后 300 ms 内 `step.start` 只产生**一次**可见切换（渲染层防抖，不改 Hub 状态） | §11-B4 | **B** | stateLog 计数 = 1 |
| T-17 | 两会话（working + waiting）→ 聚合 `waiting`；徽标 2 个且 waiting 置顶 | §11-B5 | **B** | §3 CASE-UI-3 |
| T-18 | `done` 停 2 s → `idle`；`approval timeout` 1.5 s → 回登记前状态；`turn.end(error)` **常驻** | §11-B6 | **A**（逻辑）/**B**（计时） | `replay-check`；UI 计时用逻辑时钟回放 |
| T-19 | `turn.end(aborted)` 会话级例外：该行回 `idle`，**不打断**其他会话 `waiting` | §51 WF-22、契约 §4.2 | **B** | §3 CASE-UI-5 |
| T-20 | `clearedPending` 在 UI 可见（脚注「已清理 N」→ 待办页含 `requestId`/时刻/原因），不静默 | §11-B3、§51 §3.3 | **B** | 快照含 `clearedPending` + UI 断言 |

### 2.3 工作框 UI（T-21 ~ T-34）

| ID | 用例与期望结果 | 来源 | 标签 | 依赖 / 命令 |
|---|---|---|---|---|
| T-21 | 首行 40 px 内四项可读（聚合状态 / 动作 / 计时 / `⏳N`）；AX 树 4 个文本节点 | §51 WF-01、WF-02 | **B+M** | §3 CASE-UI-1；AX 树断言（§4-M1 工具） |
| T-22 | 会话行 28 px 内读出「会话标识 + 状态（+计时/最近动作）」；AX 每行 ≥2 节点 | §51 WF-06 | **B** | §3 CASE-UI-3 |
| T-23 | 高度公式：N=0→40；N=1..5→68/96/124/152/180（±1 px）；N>5 不再增长且出现 `+N` 脚注 | §51 WF-04/07/08/09/10 | **B+M** | §3 CASE-UI-2（像素/窗口 bounds 断言） |
| T-24 | 贴底边新增会话时**向上增长**且不越出屏幕；贴边侧不动 | §51 WF-11 | **M** | §4-M4 |
| T-25 | `now=null` → `—`（非 00:00）；`21000→00:21`、`3723000→1:02:03`；离线时冻结并标「已冻结」 | §51 WF-05/12/13 | **A**（格式化单测）/**B**（UI） | 纯函数单测 + §3 CASE-UI-1 |
| T-26 | 离线后该 source 会话行灰化、计时冻结、出现角标（含后端名） | §51 WF-17、§50 §3.5 | **B** | §3 CASE-UI-4 |
| T-27 | **零推断代码审计**：渲染层不出现 `Date.now()`/`performance.now()` 做时长计算 | §51 WF-14 | **A** | `grep -rnE "Date\.now\(\)\|performance\.now\(\)" apps/ packages/frame`（门禁见 §5.1） |
| T-28 | 瞬态错误**黄**闪 2 s 后回上一稳定状态；持久错误**红**常驻直到成功/清理 | §51 WF-15/16 | **B+M** | 逻辑：`replay-check`；视觉：取色（§4-M5） |
| T-29 | `degradedSources` 非空 → 「降级」琥珀角标；`offlineSources` → 「离线」斜纹角标；两者不混淆 | §51 WF-18、§50 §3.5 | **B** | 注入含 `degradedSources` 的快照 |
| T-30 | 勿扰「完全静默」下：气泡/声音被抑制，但首行四项 + 会话行 + 角标照常 | §11-C6、§51 WF-19 | **B+M** | 快照 + 截图；声音人工 |
| T-31 | 连续 10 条 `message.assistant`：气泡节流 ≥1.5 s/次且同时仅 1 条 | §11-C4 | **B** | 时间戳断言 |
| T-32 | 审批强提醒序列（气泡→置顶→抖动→声音→菜单栏琥珀→30 s 重提醒 ×3）；**卡片无 allow/deny 控件**；`resolved` 后消失 | §11-C5、§51 §2.6 | **B+M** | 无控件断言可自动；声音/抖动人工 |
| T-33 | 夜间窗口（23:00–08:00）气泡不弹、声音关、帧率 ≤6 fps；窗口结束弹唤醒摘要 | §11-C7 | **B+M** | 注入时钟（不改系统时间，用可注入的 `now()` 接口） |
| T-34 | 形态切换（卡片⇄窄条⇄宠物）**不重连 Hub**：socket 连接数与快照 `ts` 连续、切换 <100 ms | §51 WF-21 | **B** | Hub 日志断言 |

### 2.4 交互与外壳（T-35 ~ T-44）

| ID | 用例与期望结果 | 来源 | 标签 | 依赖 / 命令 |
|---|---|---|---|---|
| T-35 | 拖拽 100 次全部落在可视区；吸边误差 ≤4 px | §11-C1 | **M/B** | §4-M4（自动化可用 UI 驱动脚本，Phase 2） |
| T-36 | 点击穿透：底层窗口收到点击；`⌥⌘P` 可恢复；菜单栏显示「穿透中」 | §11-C2 | **M** | §4-M6（spike 已证明可设，见 [spikes/README](../spikes/README.md)） |
| T-37 | 右键菜单项齐全且逐项无崩溃 ⚠️**项数待统一**：§50 §2.4 写 12 项、[§51 §4.4](../docs/51-work-frame-spec.md) 写 15 项 | §11-C3、§51 §4.4 | **M** | §4-M7；冲突见 §6.2 |
| T-38 | 前台全屏 → 自动收为窄条（四项仍可读）+ 静音；退出 1 s 内恢复 | §11-C8、§51 WF-24 | **M** | §4-M8 |
| T-39 | 多屏拔插/分辨率变化 500 ms 内重定位且完整可见 | §50 §2.9、§51 WF-23 | **M** | §4-M9 |
| T-40 | 刘海/菜单栏避让：顶部不吸附、不覆盖菜单栏图标区 | §51 §4.1 | **M** | §4-M10 |
| T-41 | 快捷键全表在「有/无辅助功能权限」下均不崩溃且提示明确 | §50 §2.7 | **M** | §4-M11 |
| T-42 | 锁定位置后不可拖动；解锁恢复；位置/形态/宠物图层状态重启后一致 | §51 WF-23 | **M** | §4-M12 |
| T-43 | 外壳崩溃 5 s 内自动重启，且不影响 agent（`kill -9` 外壳） | §11-E1 | **M** | §4-M13 |
| T-44 | DSH 被杀/重启：**45 s 标记该 source 离线 + 聚合回落**（契约 §4.4）；DSH 重启后自动重连 socket | §11-E2 | **M/B** | §4-M13 |

### 2.5 性能与长跑（T-45 ~ T-50）

| ID | 用例与期望结果 | 来源 | 标签 | 依赖 / 命令 |
|---|---|---|---|---|
| T-45 | 空闲 5 min：内存 ≤150 MB、CPU ≤1%（中位数） | §11-D1、§51 WF-21 | **A**（工具已备）/**N** | `node spikes/tools/tree-rss.mjs <pid>`、`./spikes/tools/footprint-sum.sh pet <pid>` |
| T-46 | 工作框运行前后 DSH 首字响应差值 <100 ms（各 10 次均值） | §11-D2 | **M** | §4-M14 |
| T-47 | 动画播放 GPU <10%，静态帧接近 0 | §11-D3 | **M** | Activity Monitor（§4-M15） |
| T-48 | 1 h / 24 h 常驻：RSS 漂移 <5%（长跑）/ <10%（24 h），无句柄泄漏 | §11-D4、§51 WF-21 | **N** | 定时采样 `tree-rss.mjs` 写 CSV |
| T-49 | 事件风暴：10k 事件/60 s 不丢帧、`duplicates`/`lateEvents` 计数正确、RSS 漂移 <5% | §11-A3 扩展 | **N** | `feed.mjs --count 10000`（正式版支持 `--rate`） |
| T-50 | 端到端时延 P95 ≤200 ms（后端写事件 → 首帧） | [docs/10](../docs/10-architecture.md) §5.2 | **B/N** | 录制时间戳对比脚本 |

### 2.6 隐私与合规（T-51 ~ T-55）

| ID | 用例与期望结果 | 来源 | 标签 | 依赖 / 命令 |
|---|---|---|---|---|
| T-51 | 默认配置 24 h **0 出网**；首启引导全程 0 外连 | §11-F1、E5 | **M/N** | `sudo tcpdump -i any -n 'not host 127.0.0.1'`（§4-M16） |
| T-52 | 录制文件 `0600`、`~/.agent-pet` 与 socket 目录 `0700`、socket `0600` | §11-F2 | **A** | `stat -f "%Sp %N" ~/.agent-pet ~/.agent-pet/records/* "$TMPDIR"/agent-pet/*` |
| T-53 | fixture 与真实录制敏感信息正则扫描 0 命中（`sk-`/`ghp_`/`AKIA`/绝对路径/token） | §11-F3 | **A** | 新增 `qa/scan-secrets.sh`（草案见 §5） |
| T-54 | 一键清除后 `records` 为空且面板无历史 | §11-F4 | **B** | UI + 文件系统断言 |
| T-55 | 遥测关闭时零 payload；开启时可预览并可导出「我发送过的数据」 | §11-F5 | **B+M** | 抓包 + UI |

### 2.7 可访问性与国际化（T-56 ~ T-59）

| ID | 用例与期望结果 | 来源 | 标签 | 依赖 / 命令 |
|---|---|---|---|---|
| T-56 | 「减弱动态效果」开启后无位移/抖动（仅透明度），瞬态错误变静态黄 2 s | §11-G1、§51 §4.8 | **M** | §4-M17 |
| T-57 | VoiceOver 朗读「工作中，npm test，已用 2 分 14 秒，1 个待确认」 | §11-G2、§51 WF-20 | **M** | §4-M18 |
| T-58 | zh-CN / en 切换无残留 key；缺键回退 en | §11-G3 | **A** | 文案表 JSON 键集合对比脚本（0 缺键、0 未用键） |
| T-59 | `Tab` 可遍历框内 4 类交互元素，焦点环 2 px 高对比 | §51 WF-20 | **M** | §4-M19 |

### 2.8 资产与宠物层（T-60 ~ T-66）

> **裁决（2026-10-05，Lead）**：**T-60..T-64（§11-H1..H5）不阻塞 M2**，随宠物层一起移入 **M3（皮肤包 v1）** 里程碑，标签记为「**M3 前**」。T-65/T-66 属于工作框本身（关闭宠物层回归、Retina/更大文本），仍属 M2。

| ID | 用例与期望结果 | 来源 | 标签 | 依赖 / 命令 |
|---|---|---|---|---|
| T-60 | `agent-pet asset check` 内置皮肤退出码 0；缺 `wait` clip 的包 ≠0 并指出缺失项 | §11-H1、§50 §3.4 | **B**（M3 前） | 需实现 CLI（脚本可先行，见 §5） |
| T-61 | 含 `.js/.sh/.command` 的皮肤包被拒绝安装并提示 | §11-H2 | **B**（M3 前） | 单测 + UI |
| T-62 | 12 个必填 clip 存在、帧号 000 连续、单 clip ≤1.5 MB、整皮肤 ≤12 MB | §11-H3 | **B**（M3 前） | `asset check` 断言 |
| T-63 | 切换皮肤后常驻内存回落 ±10 MB；全部 clip 解码 ≤80 MB | §11-H4 | **B/N**（M3 前） | `footprint-sum.sh` |
| T-64 | 深色桌面（#111）截图取色：描边对比度 ≥3:1；文字对比度 ≥4.5:1 | §11-H5、§51 WF-20 | **M**（M3 前） | `pixelprobe`（§4-M5） |
| T-65 | **关闭宠物层后信息不缺失**：首行四项 + 会话行 + 角标 + 菜单/快捷键全部可用 | §51 WF-25 | **B/M** | 回归用例 |
| T-66 | Retina 1×/2×/3× 下 CSS px 布局一致、描边不虚、无位图文字；更大文本 12→14 px 时高度按常量放大 | §51 WF-03/26 | **M** | §4-M20 |

### 2.9 安装、卸载与引导（T-67 ~ T-70）

| ID | 用例与期望结果 | 来源 | 标签 | 依赖 / 命令 |
|---|---|---|---|---|
| T-67 | 适配器安装：写 hooks 前备份 + diff 确认 + 幂等（跑 2 次结果同）+ 回滚后与原文件 `shasum` 一致 | §11-E3 | **B** | 需 CLI |
| T-68 | 卸载：无残留 LaunchAgent/socket，agent 配置已回滚；`~/.agent-pet` 由用户选择 | §11-E4 | **B/M** | `launchctl list \| grep -i pet`、`ls "$TMPDIR"/agent-pet` |
| T-69 | 开机自启开关生效且关闭后不残留 LaunchAgent | §50 §2.8 | **M** | §4-M21 |
| T-70 | 首启引导 ≤90 s 可完成、可跳过；第 3 步展示 hooks diff；第 4 步演示回放不触发真实 agent | §11-E5 | **M** | §4-M22 |

---

## 3. fixture 注入驱动 UI 的 6 个用例（重点）

> 通用前提：外壳支持 `--replay <file.pet.jsonl>`（或 `PET_SPIKE_SOCKET` + `feed.mjs`）。**回放时间基准 = fixture 的 `ts` 字段（逻辑时钟）**，断言全部基于逻辑时间，避免等待真实 45 s/10 min；真实时间路径另做一次（§4-M2）。
> 现状：逻辑层**今天就能验证**（`replay-check.mjs`）；UI 层需要外壳实现后跑同一份 fixture。下面给出可直接落盘的 fixture 行。

### CASE-UI-1（T-21 / T-25 / T-32）审批进入 waiting + 无 allow/deny 控件

```jsonl
{"v":1,"seq":0,"ts":1791172500000,"source":"qa","sessionId":"qa-appr-1","workspace":"/tmp/qa","type":"session.start","data":{"nativeSessionId":"qa-appr-1","startedAt":1791172500000}}
{"v":1,"seq":1,"ts":1791172500500,"source":"qa","sessionId":"qa-appr-1","workspace":"/tmp/qa","type":"turn.start","data":{"turnId":"t1","inputKind":"user"}}
{"v":1,"seq":2,"ts":1791172501000,"source":"qa","sessionId":"qa-appr-1","workspace":"/tmp/qa","type":"tool.call","data":{"callId":"c1","toolName":"run_shell","category":"exec","risk":2,"summary":"rm -rf build"}}
{"v":1,"seq":3,"ts":1791172501500,"source":"qa","sessionId":"qa-appr-1","workspace":"/tmp/qa","type":"approval.request","data":{"requestId":"req-qa-1","kind":"command","summary":"rm -rf build","risk":2,"callId":"c1"}}
{"v":1,"seq":4,"ts":1791172510000,"source":"qa","sessionId":"qa-appr-1","workspace":"/tmp/qa","type":"approval.resolved","data":{"requestId":"req-qa-1","decision":"allow","latencyMs":8500}}
```

- **步骤**：① `node scripts/replay-check.mjs qa/fixtures/approval.pet.jsonl` 先验逻辑；② 外壳 `--replay qa/fixtures/approval.pet.jsonl`；③ 在 `seq=3` 到达后暂停回放（或用 `--pause-on waiting`）。
- **期望**：首行状态文本 = 「等你确认」、`⏳1` 可见、色 = 琥珀、会话行该行状态灯为 waiting；**卡片 DOM/AX 树中不存在 allow/deny 按钮**（断言 `role=button` 且 label 含 allow/deny 的节点数 = 0）；`seq=4` 后 `⏳` 隐藏、状态回 `working`。
- **自动化断言**：AX 树文本节点集合 + `⏳` 计数 + 无按钮断言；无需人工。

### CASE-UI-2（T-23）6 个会话 → 高度 202 px + 「+1 个会话」

```jsonl
{"v":1,"seq":0,"ts":1791172500000,"source":"qa","sessionId":"qa-s1","workspace":"/tmp/qa/proj-a","type":"session.start","data":{"nativeSessionId":"qa-s1","startedAt":1791172500000,"title":"proj-a"}}
{"v":1,"seq":0,"ts":1791172500100,"source":"qa","sessionId":"qa-s2","workspace":"/tmp/qa/proj-b","type":"session.start","data":{"nativeSessionId":"qa-s2","startedAt":1791172500100,"title":"proj-b"}}
{"v":1,"seq":0,"ts":1791172500200,"source":"qa","sessionId":"qa-s3","workspace":"/tmp/qa/proj-c","type":"session.start","data":{"nativeSessionId":"qa-s3","startedAt":1791172500200,"title":"proj-c"}}
{"v":1,"seq":0,"ts":1791172500300,"source":"qa","sessionId":"qa-s4","workspace":"/tmp/qa/proj-d","type":"session.start","data":{"nativeSessionId":"qa-s4","startedAt":1791172500300,"title":"proj-d"}}
{"v":1,"seq":0,"ts":1791172500400,"source":"qa","sessionId":"qa-s5","workspace":"/tmp/qa/proj-e","type":"session.start","data":{"nativeSessionId":"qa-s5","startedAt":1791172500400,"title":"proj-e"}}
{"v":1,"seq":0,"ts":1791172500500,"source":"qa","sessionId":"qa-s6","workspace":"/tmp/qa/proj-f","type":"session.start","data":{"nativeSessionId":"qa-s6","startedAt":1791172500500,"title":"proj-f"}}
```

- **期望**：窗口高度 = **202 CSS px** —— 公式来源为**契约 §8.1**：`height = 40 + 28×min(N,5) + (N>5 ? 22 : 0)`，代入 N=6 得 `40 + 28×5 + 22 = 202`（Retina 2× → 404 物理 px）；可见 5 个会话行 + 脚注 `+1 个会话`；点脚注 → 「全部会话」页列出 6 条。
- **自动化断言**：窗口 bounds 高度（`wininfo`/AX）/ 截图边界像素；脚注文本；列表项数 = 6。
- **变体**：N=0/1/3 → 40/68/124 px（参数化，覆盖 T-23 的高度序列）。

### CASE-UI-3（T-17 / T-22）多会话聚合：一个 waiting 压过 working

```jsonl
{"v":1,"seq":0,"ts":1791172500000,"source":"qa","sessionId":"qa-w1","workspace":"/tmp/qa/api","type":"session.start","data":{"nativeSessionId":"qa-w1","startedAt":1791172500000,"title":"api-fix"}}
{"v":1,"seq":1,"ts":1791172500500,"source":"qa","sessionId":"qa-w1","workspace":"/tmp/qa/api","type":"turn.start","data":{"turnId":"t1","inputKind":"user"}}
{"v":1,"seq":2,"ts":1791172501000,"source":"qa","sessionId":"qa-w1","workspace":"/tmp/qa/api","type":"approval.request","data":{"requestId":"req-qa-2","kind":"permission","summary":"读取 ~/.ssh 下的文件","risk":3}}
{"v":1,"seq":0,"ts":1791172501200,"source":"qa","sessionId":"qa-w2","workspace":"/tmp/qa/web","type":"session.start","data":{"nativeSessionId":"qa-w2","startedAt":1791172501200,"title":"web"}}
{"v":1,"seq":1,"ts":1791172501500,"source":"qa","sessionId":"qa-w2","workspace":"/tmp/qa/web","type":"tool.call","data":{"callId":"c2","toolName":"npm","category":"exec","risk":1,"summary":"npm test"}}
```

- **期望**：聚合 = `waiting`；首行 `⏳1`；会话行 2 条，waiting 行置顶且脉冲；`working` 行不抢占首行文案；`clearPending` 前 30 s 内再注入 `agent.status{state:"working",force:false}` → 仍为 waiting 且 `overrideRejected+1`。
- **断言**：`snapshot.agg`、首行文本、行序、计数器。

### CASE-UI-4（T-26 / T-11）离线角标与计时冻结（逻辑时间）

在 CASE-UI-3 的 fixture 末尾追加一条「45 s 后」的事件，然后**停止注入**（fixture 结束）：
- **期望**：回放结束 + 45 s（逻辑时间）→ **该 source 标记离线 + 聚合回落到剩余 source**（契约 §4.4；无剩余则 `idle`）；首行出现「离线」斜纹角标（含后端名）；计时显示最后值 + 「已冻结」，**不再走字**；会话行灰化；60 s 后仍保持（无残留「忙碌」）。
- **命令**：`node scripts/replay-check.mjs qa/fixtures/offline.pet.jsonl --offline-ms=45000`（脚本已支持该参数）。
- **真实时间版**：见 §4-M2。

### CASE-UI-5（T-19）`turn.end(aborted)` 会话级例外不打断他会话 waiting

```jsonl
{"v":1,"seq":0,"ts":1791172500000,"source":"qa","sessionId":"qa-a1","workspace":"/tmp/qa/x","type":"session.start","data":{"nativeSessionId":"qa-a1","startedAt":1791172500000}}
{"v":1,"seq":1,"ts":1791172500100,"source":"qa","sessionId":"qa-a1","workspace":"/tmp/qa/x","type":"turn.start","data":{"turnId":"t1","inputKind":"user"}}
{"v":1,"seq":2,"ts":1791172500200,"source":"qa","sessionId":"qa-a1","workspace":"/tmp/qa/x","type":"turn.end","data":{"turnId":"t1","status":"aborted"}}
{"v":1,"seq":0,"ts":1791172500300,"source":"qa","sessionId":"qa-a2","workspace":"/tmp/qa/y","type":"session.start","data":{"nativeSessionId":"qa-a2","startedAt":1791172500300}}
{"v":1,"seq":1,"ts":1791172500400,"source":"qa","sessionId":"qa-a2","workspace":"/tmp/qa/y","type":"approval.request","data":{"requestId":"req-qa-3","kind":"other","summary":"确认部署","risk":1}}
```

- **期望**：`qa-a1` 行回 `idle`；聚合仍为 `waiting`（`qa-a2`）；`⏳1` 不变。
- **断言**：`snapshot.agg`、行状态、未决计数；**反例**：若实现按优先级比较，聚合会退化为 idle —— 该断言就是回归护栏。

### CASE-UI-6（T-10）`observes` 缺能力 → 指标隐藏

先发控制帧 `{"ctl":"hello","contract":1,"source":"qa","adapterVersion":"0.0.1","observes":["turn.*","tool.*"]}` 再注入 CASE-UI-1 的事件。
- **期望**：不显示步骤进度（无 0/空白占位）、不显示 `⏳`（未声明 `approval.*`）；tooltip/「能力」小字可查到「该后端不支持 approval」。
- **断言**：AX 树中不存在 `⏳` 节点与进度条节点（数量 = 0），而非「存在但为 0」。

---

## 4. 不可自动化项与手工步骤（照着做就能复现）

| 编号 | 项目 | 为什么不能自动 | 手工步骤 |
|---|---|---|---|
| **M1** | AX 树/无障碍断言（T-21/22/59/65） | 需要辅助功能权限与真实 UI | ① 开启「系统设置 → 隐私与安全性 → 辅助功能」给外壳授权；② 打开 Accessibility Inspector（`developer.apple.com/documentation/accessibility/accessibility-inspector`，2026-10-05 可达）；③ 选中工作框窗口 → 记录首行 4 个静态文本节点与每会话行节点；④ 截图存档 |
| **M2** | 真实离线（T-11/T-26） | 需要真实进程与真实等待 | ① 起 Hub + 适配器 + 外壳；② `kill -9 <adapter-pid>`；③ 用秒表/脚本计时，记录「**45 s 标记离线 + 聚合回落**」的出现时刻（契约 §4.4）；④ 观察 60 s 无「忙碌」残留；⑤ 记录 `snapshot.offlineSources` |
| **M3** | R2 留痕三条（T-15/T-20） | 涉及菜单栏、通知中心 | ① 注入 `approval.request`；② 让会话 10 min 无状态变化（或注入逻辑时钟）；③ 确认：菜单栏琥珀计数仍在 / 面板列出被清理项含 `requestId` / 收到通知；④ 点击确认后痕迹消失 |
| **M4** | 拖拽/吸边/贴边增长（T-24/T-35/T-42） | 真实鼠标与屏幕几何 | ① 拖到四边各 10 次，量吸边误差 ≤4 px；② 贴底边时连续注入 3 个 `session.start`，确认向上增长不越界；③ 锁定位置后拖动应无效；④ 重启确认恢复 |
| **M5** | 像素取色（T-28/T-64/T-66） | 需屏幕截图与像素读取 | ① `screencapture -x qa/shot.png`；② `./spikes/tools/bin/pixelprobe qa/shot.png <x> <y>`（编译见 [spikes/README](../spikes/README.md)）；③ 记录描边/文字与底色，算对比度；④ 深色桌面（#111 壁纸）重复一次 |
| **M6** | 点击穿透（T-36） | 需要底层窗口交互 | ① 开启穿透；② 在被覆盖的文本编辑器里输入字符，确认落到底层；③ 按 `⌥⌘P` 恢复，确认菜单栏角标消失；④ 反复 3 次 |
| **M7** | 右键菜单（T-37） | 菜单项与崩溃需人工点击 | ① 逐项点击（项数见 §6.2 冲突）；② 每项后确认工作框仍响应；③ 记录任何异常到 issue |
| **M8** | 全屏共存（T-38） | 需真实全屏应用 | ① 播放全屏视频；② 确认工作框收为窄条且四项可读、静音；③ 退出全屏，1 s 内恢复原形态/高度/位置 |
| **M9** | 多屏（T-39） | 需外接屏 | ① 接第二屏，拖到副屏并锁定；② 拔掉副屏，确认 500 ms 内回到主屏可视区；③ 改分辨率重复 |
| **M10** | 刘海/菜单栏避让（T-40） | 需带刘海机型 | ① 尝试将工作框拖到顶部（应不吸附）；② 自动布局后确认菜单栏图标区未被覆盖 |
| **M11** | 快捷键（T-41） | 依赖辅助功能权限 | ① 未授权状态测全部快捷键（应降级并提示）；② 授权后重测；③ 制造冲突快捷键，确认设置页提示并可改键 |
| **M12** | 崩溃自愈（T-43/T-44） | 真实进程 | ① `kill -9` 外壳 → 5 s 内自动重启且 agent 无感；② `kill -9` 适配器 → 退避重启；③ 连杀 5 次 → 标记 `degraded` 并在 UI 显示 |
| **M13** | 性能人工复核（T-46/T-47） | 需交互式测量 | ① 记录 DSH 首字延迟 10 次（跑/不跑工作框）；② Activity Monitor 看 GPU；③ 与 [docs/10](../docs/10-architecture.md) §7 NFR 对齐 |
| **M14** | 隐私抓包（T-51） | 需 root 与网络观察 | ① `sudo tcpdump -i any -n 'not host 127.0.0.1' -w qa/net.pcap`；② 运行 24 h（或首启引导全程）；③ `tcpdump -r qa/net.pcap` 确认为空（除用户主动触发的更新/皮肤下载） |
| **M15** | Reduce Motion / VoiceOver（T-56/T-57） | 系统开关 + 听感 | ① 开「减弱动态效果」→ 审批提醒应无位移/抖动；② 开 VoiceOver 遍历，核对朗读模板 |
| **M16** | Retina / 更大文本（T-66） | 需分辨率切换与像素检查 | ① 1×/2×/3× 各截一次图，比对 CSS px 布局一致；② 开「更大文本」确认 40→48、28→32 px 且不裁切 |
| **M17** | 自启/卸载（T-68/T-69） | 系统登录项 | ① 开启自启 → 重启（或 `launchctl list | grep -i pet`）；② 关闭后确认无残留；③ 卸载后 `ls "$TMPDIR"/agent-pet` 为空 |
| **M18** | 首启引导（T-70） | 需人类走流程 | ① 清空配置重开；② 计时 ≤90 s、可 Esc 跳过；③ 第 3 步确认展示了 hooks diff；④ 第 4 步回放不触发真实 agent（观察无 agent 进程被拉起） |

---

## 5. CI 门禁清单

### 5.1 每次提交（PR，必须全绿才可合并）

```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# 1) 契约一致性：16/16 type 覆盖 + 6 状态 + 配对 + 超时（现有脚本）
node scripts/replay-check.mjs fixtures/contract-sample.pet.jsonl
node scripts/check-fixtures.mjs
node schema/validate-pet-event.mjs fixtures/contract-sample.pet.jsonl

# 2) 契约/其它 fixture 全量校验（新增用例后自动纳入）
node scripts/check-fixtures.mjs qa/fixtures/*.pet.jsonl
node scripts/replay-check.mjs qa/fixtures/*.pet.jsonl

# 3) 零推断门禁（T-27）：渲染层不得用本地时钟算时长
! grep -rnE "Date\.now\(\)|performance\.now\(\)" apps/ packages/frame 2>/dev/null \
  | grep -vE "test|spec|\.md" || { echo "FAIL: 渲染层出现本地时钟推断"; exit 1; }

# 4) i18n 键完整性（T-58）
node qa/i18n-key-check.mjs locales/zh-CN.json locales/en.json

# 5) 敏感信息扫描（T-53）
bash qa/scan-secrets.sh fixtures/ qa/fixtures/
```

> 前 3 条**今天即可运行**（已在 §0 实测通过）；第 3–5 条脚本为本文附带草案（见 5.4），实现后纳入。

### 5.2 每晚（Nightly）

| 项 | 命令 / 做法 | 通过标准 |
|---|---|---|
| 长跑内存（T-48） | 外壳常驻 1 h，每 60 s `node spikes/tools/tree-rss.mjs <pid>` 写 CSV | RSS 漂移 <5% |
| 事件风暴（T-49） | `node spikes/jsonl-feed/feed.mjs --socket … --scenario unknown-storm --count 10000` | 无异常、计数精确、RSS 漂移 <5% |
| 全量回放（T-01/T-05…） | `node scripts/replay-check.mjs fixtures/*.pet.jsonl qa/fixtures/*.pet.jsonl` | 全绿 |
| 离线/清理逻辑时间回归（T-11/T-15） | `replay-check --offline-ms=45000 --stale-ms=600000` | 角标与 `stale` 计数正确 |
| 资源基线（T-45） | `./spikes/tools/footprint-sum.sh pet <pid>` | 空闲 ≤150 MB、CPU ≤1% |

### 5.3 发布前（Release，含手工）

> **M3 前的资产用例**：T-60..T-64（§11-H1..H5）随宠物层移入 **M3（皮肤包 v1）**，**不阻塞 M2 发布**；M2 的资产相关门禁只有 T-65（关闭宠物层信息不缺失）与 T-66（Retina/更大文本）。

公证/签名（[docs/60](../docs/60-risk-register.md) R-04）→ 干净机器安装 → TCC/辅助功能/通知权限流程 → §4 全部 M 项 → 隐私抓包 24 h → 性能基线写入 [docs/30](../docs/30-implementation-stack.md)。

### 5.4 需要新增的 3 个小脚本（草案，放在 `qa/`）

1. `qa/scan-secrets.sh`：对 `fixtures/`、`qa/fixtures/`、`~/.agent-pet/records/` 跑正则 `sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}|/Users/[^\s"]+`，命中即非 0。
2. `qa/i18n-key-check.mjs`：两语言键集合对称、无缺键、无未用键。
3. `qa/mock-hub.mjs`：读 fixture → 按契约 §5.2 回 `ctl:ack` → 广播 `snapshot`，用于 T-09/T-10/T-14 在无真 Hub 时自动化。

---

## 6. 追溯与冲突

### 6.1 74 → 70 的合并说明

| 合并结果 | 被合并的来源 | 理由 |
|---|---|---|
| T-01 | §11-A1 + A6 | 同一份 fixture 回放同时验证「状态覆盖」与「type 覆盖」 |
| T-03 | §11-A5 | 与 `replay-check` 的 >8 KB 负例同一断言 |
| T-13 | §11-B1 + §11-B2 | 都是「waiting 粘性」，只是断言层不同（逻辑 / 快照） |
| T-21 | WF-01 + WF-02 | 首行可读性与动作保底宽度同一次断言 |
| T-23 | WF-04 + WF-07 + WF-08 + WF-09 + WF-10 | 高度公式的参数化用例 |
| T-25 | WF-05 + WF-12 + WF-13 | 计时格式化与冻结同一函数族 |
| T-28 | WF-15 + WF-16 | 瞬态/持久错误的同一实现分支 |
| T-45 | §11-D1 + 部分 WF-21 | 同一次采样 |
| T-51 | §11-F1 + §11-E5（网络部分） | 同一次抓包 |
| T-65/T-66 | WF-25 + WF-27 / WF-03 + WF-26 | 宠物层关闭回归 / Retina 与更大文本 |
| 未合并（保持独立） | T-36/T-37/T-38/T-39/T-40/T-41/T-42/T-43/T-44/T-46/T-47 | 均为独立手工场景，合并会失去可复现性 |

覆盖核对：§11 的 47 条与 WF 的 27 条**全部**能在 §2 矩阵中找到归属（A/ B/ C/ D/ E/ F/ G/ H 与 WF-01..WF-27 均已映射）。

### 6.2 文档冲突与裁决（**Lead 已于 2026-10-05 裁决，Q-1~Q-3 均已落地**）

| # | 冲突 | 涉及 | 建议 |
|---|---|---|---|
| Q-1 | 右键菜单项数：12 项（§50 §2.4 与 §11-C3）vs **15 项**（§51 §4.4） | §11-C3 / T-37 | ✅ **已裁决：以 §51 = 15 项为准**。docs/50 §2.4 与 §11-C3 已改为 15 项并按 §51 §4.4 对齐清单 |
| Q-2 | 全屏行为：§50 §2.10「滑到右缘半隐藏」vs §51 §4.1「自动收为窄条 320×40」 | §11-C8 / T-38 | ✅ **已裁决：以 §51 为准**。docs/50 §2.10 已改为「全屏应用自动收窄条，退出全屏 1 s 内恢复原形态与位置」 |
| Q-3 | 资产验收（§11-H1..H5）在宠物层默认关闭后是否阻塞 M2 | §11-H / §51 §8 | ✅ **已裁决：非阻塞，移入 M3（皮肤包 v1）**。docs/50 §11-H 已加说明；本文件 T-60..T-64 标签改为「M3 前」 |
| Q-4 | §50 §1.1 的 `error` 行原未分瞬态/持久 | 已由作者本轮对齐（§50 §1.1 拆两行） | 已完成，无需动作 |
| Q-5 | `check-fixtures.mjs` 头部写「契约 v1.1」，而 `replay-check.mjs` 已是 v1.2 | 工具文档一致性 | 建议 T3 作者把注释与输出改为 v1.2（不影响行为） |

---

## 7. 残余风险与未覆盖项

1. **fixture 与真实事件的偏差**：fixture 由规范构造，真实适配器可能有额外字段/缺字段；缓解：每周用真实录制（`~/.agent-pet/records/*.pet.jsonl`）跑一次全量回放（nightly）。
2. **逻辑时间 vs 真实时间**：TTL/离线/清理默认按逻辑时间验证，可能掩盖真实定时器缺陷；缓解：§4-M2 的真实时间版每 Sprint 跑一次。
3. **无 Hub 时 UI 无法自动化**：T-14 起的 UI 断言依赖外壳实现；在实现前，UI 层用 `qa/mock-hub.mjs`（5.4）兜底。
4. **音效/触感类不可自动**：审批提示音、抖动「体感」需人工抽检（T-30/T-32）。
5. **公证与 TCC 只能手测**：发布前必须在一台干净机器上走完整流程。
6. **性能指标待 T1 回填**：[docs/30](../docs/30-implementation-stack.md) 仍是占位，T-45/T-48/T-50 的阈值需按其实测结论复核（本文用的是 docs/10 §7 的 NFR）。

---

## 8. 参考

**仓库内**：[契约](../docs/00-interface-contract.md)（v1.2）· [架构](../docs/10-architecture.md) · [适配矩阵](../docs/40-adapters.md) · [产品规格](../docs/50-product-spec.md) · [工作框规格](../docs/51-work-frame-spec.md) · [风险登记册](../docs/60-risk-register.md) · [团队与指标](../docs/70-team-and-metrics.md) · [独立验收报告](../docs/99-verification-report.md) · [spikes 说明](../spikes/README.md) · [fixture](../fixtures/contract-sample.pet.jsonl)

**外部（访问日期 2026-10-05，本机实测可达）**：
- Node.js Test runner（`node --test`，用于把 T-06/T-12/T-25 写成单测）：`https://nodejs.org/api/test.html`（200）
- Apple · Accessibility Inspector（M1 手工步骤用）：`https://developer.apple.com/documentation/accessibility/accessibility-inspector`（200）
- Apple HIG · Accessibility（T-56/T-57 判据）：`https://developer.apple.com/design/human-interface-guidelines/accessibility`（200）
- VS Code Status Bar UX guidelines（首行信息密度判据，§51 §2.1 已引用）：`https://code.visualstudio.com/api/ux-guidelines/status-bar`（200）
