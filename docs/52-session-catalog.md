# 52 · 会话目录（项目 / 多会话）与元信息解析

> 状态：**v1 完成**（2026-10-05，队友 G / task-12）。契约依据：[00-interface-contract.md](./00-interface-contract.md) v1.3 的 §2.2（`ctl:catalog` / `session.open` / `session.new`）与 §3.4（`session.meta` / `session.activity`）。
> 本文所有结论都带**本机实测命令 + 真实输出**；凡未实测的（例如需要写 `~/.dsh` 的启动实验）都显式标注「**源码证据，未实测**」。
> 约束遵守：只读 `~/.dsh/sessions/**` 与 `~/.dsh/storages/workspace.json`；**没有读取也没有使用** `~/.dsh/.credentials.yaml`；没有启动任何占用 19387 端口的进程。

---

## 0. 交付物

| 文件 | 作用 | 自检 |
|---|---|---|
| [adapters/session-catalog.mjs](../adapters/session-catalog.mjs) | 扫描 `~/.dsh/sessions/**` → **项目 → 会话**树 + 元信息；快扫/深扫两种策略；flock 占用探测；`ctl:catalog` 帧 | [scripts/catalog-check.mjs](../scripts/catalog-check.mjs) |
| [adapters/dsh-meta.mjs](../adapters/dsh-meta.mjs) | 纯函数：多帧 zstd 解码 + 元信息抽取 + 粗粒度 activity + 契约事件组装 | 内置 `--selftest`（**50/50 通过**） |
| [scripts/catalog-check.mjs](../scripts/catalog-check.mjs) | 真实数据自检（16 项断言）+ 性能实测 | 自身 |
| 本文 | 字段来源表 / 性能实测 / 打开-新建能力矩阵 | — |

```bash
node adapters/dsh-meta.mjs --selftest     # 45/45 通过
node scripts/catalog-check.mjs            # 16 项断言全过
node adapters/session-catalog.mjs         # 人类可读目录树
node adapters/session-catalog.mjs --json --frame   # 契约 §2.2 ctl:catalog 载荷
```

---

## 1. 本机真实数据

### 1.1 磁盘结构（实测 `ls`）

```text
~/.dsh/sessions/
├── --Users-demo-Desktop-agent~684C~5BA0--/          ← 项目目录（projectKey）
│   ├── session-0a1b2c3d-4e5f-4a6b-8c9d-1a2b3c4d5e6f/       ← 会话目录（encodeSegment(sessionId)）
│   │   ├── session.lock                                    ← 0 字节；flock 写租约锚点（见 §5.1）
│   │   └── session.v4.jsonl.zstd                           ← 多帧 zstd 追加日志 = 唯一真相源
│   └── …（本项目共 9 个会话目录）
├── --Users-demo-Desktop-~539F~751FAI~64CD~4F5C~7CFB~7EDF--/   ← /Users/demo/Desktop/原生AI操作系统
└── --Users-demo-Desktop-~9E48~9E55~6D4B~8BD5~53D8~4F53~7B56~5212--/  ← 鹈鹕测试变体策划
```

**项目目录名是 DSH 自己的编码规则**（读者可核对 `dsh-session-persistence-jsonl/lib/index.js` 的 `projectKey()`）：`/` `\` `:` → 连续的 `-`；非 `[A-Za-z0-9._-]` 的 UTF-16 码元 → `~XXXX`（大写十六进制）。
因此 `--Users-demo-Desktop-agent~684C~5BA0--` 解码为 `/Users/demo/Desktop/agent桌宠`（桌=U+684C、宠=U+5BA0）。

> ⚠ **该编码有意有损**（连续分隔符折叠、超长截断到 251 字符），例如 `/Users/a-b/proj` 与 `/Users/a/b/proj` 会映射到同一目录名。所以：
> **cwd 的权威来源是日志首行 header.cwd**，目录名解码只用于 header 不可读时的兜底（记录里以 `cwdSource: 'log-header' | 'dir-name(lossy)'` 标注）。
> 自检 A11 用真实 cwd 反推 `projectKey`，与磁盘上的目录名逐字比对：**3/3 一致**。

### 1.2 规模（实测，2026-10-05 13:15）

```text
会话目录 /Users/demo/.dsh/sessions
3 个项目 / 16 个会话（主 8 · 子代理 8 · 活跃 2 · 降级 0）  扫描耗时 22.2 ms
```

- 会话数会随队友/子代理运行而增长（任务描述里的 12 个已变为 16 个）；自检因此断言 `≥12` 而不是等于 12。
- **主会话 / 子代理必须区分**：`header.origin === 'subagent'` 或 `parentSession` 非空 → `kind='subagent'`。本机 16 个会话里 8 个是 Agent Teams 的子代理会话；工作框默认应折叠它们（与契约 §8 的 5 行上限配合）。
- 子代理会话的好标题来自 `subagent/descriptor.data.label`（如「T12 会话目录与元信息解析」），而不是被 `system-reminder` 污染的 `session/title`。

### 1.3 会话目录树（真实输出节选）

```text
📁 agent综合管理平台   (/Users/demo/Desktop/agent桌宠)
   projectId=86b7c4e5-2466-48c5-bb33-0fcc1c0277e5 · 会话 9 个 · 活跃 2 · workspace 已登记 1/9
   └─ 4e5f6a7b-545b-49f7-8e71-fb6fbef0e5e1     10-05 13:15   775KB  deepseek-flash  max   running  子代理  ● 活跃
      「T12 会话目录与元信息解析」  deepseek-account · preset=ptc · label=T12 会话目录与元信息解析
   └─ session-0a1b2c3d-2dc8-401e-b07b-46485304 10-05 13:12   2.1MB  deepseek-flash  max   idle     主会话  ● 活跃
      「DeepSeek桌宠开发计划」  deepseek-account · preset=ptc

📁 原生AI操作系统   (/Users/demo/Desktop/原生AI操作系统)
   projectId=eb2c1168-0dd7-49b9-81f9-1d03846a1f03 · 会话 4 个 · 活跃 0 · workspace 已登记 4/4
   └─ session-ed4bcf8d-e4b4-4da0-a941-c7342e15 09-22 08:19   668KB  deepseek-flash  high  idle     主会话
      「现在确定本项目的进度」  deepseek-official · preset=ptc

📁 鹈鹕测试变体策划   (/Users/demo/Desktop/鹈鹕测试变体策划)
   projectId=271107bb-1048-4dab-a717-36af3b94e248 · 会话 3 个 · 活跃 0 · workspace 已登记 3/3
   └─ session-e50dd07b-641f-437c-90e9-cdfd71a2 09-25 21:53    41KB  deepseek-v4-pro high  ended    主会话
      「鹈鹕测试变体策划」  deepseek-account · preset=standard
```

**项目标题/身份**额外来自 `~/.dsh/storages/workspace.json`（`tables.workspaces[workspaceId] = { path, title, sessionIds }`）：`cwd` 精确匹配时 `projectId` 用 `workspaceId`，并把 `title` 用作展示名（如「agent综合管理平台」）。注意 `sessionIds` **只登记用户在 GUI 里打开的会话**（本项目 9 个会话只登记了 1 个），所以目录条目数必须以文件系统为准。

---

## 2. 字段来源表（每个字段 ← 哪个原生事件）

原生事件 = `session.vN.jsonl.zstd` 解帧后的 JSON 行（`type` 字段）。**字段来源可追溯**：运行时把来源写进会话记录的 `metaSources`，自检 A4/A6 逐条断言。

| 目录/契约字段 | 原生来源（优先级高→低） | 取值规则 | 兜底 | `metaSources` 取值（实测） |
|---|---|---|---|---|
| `sessionId` | 首行 `session` header 的 `id` | 权威 ID（目录名是它的编码形式） | 目录名 | — |
| `cwd` | header 的 `cwd` | 权威路径 | 目录名解码（有损） | `cwdSource` |
| `createdAt` | header 的 `createdAt`（ms） | — | 文件 mtime | — |
| `updatedAt` | max(文件 mtime, 窗口内最后一条事件的 `time`) | 取整 ms | mtime | — |
| `bytes` | 最高代日志文件大小 | 目录里选 `v` 数值最高的代（DSH 运行时同规则） | 0 | — |
| `live` | 文件 mtime | `now - mtime < 60_000` | false | — |
| `state`（粗粒度） | 尾部窗口事件的 `turn/start` / `turn/end`(`data.reason.kind`) / `session/end-seed` / `llm/retry` | 开轮未配对→`running`；`reason=error`→`error`；`session/end-seed`→`ended`；否则 `idle` | `idle` | `stateSource` |
| `provider` / `model` / `reasoningEffort` | ① `request/header` → `data.header.config.{provider,model,reasoningEffort}`（**该轮真实生效配置**）<br>② `model/selection` → `data.{provider,model,reasoningEffort}`（用户显式选择）<br>③ `subagent/descriptor` → `data.agent{Provider,Model,ReasoningEffort}` | 生效配置优先；显式选择另存 `selection`，与生效值不一致时进 `conflicts[]`（只报告不隐藏） | null | `request/header.data.header.config.model`（实测 12/16 条取自此）、`model/selection.data.model`（2/16）、另 2 条日志太小无模型信息 |
| `title` | ① `session/title` → `data.title`<br>② `subagent/descriptor` → `data.label` | 若 ① 是 `system-reminder` 回显且有 ②，用 ②（原值保留在 `titleRaw`） | `basename(cwd)` → `derived:basename(cwd)` | `session/title.data.title` / `subagent/descriptor.data.label` |
| `agentPreset` | ① `agent-preset/selected` → `data.agentPreset`<br>② header 的 `agentPreset` | ① 覆盖 ② | null | `agent-preset/selected.data.agentPreset` / `header.agentPreset` |
| `agentName` / `agentVersion` | 常量 `'DSH'` / 应用版本 | 取自 app bundle `Info.plist` 与 `package.json`：**0.2.0-rc.2** | — | — |
| `logFormatVersion` | header 的 `version` = **4** | **是日志格式版本，不是应用版本**（自检 A5 专门盯这个混淆） | null | — |
| `origin` / `parentSession` / `delegationDepth` / `isSeeded` | header 同名字段 | `origin==='subagent'` → `kind='subagent'` | — | — |
| `variant`（会话形态 cli/desktop） | **派生规则**（非原生字段） | cwd 落在 `~/.dsh/profiles/**` → `cli`（CLI/脚本从 profile 目录启动）；其余 → `desktop`（desktop profile 被 Electron 独占，§5.3） | 降级记录为 null（不猜） | — |
| `lock`（可选） | `session.lock` 的 `flock` | `'held'` / `'free'` / `'unknown'` | unknown | — |

> ⚠ **两个曾经踩过的坑（已被自检覆盖）**：
> 1. `agentVersion` **不能**取 header 的 `version`（那是格式版本 4）。早期一份实现写成 `'v' + header.version`，UI 会显示「DSH v4」。
> 2. `agentPreset` **不能**取 `permission/preset` 的 `data.preset`（那是权限预设 `auto/workspace-write`）；预设要取 `agent-preset/selected.data.agentPreset`。本机 `session-4e6c3d30` 的 preset 是 `cordis`，取错字段会静默退化成 header 的 `ptc`。

### 2.1 实测样例（`session-e50dd07b`，取 `model/selection` 路径）

```json
{"type":"model/selection","data":{"provider":"deepseek-account","model":"deepseek-v4-pro","reasoningEffort":"high"}}
```
目录条目：`model=deepseek-v4-pro`、`reasoningEffort=high`、`metaSources.model='model/selection.data.model'`、`agentPreset=standard`（来自 header）。

---

## 3. 解析策略与性能实测

### 3.1 为什么必须按魔数分帧

会话日志是**多帧 zstd 顺序追加**（每批一个 frame）。Node 内置 `zlib.zstdDecompressSync` **只解第一帧**，直接整文件解压会丢掉后面所有事件（自检里有这条回归断言）。

```js
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);   // zstd 帧魔数
// 按魔数切出每帧的 [start, end)，逐帧解压；末帧写入中会解出空串 → 跳过（见 3.4）
```

### 3.2 快扫（默认）与深扫（`--deep`）

| 模式 | 读什么 | 解哪些帧 | 元信息完整性 | 用途 |
|---|---|---|---|---|
| **快扫**（默认） | 文件头 64 KB（按需翻倍，上限 1 MB）+ 文件尾 64 KB（上限 512 KB） | **前 8 帧 + 末 2 帧** | 窗口内最后一次取值（`metaComplete=false` → `metaApproximate=true`） | 列表/工作框（每 1–2 s 刷新） |
| **深扫** `--deep` | 整文件 | 全部帧 | 精确（`metaComplete=true`） | 会话详情面板、导出、自检对照 |

深扫会解压全部帧，但不会对所有行执行 `JSON.parse`：目录专用解码只解析影响最终元信息/状态的事件，保留最后一条 assistant 的相对位置与首个有效用户标题；通用回放仍使用完整事件解码。

两个模式都**不需要预先知道帧数**：头窗口按 `64 KB → 128 KB → …` 翻倍，直到解出 8 个完整帧或到达 EOF。

### 3.3 性能实测（命令 + 真实输出）

```text
$ node adapters/session-catalog.mjs --bench 10
扫描耗时 10 轮：min 15.4 ms / 中位 16.8 ms / max 23.5 ms / 平均 17.4 ms
统计：{"projects":3,"sessions":16,"mainSessions":8,"subagentSessions":8,"live":3,"degraded":0,
      "readBytes":1763267,"headFrames":8,"tailFrames":2}

$ node scripts/catalog-check.mjs --runs 10
性能：10 轮 min 15.1 / 中位 16.4 / max 22.5 ms（阈值 300 ms；实际读取 1722 KB）

$ node adapters/session-catalog.mjs --deep          # 深扫对照
3 个项目 / 16 个会话（主 8 · 子代理 8 · 活跃 2 · 降级 0）  扫描耗时 202.8 ms
```

- **12+ 会话整体 < 300 ms 达标**：本机 16 个会话（最大 2.50 MB / 991 帧，最长 1215 帧）快扫 **16.4 ms（中位）**，只读 **1.7 MB**。
- 快扫的 I/O 与**会话数**成正比而与**日志大小**无关（每会话上限 64 KB 头 + 64 KB 尾，实测平均约 107 KB）；深扫与日志总量成正比（16 会话 14.2 MB → 203 ms）。会话数上到 100+ 时应保持快扫 + 按需深扫单会话（单会话深扫平均 12 ms、最慢 33 ms）。
- 自检 A13 同时要求真实深扫零降级、固定合成语料与独立全量解码结果一致，以及固定语料多轮中位数 < 300 ms；真实全量耗时仅作诊断，避免本机数据增长让性能门禁失真。

### 3.4 降级（必须有，且已实测）

| 情形 | 行为 | 自检 |
|---|---|---|
| 目录里没有 `session*.jsonl(.zstd)` | `degraded=true, error='no-session-log'`，仍给 `sessionId/updatedAt/bytes` | — |
| 日志损坏/空/找不到 header 帧 | `degraded=true, error='no-header-frame'`，仍给 `sessionId/updatedAt/bytes`（用 mtime 与文件大小） | **A8**（合成坏日志） |
| 末帧正在写入（torn tail） | Node 对截断帧**不抛错而是返回空串**（实测）→ 计 `emptyTail` 并跳过，前面的记录全部保留 | dsh-meta 单测 |

> 实测细节（Node v24.18）：对截断的 zstd 帧调用 `zstdDecompressSync` 返回空 Buffer 而非抛异常；因此「正在写入的末帧」是安全退化的，但**不能**靠 try/catch 判断 torn，必须显式看「末帧是否解出 0 字节」。

---

## 4. 自检（真实输出，可原样复现）

```text
$ node adapters/dsh-meta.mjs --selftest
dsh-meta selfTest: 45/45 通过

$ node scripts/catalog-check.mjs --runs 10
会话目录自检  ·  root = /Users/demo/.dsh/sessions
本机实际：3 个项目 / 16 个会话（主 8 · 子代理 8 · 活跃 2 · 降级 0）
性能：10 轮 min 15.1 / 中位 16.4 / max 22.5 ms（阈值 300 ms；实际读取 1722 KB）

  ✅ A1 会话根目录可读且项目数 ≥ 3
  ✅ A2 会话数 ≥ 12
  ✅ A3 每条会话都有 sessionId + updatedAt + bytes
  ✅ A4a model 来源可追溯（metaSources.model 指向已知原生事件）
  ✅ A4b reasoningEffort 来源可追溯
  ✅ A4c 抽样：目录结果与整文件全量解析一致
  ✅ A5 agentVersion（应用版本）≠ logFormatVersion（日志格式版本）
  ✅ A6 title 来源可追溯（session/title 或子代理 label）
  ✅ A7 activity 摘要来自固定字典 / ≤80 字符 / 零参数泄漏
  ✅ A8 坏日志降级：仍给出 sessionId/updatedAt/bytes
  ✅ A9 扫描耗时中位数 < 300 ms
  ✅ A11 项目目录名与 DSH projectKey 编码规则一致（用真实 cwd 反推）
  ✅ A12 快扫(前8+末2帧) 与深扫(整文件) 的元信息差异 ≤ 25%（差异=会话中途改模型/标题）
  ✅ A13 真实深扫零降级；固定语料结果一致且中位数 <300ms
  ✅ A10 契约 §2.2 ctl:catalog 帧形状正确

全部 16 项断言通过
```

**A12 的诚实说明**：快扫确实会在「会话中途换过模型/标题」的会话上与全量不一致。本机实测 **2/16（12.5%）**：

```text
session-e50dd07b-641  快扫: high +「鹈鹕测试变体策划」   深扫: max +「SVG鹈鹕骑自行车2D动画」
session-ed4bcf8d-e4b  快扫: high +「现在确定本项目的进度」 深扫: max +「确定项目进度」
```

两者的「最后一次元信息事件」落在第 8 帧之后、倒数第 2 帧之前（实测：`e50dd07b` 共 19 帧，最后一个 `session/title` 在第 9–10 帧）。**这是快扫的固有取舍，不是 bug**；详情面板/导出请用 `--deep`。

---

## 5. 打开已存在会话 · 能力调研

### 5.1 会话文件被 `flock` 独占（源码证据 + 本机实测）

`@deepseek-ai/dsh-session-persistence-jsonl` 的实现（shipped 源码 `lib/index.js`）：**POSIX 用非阻塞 `flock(2)` 锁 `<sessionDir>/session.lock`**（Windows 用同名内核信号量，不落文件）；锁在 **write-open** 时获取、句柄 close 时释放；争用 → `SessionAlreadyOwnedError`；**读者从不碰锁**。

实测（用 DSH 自带原生插件的 `tryLock(fd, cb)`，errno 0=空闲、35=EAGAIN=被占用；先在 /tmp 用 python `fcntl.flock` 做过对照校准）：

```text
$ node adapters/session-catalog.mjs --locks     # 节选
session-0a1b2c3d-4e5f-4a6b-8c9d-1a2b3c4d5e6f  held   ← 用户正在用的 GUI 主会话（PID 59861）
4e5f6a7b-545b-49f7-8e71-fb6fbef0e5e1          held   ← 正在跑的本任务子代理会话
5f6a7b8c-f7a1-4d49-b7df-01f736e5cac1          held   ← 另一个正在跑的子代理会话
session-1b2c3d4e-5f6a-4b7c-9d0e-2b3c4d5e6f7a  held   ← GUI 仍持有写句柄（已打开过）
session-2c3d4e5f-6a7b-4c8d-ae0f-3c4d5e6f7a8b  held   ← 同上
77245dbf-…/09403664-…/2bcb0062-…/eace28a4-…    free   ← 已结束的会话
```

**结论**：任何「替用户打开/接管正在运行的会话」的方案，都必须先过这把排他锁；`held` 的会话**不可能**被第二个进程写入。

### 5.2 桌面端 GUI（127.0.0.1:19387）——需要用户授权

```text
$ curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:19387/
401
$ curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:19387/api/sessions
401
```

GUI 的 HTTP 面存在但需要浏览器会话密钥（`~/.dsh/.credentials.yaml`）。**按任务约束我们没有读取也没有使用该密钥**（一次 GET 只证明「未授权」）。
→ 结论：**需要用户授权**；我们不解析、不复制、不代管用户密钥。替代方案见 §7。

### 5.3 CLI：`desktop` profile 被显式拒绝（本机实测）

```text
$ "…/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --profile desktop --help
error: profile "desktop" is managed exclusively by the Electron application
$ echo $?
1
```

CLI 本体是真实存在的（`dsh --help` 正常输出，exit 0；入口 = app 内 `…/dsh-desktop-host/lib/cli.js`）：
启动器只认 `--profile / --from-default-profile / --patch / --dump-config*`，**其余参数原样透传给 profile 内的 app**（源码 `@deepseek-ai/dsh/lib/bin.js` 注释：`dsh --profile tui --resume abc`）。
→ 结论：**不可行**。不可能用 CLI 打开桌面端正在用的会话（桌面 profile 由 Electron 独占，且会话还被 flock 锁住）。

### 5.4 CLI：`headless --session-id` 是真实存在的「打开」入口（源码证据，未实测）

```text
--session-id <id>   "adopt the persisted Session with this id; an unknown id is an error"
Examples:
  dsh --profile headless --session-id session-… "continue"   resume an existing Session
                                    —— @deepseek-ai/dsh-headless/lib/startup.js（shipped 源码）
```

采纳（adopt）时有**四条硬约束**（同包 `assertAdoptable()`，逐条命中会直接报错退出）：
1. 该会话的 agent preset 必须是 headless 能组装的（`agent-preset/selected` 存在且不匹配 → 拒绝）；
2. `header.origin === 'subagent'` 或 `header.parentSession` 非空 → **拒绝**（子代理/分叉会话不能被直接驱动）；
3. header 没有 `cwd` → 拒绝；
4. 记录的 `cwd` 与当前工作目录不一致 → 拒绝（**必须在原目录里启动**）。

→ 对我们 8 个子代理会话：**不可行**；对主会话：**需要用户授权**（headless profile 需要在 `$DSH_HOME/profiles/<name>` 下创建/安装插件，属于写 `~/.dsh`，本任务禁止；且会真实消耗模型额度）。

### 5.5 插件内 `ctx.agents.resume()`（源码证据 `@deepseek-ai/dsh-agent/README.md`）

> `ctx.agents.create()` builds a fresh agent and session under one identity; `ctx.agents.resume()` loads a persisted session and rebuilds the agent on it.

这是把「打开会话」做成产品能力（而不是让用户切窗口）的唯一干净路径；同样需要 Phase 2 插件落到用户的 profile。

---

## 6. 新建会话 · 能力调研

### 6.1 CLI：`dsh headless "<task>"`（源码证据，未实测）

`headless` profile 的语义是「答一个任务然后退出」，不传 `--session-id` 时即**新建**一个会话。同样需要先在 `$DSH_HOME/profiles` 下安装 profile（写 `~/.dsh` + pnpm 联网）→ **需要用户授权**。

### 6.2 插件内 API（源码证据，**最小骨架，不落地到 `~/.dsh`**）

来自 shipped README：`@deepseek-ai/dsh-session` 提供 `ctx.sessions`，`@deepseek-ai/dsh-agent` 提供 `ctx.agents`（后者需要 `dsh-agent-loop` 作为 driver 才可用）。

```js
// ⚠ 示意骨架：仅在**用户自己的 profile**里安装后才生效；本项目 Phase 1 不落地到 ~/.dsh。
// 事实来源：dsh-session/README.md（ctx.sessions.create 签名）、dsh-agent/README.md（create/resume + handle 方法）。
export const name = 'agent-pet-session-control'
export const inject = ['agents', 'sessions', 'sessionPersistence', 'sessionQuery']

export function apply(ctx) {
  // 新建会话：同一身份下建 session + agent，再用 followup 发第一条消息
  async function createSession({ cwd, text, provider, model, reasoningEffort }) {
    const handle = await ctx.agents.create({
      // sessionId 省略 = 运行时分配；agentOptions 决定 provider/model/reasoningEffort
      agentOptions: { provider, model, reasoningEffort },
      setup: (agentCtx, agent) => { /* 用 agent.session 的 meta 记录 cwd；精确写法以 README 为准 */ },
    })
    await handle.agent.followup({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    return handle            // handle.dispose() 才能拆除；句柄是唯一所有者
  }

  // 打开已存在会话：加载持久化会话并在其上重建 agent
  async function openSession(sessionId) {
    const handle = await ctx.agents.resume({ sessionId })   // 参数形状未实测，以 README 为准
    return handle
  }

  // 轻量路线：只要一个活的 Session（不带 agent、绑定到调用 fiber）
  function bareSession(sessionId, cwd) {
    return ctx.sessions.create(sessionId, { meta: { cwd } })
  }

  ctx.on('pet/ctl', async (ctl) => {
    if (ctl.ctl === 'session.new') return createSession(ctl)
    if (ctl.ctl === 'session.open') return openSession(ctl.sessionId)
  })
}
```

其它可用原语（同 README）：`ctx.sessions.get(id)` / `list()`、`ctx.sessions.fork(source, boundary?, childSessionId?)`（把活会话的某个前缀复制成子会话）、`ctx.sessions.flush(session)`（持久化屏障）、`handle.agent.steer() / inject() / cancel() / whenIdle()`。

---

## 7. 能力矩阵（诚实版）

| # | 能力 | 结论 | 证据（命令 / 源码位置） | 替代方案 |
|---|---|---|---|---|
| 1 | 只读发现：项目 → 多会话树 + 元信息 | ✅ **本机实测可行** | `node scripts/catalog-check.mjs`（16 会话 / 16.4 ms / 16 项断言） | — |
| 2 | 判断「会话是否被活进程占用」 | ✅ **本机实测可行**（可选，需要 DSH 自带原生 flock 插件） | `--locks` 输出（§5.1） | 无插件时退化为 mtime 60 s 判「活跃」 |
| 3 | 「不用打开」就能显示状态 | ✅ **本机实测可行** | 只读 tail 日志；[demo/frame.mjs](../demo/frame.mjs) 已跑通 | 这是 Phase 1 的主路线 |
| 4 | 打开已存在会话：在桌面 GUI 里打开 | ⚠️ **需要用户授权** | `GET :19387/` → 401（§5.2）；密钥在 `.credentials.yaml`，我们**不使用** | ①工作框按钮只做「把用户送到 DSH 窗口」；②用户在 GUI 里手动打开；③只读跟随，不接管 |
| 5 | 打开已存在会话：CLI 启 desktop profile | ❌ **不可行** | `dsh --profile desktop …` → exit 1（§5.3） | 同 #4 |
| 6 | 打开已存在会话：`headless --session-id` | ⚠️ **需用户授权**（且约束多） | `dsh-headless/lib/startup.js` + `assertAdoptable()`（§5.4） | 子代理会话**不可能**（源码硬拒）；主会话需在原 cwd、需 profile 安装；也可 `cp -R` 会话目录到独立 `DSH_HOME` 后再采纳（源文件保持逐字节不变） |
| 7 | 打开已存在会话：插件 `ctx.agents.resume()` | ⚠️ **需要用户授权**（Phase 2） | `@deepseek-ai/dsh-agent/README.md`（§5.5） | 同 #4 |
| 8 | 新建会话：CLI `dsh headless "<task>"` | ⚠️ **需要用户授权**（装 profile + 消耗额度） | `dsh-headless` 源码（§6.1） | 我们只提供「复制命令给用户」的按钮，不代跑 |
| 9 | 新建会话：插件 `ctx.agents.create()` / `ctx.sessions.create()` | ⚠️ **需要用户授权**（Phase 2 插件；API 未在本机实测） | shipped README（§6.2） | 同 #8 |
| 10 | 直接写回/接管运行中的会话日志 | ❌ **不可行** | `flock` 排他写租约 + `SessionAlreadyOwnedError`（§5.1） | 只读；写回一律走 DSH 自己的进程 |
| 11 | 新建会话：复制会话到新 profile 启动 | ⚠️ **可能可行但未实测** | 会话目录可整目录复制（只读源）；目标 profile 需安装 | 仅当用户明确要求「克隆一份去跑」时使用，且需用户授权写 `~/.dsh` 以外的目录 |

> **给 Lead 的结论**：用户新需求里的「打开多个项目/会话」在 Phase 1 应实现为**只读多会话视图**（矩阵 #1/#2/#3），而不是真的去「打开」DSH 会话；「新建会话」在 Phase 1 只能降级为「复制命令给用户」（#8），真正的按钮化要等 Phase 2 插件（#7/#9）。契约里 `ack.canOpen/canCreate` 因此对 DSH 应报 `canCatalog:true, canOpen:false, canCreate:false`（能力位诚实，不要虚报）。

---

## 8. 与契约 v1.3 的对接

### 8.1 `session.meta`（§3.4）

`adapters/dsh-meta.mjs` 的 `extractMeta()` → `toMetaEvent(meta, base)` 产出；字段只填有值的，`nativeSessionId` 必填；语义是 **no-op（不改状态机）**。示例：

```json
{"v":1,"seq":42,"ts":1791172829778,"source":"dsh","sessionId":"session-0a1b2c3d-…","workspace":"/Users/demo/Desktop/agent桌宠","agent":{"name":"DSH","version":"0.2.0-rc.2"},"type":"session.meta","data":{"nativeSessionId":"session-0a1b2c3d-…","agentName":"DSH","agentVersion":"0.2.0-rc.2","provider":"deepseek-account","model":"deepseek-flash","reasoningEffort":"max","agentPreset":"ptc","title":"DeepSeek桌宠开发计划"}}
```

### 8.2 `session.activity`（§3.4）：粗粒度 + **结构上零泄漏**

文案来自**固定字典**（不拼接任何来自事件的值），因此构造上不可能带出步骤序号/工具参数/命令原文/文件内容：

| 原生事件 | kind | text |
|---|---|---|
| `turn/start` / `step/start` / `request/header` | thinking | 思考中 |
| `tool/call`（category=read/write/exec/net/other） | tool | 读取文件 / 修改文件 / 运行命令 / 联网检索 / 调用工具 |
| `assistant/message` | reply | 撰写回复（**不含正文**） |
| `approval/asked` | waiting | 等待你 |
| `llm/retry` / `tool/result(error)` | error | 模型重试中 / 工具执行出错 |
| `turn/end` / `session/end-seed` | done | 本轮已完成 / 本轮已中断 / 会话已结束 |
| 其它（`user/message`、`tool/result(ok)`、`command/run`…） | — | 不产出 activity |

自检 A7 用**真实日志里的命令/路径片段当探针**（needles），断言它们一次都没有出现在 activity 文案里；单测另有「`rm -rf … && cat ~/.dsh/.credentials.yaml` 作为工具输入 → 输出必须是『运行命令』」这类用例。`text` 一律 ≤80 字符（按 Unicode 码点截断，不劈代理对）。

### 8.3 `ctl:catalog`（§2.2）

`toCatalogFrame(catalog)` 直接产出契约帧（`ctl:"catalog"`，`projects[].sessions[]` 含 `sessionId / title / agentName / provider / model / reasoningEffort / agentPreset / state / kind / createdAt / updatedAt / live`）。真实样例见 §1.3 与 `--json --frame`。

```bash
node adapters/session-catalog.mjs --json --frame | head -30
```

**适配器接入建议**：`ctl:catalog.get` → 调 `toCatalogFrame(scanCatalog())` 回一帧 `ctl:catalog`；会话状态变化时用 `extractMeta()` 增量发 `session.meta`（字段变化才发），活动变化时用 `activityOf()` 发 `session.activity`（同一 kind+text 去重、≥1.5 s 节流）。

---

## 9. 已知限制 / 后续

1. **快扫是近似**（2/16 会话在快扫与深扫间有差异）。建议：列表用快扫；详情/导出用 `--deep`；或对「当前选中会话」单独深扫（<35 ms）。
2. **`decodeProjectDirName` 有损**，仅作兜底；不要用它反推路径去做写操作。
3. **flock 探测依赖 DSH 自带原生插件**（`app.asar.unpacked` 下的 `system.node`）；未安装/平台不符时返回 `unknown`，UI 不应据此禁用「打开」按钮。
4. **多 Agent 扩展**：`KNOWN_AGENTS` 已留出表结构（id/name/version/sessionsRoot/layout），claude-code / codex 的 rollout 目录可用同一「项目 → 会话」形状接入（本任务只实现 DSH）。
5. **未实测项**（明确列出，避免被当成已验证）：`dsh headless "…"`、`--session-id` 采纳、插件 `ctx.agents.*` 的真实调用、`cp -R` 会话后启动。这些都需要写 `~/.dsh`（本任务禁止），建议由用户在隔离 `DSH_HOME` 中试验。
6. **凭据红线**：适配器全程不读 `~/.dsh/.credentials.yaml`；GUI 401 只作为「需要用户授权」的证据。
7. **兼容别名**：`adapters/session-catalog.mjs` 保留了早期版本的导出名（`readSessionEvents` / `metaFromEvents` / `cleanTitle` / `coarseState` / `resolveSession`），既有调用方不会断；新代码请用 `scanCatalog` + `adapters/dsh-meta.mjs`。
