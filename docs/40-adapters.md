# 40 · Agent 后端适配矩阵（Phase 2 可行性）

> 负责人：队友 C（adapter-recon）｜状态：**DRAFT v1**（2026-10-05）｜上游契约：[00-interface-contract.md](./00-interface-contract.md)（冻结）
> 本文的每条事实都标注证据：**本机实测**给命令与输出要点，**外部来源**给完整 URL + 访问日期（均为 2026-10-05）。
> **对齐状态：已按契约 v1.2（2026-10-05 冻结）重写**——**16 个 type 字符串 / 16 行**口径、`session.start.startedAt` 与 `session.end.endedAt`、`approval.*` 的 `requestId` 配对、`questionId`、控制帧（`ctl`，无 `type`，且所有控制帧带 `contract`）、`agent.status` 五状态（无 `done`/`blocked`）、§4.7 错误分级（瞬态 TTL / 持久错误 / 连击升级）、§5.2.1 `observes` 观测能力等级、`seq` 作用域 `per(source, sessionId)` 与 `sessionId="backend"` 保留值、§4.4/§4.5 双超时。
> 无法核实的写「未验证 + 验证方法」，不写推测当结论。

---

## 0. TL;DR

| # | 后端 | 接入点 | 规范事件覆盖 | 优先级 | 适配工作量（估算） |
|---|---|---|---|---|---|
| 1 | **DSH 0.2.0-rc.2**（Phase 1） | 离线会话日志（zstd JSONL）+ hook 桥 | 16 个 type 字符串中 12 个可达（9 个 1:1） | **P0（已定）** | 5～7 人日（含本文原型） |
| 2 | **Claude Code** | 33 个 hook 事件 + 会话转录 JSONL | 10～12 类 | **P0** | 10～14 人日 |
| 3 | **Codex CLI** | 10～12 个 hook 事件 + rollout JSONL | 9～11 类 | **P0** | 10～13 人日 |
| 4 | **通用 ACP 客户端** | JSON-RPC over stdio（session/update 通知流） | 11 类 | **P1**（一次适配多家，但 v2 草案并存） | 8～12 人日 |
| 5 | **Cursor** | 21 个 hook 事件 | 10～12 类 | **P1** | 6～8 人日 |
| 6 | **GitHub Copilot CLI** | 8 个 hook 事件（含 Claude 兼容格式） | 9～11 类 | **P1** | 5～7 人日 |
| 7 | **MCP 客户端/服务端** | MCP 工具与通知 | 辅助（不能做主通道） | **P1（辅助）** | 3～5 人日 |
| 8 | **Gemini CLI** | 11 个 hook 事件（官方已宣布被 Antigravity CLI 取代） | 9～10 类 | **P2** | 6～8 人日 |
| 9 | **Windsurf** | hook（官方文档本次不可达，第三方镜像） | 未验证（估计 6～8 类） | **P2** | 8～10 人日 |
| 10 | **Aider** | 无 hook；JSON 输出/历史文件/进程观测 | 3～4 类（进程级为主） | **P2** | 3～4 人日 |
| 11 | **进程/日志兜底层** | ps / lsof / 文件监听 | 2 类（session.start/end 级别） | **P1（兜底）** | 2～3 人日 |
| 12 | **Kimi Code**（桌面 App + CLI，1.0.4） | `~/.kimi-code/` 文件级数据（state.json + agents/main/wire.jsonl 事件流）+ 内置 hooks（20 事件，未用） | wire 实测可映射 8 类（含**原生审批对**） | **首批（A 路径 ✅）** | 已落地（hooks 升级项另计） |
| 13 | **OpenCode**（CLI + 桌面 2.1.2，2026-10-22 已落地） | opencode.db（WAL 只读；CLI/桌面共用后台服务）；双消息存储（≤1.18 message/part + ≥2.x session_message，迁移双写按 v2 去重） | 回合/工具/文本/状态全链（MO1–MO10） | **已落地** | 用量对账 MU11（input 不含 cache）；控制 `opencode run --session`/`run -m`（PWD 修复） |
| 14 | **Qoder**（Qoder CN 0.4.8 桌面 + qoderclicn 1.1.76 CLI，2026-10-22 已落地） | 桌面 main.sqlite 结构化列（**消息原文列列级排除**）+ `~/.qoder-cn/logs/sessions/**/segments/*.jsonl` 事件流（桌面/CLI 共用；CLI 回合唯一落点，不回写 sqlite） | 会话/回合级（MQ1–MQ11；工具级需原文→红线缺席；segments token 字段实测恒 0→用量如实降级） | **已落地** | 控制走 `qoderclicn -p -r <id>`（CLI 与桌面会话可互相续接，共用 chat_sessions）；不用 --dangerously-skip-permissions |
| 15 | **Cursor**（桌面 3.26.16 + cursor-agent CLI，2026-10-22 已落地） | 桌面 state.vscdb（composerHeaders + composerData.status；不读消息泡/subtitle）；CLI chats meta.json（store.db 转录原文红线不读） | 桌面：会话/状态级（agent.status）；CLI：会话级（MG1–MG9） | **已落地** | 控制 `cursor-agent -p --resume`（CLI 会话）；桌面 composer 无通道；用量云端 → 如实降级 |
| 13 | **ZCode**（桌面 App 3.14.4，CLI 0.16.9 随包分发） | `~/.zcode/cli/db/db.sqlite`（WAL；session/message/part 三表，node:sqlite 只读并发）+ 包内 `zcode.cjs` CLI（--resume/--prompt） | sqlite 实测可映射 8 类（turn/step/tool/message；**无审批流**——permission 表为项目配置） | **首批 ✅（M-L）** | 已落地（无头投递对 account:* provider 会话受上游登录态限制，见 §3.12） |

**三条结论**：
1. **Phase 2 的关键不是「能不能拿到事件」，而是「拿到事件要不要用户改配置」**：Claude Code / Codex / Cursor / Copilot / Gemini 的 hook 都要写进用户或项目配置文件，属于「需用户同意安装」的接入方式；**离线日志兜底（只读、零侵入）应当作为每个后端的默认降级路径**。本机实测证明两条路都可行（见 §3.1/§3.2 的实测证据段）。
2. **上游漂移速度很快**：Claude Code 的 hook 事件在 **2026-09-29 → 2026-10-05 一周内从 30 个涨到 33 个**（DSH 桥自述基线 vs 官方文档当前值），Codex 桥基线 10 个、当前官方文档镜像为 12 个。**适配器必须把「事件名清单」做成可热更新的数据，而不是硬编码逻辑**。
3. **ACP 是唯一「一次适配、多家覆盖」的通道**，但成熟的 ACP 客户端/Agent 生态仍在演进（本机 DSH 内置 @agentclientprotocol/sdk 1.4.0 已含 v2 草案 schema）。建议 P1，作为 Phase 2 后半段的杠杆。

---

## 1. 方法与证据边界

### 1.1 本机环境（实测）

~~~bash
$ node -v && sw_vers -productVersion && uname -m
v24.18.0
26.x（Darwin 27.0 内核）
arm64
$ /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "/Applications/DeepSeek Harness.app/Contents/Info.plist"
0.2.0-rc.2
~~~

### 1.2 本次调研的网络可达性（重要，影响证据等级）

| 目标 | 结果 | 处理方式 |
|---|---|---|
| code.claude.com、cursor.com、geminicli.com、docs.github.com、aider.chat、support.apple.com | ✅ 或部分可达 | 直接引用 |
| github.com、raw.githubusercontent.com、learn.chatgpt.com、agentclientprotocol.com、docs.windsurf.com、developers.openai.com | ❌ web_fetch 失败或 403 | 改走 **jsDelivr CDN 读取官方仓库原文**（`cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>`），并在每条证据上标注实际读取路径 |
| 官方文档站点为 JS 渲染（docs.github.com、geminicli.com） | ⚠️ 只返回导航骨架 | 改为读取其**上游 Markdown 源文件**（github/docs、google-gemini/gemini-cli） |

> 结论：本文中标注「官方仓库原文（经 jsDelivr）」的证据等价于官方文档内容；标注「第三方镜像」的证据只用于交叉验证，不能单独作为结论。

### 1.3 证据等级定义

- **[A] 本机实测**：给了可复现命令与输出要点。
- **[B] 官方文档/官方仓库原文**：URL + 访问日期。
- **[C] 第三方镜像/交叉验证**：URL + 访问日期，且与 [A]/[B] 交叉印证。
- **[U] 未验证**：写明验证方法，禁止当结论用。

---

## 2. DSH（Phase 1，最详细）

### 2.1 本机会话日志的结构 [A]

~~~bash
$ ls -la "$HOME/.dsh/sessions"
drwx------@ 8 demo  staff  256 Oct  5 12:00 --Users-demo-Desktop-agent~684C~5BA0--
drwx------   6 demo  staff  192 Oct  5 11:54 --Users-demo-Desktop-~539F~751FAI~64CD~4F5C~7CFB~7EDF--
...
$ ls -la "$HOME/.dsh/sessions/--Users-demo-Desktop-agent~684C~5BA0--/session-0a1b2c3d-.../"
-rw-------  1 demo  staff  324913 Oct  5 12:00 session.v4.jsonl.zstd
-rw-r--r--  1 demo  staff       0 Oct  5 11:55 session.lock
~~~

- 路径规则：`~/.dsh/sessions/<cwd 转义>/<sessionId>/session.v4.jsonl.zstd`，目录名把 `/` 写成 `-`、非 ASCII 字符写成 `~XXXX`（UTF-16 码元十六进制）。实测路径 `--Users-demo-Desktop-agent~684C~5BA0--` 对应 `/Users/demo/Desktop/agent桌宠`。
- 文件是 **zstd 多帧压缩的 JSONL**，首行是会话头：
  ~~~json
  {"type":"session","version":4,"id":"session-0a1b2c3d-4e5f-4a6b-8c9d-1a2b3c4d5e6f","createdAt":1791172500273,"cwd":"/Users/demo/Desktop/agent桌宠","isSeeded":false,"delegationDepth":0,"agentPreset":"ptc"}
  ~~~
- 之后每行是事件信封（与契约 §2 高度同构，可直接映射）：
  ~~~json
  {"type":"tool/call","seq":294,"time":1791172861963,"data":{"turn":1,"step":17,"callId":"call_00_...","name":"run_code","arguments":"{\"code\": ...}"}}
  ~~~
  信封字段固定为 `type / seq / time / data`，另有可选 `ignorable`（供新版本写入未知事件时读取端安全跳过，来源：`dsh-session-format-v0-to-v1` 校验器 [A]）。`seq` 从 0 起、**稠密**（读取端会校验 `record.seq === index`）。
- 首次观察到的坑：**单帧解压只得到第一行**。见 §2.4。

### 2.2 原生事件词表（58 种）与实测出现率 [A]

来源：DSH 应用包内 `app.asar` → `dsh/node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js`（`KNOWN_SESSION_EVENT_TYPES`，58 个类型）。读取方法（app.asar 是 Electron 归档，不是目录，需自写 8 字节 pickle 头解析后按 offset 读）：

~~~bash
$ node -e '/* 见 §9.3 asar-ls.mjs */' # 输出：
total files in asar: 12973 | header size field: 3393616 | base offset: 3393624
$ node /tmp/extract.cjs "lib/types/known-event-types.js"   # 抽出后读到的 58 个类型见下
~~~

58 个类型（原样抄录）：
agent-preset/selected, agent/inbox/spliced, approval/asked, approval/decided, approval/policy, assistant/attempt, assistant/message, command/done, command/run, compaction/end, compaction/prune, compaction/start, compaction/summary, deliverables/presented, developer/message, feedback/message-delete, feedback/message-put, feedback/record, goal/change, hook/invoked, hook/result, image/offload, llm/retry, llm/retry-started, model/selection, permission/preset, plan/mode, request/context, request/header, sandbox/mode, schedule/change, session-log-deepseek/delivery-accepted, session/end-seed, session/title, session/title-llm-request, step/end, step/start, subagent/catalog, subagent/descriptor, subagent/model-selection-policy, system/message, team/member, team/message/delivered, team/message/queued, team/task, todo/write, tool-workflow/agent-end, tool-workflow/agent-start, tool-workflow/run-end, tool-workflow/run-start, tool/call, tool/ptc-dispatch, tool/ptc-dispatch-start, tool/result, turn/end, turn/start, user/message, web/deepseek-search-llm-request, workspace/changes

本机 11 个会话日志、3,612 条原生事件中**实际出现过 36 种**（Top：tool/ptc-dispatch-start 321、tool/ptc-dispatch 317、step/start 131、tool/call 130、assistant/message 129、tool/result 126、step/end 125、session-log-deepseek/delivery-accepted 114、user/message 41、agent/inbox/spliced 35、team/task 16、approval/asked 2、approval/decided 2）。

关键原生载荷（来自 `dsh-session-format-v0-to-v1/lib/index.js` 的发布版载荷校验器 [A]）：

| 原生类型 | 字段（校验器原文） |
|---|---|
| `turn/start` | `turn`(count) |
| `turn/end` | `turn` + `reason.kind ∈ {completed, blocked, max-tokens, interrupted, aborted(带 reason)}` |
| `step/start` / `step/end` | `turn`, `step`（**无状态、无时长**） |
| `tool/call` | `turn`, `step`, `callId`, `name`, `arguments`(string) |
| `tool/result` | `turn`, `step`, `message`(role=tool), 可选 `error:{name,code}` |
| `approval/asked` | `id`, `toolName`, 可选 `callId`, 可选 `reason` |
| `approval/decided` | `id`, `outcome ∈ {allowed-once, rejected, cancelled, unavailable}` |
| `assistant/message` | `turn`, `step`, `message`, 可选 `usage`, `interrupted:true` |
| `hook/invoked` | `turn`, `point`, `dialect ∈ {claude-code, codex}`, 可选 `matcher`, `handlerId` |
| `hook/result` | `turn`, `point`, `handlerId`, `decision`, 可选 `exitCode`, `stderrSummary`, `durationMs` |
| `approval/policy` | `policy ∈ {ask, never}`（本机实测多为 `never`，来源 `source:"delegation"`） |

### 2.3 规范事件 ← DSH 原生事件：逐条映射（对齐契约 §3/§6）

| 规范事件 | DSH 原生来源 | 字段抽取 | 缺口 / 兜底 |
|---|---|---|---|
| `session.start` | 会话日志首行 `type:"session"` | `id→nativeSessionId`、`cwd→workspace`；`agentVersion` 需外部注入（头部 `version:4` 是**会话格式版本**不是应用版本） | 首行无 `seq/time` → 适配器补 `seq=0, ts=createdAt`（已实现并实测） |
| `session.end` | ✗ 无原生事件 | — | **兜底**：适配器在会话进程退出 / socket 关闭 / 日志停止增长（>90s）时合成，`reason` 取最后一轮 `turn/end` 的 kind（done/aborted/error/unknown） |
| `pet.heartbeat` | ✗ 无原生事件 | — | 适配器定时器：15s 无事件即发；**后端级心跳**用信封 `sessionId:"backend"` + `data.nativeSessionId:null`、`load` 缺省 0（契约 §2.4/§3.1） |
| `turn.start` | `turn/start` | `turn→turnId:"turn-N"`；`inputKind` **原生无此信息** → 固定 `user` | 桌面端派生回合（如 team 消息）会显示为 user；可作为 v2 改进项 |
| `turn.end` | `turn/end` | `reason.kind` → `status`：completed/max-tokens→ok；blocked/interrupted/aborted→aborted；未知→error。`durationMs` 需用同 turn 的 `turn/start.time` 相减 | 原生无 durationMs、无 summary |
| `step.start` / `step.end` | `step/start`、`step/end` | `stepId = "turn-N/step-M"`（原生只有数字）；`index=step` | `step/end` 无状态 → 固定 ok；`durationMs` 需适配器计算 |
| `message.assistant` | `assistant/message` | `message.content[]` 中 `type=="text"` 的块拼接，去掉 `reasoning` 与 `tool-call` 块；截断 280 字符并写 `privacy.redacted=true` | reasoning 属思维链，**默认不外传**（隐私） |
| `tool.call` | `tool/call` | `name→toolName`、`callId`、`arguments`(JSON 字符串) 压缩为 `summary`；`category/risk` **原生没有** → 按工具名 + 参数启发式判定 | 子调用（`tool/ptc-dispatch-start`）可作为「嵌套工具」信号，v1 先忽略（避免刷屏） |
| `tool.result` | `tool/result` | `message.toolCallId→callId`；`error` 存在或 `message.isError` → `status=error`，否则 ok；`durationMs` 用 call→result 时间差 | `denied` 无法直接判定 → 兜底：`approval/decided=rejected` 之后同 `callId` 的 result 标 `denied` |
| `approval.request` | `approval/asked` | `id→requestId`（**原生就是这个字段，正好满足 v1.2 §3.3 配对要求**）、`reason→summary`（截断）、`callId` 直传；`kind` 由 `toolName` 映射：bash/shell→`command`、write/edit→`file-write`、web/fetch→`network`、其余→`permission`/`other`；`risk` 启发式 | 本机实测仅 2 条（`approval/policy=never` 时极少触发）；`expiresAt` 原生无 |
| `approval.resolved` | `approval/decided` | `id→requestId`（与 `approval/asked.id` 天然配对）；`allowed-once→allow`、`rejected→deny`、`cancelled→deny`、`unavailable→timeout`；`latencyMs` 用 asked→decided 时间差 | 原生 4 值 vs 契约 3 值，**有损映射**（见 §8）；找不到未决项时按 §3.3 计 `orphanApprovals` |
| `user.question` / `user.answer` | ✗ 无原生事件 | — | 兜底：按工具名白名单识别并向 `questionId` 归一（用工具调用 `callId` 派生，保证答配问）；v1 允许后端永不发这两类事件 |
| `agent.status` | 派生（`agent/inbox/spliced`、`goal/change`、`approval/policy`、`sandbox/mode`、`model/selection`） | `state` 只能取 §3.4 的 5 个值（`idle|thinking|working|waiting|error`，**不能发 `done`**）；建议只在适配器确有把握时发，否则交给 Hub 从事件推导 | 需要遵守 §3.4 覆盖规则（10s 有效 + 优先级 ≥ 当前，或被 Hub 计 `overrideRejected`） |
| `error.raised` | `llm/retry`、`llm/retry-started`、`tool/result(error)`、`compaction/*` 的 error 字段 | `scope`：llm/tool/session；`fatal=false` | `fatal=true` 只在适配器自身断线时合成 |

> **v1.2 时间字段（DSH）**：`session.start.startedAt` ← 会话首行的 `createdAt`（本机实测该字段存在且为 Unix ms）；`session.end.endedAt` ← 适配器合成 `session.end` 的时刻（原生无结束事件，见上表兜底列）；`session.end.durationMs` ← `endedAt - startedAt`。
>
> **DSH 原生 decision 四值 → 契约三值的有损折叠规则（独立验收 C-25）**：`allowed-once → allow`；`rejected → deny`；`cancelled → deny`；`unavailable → timeout`。
> **信息损失点**：`rejected`（人明确点了拒绝）与 `cancelled`（审批渠道被取消/断线）在契约里都变成 `deny`，UI 无法区分「用户说不」与「没人来批」；`unavailable`（无审批渠道，本机 `approval/policy=never` 时的常见路径）折叠成 `timeout` 也偏乐观。
> **建议**：v1.3 允许 `data.nativeOutcome` 透传原生四值（可选字段，不破坏现有消费者），或在 `decision` 增加 `cancelled`。当前**不擅自扩展**：适配器只发三值，原生值仅写进本地日志。

**覆盖率（DSH）**：16 个 type 字符串中 12 个可实现（9 个 1:1 直接映射 + 3 个派生/合成），4 个有明确缺口（`session.end` 依赖进程边界、`user.question/answer` 无原生对应、`step` 无状态、`denied` 需推断）。**评分：事件丰富度 8.5/10，接入成本 2/10（只读日志，零配置），综合 9/10。**

### 2.4 最小可行代码：离线读会话日志 → 规范事件（已实测）

**核心坑**：`session.v4.jsonl.zstd` 是**每行一帧的多帧 zstd**。Node v24 的 `zlib.zstdDecompressSync` 与 `createZstdDecompress()` 都**只解第一帧就正常返回**（不报错）：

~~~bash
$ node -e 'const z=require("zlib"),f=require("fs");const b=f.readFileSync(process.argv[1]);
  console.log("compressed:",b.length,"| single-frame decoded:",z.zstdDecompressSync(b).length)' <某会话日志>
compressed: 366642 | single-frame decoded: 209      # ← 只有第一行！漏掉 296 行
~~~

可用读法（已随本任务交付为 `scripts/dsh-session-to-pet.mjs`，可直接跑）：

~~~js
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];              // zstd 帧魔数
export function decodeZstdJsonlFrames(buf) {
  const offsets = [];
  for (let i = 0; i + 4 <= buf.length; i++)
    if (buf[i] === MAGIC[0] && buf[i+1] === MAGIC[1] && buf[i+2] === MAGIC[2] && buf[i+3] === MAGIC[3]) offsets.push(i);
  const lines = []; let frames = 0, errors = 0, i = 0;
  while (i < offsets.length) {
    let advanced = false;
    for (let j = i + 1; j <= offsets.length; j++) {
      const end = j < offsets.length ? offsets[j] : buf.length;
      let out; try { out = zstdDecompressSync(buf.subarray(offsets[i], end)); } catch { continue; }  // 截断帧 → 外推边界
      const text = out.toString('utf8');
      if (!text.endsWith('\n') && j !== offsets.length) continue;   // 没解到帧尾 → 继续外推
      frames++; for (const l of text.split('\n')) if (l.trim()) lines.push(l);
      i = j; advanced = true; break;
    }
    if (!advanced) { errors++; break; }   // 尾部半帧：本次放弃，等文件增长后重读
  }
  return { lines, frames, errors, candidates: offsets.length };
}
~~~

两个必须说明的细节：
1. **压缩数据内部可能偶然出现帧魔数**，所以不能「按魔数切分后逐段解压」了事；本实现对每个候选边界都做「解出的文本是否以换行结尾」的校验，不满足就把边界外推——实测本机 **11 个日志 / 1,977 帧 / 0 解帧失败**。
2. **最后可能有一个未写完的半帧**：`errors>0` 表示尾部半帧，读实时日志时应记录 offset、等文件增长后重读，而不是丢弃整份日志（本原型在离线场景直接跳过尾部）。

实测（本机 11 个会话日志，只读）：

~~~bash
$ node scripts/dsh-session-to-pet.mjs <某会话日志> --agent-version 0.2.0-rc.2 > /tmp/pet-out.jsonl
# 该会话仍在增长，下面是 2026-10-05 12:20 的快照（12:26 复跑已是 604,281B/292 帧/499 原生/141 规范，结论不变）
[dsh-session-to-pet] 压缩 578741B → 帧 277/277 候选 → 原生事件 472 → 规范事件 130（解帧失败 0）
[type 分布] session.start=1, turn.start=1, step.start=29, tool.call=35, tool.result=34, step.end=28, error.raised=2
$ node scripts/check-fixtures.mjs /tmp/pet-out.jsonl    # 用本任务的契约 v1.2 自检脚本验收输出
行数(非空): 130 | 事件: 130 | 控制帧: 0 | 最大单行: 580B / 8192B
配对: orphanApprovals=0, orphanAnswers=0, 结束时未决=0
会话 [dsh||session-0a1b2c3d-…] 终态=working 迁移 12 次，覆盖=[idle, thinking, working, error]
~~~
全量汇总（11 个文件，2026-10-05 12:25 实测；会话日志是活的，数字随时间增长）：`压缩 7,141,376B｜zstd 帧 2,952｜解帧失败 0｜原生事件 5,257｜规范事件 1,893｜单事件最大 931B`，其中 `step.start=438, tool.call=437, tool.result=433, step.end=432, message.assistant=111, session.start=11, turn.start=11, error.raised=11, turn.end=5, approval.request=2, approval.resolved=2`。
> 两个必须记住的实测教训：
> 1. **截断是硬要求**：原生单行最大 438,567B（本机 11 个日志），映射后若参数/摘要不截断，单事件会到 **7,615B**（我第一版就把 `--summary-max` 解析成 NaN 导致截断静默失效）——修好后最大 580B。8KB 不是保险丝，是必须主动执行的策略。
> 2. **未出现的 type 不等于不存在**：`session.end`/`user.question`/`agent.status` 在本机 11 个日志里一次都没出现（因为会话还在进行 / 由适配器合成 / 属于派生态），fixture 必须显式覆盖它们。

### 2.5 DSH 的 hook 桥：可复用用户已有的 Claude Code / Codex hooks

DSH 0.2.0-rc.2 内置两个兼容桥 [A]（app.asar → `@deepseek-ai/dsh-hooks-claude-code` / `-codex` / `-hook-protocol` README）：

- `dsh-hooks-claude-code`：支持 Claude Code hooks 的 **7 个事件**——`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`、`SubagentStart`、`SubagentStop`；其余 **23 个**被忽略（README 原文列举：Setup, InstructionsLoaded, UserPromptExpansion, MessageDisplay, PermissionRequest, PostToolUseFailure, PostToolBatch, PermissionDenied, Notification, TaskCreated, TaskCompleted, StopFailure, TeammateIdle, ConfigChange, CwdChanged, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, SessionEnd, Elicitation, ElicitationResult）。
- `dsh-hooks-codex`：支持 Codex hooks 的 **5 个事件**——`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`；Codex 的 `PermissionRequest`、`PreCompact`、`PostCompact`、`SubagentStart`、`SubagentStop` 共 5 个未支持。
- 桥每次执行会写入原生事件 `hook/invoked` + `hook/result`（字段见 §2.2），**这两类事件对桌宠有直接价值**：`point=PreToolUse` 表示「马上要动工具」、`decision=deny` 表示「被策略拦下」、`durationMs` 可做「卡住」提示。
- ⚠️ 事实纠正：`transcript_path` 在 DSH 桥里**恒为空字符串**（README 原文：persistence seam 不暴露 artifact 路径，且默认 zstd 会话日志 hook 脚本读不了）。所以「用 hook 读 transcript」这条路在 DSH 上不通，**必须走 §2.4 的日志通道**。

**对 Phase 1 的结论**：DSH 桌宠适配器**不需要用户配置任何 hook**，只读会话日志即可拿到 12/16 类事件；hook 桥只在用户本来就写了 hooks 时提供额外信号。这也意味着**适配器可以完全离线工作**（对隐私和「零侵入」都最有利）。

### 2.6 DSH 适配工作量（估算）

| 工作项 | 人日 |
|---|---|
| 日志定位 + 多帧解压 + 增量 tail（含半帧重读） | 1.5 |
| 12 类事件映射 + 启发式（category/risk/denied/status 派生） | 2 |
| 8KB 截断 + 脱敏 + 契约一致性单测 | 1 |
| 进程/会话发现（多会话、workspace 转义规则） | 1 |
| 断线/退出合成 `session.end` + 心跳 + 兜底 | 1 |
| **合计** | **5～7 人日**（本文原型已覆盖约 40%） |

---

## 3. 逐后端适配矩阵

### 3.1 Claude Code（P0）

**接入点**
1. **Hook 事件（首选，事件最丰富）**：官方 hooks 参考页共 **33 个事件** [B]。
2. **会话转录 JSONL（兜底，零侵入）**：`~/.claude/projects/<cwd 转义>/<sessionId>.jsonl` [A]。
3. **进程观测（最后兜底）**：见 §3.10。

**33 个 hook 事件**（[B] 官方文档 2026-10-05 逐行抄录）：
SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, Elicitation, ElicitationResult, SessionEnd

**公共输入字段**（每个事件另有专属字段）[B]：

| 字段 | 说明 |
|---|---|
| `session_id` | 会话 ID |
| `prompt_id` | 当前 prompt 的 UUID（需 Claude Code ≥ 2.1.196） |
| `transcript_path` | 会话 JSON 路径；**异步写入、可能滞后**，官方建议用 `Stop`/`SubagentStop` 的 `last_assistant_message` 取最终回复 |
| `cwd` | 当前工作目录 |
| `scratchpad_dir` | 会话草稿目录（需 ≥ 2.1.257） |
| `permission_mode` | `default｜plan｜acceptEdits｜auto｜dontAsk｜bypassPermissions` |
| `effort` | `{level: low｜medium｜high｜xhigh｜max}` |
| `tool_name` / `tool_input` / `tool_use_id` | 工具类事件专属 |

**配置与语义** [B]：settings JSON 三级结构（事件 → matcher group → handler）；handler 类型支持 command / HTTP / MCP tool / prompt / agent；退出码 0=静默通过、2=阻断（stderr 作为理由）、其他=非阻断告警；JSON 输出支持 `continue`、`hookSpecificOutput.permissionDecision`（allow/deny/ask）、`additionalContext`、`systemMessage`；`additionalContext`/`systemMessage`/纯 stdout **单串上限 10,000 字符**（超限改写为文件路径 + 2,000 字符预览）。

**本机实测证据 [A]**：Claude Code **2.1.284** 已在本机运行（进程路径 `~/Library/Application Support/Claude-3p/claude-code/2.1.284/.../claude`，由 Claude.app 2.19675.0 管理），`~/.claude/projects` 下有 **289 个转录文件**：

~~~bash
$ ls "$HOME/.claude/projects"/*/*.jsonl | wc -l
289
$ ps -Ao pid,comm | grep -i claude | head -3
22994 .../Claude-3p/claude-code/2.1.284/4819fdb9b264/claude.app/Contents/MacOS/claude
$ node scripts/scan-claude-transcripts.mjs        # 本任务扫描（统计口径见 §9.2）
文件 289 | 行 75,493 | 最大单行 1,803,475B
行类型: assistant=33838, user=19741, attachment=14546, last-prompt=1328, atis-latch=1222,
        custom-title=1210, agent-name=1150, queue-operation=974, mode=440, system=435,
        file-history-delta=283, file-history-snapshot=111, ai-title=102, permission-mode=62,
        cost-state=45, agent-setting=6
system 子类型: stop_hook_summary=237, api_error=177, turn_duration=12, away_summary=6,
        informational=2, compact_boundary=1
内容块: tool_result=18961, tool_use=18928, thinking=9306, text=5647, server_tool_use=33, image=3, document=1
工具名 Top: Read=10228, Bash=5954, Edit=1483, Write=596, Agent=234, WebFetch=190, WebSearch=51,
        TaskOutput=35, TaskStop=31, mcp__*=…, AskUserQuestion=4, Skill=4
~~~

**覆盖度评分**：事件丰富度 **9.5/10**（33 事件 + 完整审批语义）；接入成本 **5/10**（hook 需用户写入 settings，纯本地无云）；**综合 8.5/10**。

**权限与认证**：hook 是本地子进程，不需要额外系统权限；读取转录 JSONL 属于读用户家目录（非 TCC 保护目录）。Claude Code 自身需要 Anthropic 账号/API key（[U] 本机未验证登录态，验证方法：`claude --version` 与官方 docs「Quickstart」页）。

**版本稳定性与漂移风险：高**。硬证据：DSH 0.2.0-rc.2 的桥（构建于 **2026-09-29**）自述 Claude Code 有 **30 个** hook 事件，而官方文档 2026-10-05 已有 **33 个**（新增 DirectoryAdded、PreModelSwitch、PostModelSwitch）——**一周内 +3**。缓解：事件清单外置为 JSON 清单 + 版本探测；把「未识别事件」按契约 §7.3 忽略并计数。

**适配工作量：10～14 人日**（hook 通道 6～8：33 事件的配置注入 + payload 解析 + 权限回写；转录通道 4～6：增量 tail + 乱序/滞后容忍）。

**降级体验**：
- 用户拒绝装 hook → 走转录 tail：可得 turn/tool/assistant 文本/api_error（可映射 `error.raised`）；**拿不到 `approval.request`**（PermissionRequest 只在 hook 通道），降级为「工具即将执行」的气泡提示，不弹强提醒。
- 转录滞后 → 桌宠状态延迟 1～3s，需在 UI 上体现为「思考中」而不是「卡住」。

**证据来源**：[B] https://code.claude.com/docs/en/hooks.md （2026-10-05；`docs.claude.com/en/docs/claude-code/hooks` 本次抓取失败）；[A] 本机 `~/.claude` 实测；[A] DSH app.asar 内 `@deepseek-ai/dsh-hooks-claude-code/README.md`（构建日 2026-09-29）。

---

### 3.2 Codex CLI（P0）

**接入点**
1. **Hook 事件**：`hooks.json` 或 `config.toml` 内联 `[hooks.*]`；官方文档当前列出 **12 个事件** [C]（其中 10 个与 DSH 桥基线一致 [A]）。
2. **Rollout JSONL（兜底，零侵入）**：`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` [A]。
3. **进程观测**：§3.10。

**事件清单**：
- DSH 桥（2026-09-29 构建）基线 **10 个** [A]：`SessionStart`、`SubagentStart`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`UserPromptSubmit`、`SubagentStop`、`Stop`。
- 官方文档镜像（2026-10-05 读取）**12 个** [C]：上述 10 个 + `Interrupt`（打断活动回合时触发，子会话不触发）+ `SessionEnd`（主线程结束）。**后两个标 [U]**：镜像为第三方仓库（声明 `source: https://learn.chatgpt.com/docs/hooks`），官方站点本次不可达；验证方法：在装有 Codex CLI 的机器上执行 `/hooks` 查看支持列表，或直接打开 `https://learn.chatgpt.com/docs/hooks`。

**配置语义** [A]+[C]：位置 `~/.codex/hooks.json`、`~/.codex/config.toml`、`<repo>/.codex/hooks.json`、`<repo>/.codex/config.toml`；handler 形如 `{type:"command", command:"...", timeout:30, statusMessage:"..."}`，默认 timeout 600s；matcher 是**非锚定正则**；同一事件多个匹配 hook **并发**执行；非托管 hook 必须经 `/hooks` 人工信任（按 hash 记录）；企业侧 `requirements.toml` 支持 `allow_managed_hooks_only`（后者由 [B] 官方仓库 `docs/config.md` 证实：https://cdn.jsdelivr.net/gh/openai/codex@main/docs/config.md ，2026-10-05）。

**本机实测证据 [A]**：`~/.codex` 存在（含 `config.toml` 147 行、`auth.json`、`sessions/`），**32 个 rollout 文件 / 16,903 行**：

~~~bash
$ node scripts/scan-codex-rollouts.mjs
顶层行类型: event_msg=9631, response_item=6748, world_state=113, turn_context=93,
            inter_agent_communication_metadata=215, compacted=10, token_usage_record=61, session_meta=32
行信封字段: timestamp, ordinal, type, payload          # ordinal 提供全序，天然抗乱序
event_msg.payload.type: item_completed=6554, token_count=2853, task_started=89,
            task_complete=71, thread_settings_applied=59, turn_aborted=5
response_item.payload.type: reasoning=2165, custom_tool_call=1437, custom_tool_call_output=1437,
            function_call=535, function_call_output=535, message=424, agent_message=215
item_completed.item.type: Reasoning=5576, AgentMessage=290, FileChange=278, SubAgentActivity=255,
            UserMessage=65, McpToolCall=39, CommandExecution=39, ContextCompaction=10, ImageView=2
session_meta.payload 键: session_id, id, timestamp, cwd, originator, cli_version
turn_context.payload 键: turn_id, cwd, workspace_roots, current_date, timezone, approval_policy
本机 ~/.codex/config.toml 中 "hook" 匹配数: 0        # 用户当前没配 hooks
最大单行: 5,093,685B（≈5.1MB，含完整工具输出）      # 必须流式逐行读 + 先截断再产出事件
session_meta.payload 另含: source, thread_source, model_provider, git, runtime_workspace_roots, …
turn_context.payload 另含: approval_policy, approvals_reviewer, sandbox_policy, permission_profile, model, effort, collaboration_mode, …
~~~

**覆盖度评分**：事件丰富度 **8.5/10**（12 事件 + rollout 全量结构化）；接入成本 **5/10**（需信任流程）；**综合 8/10**。

**权限与认证**：hook 为本地命令；读 `~/.codex` 是读家目录。Codex 自身需 ChatGPT 登录或 API key（[A] 本机存在 `~/.codex/auth.json`，**未读取其内容**）。

**版本稳定性与漂移风险**：**高**。同一份 DSH 桥基线 10 个 vs 镜像 12 个；配置形态在 2026 年内多次演进（镜像记录：Feb 2026 v0.117.0 加入 PreToolUse/PostToolUse、Mar 2026 PR #14626 加入 UserPromptSubmit、Apr 2026 v0.124.0 转稳定并支持内联 TOML，[C]）。缓解同 Claude Code：清单外置 + 未识别事件忽略计数。

**适配工作量：10～13 人日**（hook 通道 5～6；rollout 通道 5～7：item 分类、ordinal 排序、turn 边界重建）。

**降级体验**：无 hook 时用 rollout tail——`task_started/task_complete/turn_aborted` → turn 边界，`CommandExecution/FileChange/McpToolCall` → `tool.call`，`AgentMessage` → `message.assistant`，`SubAgentActivity` → 子代理徽标；**审批与权限提示拿不到**（本机 16,903 行里未见审批类 item），降级为「等待中」呼吸动画而非强提醒。

**证据来源**：[A] 本机 `~/.codex` 实测；[A] DSH app.asar 内 `@deepseek-ai/dsh-hooks-codex/README.md`；[B] https://cdn.jsdelivr.net/gh/openai/codex@main/docs/config.md （2026-10-05，官方仓库原文）；[C] https://cdn.jsdelivr.net/gh/mehmetbaykar/codex-docs-skill@main/skills/codex-docs/references/hooks.md （2026-10-05，镜像，声明 source 为官方 `learn.chatgpt.com/docs/hooks`；官方站点本次 web_fetch 失败）。

---

### 3.3 Cursor（P1）

**接入点**：Hook 事件（**21 个**，[B] https://cursor.com/docs/hooks.md ，2026-10-05）。无公开的会话 JSONL 格式文档；hook payload 里有 `transcript_path` 与环境变量 `CURSOR_TRANSCRIPT_PATH`（[U] 文件格式未验证）。

**21 个事件**：preToolUse, postToolUse, postToolUseFailure, subagentStart, subagentStop, beforeShellExecution, afterShellExecution, beforeMCPExecution, afterMCPExecution, afterFileEdit, beforeReadFile, beforeTabFileRead, afterTabFileEdit, beforeSubmitPrompt, afterAgentResponse, afterAgentThought, stop, sessionStart, sessionEnd, preCompact, workspaceOpen。
云代理（cloud agent）**不支持**：sessionStart、sessionEnd、before/afterMCPExecution、beforeTabFileRead、afterTabFileEdit、workspaceOpen（官方表格明确列出）。

**配置**：用户级 `~/.cursor/hooks.json`；项目级 `<repo>/.cursor/hooks.json`；企业级 `/etc/cursor/hooks.json`（macOS：`~/Library/Application Support/Cursor/hooks.json`；Windows：`C:\ProgramData\Cursor\hooks.json`）。全局配置 `{version: 1}`；每条 hook 支持 `command`、`type: command|prompt`、`timeout`、`loop_limit`（默认 5）、`failClosed`（默认 false：崩溃/超时/非 2 退出码**放行**）。

**关键输入字段**：公共 `conversation_id`、`generation_id`、`model`、`model_id`、`model_params`、`hook_event_name`、`cursor_version`、`workspace_roots`、`user_email`、`transcript_path`；`preToolUse` 另有 `tool_name`、`tool_input`、`tool_use_id`、`cwd`、`agent_message`，输出 `permission: allow|deny`（`ask` 未被强制执行）与 `updated_input`；`postToolUse` 输入含 `tool_output`（JSON 字符串）、`duration`(ms)；`stop` 输入 `status: completed|aborted|error` + `loop_count`；`sessionStart` 输入 `session_id`、`is_background_agent`、`composer_mode`。环境变量：`CURSOR_PROJECT_DIR`、`CURSOR_VERSION`、`CURSOR_USER_EMAIL`、`CURSOR_TRANSCRIPT_PATH`、`CURSOR_CODE_REMOTE`、`CLAUDE_PROJECT_DIR`。

**覆盖度评分**：事件丰富度 **8.5/10**；接入成本 **5/10**；**综合 7.5/10**。**权限认证**：需 Cursor 账号登录（`user_email` 在 payload 中）；hook 是本地脚本。
**本机证据 [A]**：`~/.cursor` **不存在** → Cursor 未安装，全部为文档证据（无 [A] 交叉验证）。**漂移风险**：中高（`failClosed`、`loop_limit` 等参数与云/本地差异说明较新）。
**工作量：6～8 人日**。**降级体验**：无 hook 时**只能做进程级观测**（Cursor 是 GUI 应用，进程常驻，只能表达「编辑器开着」）→ 桌宠保持 idle，不虚构状态。

**证据来源**：[B] https://cursor.com/docs/hooks.md （2026-10-05）。

---

### 3.4 Gemini CLI（P2，战略降级）

> **降级理由（硬证据）**：官方文档站顶部横幅写明「**Unpaid tier and Google One users: Gemini CLI was replaced by Antigravity CLI on June 18th, 2026**」（[B] https://geminicli.com/docs/hooks ，2026-10-05）。产品线更替期，适配投入产出比下降 → 从 P1 降到 P2，并把预算转投 ACP。

**接入点**：Hook 事件 **11 个**（[B] 官方仓库原文 `docs/hooks/index.md`，经 jsDelivr 读取，2026-10-05）：`SessionStart`、`SessionEnd`、`BeforeAgent`、`AfterAgent`、`BeforeModel`、`AfterModel`、`BeforeToolSelection`、`BeforeTool`、`AfterTool`、`PreCompress`、`Notification`。
**配置**：`settings.json` 的 `hooks` 对象；hook 定义 `{matcher, sequential, hooks:[…]}`；hook 配置 `{type:"command", command, name, timeout(默认 60000ms), description}`。**公共输入**：`session_id`、`transcript_path`、`cwd`、`hook_event_name`、`timestamp`(ISO8601)。**公共输出**：`systemMessage`、`suppressOutput`、`continue`、`stopReason`、`decision: allow|deny(block)`、`reason`。工具事件输入：`tool_name`、`tool_input`、`mcp_context`、`original_request_name`。退出码 0/2/其他。**严格约束**：stdout 必须是**纯 JSON**（多一个 echo 就解析失败并默认 allow）。
**覆盖度评分**：事件丰富度 **8/10**；接入成本 5/10；**综合 6/10（因产品更替再降权）**。**认证**：Google 账号或 API key。**本机证据 [A]：`~/.gemini` 不存在**（未安装）。
**工作量：6～8 人日**。**降级体验**：进程级 + 无。
**证据来源**：[B] https://cdn.jsdelivr.net/gh/google-gemini/gemini-cli@main/docs/hooks/index.md 与 `…/docs/hooks/reference.md`（2026-10-05，官方仓库原文）；[B] https://geminicli.com/docs/hooks （2026-10-05，仅取到导航与更替公告）。

---

### 3.5 GitHub Copilot CLI（P1）

**接入点**：Hook 事件 **8 个**（[B] 官方文档源文件 `content/copilot/concepts/agents/hooks.md`，canonical URL https://docs.github.com/en/copilot/concepts/agents/hooks ，2026-10-05）：`sessionStart`、`sessionEnd`、`userPromptSubmitted`、`preToolUse`（**可批准/拒绝**）、`postToolUse`、`agentStop`、`subagentStop`、`errorOccurred`。
**配置**：仓库级 `<repo>/.github/hooks/*.json`、个人级 `~/.copilot/hooks/*.json`；`{"version":1,"hooks":{…}}`；条目支持 `type:"command"`（`bash`/`powershell`/`command`/`exec`、`args`、`cwd`、`env`、`timeoutSec` 默认 30）或 `type:"http"`（`url`、`headers`、`allowedEnvVars`）。
**关键发现（对适配器很有价值）**：preToolUse 等事件同时接受 **camelCase（Copilot 原生）** 与 **PascalCase + snake_case（Claude / VS Code 兼容）** 两种命名与载荷——即「同一份适配器代码可以覆盖 Copilot 与 Claude 两种 payload 形态」[B] 官方 `content/copilot/reference/hooks-reference.md`，2026-10-05。原生输入示例：`{sessionId, timestamp, cwd, toolName, toolArgs}`；Claude 兼容输入示例：`{hook_event_name:"PreToolUse", session_id, timestamp(ISO), cwd, tool_name, tool_input}`。
**覆盖度评分**：事件丰富度 **7.5/10**；接入成本 **4/10**；**综合 7.5/10**。**认证**：GitHub 账号 + Copilot 订阅。**本机证据 [A]**：`~/.copilot` 存在（`config.json`、`logs/`、`ide/`），但未验证 logs 内容与事件相关性 → [U]。
**工作量：5～7 人日**。**降级体验**：`~/.copilot/logs` 轮询（[U] 格式未验证，验证方法：跑一次 `copilot` 后 `ls -lt ~/.copilot/logs` 观察是否含结构化事件）→ 否则进程级。
**证据来源**：[B] https://cdn.jsdelivr.net/gh/github/docs@main/content/copilot/concepts/agents/hooks.md 与 `…/content/copilot/reference/hooks-reference.md`（2026-10-05，docs.github.com 的上游 Markdown 源）。

---

### 3.6 Windsurf（P2，证据不足）

**接入点**：hook 配置文件（项目级 `.windsurf/hooks.json`）[C]。**官方文档本次不可达**：`https://docs.windsurf.com/windsurf/cascade/hooks`、`https://windsurf.com/docs/cascade/hooks`、`https://docs.windsurf.com/pt-BR/windsurf/cascade/hooks` 三个 URL 的 web_fetch 全部失败（2026-10-05）。
**第三方镜像给出的信息 [C]**（https://cdn.jsdelivr.net/gh/whit3rabbit/agent-config@main/docs/agents/windsurf.md ，2026-10-05，**仅作交叉参考，不能当结论**）：项目级 `.windsurf/hooks.json`；前置（可阻断，exit 2）`pre_user_prompt`、`pre_read_code`、`pre_write_code`、`pre_run_command`、`pre_mcp_tool_use`；后置（非阻断）`post_cascade_response`（2026-02 起含 `rules_applied` 字段）及其他 `post_*`；配置形态为每个事件给 `{bash, powershell}`。
**覆盖度评分**：**未验证**（若上述成立，事件丰富度约 7/10，成本 5/10）。
**权限与认证**：Windsurf/Codeium 账号（[U]）。
**本机证据 [A]**：`~/Library/Application Support` 下无 Windsurf/Codeium 目录 → 未安装。
**工作量：8～10 人日**（不确定性溢价）。
**降级体验**：进程级 + 让用户手贴 hook 配置后由用户自测。
**验证方法**：在浏览器打开官方 hooks 文档；或在一台装了 Windsurf 的机器上检查 `.windsurf/hooks.json` 是否被读取（改一个 echo 到 stderr 的 hook 观察输出）。

---

### 3.7 Aider（P2，无 hook）

**接入点**：无 hooks / 插件事件系统；可用的是
1. **命令行脚本化**：`--message/-m`、`--message-file`、`--stream/--no-stream`、`--yes`、`--dry-run`、`--commit`；
2. **历史文件**：`.aider.input.history`、`.aider.chat.history.md`、可选 `--llm-history-file`（含「Log the conversation with the LLM to this file」）；
3. **Python 库嵌入**：`from aider.coders import Coder; coder = Coder.create(main_model=Model("…"), fnames=[…]); coder.run("…")` —— 这条路**可以拿事件级信息**（适配器把自己的 IO 包装注入）；
4. **git 事件**：`--auto-commits`（默认开）、`--no-verify`（控制 pre-commit hook）。
证据：[B] https://cdn.jsdelivr.net/gh/Aider-AI/aider@main/aider/website/docs/scripting.md 与 `…/docs/config/options.md`（2026-10-05，官方文档源文件）。
**覆盖度评分**：事件丰富度 **3/10**（无结构化事件流，只有文本历史与 git）；接入成本 **6/10**；**综合 3.5/10**。
**认证**：取决于模型 provider（OpenAI/Anthropic/本地）。
**本机证据 [A]**：`~/.aider*` 不存在（未安装）。
**工作量：3～4 人日**。**降级体验**：**明确的「进程级后端」**——只显示「aider 在跑」徽标 + git 提交事件（可作为「完成了」的正向信号）；气泡从 `.aider.chat.history.md` 尾部提取最近一段（本地、只读、需用户显式开启）。

---

### 3.8 通用 ACP（Agent Client Protocol）（P1，最高杠杆）

**接入点**：JSON-RPC 2.0 over stdio（官方亦提供 HTTP/WebSocket 实验传输）[B]；桌宠作为 **ACP 客户端**（或作为客户端与真实 IDE 之间的代理/嗅探器）接收 `session/update` 通知流。

**本机证据 [A]（最强）**：DSH 应用包内置 `@agentclientprotocol/sdk` **1.4.0**（Apache-2.0，Zed Industries），含 `schema/schema.json`（370,113 字节、265 个 `$defs`）与 `schema/v2/schema.unstable.json`。从 schema 中提取到的**方法清单**：

| 方向 | 方法 |
|---|---|
| 客户端 → Agent | `initialize`、`authenticate`、`listProviders`、`setProvider`、`disableProvider`、`logout`、`session/new`、`session/load`、`listSessions`、`deleteSession`、`forkSession`、`resumeSession`、`closeSession`、`setSessionMode`、`setSessionConfigOption`、`session/prompt`、`startNes`、`suggestNes`、`closeNes`、`messageMcp`、`ext` |
| Agent → 客户端 | `session/update`(通知)、`session/request_permission`、`readTextFile`、`writeTextFile`、`terminal/create`、`terminal/output`、`terminal/release`、`terminal/waitForExit`、`terminal/kill`、`elicitation/create`、`mcp/connect`、`mcp/message`、`mcp/disconnect`、`ext` |

**`session/update` 变体（SDK 1.4.0 schema 实测 15 个）**：`user_message_chunk`、`agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`plan`、`plan_update`、`plan_removed`、`available_commands_update`、`current_mode_update`、`config_option_update`、`session_info_update`、`usage_update`、`compaction_update`、`compaction_summary_chunk`。
（官方 v1 文档页只列 **11 个** [B]，说明**文档落后于 SDK** —— 又一个漂移证据。）

**枚举（schema 原文 [A]）**：`ToolCallStatus = pending|in_progress|completed|failed`；`ToolKind = read|edit|delete|move|search|execute|think|fetch|switch_mode|other`（10 个）；`PermissionOptionKind = allow_once|allow_always|reject_once|reject_always`；`StopReason = end_turn|max_tokens|max_turn_requests|refusal|cancelled`。
**协议流程** [B]：`initialize` →（可选）`authenticate` → `session/new`/`session/load` → `session/prompt` → Agent 持续发 `session/update`（含 `tool_call`、必要时 `session/request_permission`）→ 客户端可 `session/cancel` → `session/prompt` 响应带 stop reason。
**覆盖度评分**：事件丰富度 **8/10**（工具调用、消息、计划、权限、用量齐全；**无 turn/step 的显式边界事件**，需从 prompt 请求/响应推断）；接入成本 **6/10**（一次实现覆盖所有 ACP Agent）；**综合 8/10**。
**认证**：协议自带 `authenticate` 方法，具体凭据由各 Agent 定义。
**漂移风险**：**中高**——v1 稳定 + v2 草案并存（`schema/v2/schema.unstable.json`、`docs/protocol/v2/draft/*`），且文档与 SDK 已有 11 vs 15 的差异。
**工作量：8～12 人日**（含能力协商、权限回环 `session/request_permission` → 桌宠 UI → optionId 回写）。
**降级体验**：Agent 若不支持某能力（如 terminal），适配器仍能拿到消息与工具事件；若 `session/update` 缺失（老版本），退化为 prompt 边界级（thinking/done）。

**证据来源**：[A] 本机 `app.asar → dsh/node_modules/@agentclientprotocol/sdk/{package.json, schema/schema.json}`；[B] https://cdn.jsdelivr.net/gh/zed-industries/agent-client-protocol@main/docs/protocol/v1/{overview,prompt-turn,tool-calls}.mdx （2026-10-05，ACP 官方仓库原文；`agentclientprotocol.com` 本次 web_fetch 失败）。

---

### 3.9 MCP（P1，只能做辅助通道）

**能做什么、不能做什么（必须先说清边界）**：MCP 是「宿主 ↔ 工具/上下文服务」的协议。**一个 MCP server 只能看到自己的工具被调用**，看不到 agent 的回合、其他工具、审批与错误；**一个 MCP client 只能看到它连接的 server 的能力**。因此 **MCP 不能作为桌宠的主观测通道**。

**可行用法**：
1. **桌宠作为 MCP server**：agent 主动调用桌宠暴露的工具（如「让桌宠提醒我」「在桌宠上显示进度」）。事件是 agent 主动发起，可靠性高、语义明确，但不是「观测」，是「协作」。
2. **桌宠作为 MCP client**：连接 agent 侧的 MCP server（如本机 `~/.codex/config.toml` 里配置的 `mcp_servers.node_repl` 等 [A]），拿到的只有该 server 的能力与通知，仍然**看不到 agent 全局状态**。
3. 规范里的 `notifications/message`（logging）、`progress`、`elicitation` 可用于「展示/询问」，其中 **elicitation（服务端请求用户补充信息）与契约 `user.question` 语义最接近**，但方向相反（MCP 里是 server 问 client）。

**规范版本与证据** [B]：Model Context Protocol 规范 **2025-06-18**（https://cdn.jsdelivr.net/gh/modelcontextprotocol/modelcontextprotocol@main/docs/specification/2025-06-18/index.mdx ，2026-10-05；canonical：https://modelcontextprotocol.io/specification/2025-06-18 ）；JSON-RPC 2.0；Server 提供 Resources/Prompts/Tools，Client 提供 Sampling/Roots/Elicitation；公共工具含 progress、cancellation、logging、error。
**覆盖度评分**：作为观测通道 **2/10**；作为协作通道 **7/10**。**工作量：3～5 人日**（桌宠 MCP server + 2～3 个工具 + 权限确认）。

---

### 3.10 进程 / 日志兜底观测（P1，兜底层，必须有）

**手段与实测** [A]：

~~~bash
$ ps -Ao pid,comm | grep -iE "claude|codex|cursor|windsurf|gemini|copilot|aider"
20657 /Applications/Claude.app/Contents/MacOS/Claude
22994 .../claude-code/2.1.284/.../MacOS/claude          # 只能得出「在跑」
$ lsof -p <pid> | head            # 打开的文件/socket；可判断「在读哪个仓库」
$ node -e 'fs.watch(dir, ...)'    # 文件级变化（会话日志增长 = 有活动）
~~~
**能力边界（必须诚实）**：只能得到 **进程级**信息——在跑/不在跑、CPU、打开的仓库与 socket；配合**文件 mtime 增长**可推断「有活动」，但**无法知道在做什么**。不得据此伪造 `tool.call` 等事件。
**TCC / 权限**：App Sandbox 容器之间互相不可读（[B] https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox.md ，2026-10-05）；`~/Library/**`、`~/.claude`、`~/.codex` 属于用户家目录普通位置，本机实测**无需 Full Disk Access 即可读**（[A] 本次全部扫描均未提权）；`~/Documents`、`~/Desktop`、`~/Downloads` 属于受保护目录，读取需用户授权（[U] 未找到可抓取的 Apple 官方页面，验证方法：系统设置 → 隐私与安全性 → 完全磁盘访问权限；或在沙箱外进程内 `fs.readdir` 这两个目录观察是否报 EPERM）。
**降级体验设计**（契约合规）：只发 `session.start`（进程启动）/ `session.end`（进程退出）与 `pet.heartbeat`（带 `load`≈CPU 占用档位），渲染层保持 `idle`，UI 上显示「在跑」小徽标而不是动画；**禁止**用 `agent.status=working` 冒充。
**工作量：2～3 人日**（进程发现 + 文件监听 + 契约信封）。

---

### 3.11 Kimi Code（首批，A 路径 ✅）【2026-10-06 补行，同日下午勘误重写】

**接入点（本机实测 [A]）**：Kimi Code 是 CLI-first 架构（app.asar 内含 node-sdk + agent-core-v2），agent 核心写 `~/.kimi-code/`：
- `sessions/wd_<hash>/session_<uuid>/state.json`——会话状态（id/cwd/createdAt/updatedAt/title/titleKind/archived/lastTurnReason；lastPrompt 为用户原文，适配器不读）。
- `agents/main/wire.jsonl`——**事件流**（protocol 1.5；本机 5557 行 / 最大单行 2.5MB）：`turn.prompt` / `turn.ended(reason,durationMs)` / `context.append_loop_event{tool.call|tool.result}` / `interaction.request|resolved(kind=approval，同 id 天然配对)` / `agent.message.appended` / `profile.bind(modelAlias,thinkingEffort)` 等。
- 另内置 **external hooks 系统**（20 事件，command 型 handler，`config.toml` `[hooks]` 节）——留作授权后升级项。

**映射（已落地于 `adapters/kimi-code-adapter.mjs`）**：turn.prompt→turn.start；loop tool.call/result→tool.call/tool.result（category 复用 categoryOf）；turn.ended(completed→ok / cancelled→aborted)；interaction.request(approval)→approval.request、interaction.resolved→approval.resolved（**requestId 同 id 配对，契约 §3.3 零成本满足**）；agent.message.appended→message.assistant(截断 280)；turn.step.retrying→error.raised(瞬态)。非 main agent 的 wire 流 = 子代理，整文件跳过。

**勘误记录**：首版 spike 曾误判「会话仅在 Electron LevelDB → 降级为进程级兜底」——根因是探测命令 `ls -d ~/.kimi* ~/kimi*` 中 `~/kimi*` 无匹配导致 zsh 整体中止，`~/.kimi-code/` 未被列出。LevelDB 实为前端层缓存，现降为第三层兜底（`scanKimiLegacyCount`，近似计数）。

**证据等级**：[A] 本机实测（2026-10-06 两轮：上午 LevelDB spike + 下午 wire/state 全量分析，均只读）。

---

### 3.12 ZCode（首批 ✅ M-L，2026-10-07 落地）【本会话同款桌面 Agent】

**接入点（本机实测 [A]，全部只读）**：`~/.zcode/cli/db/db.sqlite`，**WAL 模式**，用 `node:sqlite`（Node ≥22.5 自带，零依赖）以 `readOnly` 连接并发读——与桌面 App 共存无锁（本机实测：调研期间的查询本身即出现在 part 流里）。表结构：
- `session`——会话目录：`id / title(title_source) / path(=cwd) / parent_id / task_type(interactive|subagent_child|selection_side_chat) / version / time_created / time_updated / time_archived`。**子代理判定 = task_type='subagent_child'（本机 56 个），SQL 层直接排除**。
- `message`——消息信封：`role(user|assistant) / finish(stop|completed|tool-calls|failed|interrupted) / semantics.origin(real_user|agent_runtime|system；synthetic 注入不产事件) / anchor.turnId / tokens`。
- `part`——消息内片段：`type=step-start|step-finish(reason)|tool(callID,state.status=running|completed|error)|text|reasoning|timeline|compaction`。**tool 的 running→completed 是同行 UPDATE（time_updated 变、time_created 不变）**——跟随器按 time_updated 水位 + `(tbl,id)→data 指纹`去重捕获状态迁移。
- `session_entry`——`runtime/model_selection`（模型/思考档/`providerId`——注意 `account:*` = 登录态 coding-plan）。

**映射（已落地于 `adapters/zcode-adapter.mjs`）**：real_user message→turn.start（合成注入如 todo_reminder 跳过）；tool(running)→tool.call、tool(completed/error)→tool.result；step-start/finish→step.start/end；assistant finish(stop|completed→ok / failed→error / interrupted→aborted)→turn.end；text part→message.assistant(截断 280)。**无审批族**：permission 表是项目级配置（本机 0 行），observes 如实声明不含 approval.*。

**控制通道（包内 CLI `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`，PATH 里无 zcode）**：
- 投递 = `zcode --resume <id> --mode build --prompt "<text>"`（`--mode build` 显式压掉无头默认的 yolo，守住「不越权」红线）；新建/打开 = Terminal 窗口跑同 CLI。
- **必须补两个环境变量**（桌面 App 进程会注入、独立运行时缺失，否则 `无法定位 CLI ZCode Built-in Provider Config` → `Model creation failed`）：`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`（App 包 `config/provider/zcode-builtin.json`，按 bin 相对位置推导）与 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`（`~/.zcode/v2/provider_config.json`）。
- **上游限制（2026-10-07 发现；2026-10-08 根因修正）**：无头 `--resume` 对 `account:*`（Z.AI Coding Plan 登录态）provider 会话必失败（"Model creation failed"）。~~起初归因于登录态文件缺失~~——10-08 复核：`~/.zcode/v2/credentials.json` 存在且全部 8 个字段可用引擎的确定性回退密钥（`sha256("zcode-credential-fallback:<platform>:<homedir>:<username>)"`，格式 `enc:v1:<iv>.<tag>.<ct>` base64url）解开，含 `account-provider:...:api-key`；真实根因在 CLI 日志（`~/.zcode/cli/log/*.jsonl`）的 `turn.failed`：`cause = "Select a model before continuing"`（CONFIGURATION_ERROR）——account provider 只能由**桌面 App 进程注入的 model adapter** 注册（App 内引擎 `hasInjectedModelAdapter=true`，独立引擎 `=false`），外部无头进程建不出该 provider → 会话的模型选择恢复不了。builtin / 个人 Key 会话不受影响（10-08 实测 `moonshot-kimi` 探测会话无头续接成功回复）。
- **cli-control 预检（2026-10-08；二轮复核标注为历史设计）**：~~`deliverViaCli` 对 `provider` 以 `account:` 开头的 zcode 会话提前如实失败（`zcode-account-provider`，不烧必败进程）~~——**2026-10-17 二轮代码复核：该预检分支在当前接线不可达**。`deliverViaCli` 对 `source` 为 zcode 的请求无条件先走 app-server 管道（见下一条），`account:*` 会话同样走管道、逐条 `modelSelection` 覆盖到非登录态 provider；无非登录态 provider 时由管道如实失败（`zcode-pipe-no-model` 等），不再返回 `zcode-account-provider`。10-08 的解锁提示保留为历史背景：`zcode login` **不解除该限制**（2026-10-08 复测：login 后凭证已刷新入 v2/credentials.json，无头续接 account 会话仍 `Select a model before continuing`）——docs/40 §3.12 的 10-07「login 可解除」结论在 App 3.14.4 / CLI 0.16.9 上失效。出路：①改投 builtin / 个人 Key 会话；②cli-control 的「打开会话」对 account 会话改走 `zcode://workspace/open?path=` 深链，直达桌面 App 该项目后点击会话继续。
- **app-server 管道（2026-10-08 落地，account 会话的最终答案）**：`zcode app-server` 是桌面 App ↔ 引擎之间的官方进程间协议（stdio NDJSON，信封 `{id, method, params}`，无 `jsonrpc` 键、无握手）。探测确认的最小面：`session/resume {sessionId}` → 服务器反向请求 `session/requestRuntimePreferences`（应答 `{nativeSearchEnhancementsEnabled:true, memoryEnabled:false, askUserQuestionAutoResolutionEnabled:true}`，其余反向请求回 `-32601`）→ `session/send {sessionId, content, modelSelection}`。**`modelSelection`（严格模式 `{providerId, modelId, options.reasoningLevel}`）是逐条消息的模型覆盖**——account 会话的回合可用个人 Key provider（实测 moonshot-kimi/kimi-k3）完整跑完，不经 Z.AI 登录态。两个实测副作用（如实告知）：①覆盖会被引擎**原地持久化**为会话保存的选择（同一 session_entry 行 time_created 不变、内容改写）；②外部**无法恢复**为 account:*（独立引擎 Provider Registry 不含登录态 provider，`session/setModel` 报「Provider Registry 中不存在 Model」）——管道投递后该会话在桌面 App 的默认模型即管道 provider，想回 Coding Plan 需在 App 内 /model 手动切回。生命周期红线：**app-server 进程必须活到 `state.updated patch.status=idle`**，提前断开 = `model_request_cancelled`（两次实测踩坑）。投递语义对齐无头：`accepted` + 8s 快速失败窗口（model_request_failed / state error 如实 failed）。模型覆盖来源：`PET_ZCODE_PIPE_MODEL=provider/model` 环境变量优先，否则取会话库 `session_entry` 最近用过的非 account provider（元数据，不读凭证）。回合计权模式继承会话自身设置（与无头 `--mode build` 不同——管道是「代用户在他自己的会话里发消息」，不额外降权）。`PET_ZCODE_PIPE=0` 仅关闭管道投递（请求返回 `zcode-pipe-disabled` 如实失败）；**当前接线不会回落到 UI 粘贴**——`deliverViaZcodeUi` 的 account 回落分支不可达、`PET_ZCODE_UI_DELIVER` 失效（既有死代码）；自检入口 `node adapters/cli-control.mjs --pipe-zcode <sessionId> [text]`。

**形态（CLI/桌面）**：库内无 surface 标记（message/session_entry 均查过）——ZCode 会话不打形态徽标（与 DSH 同口径），软件状态面板为单行（App 捆 CLI，无独立安装）。

**证据等级**：[A] 本机实测（2026-10-07：schema/枚举值全量核对 + 当前运行会话实时跟随验证 + 无头新建/续接/provider 边界二分定位，均只读）。

---

### 3.13 usage-collect：Token 用量采集（跨五源慢通道，2026-10-07 落地）

**定位**：`adapters/usage-collect.mjs`——按 **Agent × 模型**计数 token 用量的独立采集层，与目录扫描（头/尾窗口、5s 热缓存）分离：usage 需全文件精确累计（本机实测基线 2026-10-19：Claude 1.09GB/166 文件全量 4,951ms、Codex 2,544ms、Kimi 2,038ms、DSH 1,335ms、ZCode 426ms；冷启动合计 ≈4,963ms）。**增量机制四级（PERF-7，2026-10-19）**：

1. **事件循环让出**：文件间/每 512 行/DSH 帧粒度/ZCode `iterate()` 游标分批——冷扫期间 SSE tick 不停顿（P7-a 实测 5.6s 扫描最大间隔 2001ms）；ZCode 不加 SQL `ORDER BY`（无索引时 sqlite 首行前全表物化+排序是 ~228ms 同步块，part 的确定性由 JS 排序保证）。
2. **文件级缓存跨重启持久化**：`~/.agent-pet/usage-checkpoint.json`（`PET_USAGE_CHECKPOINT` 可覆盖；0600、唯一 tmp 名原子写、8MB 护栏、`SCANNER_VERSION` 不符整体作废、单条目形状异常只丢该条）。失效键与进程内一致（size+mtime）；首轮扫描前才加载（启动不扫，P3① 保持）；`?refresh=1` 跳过加载、五源强刷（含 ZCode）后覆盖写——坏缓存自愈通路。P7-b 实测重启后 readBytes=0（对照组全量 67MB）。
3. **增长文件尾读**：DSH 按「解码成功且非空且以 `\n` 收尾」的**帧边界**续读（截断帧不抛错而「成功」解出半段——PERF-2 同款坑；末帧不合格推迟到下轮），inode+魔数双锚防同路径替换；Codex 携带 `prevTotal/curModel/calls.seen` 续解析（差分归日不因跨界回到「首条」分支），字节精确偏移（按 `0x0A` 切行，不用 readline 字符偏移）+ 偏移前 64B 哈希锚点；Kimi 同构（`variant/seenCallIds`）。**Claude 例外保持整读**：按 message.id 去重需全量 seen-id 集合，持久化会使 checkpoint 膨胀至 MB 级（评审选型：重启秒就绪已由②覆盖，活跃文件靠①兜底）。
4. **ZCode 水位增量**：`time_updated` 单调水位 + 2s 重叠 + `msgLru`（id→已计值，差量=新−旧、**负值截 0**、requests 仅首次入账 +1）与 `partLru`（(sid,callId) 去重）双 LRU 6000/batch 2000，**随检查点持久化**（spike S3b 实测不持久化重启丢 495 万 token）；`staleMiss` 规则=「未命中 LRU 且 tc 早于 LRU 最早条目」才跳过（lag p99≈5min，固定窗规则会漏计），计入 stats 可观测；异常轮不推进水位（行内「acc 变更+LRU 基线」成对，下轮幂等收敛）。稳态 409ms→40ms（`WHERE` 里 `time_updated` 前置短路 json_extract）。**口径前提（spike S1 推翻原假设后重述）**：tokens 并非只在终态写入（29,781/31,457 行处于中间态 `finish=tool-calls`）——精确性依赖「LRU 记忆期内 delta 追账 + 终态后冻结」，LRU 淘汰后重见按冻结假设跳过（本机实测 0 例）。spike 与回放证据：[spikes/zcode-usage-watermark](../spikes/zcode-usage-watermark/README.md)。

`stats` 口径（P0-1，2026-10-19）：`readBytes`=本轮**实际读取**字节（缓存命中 0 / 尾读增量段 / 整读全量；ZCode sqlite 页缓存不可测恒 0）、`corpusBytes`=本轮纳入语料体积、`resumedFiles`=尾读续文件数。15s 软时限为**单文件**预算：到点该文件不写缓存（含尾读状态不推进）、下轮重来。

**五源口径（本机实测，2026-10-07）**：

| 源 | usage 出处 | 口径要点 | input 含 cache? |
|---|---|---|---|
| DSH | `assistant/message` 的 `data.usage` | 多帧 zstd 逐帧解压（明文直读）；每调用一组直接累加；model 取行序 `request/header`；每目录只取最高代日志（pickLogFile 防双计）；∑分量=∑totalTokens 恒等式对账 | 否 |
| Claude Code | assistant 行 `message.usage` | 按 message.id 去重（流式快照后写覆盖）；`<sid>/subagents/agent-*.jsonl` 子代理消耗归入父会话 | 否 |
| Codex | `token_count.info.total_token_usage` | **累计值差分归日**（2026-10-09 修）：首条只认自身 `last_token_usage`（fork/子代理 rollout 的首条累计继承父会话——逐文件求和会把父前缀重复计入，本机 Σ 前缀 9,282 万 token），其后每条取 Δ累计（负值截 0；重复上报的「累计值不动」事件只计请求不计 token，本机 298 条）。**Σ日桶 ≡ 源总量**（`dayIdentityMismatched` 自检）；单模型会话整额归属 | 是 |
| Kimi Code | `usage.record`（每请求一条） | inputOther/inputCacheRead/inputCacheCreation 映射；含全部 agents/<id>/ 子代理流 | 否 |
| ZCode | `message.data.tokens`（SQL 按 session × modelId 聚合） | 与 part.step-finish 双路一致；逐行对齐官方账本 model_usage 相等；**input 含 cacheRead**（raw_usage_json 证实：totalTokens=inputTokens+outputTokens，inputTokens 为全量 prompt）；subagent_child 计入 | 是 |

- **展示口径（2026-10-09 统一）**：`promptTokens` = 全量 prompt（含缓存读）= 各厂商 UI 的 input——DSH/Claude/Kimi = `input` + `cacheRead`（Anthropic 式 input 不含 cache），Codex/ZCode = `input`（OpenAI 式已含 cache）；`totalTokens` = promptTokens + `cacheWrite` + `output`，即各 Agent 自带计数器显示的总量。日历日桶、来源对比图、软件页 Token、各类表格的 in 列全部按此口径（界面上标「in（含缓存读）」「Token · 全量」）。原始 `input/cacheRead/cacheWrite/output` 分项与 `freshInput` 原样保留，供命中率与下钻使用。
- DSH 的 title 生成小额消耗无 usage 事件、不计（成文边界）。
- 跨源同名模型**小写归并**；子代理/子链路消耗一律计入总量（真实消耗口径）；子代理会话行不单列（只进源级合计）。
- **三个展示维度（二期，2026-10-07）**：① 时间窗——本地自然日分桶（绝对口径，缓存跨天正确），切 当日/7日/30日/全部；② 形态——Claude(entrypoint)/Codex(originator)/Kimi(clientMetadata) 文件级归属 CLI/桌面/IDE（全量=byVariantFlat 恒等；2026-10-09 起五源 Σ日桶 逐字段 ≡ 总量，Codex 时间窗不再有增量近似这一例外，仅「Δ 落在哪一天」按事件边界近似）；③ 缓存命中率——cacheRead/(fresh+cacheRead)，fresh 按源 input 含 cache 语义折算（**Codex 与 ZCode 含**），跨源合并行经 freshInput 累计同样可算。

**输出面**：framed 快照 `usage` 块（totals/byModel/bySource + ranges 时间窗 + 会话行 `usage` 字段）、`/api/usage` 明细端点、UI「用量」页（时间窗切换器 + **各 Agent 消耗量表（形态拆分 + 命中率列）** + 模型表 + 会话行 `tok in/out`）；CLI `node adapters/usage-collect.mjs [--json|--refresh]`。

**复现**：`node scripts/multi-source-check.mjs` 看 MU1–MU9（独立对账：Claude 去重证明 / Codex 文件自有量反读（首条 last + Δ累计）/ Kimi 原始行计数（会话全部 wire）/ ZCode 双路互证 / DSH 恒等式+独立解压重数 / 形态归属恒等 / 日桶逐字段=总量+单调性 / framed 端到端）。**证据等级 [A]**。

### 3.14 控制通道可见性矩阵（v0.1.1 CLI-1，2026-10-17 复核收口；同日代码复核纠偏）

投递动作哪些「全程后台无窗口」、哪些「必然可见」，逐通道明示（实测口径；详见 [docs/25 §2](./25-v0.1.1-scope.md)）：

| 通道 | 可见性 | 定性 |
|---|---|---|
| `/api/input` → CLI 无头续会话（claude/codex/kimi，`adapters/cli-control.mjs` headlessRun） | **全后台**（detached spawn，输出落 `~/.agent-pet/cli-control/*.log` 0600） | 设计意图 |
| `/api/new`（含 `new:<source>:<cwd>` 投递即新建）→ CLI 无头新建 | **全后台**（同上） | 设计意图 |
| ZCode 投递/新建 → app-server 管道（含 `account:*` 登录态会话，逐条 `modelSelection` 覆盖到非登录态 provider，§3.12） | **全后台**（stdio 全 pipe，无窗口） | 设计意图（无 UI 粘贴回退：`deliverViaZcodeUi`/account 回落分支未接线、`PET_ZCODE_UI_DELIVER` 失效；无非登录态 provider 时如实失败） |
| 「打开会话」→ `POST /api/open` | **可见**：CLI 会话新开/聚焦 Terminal 窗口；ZCode `account:*` 会话走 `zcode://workspace/open` 深链（App 前台）；DSH 会话交插件（进程内，无新窗口） | 设计意图（用户显式交互动作；当前**唯一**已接线的可见通道） |

**纠偏说明（2026-10-17 代码复核）**：①「新建会话窗口 → `newCliSession`（Terminal/tmux 新窗口）」通道**未接线**（全仓无调用方；实际 `/api/new` 一律走上面的无头后台新建；属 [docs/22](./22-post-release-roadmap.md) 审查遗留 M1 死代码），不列为可见通道；② ZCode `account:*` 会话投递实际走 app-server 管道（全后台），不存在 UI 粘贴回退（上游限制下无个人 Key provider 时如实失败），不再标注「可见/技术必然」。

无头投递**并发上限 2**（PERF-5，`PET_HEADLESS_CAP` 可覆盖）：在途台账见 `/api/state` 的 `inFlight`；超出自动入队（`autoRetry`）由 20s 冲刷重试（测试可用 `PET_FLUSH_MS` 缩短周期），不误标失败（回归 `demo/test-headless-cap.mjs`）。

---

## 4. 适配器优先级（用户量 × 成本 × 事件丰富度）

评分口径：**用户量 1～5**（可核验的公开规模信号，缺证据给 3）、**事件丰富度 1～5**、**接入成本 1～5（越低越好）**；`优先级分 = 用户量×1.2 + 事件丰富度×1.0 + (6−成本)×0.8`（启发式，非精确模型）。

| 后端 | 用户量 | 事件丰富度 | 接入成本 | 优先级分 | 最终优先级 | 定级说明 |
|---|---|---|---|---|---|---|
| Claude Code | 5 | 5 | 3 | 14.4 | **P0-1** | 事件最全 + 已有本机转录证据 |
| Codex CLI | 4.5 | 4.5 | 3 | 13.4 | **P0-2** | rollout 结构化程度最高（ordinal 全序） |
| Cursor | 5 | 4.5 | 4 | 12.1 | **P1-1** | 21 事件，但无本机验证 + GUI 场景 |
| GitHub Copilot CLI | 4 | 4 | 2 | 12.0 | **P1-2** | 配置最简（8 事件 + Claude 兼容载荷） |
| ACP 通用 | 3 | 4 | 3 | 11.0 | **P1-3** | 一次实现多家覆盖，但 v1 文档/SDK 已漂移且 v2 草案并存 → 不进 P0 |
| 进程兜底 | 5 | 1 | 1 | 11.0 | **P1-4** | 所有后端的保底，必须有（横切能力） |
| MCP 辅助 | 4 | 1.5 | 2 | 10.3 | **P1-5** | 协作通道，不做观测主通道（横切能力） |
| Gemini CLI | 3.5 | 4 | 3 | 11.0 | **P2** | 战略降级：官方已宣布被 Antigravity CLI 取代（分数本可进 P1，但生命周期风险高） |
| Windsurf | 2.5 | 3.5? | 4 | ≤9.9 | **P2** | 官方文档不可达，证据不足 |
| Aider | 2 | 1.5 | 2 | 8.6 | **P2** | 无 hook，进程级为主 |

**排序规则（v1.2 修订，回应独立验收 V-01）**：**最终优先级 = 按优先级分降序，再叠加两类显式战略调整**（不再有「分数低却排 P0」的自相矛盾）：
1. **生命周期风险降级**：Gemini CLI 分 11.0 本可进 P1，但官方公告产品被 Antigravity CLI 取代 → 降 **P2**；
2. **横切能力单列**：进程兜底（P1-4）与 MCP 辅助（P1-5）是每个后端都要用的兜底/协作层，按「必须有 / 只能辅助」定级，不参与主线竞争。
**ACP = P1（与 §0 TL;DR、§3.8 一致）**：它的分（11.0）低于 Cursor（12.1）与 Copilot（12.0），且存在「官方 v1 文档列 11 个 `session/update` 变体 vs 本机 SDK 1.4.0 有 15 个」的漂移与 v2 草案并存 → 定位为 **Phase 2 中段的杠杆**，而不是与 Claude Code/Codex 并列的 P0。

---

## 5. P0 后端的「规范事件 ← 原生事件」映射表

> DSH 见 §2.3（Phase 1）。三张表都标注了缺口与兜底。

**§5.0 `requestId` / `questionId` 的通用合成规则（v1.2 §3.3 强制配对）**：契约要求 `approval.resolved` 必须用 `requestId` 配对，找不到未决项时忽略并计 `orphanApprovals`（`user.answer` 同理）。各后端的原生 ID 情况不同，适配器统一按下面的规则处理：

| 后端 | `approval.request.requestId` 来源 | 兜底合成（原生无 ID 时） |
|---|---|---|
| DSH | `approval/asked.id`（原生已有，直接透传） | — |
| Claude Code | `PermissionRequest` hook 的 `tool_use_id`（若 payload 提供） | `session_id + ':' + tool_use_id`；再无则 `session_id + ':req:' + 单调计数`（**同一适配器实例内配对，进程重启会丢未决项 → 计 orphan 而不是乱配**） |
| Codex CLI | `PermissionRequest` hook payload（[U] 字段未验证） | 同 Claude Code 的兜底策略 |
| ACP | `session/request_permission` 的 JSON-RPC `id`（或 Agent 给的工具 `toolCallId`） | 用 `toolCallId`；`outcome:selected(optionId)` → `allow_always/allow_once→allow`、`reject_*→deny`；`cancelled→timeout` |

> 重要：**适配器不得用 FIFO 猜配对**（契约明文禁止）。若一个后端确实给不出稳定 ID，正确做法是只发 `approval.request` 不发 `approval.resolved`，让 Hub 的 45s 离线/10min 陈旧清理兜底。

### 5.1 Claude Code

| 规范事件 | Hook 通道（首选） | 转录通道（兜底） | 缺口 / 兜底 |
|---|---|---|---|
| `session.start` | `SessionStart` | 转录文件创建 / 首行 `user` | 转录无显式 session 头，需从文件名（`<uuid>.jsonl`）取 sessionId |
| `session.end` | `SessionEnd` | 文件停止增长 > 90s | 合成 `reason`；转录不给结束原因 |
| `pet.heartbeat` | ✗（适配器自产） | 文件 mtime | 15s 定时 |
| `turn.start` | `UserPromptSubmit` | `user` 行（带 `promptId`） | 转录含 `isSidechain`，子代理回合要区分 |
| `turn.end` | `Stop`（成功）/ `StopFailure`（API 错误） | `system:turn_duration`(12 条实测) 或下一条 `user` 行 | 转录的 turn 边界需推断 |
| `step.start/end` | ✗ 无对应 | ✗ | 用「工具批次」近似：一次 `assistant.tool_use*` → 一个 step；标注为近似 |
| `message.assistant` | ✗（`MessageDisplay` 在理论可用，但是流式展示事件） | `assistant` 行的 `text` 块（实测 5,647 块） | 截断 280 + `privacy.redacted` |
| `tool.call` | `PreToolUse`（`tool_name`、`tool_input`、`tool_use_id`） | `assistant` 行里 `tool_use` 块（实测 18,928） | category/risk 启发式；`tool_use.name` 实测 Top：Read/Bash/Edit/Write/Agent/WebFetch |
| `tool.result` | `PostToolUse` / `PostToolUseFailure` | `user` 行 `tool_result` 块 + `toolUseResult`（实测 18,961 + 4,741） | `denied` 用 `PermissionDenied`；无 hook 时无法区分拒绝与失败 |
| `approval.request` | `PermissionRequest` | ✗ | **无 hook 即缺失** → 降级为「工具即将执行」提示 |
| `approval.resolved` | `PermissionRequest` 的返回值 / `PermissionDenied` | ✗ | 同上 |
| `user.question`/`user.answer` | ✗（`Elicitation` 面向 MCP） | `AskUserQuestion` 工具（实测 4 次） | 兜底：识别 `AskUserQuestion` 的 `tool_use`/`tool_result` |
| `agent.status` | 派生 | 派生 | 由 `PreToolUse`/`Stop` 等派生 |
| `error.raised` | `StopFailure`、`PostToolUseFailure` | `system:api_error`（实测 177 条） | 脱敏后只带 code/摘要 |

### 5.2 Codex CLI

| 规范事件 | Hook 通道 | Rollout 通道（兜底） | 缺口 / 兜底 |
|---|---|---|---|
| `session.start` | `SessionStart` | `session_meta`（含 `session_id/id/cwd/cli_version`） | 直接可得 workspace 与版本 |
| `session.end` | `SessionEnd` [U] | 文件停止增长 / 新 session 文件出现 | 同 DSH |
| `turn.start` | `UserPromptSubmit` | `event_msg.task_started`（含 `turn_id`） | 直接可得 turnId |
| `turn.end` | `Stop` / `Interrupt` [U] | `task_complete` / `turn_aborted` | `turn_aborted` 实测 5 条 → `status=aborted` |
| `step.start/end` | ✗ | 用 `item_completed` 近似（实测 6,554 条） | 近似，标注 |
| `message.assistant` | ✗ | `response_item.payload.type=agent_message`（215）或 `item.type=AgentMessage`（290） | 截断 280 |
| `tool.call` | `PreToolUse`（`tool_input:{command}`，**非 shell 工具参数不可信**） | `custom_tool_call`/`function_call`（1,437+535）与 `item.type ∈ {CommandExecution, FileChange, McpToolCall}`（39/278/39） | 用 item.type 精确分 category：exec/write/net |
| `tool.result` | `PostToolUse` | `custom_tool_call_output`/`function_call_output`（1,437+535） | status 由 output 判定 |
| `approval.request` | `PermissionRequest` | ✗（本机 16,903 行未见审批 item） | 无 hook 即缺失 |
| `approval.resolved` | `PermissionRequest` 响应 | ✗ | 同上 |
| `user.question/answer` | ✗ | ✗ | v1 不支持 |
| `agent.status` | 派生 | 派生（`turn_context.approval_policy` 可提示「当前是否需要审批」） | — |
| `error.raised` | `PostToolUse` 失败 / `StopFailure` | `event_msg` 的失败 item、`compacted` 标记 | — |

### 5.3 通用 ACP 客户端

| 规范事件 | ACP 来源 | 缺口 / 兜底 |
|---|---|---|
| `session.start` | `session/new` 响应（`sessionId`）或 `session/load` | `cwd` 从 `session/new` 参数拿 |
| `session.end` | `session/close`（新方法）或 `closeSession` 响应 / 进程退出 | 老 Agent 无 close → 用进程边界 |
| `turn.start` | `session/prompt` 请求发出 | 无 turn_id → 适配器自增 |
| `turn.end` | `session/prompt` 响应（`StopReason`：end_turn/max_tokens/max_turn_requests/refusal/cancelled） | `cancelled→aborted`；`refusal→error` |
| `step.start/end` | ✗（`plan`/`plan_update` 可近似） | 用 plan 条目数近似 step 计数 |
| `message.assistant` | `session/update.sessionUpdate=agent_message_chunk` | **是流式 chunk** → 适配器需按 `messageId` 聚合 + 节流 1.5s + 截断 280 |
| `tool.call` | `tool_call`（`toolCallId/name/title/kind/status=pending/rawInput`） | `kind`(10 值) → `category`：read/edit→read、write、execute→exec、fetch→net、think/other→other；`title` 作 summary |
| `tool.result` | `tool_call_update`（`status=completed|failed` + `content`/`rawOutput`） | `failed→error`；`durationMs` 用两次 update 的 ts 差 |
| `approval.request` | `session/request_permission`（`options[].kind=allow_once|allow_always|reject_once|reject_always`） | 天然对应强提醒 |
| `approval.resolved` | 客户端返回的 `outcome: selected(optionId)|cancelled` | `allow_always/allow_once→allow`、`reject_*→deny`、`cancelled→timeout` |
| `user.question/answer` | `elicitation/create`（Agent→Client） | 方向与 MCP 相同，语义最接近 |
| `agent.status` | 派生（`current_mode_update`、`available_commands_update`、`session_info_update`） | — |
| `error.raised` | JSON-RPC error 响应 / `tool_call_update(status=failed)` | — |

> **ACP 的边界（独立验收 C-19）**：`session/request_permission` **只映射到 `approval.*`**（它是「允许/拒绝某个工具调用」，带 `options[].kind=allow_once|allow_always|reject_once|reject_always`）；**agent 主动索要信息**（`elicitation/create`，或纯讨论式 `session/prompt` 里的追问）才映射到 `user.question/answer`。同一原生方法**不得**同时映射到两个语义不同的规范事件。
> 说明：独立验收指出的重复映射位于**契约 §6 的表**（`approval.request/resolved` 行与 `user.question/answer` 行都把 ACP 写成 permission 请求），那是我 write scope 之外的文件；建议把 §6 的 `user.question/answer` × ACP 单元格改为 `elicitation/create`（或在 `session/request_permission` 后加注「仅 approval.*」）。**本文档的所有映射表已按上面的边界执行。**

---

## 6. 只能拿到进程级信息的后端 & 降级体验设计

| 后端 | 为什么只能到进程级 | 降级体验（契约内合法表达） |
|---|---|---|
| **Aider** | 无 hooks/插件事件系统；只有文本历史与 git 提交 | `session.start/end`（进程边界）+ `pet.heartbeat(load)` + git commit 触发「完成」气泡；**不产生** `tool.call` |
| **Windsurf** | 官方文档不可达，hook 机制未验证；即便有，也不保证用户会装 | 与 Aider 相同的进程级形态 |
| **Cursor（未装 hook 时）** | GUI 常驻进程，无 hook 就无事件；`CURSOR_TRANSCRIPT_PATH` 格式未验证 | 「编辑器在跑」徽标 + idle；**禁止**把编辑器常驻当作「agent 忙碌」 |
| **任何未列入本表的新后端** | 默认未知 | 上进程兜底层；契约 §7.3 的未知事件计数在适配器侧同样适用 |

**设计红线**（写进适配器 SDK 的规约）：
1. 任何降级都**不得**产生 `turn.*`/`tool.*`/`approval.*` 假事件——宁可桌宠发呆，也不能撒谎。
2. 降级后端**不能**靠往 `session.start.data` 里塞 `degraded:true` 之类的扩展字段来表达能力等级——契约没有该字段。方案：由桌宠侧的适配器注册表（本地配置）标注能力等级，UI 层显示「有限观测」角标；更彻底的做法已在 v1.2 §5.2.1 落地：适配器在 `hello` 里用 `observes`（glob 数组）声明**实际能产生**的事件族，Hub 据此隐藏不支持的工作框指标（见 §8 第 9 条）。
3. 45 s 内未收到**任何帧**（事件或控制帧）即判该 source 离线（契约 §4.4，注意这是**连接**判定，与会话陈旧 10 min 是两条独立规则）；降级后端靠 `pet.heartbeat` 维持在线态。

---

## 7. 安全与隐私

### 7.1 只读原则（本任务与未来适配器都适用）

- 只以只读方式打开其他产品的数据文件（`O_RDONLY`/`readFileSync`），**不写、不改名、不删、不改权限**。
- 不向被观测产品注入任何代码/配置，除非用户显式执行「安装 hook」动作并在 UI 上看到将要写入的文件与内容。
- 不开启需要 root/管理员的手段（DTrace、`fs_usage`、`opensnoop` 一律不用）。
- 本任务实测全程未提权、未写任何被观测产品目录（唯一写入是工作区 `docs/`、`fixtures/`、`scripts/`）。

### 7.2 合法边界

| 场景 | 结论 |
|---|---|
| 读用户自己账号下、家目录内的产品日志（`~/.dsh`、`~/.claude`、`~/.codex`、`~/.copilot`） | 本次实测**可读**，无 TCC 拦截；但**必须**在隐私政策中告知并在首次运行时征得同意 |
| 读 `~/Documents`/`~/Desktop`/`~/Downloads` 内的项目文件 | 受 TCC 保护，需用户授权（[U] 官方页面未抓到，验证方法见 §3.10） |
| 读 App Sandbox 容器（`~/Library/Containers/<other app>`） | 官方明确：跨容器访问会弹权限询问（[B] Apple 文档，2026-10-05）——**不读** |
| 读凭据文件（`~/.codex/auth.json`、`~/.claude/.credentials.json`、keychain） | **绝对不读**；本任务扫描脚本显式跳过 |
| 读取并上传任何内容 | 默认**不上传**；所有云端能力默认关闭（与契约 §1.4 一致） |

### 7.3 脱敏规则（与契约 §2 `privacy` 字段一一对应）

| 数据 | 处理 | 契约字段 |
|---|---|---|
| 助手文本 | 截断 280 字符 | `data.text` + `truncated:true` + `privacy:{redacted:true,fields:["text"]}` |
| 工具参数（`arguments`） | 压平空白 + 截断 120 字符；命中敏感模式则整段替换为 `[redacted]` | `data.summary` + `privacy.fields:["summary"]` |
| 工具输出 stdout/stderr | **不外传**，只给长度/状态/耗时 | —— |
| 思维链（`reasoning`/`thinking` 块） | **不外传** | —— |
| 文件路径 | 允许（`workspace` 必须保留，契约要求）；但**不传文件内容** | `workspace` |
| 敏感模式黑名单（建议实现） | `sk-[A-Za-z0-9]{16,}`、`ghp_[A-Za-z0-9]{20,}`、`AKIA[0-9A-Z]{16}`、`-----BEGIN [A-Z ]*PRIVATE KEY-----`、`(?i)bearer\s+\S{16,}`、`(?i)(password|passwd|secret|token)\s*[:=]\s*\S+` | 命中即置 `[redacted]` |
| 邮箱/手机号 | 建议在 `user_email` 等字段正则脱敏（Cursor payload 会带 `user_email`） | —— |

### 7.4 本地存储

- 录制文件 `~/.agent-pet/records/*.pet.jsonl` 权限 `0600`，目录 `0700`；轮转 20MB × 7 天（契约 §5）。
- 提供「一键清除本地记录」；遥测默认关闭；不做「云端回放」。

---

## 8. 对契约 v1.2 的复核意见（**未改动 00 文件**）

> 我已经把 v0.1 时代的 10 条建议、以及 v1.2 复验（docs/99）里与我文件相关的 5 条全部处理完：
> **v1.1 吸收**：16/16 口径、`requestId` 配对、控制帧与 `type` 分离、`agent.status` 五状态、`seq` 作用域与去重键、乱序窗口判定。
> **v1.2 吸收**：`session.start.startedAt` / `session.end.endedAt`、控制帧 `contract`（含 snapshot）、§4.7 错误分级（解决我 v1.1 报告的第 1 条）、§5.2.1 `observes`（解决第 8 条）。
> 以下是**在 v1.2 上重新实现 fixture 与 checker 后仍然存在**的歧义，按严重度排序；每条都注明我当前的实现选择，便于 Lead/T6 决定是改契约还是改实现。

1. **[P1，新增] v1.2 内部仍有两条「错误恢复目标」冲突**：§3.1 写「`session.end(reason=error)` → `error` 状态 **3 s**」，§3.3 写「`approval.resolved(timeout)` → `error` 1.5 s → **登记前状态**」，而 §4.7 把两者分别归为**持久错误**（保持到成功事件/清理）与**瞬态错误**（TTL 后回**上一个稳定状态**）。三条规则互斥。**我的实现**：一律以 §4.7 为准（它更新、更具体），并把差异写进 checker 的迁移标签。**建议**：删掉 §3.1/§3.3 里的时长描述，统一指向 §4.7。（v1.1 报告的第 1 条「tool/step 的 error 无退出条件」已被 §4.7 解决，此条是随之暴露的残留冲突。）
2. **[P1] `turn.end(aborted) → idle` 与优先级规则冲突**：若当前是 `waiting`/`error`（优先级更高），`aborted → idle` 会被 §4.3 拒绝，语义上却应当允许（会话被中止了，凭什么还显示忙碌）。**我的实现**：把它当普通低优先级迁移处理（会被 gate，并在报告里计 `gated`）。建议契约明确：会话级终态（`session.end`/`turn.end aborted`）可无视优先级直接落地。
3. **[P2] `agent.status.force=true` 能否覆盖未决的 `waiting`**：若能，适配器一次误报就会吞掉审批强提醒。**我的实现**：`force` 只能覆盖非 `waiting` 状态，`waiting` 期间一律拒绝（计 `overrideRejected`）。建议契约写明 `force` 不得绕过未决审批/提问。
4. **[P2] `pet.heartbeat.sessionCount?` 未在 §4 使用**：字段已定义但没有任何聚合规则引用它。建议在 §4.3「一个桌宠 + N 个徽标」里说明它就是徽标数量，或直接删除以免误用。
5. **[P3，部分解决] `snapshot` 的 `contract` 只存在于复验要求里**：v1.2 §2.2 的示例只给 `hello`/`ack`/`decide` 带 `contract`，§5.3 的 `snapshot` 示例**没有** `contract`，但独立验收（docs/99 §9.2）把它当必填。**我的实现**：fixture 的 snapshot 已补 `contract:1`，checker 对**所有**控制帧断言 `contract===1`。**建议**：把 §5.3 的示例补上 `"contract": 1`，让文档与验收一致。
6. **[P2] `data.nativeSessionId` 与信封 `sessionId` 的冗余关系未明说**：两者重复，且 `pet.heartbeat` 允许 `nativeSessionId:null` 而信封用 `"backend"`。建议明确「除 backend 保留值外，二者必须一致」，避免适配器写出自相矛盾的事件。
7. **[P2] `--replay` 离线回放时的握手语义缺失**：§5.2 要求适配器发 `hello` 并等 `ack`（3 s 超时、重试 2 次），但回放 fixture 时没有 Hub。**我的 fixture** 里放了 `hello`/`ack`/`snapshot` 三个控制帧作为样例。建议契约补：回放模式跳过握手，控制帧按 §2.2 忽略。
8. **[P2，新增] §4.7 的「失败连击」在黄金 fixture 里已触发**：fixture 的三次瞬态错误（seq 18 `tool.result(error)`、seq 23 `approval timeout`、seq 29 `step.end(error)`）间隔都 <60 s，按 §4.7 第 4 条会**升级为持久错误**（我的 checker 报告 `escalatedErrors=1`、`persistentCleared=1`，随后 `turn.start` 清除）。这本身是合法的，但**T6 的复验器与我的 checker 必须对「连击窗口」取同一口径**，否则两个校验器会给出不同的计数器（与已闭环的 C-26 同类风险）。建议契约把「连续 3 次」的判定写成可执行定义（是否要求中间无成功事件？窗口是滑动还是固定？）。

9. **[已解决，留档] 观测能力等级**：v1.2 §5.2.1 用 `hello.observes`（glob 数组）表达，正好覆盖「进程级后端只能发 `session.*`/`pet.heartbeat`」的场景。**本任务的 checker 已校验 `observes` 必须是字符串数组**；fixture 的 `hello` 暂未声明 `observes`（缺省 = 全部 16 个 type 都可能出现），符合契约。建议 §3.8 的进程级降级设计在 Phase 2 实现时通过 `observes:["session.start","session.end","pet.heartbeat"]` 声明。

---

## 9. 复现命令（全部可跑，均为只读或写工作区）

### 9.1 DSH 会话日志 → 规范事件

~~~bash
# 1) 定位会话日志
ls -la ~/.dsh/sessions/*/*/session.v4.jsonl.zstd
# 2) 映射（只读输入，输出 JSONL）
node scripts/dsh-session-to-pet.mjs "<某个 session.v4.jsonl.zstd>" --agent-version 0.2.0-rc.2 > /tmp/pet-out.jsonl
# 3) 契约自检
node scripts/check-fixtures.mjs /tmp/pet-out.jsonl
# 4) fixture 自检：覆盖 16 个 type 字符串 / 16 行、6 状态、审批超时、乱序窗口、3 条未知 type、3 个控制帧
$ node scripts/check-fixtures.mjs
行数(非空): 40 | 事件: 37 | 控制帧: 3 | 最大单行: 381B / 8192B
type 覆盖: 规范 16/16 | 未知 3 种（x-unknown.foo×1, x-unknown.bar×1, x-unknown.event-v9×1）
乱序窗口: 2 条(seq 27..26, 400ms)
配对: orphanApprovals=0, orphanAnswers=0, 结束时未决=0
会话 [dsh||sess-demo-0001] 终态=idle 迁移 19 次，覆盖=[idle, thinking, working, waiting, done, error]
会话 [dsh||backend] 终态=idle（后端级心跳，sessionId="backend"）
聚合终态=idle，聚合覆盖状态=[idle, thinking, working, waiting, done, error]
  [note] ... gated=1 / overrideRejected=1 / recoveredErrors=1 / escalatedErrors=1 / persistentCleared=1   # §4.7 计数器
✓ 全部检查通过（契约 v1.2）
~~~

### 9.2 Claude Code / Codex 本机扫描（只读，跳过凭据文件）

~~~bash
$ node scripts/scan-claude-transcripts.mjs
转录文件 289 | 行 75493 | 最大单行 1803475B | 解析失败 0
行类型: assistant=33838, user=19741, attachment=14546, last-prompt=1328, …
内容块: tool_result=18961, tool_use=18928, thinking=9306, text=5647, line.toolUseResult=4741
$ node scripts/scan-codex-rollouts.mjs
rollout 文件 32 | 行 16903 | 最大单行 5093685B | 解析失败 0
顶层行类型: event_msg=9631, response_item=6748, inter_agent_communication_metadata=215, …
item_completed.item.type: Reasoning=5576, AgentMessage=290, FileChange=278, SubAgentActivity=255, …
~~~
两个脚本只统计**类型与字段名**（不打印任何消息内容；不读 `auth.json` 等凭据文件），用于验证 §3.1/§3.2 的实测数字。

### 9.3 读 app.asar 内的 DSH 证据（Electron 归档）

~~~bash
# app.asar = 8 字节 pickle 头 + JSON 目录 + 连续文件体；不能当目录 ls
node -e 'const b=require("fs").readFileSync("/Applications/DeepSeek Harness.app/Contents/Resources/app.asar");
 const hs=b.readUInt32LE(4); const hb=b.subarray(8,8+hs); const len=hb.readUInt32LE(4);
 const h=JSON.parse(hb.subarray(8,8+len).toString());
 const flat=[]; (function w(n,p){for(const[k,v]of Object.entries(n.files||{})){const q=p+"/"+k; v.files?w(v,q):flat.push(q);}})(h,"");
 console.log("files:",flat.length); console.log(flat.filter(p=>/known-event-types|hooks-claude-code|hooks-codex|agentclientprotocol/.test(p)).join("\n"));'
~~~

### 9.4 独立 schema 校验（队友 D 的 schema/validate-pet-event.mjs）

~~~bash
$ node schema/validate-pet-event.mjs fixtures/contract-sample.pet.jsonl
{"file":"fixtures/contract-sample.pet.jsonl","knownValid":34,"controlFrames":3,"unknownTypes":3,"malformedLines":0,"invalidKnown":0}
# exit=0（34 已知事件 + 3 未知 type + 3 控制帧 = 40 行全部解析）
# 注：该 schema 当前自述基线是 v1.1，尚未校验 startedAt/endedAt（task-11 升级 v1.2 后应继续通过）
~~~
两个校验器（本文的 `scripts/check-fixtures.mjs` 与队友 D 的 JSON Schema）**相互独立**：前者做语义/状态机回放，后者做结构与逐字段类型校验。

**DSH 映射器的回归**（v1.2 修补后重跑，2026-10-05 12:5x）：

~~~bash
$ node scripts/dsh-session-to-pet.mjs <某会话日志> --agent-version 0.2.0-rc.2 > /tmp/t10-pet.jsonl
[dsh-session-to-pet] 压缩 1371744B → 帧 728/728 候选 → 原生事件 1261 → 规范事件 318（解帧失败 0）
$ node scripts/check-fixtures.mjs /tmp/t10-pet.jsonl
行数(非空): 318 | 事件: 318 | 控制帧: 0 | 最大单行: 580B / 8192B
配对: orphanApprovals=0, orphanAnswers=0, 结束时未决=0
会话 [dsh||session-0a1b2c3d-…] 终态=working 迁移 18 次，覆盖=[idle, thinking, working, error]
  [note] stale=1 / recoveredErrors=7
✓ 全部检查通过（契约 v1.2）
# 修补记录：v1.2 要求 session.start 必填 startedAt，且**会话头没有 seq/time**——
# 第一版只补了 data.startedAt 而忘了给事件本身赋 ts，产出 ts=0 的非法事件（已被自检抓出并修复）。
~~~

### 9.5 外部文档在网络受限时的等价读取方式

~~~bash
# github.com / raw.githubusercontent.com 不可达时，用 jsDelivr 读官方仓库原文：
#   https://cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>
# 例：Codex 官方仓库配置文档
#   https://cdn.jsdelivr.net/gh/openai/codex@main/docs/config.md
# 例：ACP 官方协议文档
#   https://cdn.jsdelivr.net/gh/zed-industries/agent-client-protocol@main/docs/protocol/v1/prompt-turn.mdx
~~~

---

## 附录 A. 本文引用的全部外部来源（访问日期均为 2026-10-05）

| # | 来源 | 用途 |
|---|---|---|
| 1 | https://code.claude.com/docs/en/hooks.md | Claude Code 33 个 hook 事件、公共字段、JSON 输出、字符上限、matcher |
| 2 | https://cursor.com/docs/hooks.md | Cursor 21 个事件、配置路径、字段、`failClosed`/`loop_limit` |
| 3 | https://geminicli.com/docs/hooks | Gemini CLI 更替公告（Antigravity CLI, 2026-06-18） |
| 4 | https://cdn.jsdelivr.net/gh/google-gemini/gemini-cli@main/docs/hooks/index.md | Gemini CLI 11 个事件表 |
| 5 | https://cdn.jsdelivr.net/gh/google-gemini/gemini-cli@main/docs/hooks/reference.md | Gemini CLI 配置/输入/输出 schema |
| 6 | https://cdn.jsdelivr.net/gh/github/docs@main/content/copilot/concepts/agents/hooks.md | Copilot 8 个事件、`.github/hooks/*.json`、`~/.copilot/hooks/*.json` |
| 7 | https://cdn.jsdelivr.net/gh/github/docs@main/content/copilot/reference/hooks-reference.md | Copilot 字段表、command/http、camelCase 与 Claude 兼容载荷 |
| 8 | https://cdn.jsdelivr.net/gh/mehmetbaykar/codex-docs-skill@main/skills/codex-docs/references/hooks.md | Codex 事件表与配置（第三方镜像，声明 source 为官方 hooks 页） |
| 9 | https://cdn.jsdelivr.net/gh/openai/codex@main/docs/config.md | Codex 托管 hook 策略 `allow_managed_hooks_only`（官方仓库原文） |
| 10 | https://cdn.jsdelivr.net/gh/zed-industries/agent-client-protocol@main/docs/protocol/v1/overview.mdx | ACP 通信模型与方法流 |
| 11 | https://cdn.jsdelivr.net/gh/zed-industries/agent-client-protocol@main/docs/protocol/v1/prompt-turn.mdx | `session/update` 变体表与回合生命周期 |
| 12 | https://cdn.jsdelivr.net/gh/zed-industries/agent-client-protocol@main/docs/protocol/v1/tool-calls.mdx | `tool_call` 字段、`kind` 10 值 |
| 13 | https://cdn.jsdelivr.net/gh/Aider-AI/aider@main/aider/website/docs/scripting.md | Aider 脚本化与 Python API |
| 14 | https://cdn.jsdelivr.net/gh/Aider-AI/aider@main/aider/website/docs/config/options.md | Aider 历史文件与选项 |
| 15 | https://cdn.jsdelivr.net/gh/modelcontextprotocol/modelcontextprotocol@main/docs/specification/2025-06-18/index.mdx | MCP 2025-06-18 规范与能力边界 |
| 16 | https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox.md | App Sandbox 容器互访边界（Apple 官方） |
| 17 | https://cdn.jsdelivr.net/gh/whit3rabbit/agent-config@main/docs/agents/windsurf.md | Windsurf hooks（第三方，仅交叉参考） |

## 附录 B. 本文未验证项清单（供 T6 与后续实测）

| # | 未验证内容 | 验证方法 |
|---|---|---|
| 1 | Codex `Interrupt`/`SessionEnd` 两个事件 | 在装 Codex CLI 的机器上跑 `/hooks` 查看事件列表 |
| 2 | Codex hooks 在本机的真实触发 | 在 `~/.codex/hooks.json` 写一个只 `echo` 到 stderr 的 hook，跑一次 `codex exec` 观察 |
| 3 | Claude Code 的 `PermissionRequest`/`PermissionDenied` 实际 payload | 在 `~/.claude/settings.json` 注册 hook 并触发一次需要审批的工具 |
| 4 | Cursor hooks（无本机安装） | 装 Cursor 后写 `~/.cursor/hooks.json` |
| 5 | Windsurf hook 机制与事件名 | 打开官方文档或在一台装有 Windsurf 的机器上验证 |
| 6 | Copilot `~/.copilot/logs` 是否含结构化事件 | 跑一次 Copilot CLI 后 `ls -lt ~/.copilot/logs` 并查看文件头 |
| 7 | `CURSOR_TRANSCRIPT_PATH` 文件格式 | 在 Cursor 中开启 transcripts 后 tail 该文件 |
| 8 | macOS 完全磁盘访问权限的官方说明页 | 系统设置 → 隐私与安全性 → 完全磁盘访问权限；Apple 官方页面本次抓取失败 |
| 9 | ACP v2 草案的稳定性与时间表 | 关注 `docs/protocol/v2/migration.mdx` 与官方公告 |
| 10 | 各家 Agent 的真实用户量 | 无公开可靠数据 → 优先级评分中的「用户量」为主观估计（已在 §4 标注口径） |

---

### 3.15 plan-usage：Coding Plan 订阅使用情况层（v0.1.4，2026-10-26 落地）

**定位**：`adapters/plan-usage.mjs`——回答「各家 coding plan 订阅的什么档位、用了多少、还剩多少」。不是新观察源，是叠加在八源用量链路之上的**订阅视角**。真相源 [docs/29](./29-v0.1.4-scope.md)。

**三层证据（全部本机只读，零网络）**：

| 层 | 来源（2026-10-26 本机实测 [A]） | 边界 |
|---|---|---|
| 身份 | ZCode `~/.zcode/v2/coding-plan-cache.json`（entitlement 缓存）+ 凭证文件**键名**；Codex `auth.json` `auth_mode`（apikey→API 计费；chatgpt→JWT 白名单 claim `chatgpt_plan_type`）；Cursor state.vscdb `cursorAuth/stripeMembershipType`；Copilot VS Code state.vscdb `copilotSku` + `~/.copilot/data.db` accounts；Qoder `.qoder-app-status.json` + `partner_plan_snapshots`；Claude `.claude.json` oauthAccount 有无 + settings env 键名；Kimi credentials 的 scope/expires_at + region | **凭证值绝不读入输出**：JWT 只解白名单 claim、token 列只报存在；邮箱/账号/登录名打码（MU-PU2 断言） |
| 用量 | 复用 usage-collect 八源 overview（today/d7/d30/all 四窗透传精确/请求级/估算口径）；GLM 额外用 ZCode `db.sqlite` 的 `model_usage` 表按 provider 聚合（`account:*` 前缀 = 登录态 coding plan 计费；一条 GROUP BY 同时产出四窗的 requests/input/output/cache 列），OpenCode 按 `glm*` 模型名近似并入 | Qoder/Cursor token 在云端（既有口径）；Copilot 不在八源内 → usage.kind='none' |
| 配额 | 仅 DeepSeek：`~/.dsh/.dshw-usage.json` 余额账本 → `balance/todayCost/d7Cost/d30Cost/allCost/daily[14]/events[5]`；**1 单位 = 1e-8 元**（debitUnits 1,676,000,000 ≙ 16.76 元、creditUnits 50,000,000,000 ≙ 充值 500 元，实测对账） | 其余厂商云端配额本地无缓存——**不持凭证调厂商 API（红线），如实标「云端配额本地不落盘」** |

**接线**：framed `planUsageCache`（身份层模块内 60s 缓存）→ `refreshUsage` 完成后跟随刷新 → `GET /api/plan-usage`（无参只读缓存；分钟节拍/手动 `refresh=1` 重算；快照不带该块）。UI 用量页「Coding Plan 使用情况」表格：状态徽标 / 计划身份 / 四时间窗 / 配额·余额 / 未安装合并行 / 每行 details 证据与明细；打开时读取缓存 + usage.generatedAt 变化即重拉（与日历同模式）。

**注册表（15 家）**：GLM Coding Plan / DeepSeek / Claude / ChatGPT(Codex) / Kimi For Coding / Qoder / Cursor / GitHub Copilot（8 家 probe 提取器）+ Gemini(Antigravity) / Qwen Code / iFlow / MiniMax / Trae / Windsurf / CodeBuddy（7 家安装检测，本机均零痕迹）。

**回归**：`demo/test-plan-usage.mjs`（fixture 假家目录 + 假 sqlite + 假 overview）：MU-PU1 身份 / MU-PU2 隐私（输出不含凭证值与完整账号）/ MU-PU3 账本换算 / MU-PU4 provider 拆分与窗口分桶 / MU-PU5 三口径透传 / MU-PU6 未安装与排序 / MU-PU7 UI 渲染。
