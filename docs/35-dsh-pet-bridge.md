# 35 · DSH 桌宠桥接：事件发射路径验证（Phase 1 核心可行性）

> 作者：队友 D（dsh-bridge-researcher），共享任务 task-7。
> 日期：2026-10-05。依据契约：[docs/00-interface-contract.md](./00-interface-contract.md) **v1.2**（FROZEN）。
> 本文件所有命令均在**本机**、**只读**前提下实测（不改 /Applications、不改 ~/.dsh 现有文件、不干扰正在运行的 DSH 会话）；实验产物全部在 /tmp 或项目目录内。
> 承诺：**没有实测支撑的结论一律标注「未验证」并给出验证方法。**

---

## 1. 结论速览

| 路径 | 一句话结论 | 实时事件 | 延迟量级 | 改 DSH 安装包 |
|---|---|---|---|---|
| **A 会话日志增量读取**（zstd 多帧） | **可行**，已实现并跑通 165 条规范事件 | ✅ 准实时 | **中位 ~250 ms**（受 200 ms 写批次限制） | ❌ |
| **B Cordis 用户插件**（挂到自己的 profile） | **可行且最优**，已在 /tmp 副本 profile 实测订阅到 `session/event` | ✅ 进程内同步派发 | **< 1 ms** | ❌（只加用户自己的 cordis.patch.yml 一行） |
| **C hooks.json command hook** | **可行**，实测 PreToolUse/PostToolUse 触发本地命令并送达 stdin payload | ⚠️ 仅 7 个事件点 | **~30 ms/次**（子进程启动） | ❌（同样要在 profile 挂 dsh-hooks-claude-code） |
| **D SDK JSON-RPC / ACP 旁路** | **部分可行**：只能开自己的运行时，**无法附加到正在运行的桌面会话** | ⚠️ 仅自建会话 | 取决于自建运行时 | ❌ |
| **D′ 直连桌面 host 的 HTTP/WS /api** | **技术可行但不建议**：需伪造浏览器会话 cookie（密钥在 ~/.dsh/.credentials.yaml） | ✅ | 低 | ❌（但依赖未公开协议 + 用户密钥） |
| **E 把桌宠做成 MCP server** | 方向相反：MCP 是 DSH→server 的出站调用，**不能用于观测** | ❌ | — | ❌ |

**Phase 1 推荐**：**主路径 B（Cordis 用户插件 → Unix socket）**，**兜底路径 A（会话日志增量 tail，参考实现已交付）**。两者共用同一份「原生事件 → 规范事件」映射与同一个 socket 协议，桌宠侧无差别。

---

## 2. 证据基线

| 项 | 值 | 怎么得到的 |
|---|---|---|
| 机型 / 系统 | macOS Darwin 27.0.0 arm64 | `uname -a` |
| Node | v24.18.0（自带 `zlib.zstdDecompressSync`） | `node -v` |
| DSH | 0.2.0-rc.2（Electron 桌面端） | asar 内 `@deepseek-ai/dsh/package.json` |
| 桌面 host 进程 | PID 59861，监听 `127.0.0.1:19387` | `lsof -nP -iTCP -sTCP:LISTEN` |
| 会话日志 | `~/.dsh/sessions/--<escaped-cwd>--/<id>/session.v4.jsonl.zstd` | 目录列举 |
| zstd CLI（对照） | `/opt/homebrew/bin/zstd` v1.5.7（Lead 独立实测） | `which zstd` |

只读声明：全过程未对 `/Applications/DeepSeek Harness.app` 与 `~/.dsh` 下任何**现有文件**执行写/删；实验用 `/tmp/pet-probe/**` 下的自建副本与自建 DSH_HOME。

---

## 3. 路径 A：会话日志（zstd 多帧 JSONL）离线 + 增量读取

### 3.1 原理

`@deepseek-ai/dsh-session-persistence-jsonl` 把每个会话写成**追加式容器**：header 与每个「持久化批次」各编码成**一个独立可解压、带校验和的 Zstandard frame**，frame 首尾相接、**没有任何分隔符**（源码：`lib/index.js` 的 `compressZstdFrame` / `scanZstdFrames`）。

- 写入批次窗口 = **200 ms**（源码 `enqueueLive()`：`setTimeout(() => drainLive(), 200)`），`fsync` 后才算落盘。
- 读取时选中「编号最高的 canonical generation」，即 `session.v4.jsonl.zstd`。
- 历史版本 `session.v3.jsonl.zstd` 同样存在（本机某项目目录下实测 v3/v4 并存）。

### 3.2 实测：为什么「只能读到 session 头」

    node -e "const z=require('node:zlib'),f=require('node:fs');console.log(z.zstdDecompressSync(f.readFileSync(process.argv[1])).length)" \
      "$HOME/.dsh/sessions/--Users-demo-Desktop-agent~684C~5BA0--/session-0a1b2c3d-4e5f-4a6b-8c9d-1a2b3c4d5e6f/session.v4.jsonl.zstd"

输出：`213` —— 该文件 372 837 字节，而 `zstdDecompressSync` 只解出 213 字节，正好是首行 `{"type":"session","version":4,...}`。

流式 API `zlib.createZstdDecompress()` 行为相同：**读到第一帧结束即停**（实测输出同样 213 字节）。这就是「只能拿到首行会话头」的根因——不是权限、不是加密，而是**多帧容器**。

按 magic `28 b5 2f fd` 扫描同一文件：**171 处命中**（含压缩数据内的偶发误命中），说明该文件约 170+ 个 frame。

### 3.3 四种读法对比（本机实测）

| 方案 | 原理 | 实测 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|---|
| **① 结构化 frame 扫描**（已实现，推荐） | 按 RFC 8878 解析 frame header（magic + descriptor + window/dict/content-size）与 block header（3 字节：last/type/size）+ checksum，得到精确的 `[start,end)`，再逐帧解压 | 376 273 B → **176 完整帧 / 305 行 / 0 行解析失败**；392 207 B → 185 帧 / 322 行；另一会话 166 945 B → 4 帧 / 179 行 | 零误判、零外部依赖、能精确定位半帧起点 | 需自写约 60 行解析（已交付） | ✅ **主选** |
| ② magic 扫描 + 切片解压（Lead 独立实测） | 扫所有 magic 偏移，相邻偏移间切片解压 | 410 帧 / 681 行 / 19 ms，0 失败；5 会话全通过 | 实现最短、极快 | magic 可能出现在压缩数据内部造成误命中（需跳过并计数；本机实测 0 次） | ✅ 可用备选 |
| ③ `zstdcat` CLI | 调 zstd 命令行 | 完整解码（Lead 实测 416+ 行） | 一行搞定 | **引入外部依赖**；子进程难以精确处理「写入中的半帧」 | ⚠️ 仅开发期调试 |
| ④ `compression: 'none'` | 让 DSH 写纯文本 JSONL | 源码确认配置存在（默认仍然 zstd） | 外部工具直接可读 | **要改用户 profile 的持久化配置**，且只对新会话生效 | ⚠️ 不作主路径；可作「专用桌宠 profile」选项 |

> 交付的 `adapters/_reference/dsh-log-tail.mjs` 采用方案 ①，与 DSH 自己的 `scanZstdFrames` 规则等价——先读 DSH 源码确认存储格式，再按同一规则实现，保证长期一致。

### 3.4 实测：追加写入与「尾部半帧」（torn tail）

    node /tmp/torn-test.mjs "$HOME/.dsh/sessions/--Users-demo-Desktop-agent~684C~5BA0--/session-0a1b2c3d-4e5f-4a6b-8c9d-1a2b3c4d5e6f/session.v4.jsonl.zstd"

输出摘要：

    [copy] frames 185 lines 322 tornStart undefined
    [torn cut=196103] frames 109 lines 199 tornStart 195928    <- 半帧起点被精确定位
    [torn cut=392200] frames 184 lines 320 tornStart 391357
    [append] frames 186 lines 323 last line {"type":"turn/end","seq":999,...}
    [torn-append] frames 185 lines 322 tornStart 392207        <- 追加的半帧不算完整帧

结论：**追加写入 = 追加一个新 frame**；写入中途的尾部半帧可以被精确定位（`tornStart`），用 `ZSTD_e_flush` 做前缀恢复时**只保留以换行收尾的完整行**，半个 JSON 绝不外发。参考实现再加一层「原生 `seq` 高水位去重」，保证半帧恢复的内容在帧补全后不重复下发。

### 3.5 实测：端到端延迟

方法：每 100 ms 轮询「最近修改的最多 3 个会话日志」，记录每个原生事件**首次在磁盘上可见**的时刻，减去事件自带的 `time`。

结果（218 个「10 s 内被观测到」的样本）：

| 指标 | 值 |
|---|---|
| min | **14 ms** |
| p50 | **247 ms** |
| 分布 | <200 ms：91 个；200–300 ms：67 个；300–500 ms：12 个 |
| p90 / max | 4.5 s / 8.9 s（尾巴是测量伪影：只盯 3 个文件，被挤出 top-3 的会话会攒一批一起被读到） |

**解读**：72% 的样本 ≤ 300 ms，与源码的 200 ms 写批次窗口吻合。**路径 A 的端到端延迟 ≈ 200 ms（批次）+ 一个轮询周期（建议 150 ms）≈ 350 ms 上限**，对桌宠动画完全够用。

### 3.6 能拿到什么

- **全部 60+ 种** `KNOWN_SESSION_EVENT_TYPES`（词表见 `dsh-session/lib/types/known-event-types.js`）——它们都写进同一份日志。
- 每条事件的公共字段：`type`、`seq`（会话内单调）、`time`（**注意是 time 不是 ts**）、`data`。
- 首行 header：`{"type":"session","version":4,"id","createdAt","cwd","isSeeded","delegationDepth","agentPreset"}`。
- 本机多会话实测到的类型：turn/start、turn/end、step/start、step/end、tool/call、tool/result、assistant/message、user/message、agent/inbox/spliced、approval/asked、approval/decided、approval/policy、permission/preset、sandbox/mode、session/title、session/title-llm-request、request/header、request/context、system/message、todo/write、deliverables/presented、team/task、team/member、subagent/catalog、subagent/descriptor、llm/retry(-started)、assistant/attempt、tool/ptc-dispatch(-start)、web/deepseek-search-llm-request、session-log-deepseek/delivery-accepted、command/run、command/done、session/end-seed。

### 3.7 稳定性与风险

- **只读**：`fs.readFileSync` + 纯内存扫描，不写不移不锁，对 DSH 无影响。
- 文件被「torn-tail 修复」截断时长度会回退 → 参考实现检测到回退即重置扫描偏移，并用 `seq` 去重。
- 子代理会话写在**同级另一个目录**（如 `2bcb0062-.../session.v4.jsonl.zstd`）：实现「一个桌宠 + N 徽标」必须**并行 tail 多个会话目录**（参考实现支持 `--list` 与按会话选择，多会话 fan-out 建议放到适配器守护进程）。
- 无法区分「正常结束」与「进程被 kill」：日志里**没有会话结束事件**（见 §9 第 2 行）。

### 3.8 结论

**可行**，作为兜底主路径已交付可用实现。不需要改 DSH、不需要额外依赖，代价是 ~250 ms 延迟 + 多会话 fan-out。

---

## 4. 路径 B：Cordis 用户插件（本机实测通过，推荐主路径）

### 4.1 原理

DSH 是 Cordis 生态：profile 目录（`$DSH_HOME/profiles/<name>/`）内有 `package.json`（`dsh.profile.bundles` 有序 bundle 列表）与 `cordis.patch.yml`（**用户自己的补丁层**）。组合顺序（`@deepseek-ai/dsh/README.md`）：

    bundle 层（按 bundles 顺序） → profile/cordis.patch.yml → $DSH_HOME/cordis.patch.yml → --patch 覆盖层

补丁文件是「顶层 YAML 数组的 loader patch entries（id 定向的 config 覆盖 / 禁用 / insert 列表）」；`cordis-plugin-loader` 的 entry `name` 接受任意模块 specifier，**包括本地文件路径**。

`dsh-session` 通过 ctx 扩展点发布事件（源码 `dsh-session/lib/index.js`）：

    ctx.on('session/created',  (session) => {})
    ctx.on('session/event',    (session, event) => {})   // event = { type, seq, time, data, ... }
    ctx.on('session/disposed', (session) => {})

`dsh-session-persistence-jsonl` 本身就是这样一个订阅者（`ctx.on("session/event", ...)`）。

### 4.2 实测：不碰安装包、不碰 ~/.dsh 现有文件，挂上本地插件

在 `/tmp/pet-probe/` 下自建 DSH_HOME 与 profile：

    # /tmp/pet-probe/home/profiles/petprobe/package.json
    { "name": "dsh-profile-petprobe", "private": true, "dependencies": {},
      "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } } }

    # /tmp/pet-probe/home/profiles/petprobe/cordis.patch.yml
    - insert:
        - id: pet-probe
          name: '/tmp/pet-probe/probe-plugin.mjs'

用安装包自带 CLI 启动（DSH_HOME 指向 /tmp，完全不碰 ~/.dsh）：

    DSH_HOME=/tmp/pet-probe/home \
      "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --profile petprobe --dump-config | tail -5

组合结果（本地路径被解析为 file:// URL）：

    # == /tmp/pet-probe/home/profiles/petprobe/cordis.patch.yml
    - id: pet-probe
      name: file:///tmp/pet-probe/probe-plugin.mjs

真启动后，插件 `apply()` 里注册 `ctx.on('session/event', ...)` 并把事件落盘。实测输出（`/tmp/pet-probe/out.jsonl`）节选：

    {"t":"plugin-applied","pid":64182,"ts":1791173140077}
    {"t":"created","sessionId":"pet-probe-session","ts":1791173141582}
    {"t":"event","sessionId":"pet-probe-session","seq":3,"type":"turn/start","time":1791173141586,"at":1791173141586,"data":{"turn":1}}
    {"t":"event","sessionId":"pet-probe-session","seq":4,"type":"tool/call","time":1791173141587,"at":1791173141587,
     "data":{"turn":1,"step":1,"callId":"call_probe_1","name":"bash","arguments":"{\"command\":\"echo hi\",...}"}}

**`time` 与 `at` 的差 = 0–1 ms**：`session/event` 在 `append()` 内**同步派发**，没有落盘、没有轮询。

### 4.3 实测：改自己的 profile 补丁文件即可热插拔（无需重启 DSH）

插件进程运行中直接改写 `/tmp/pet-probe/home/profiles/petprobe/cordis.patch.yml`（给插件加一个 `config.marker`），约 8 秒后：

    grep -c plugin-applied /tmp/pet-probe/out.jsonl          # 1 -> 2
    {"t":"plugin-applied","pid":67350,"ts":1791174055460,"config":{"marker":"hmr-v3"}}

同一进程内插件被重新 apply 并拿到新配置。依据：base 层挂了 `@deepseek-ai/dsh-hmr`，DSH README 明确「dsh-hmr 监听 profile manifest 与 profile/home 补丁文件并串行重载」。

> ⚠️ 该 HMR 结论是在 **/tmp 自建的 base-backed profile** 上实测的，不是用户真实 desktop profile（改它被任务禁止）。desktop profile 同样组合了 base 层，机制相同；端到端确认需要一次用户授权的配置改动。

### 4.4 代价与风险

- 需要在**用户自己的** `cordis.patch.yml` 里加一条 insert（只增不删，不动现有行）。
- 插件是**进程内**代码：写好零开销，写差会拖慢整个 DSH。必须：异常全兜、socket 写失败不阻塞、不做同步重 IO。
- 版本耦合：`event.data` 随 DSH 版本演化；适配器必须对未知 `type` 与未知字段「忽略并计数」（契约 §1.5）。
- **desktop profile 名被保留**：CLI 拒绝 `dsh --profile desktop`，所以验证要在 /tmp 复制 profile 上做。

### 4.5 本机 desktop profile 现状（只读）

    # ~/.dsh/profiles/desktop/package.json
    "dsh": { "profile": { "bundles": [
      "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
      "@deepseek-ai/dsh-experimental-auto-review",
      "@deepseek-ai/dsh-experimental-agent-team-profile",
      "@deepseek-ai/dsh-experimental-schedule-bundle",
      "@deepseek-ai/dsh-experimental-voice-input-bundle" ] } }

    # ~/.dsh/profiles/desktop/cordis.patch.yml ：已有 ui-chat / ui-settings /
    # agent-default-model / agent-preset-registry 等 id 定向覆盖，与我们的 insert 完全同类

落地形态：在这份 `cordis.patch.yml` 末尾追加一个 insert（或在 Web 侧栏 Plugins 页安装一个本地路径 bundle），指向桌宠桥接插件。

### 4.6 结论

**可行，作为 Phase 1 主路径。** 延迟 <1 ms、事件全覆盖、不改安装包、可热插拔；代价是维护一份用户插件 + 一次用户配置改动。

---

## 5. 路径 C：hooks.json command hook

### 5.1 原理

`@deepseek-ai/dsh-hooks-claude-code` 把 Claude Code 的 `hooks.json` **command hook** 桥到 DSH 拦截缝。源码 `lib/index.js` 注册的点：

    ctx.on("agent/created",       ...)  -> SessionStart
    ctx.on("agent/pre-step",      ...)  -> UserPromptSubmit
    ctx.on("tools/pre-execute",   ...)  -> PreToolUse
    ctx.on("tools/post-execute",  ...)  -> PostToolUse
    ctx.on("agent/turn-stopping", ...)  -> Stop
    ctx.on("subagent/start",      ...)  -> SubagentStart
    ctx.on("subagent/end",        ...)  -> SubagentStop

只跑 `type: "command"` 的 hook；http / mcp_tool / prompt / agent 被归入 `skipped` 并由 `ctx.logger.warn` 告警（源码 `parseClaudeCodeConfig` 与 `apply` 的 warn 分支）。

### 5.2 实测：挂上桥 + 触发真实缝，hook 本地命令确实执行

在 /tmp profile 里加一行：

    - id: hooks-claude-code
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: /tmp/pet-probe/hooks.json

`hooks.json`（含一个 http hook 作「不支持类型」对照）：

    { "hooks": {
        "PreToolUse":  [ { "matcher": "bash", "hooks": [
            { "type": "command", "command": "node /tmp/pet-probe/hook-writer.mjs PreToolUse" },
            { "type": "http",    "url": "http://127.0.0.1:9/should-be-skipped" } ] } ],
        "PostToolUse": [ { "matcher": "bash", "hooks": [
            { "type": "command", "command": "node /tmp/pet-probe/hook-writer.mjs PostToolUse" } ] } ] } }

hook 命令把 stdin 原样落盘，实测收到的 payload：

    {"argv":["PreToolUse"],"at":1791173227193,"pid":64983,
     "stdin":"{\"session_id\":\"\",\"transcript_path\":\"\",\"cwd\":\"/private/tmp\",
       \"hook_event_name\":\"PreToolUse\",\"tool_name\":\"bash\",
       \"tool_input\":{\"command\":\"echo hi\",\"description\":\"probe\"},
       \"tool_use_id\":\"call_probe_1\"}\n"}

    {"argv":["PostToolUse"],"at":1791173227226,...,
     "stdin":"{...,\"hook_event_name\":\"PostToolUse\",...,\"tool_response\":\"hi\"}\n"}

**这就是「hooks.json 触发本地命令 → 写事件文件」的端到端证据**：hook 进程被真实拉起，stdin 里有结构化 payload。

### 5.3 延迟

两次 hook 的时间戳相差 **33 ms**（227193 → 227226），其中含 PreToolUse hook 完整往返 + PostToolUse hook 启动，即**单个 command hook ≈ 30 ms**（主要是 Node 冷启动）。

### 5.4 覆盖与缺口

| 契约事件 | hook 能否提供 | 说明 |
|---|---|---|
| `session.start` | ✅ SessionStart | 但 `transcript_path` **恒为空串**（源码：默认 zstd 日志对外部脚本不可读） |
| `turn.start` | ✅ UserPromptSubmit | 无 turnId，只有 session_id / prompt |
| `tool.call` | ✅ PreToolUse | tool_name + tool_input + tool_use_id |
| `tool.result` | ✅ PostToolUse | tool_response；**失败路径 PostToolUseFailure 未桥接** |
| `turn.end` | ✅ Stop | 语义是「即将停止」，不是「已结束」 |
| step.* / message.assistant | ❌ | 无对应缝 |
| approval.* | ❌ | PermissionRequest 未桥接（README 明确列出该缺口） |
| user.question | ❌ | 无对应缝 |

### 5.5 结论

**部分可行**：可作兜底或补充，不能作主路径（只有 7 个点，拿不到 step / 审批 / 助手文本，且有 ~30 ms 子进程开销与阻塞语义）。额外代价同 B：仍要在 profile 里挂 `dsh-hooks-claude-code`。

---

## 6. 路径 D：SDK JSON-RPC / ACP 旁路

### 6.1 事实

- `@deepseek-ai/dsh-sdk-jsonrpc-server`：stdio JSON-RPC 服务；客户端 `initialize` → `session/prompt`，服务端把**每条持久事件**作为 `session.event` 通知推给客户端（源码 `ctx.on("session/event", ...)`）。它服务的是**它自己拥有的 plugin tree**（`dsh --profile sdk`）。
- `@deepseek-ai/dsh-acp`：`dsh --profile acp` 起 stdio ACP server，支持 session/new、session/list、session/resume、session/close。
- `@deepseek-ai/dsh-headless`：`dsh --profile headless "task"`，`--json` 输出 session / status / text / thinking / tool_call / tool_result 事件流。

### 6.2 为什么不能附加到「正在运行的桌面会话」

1. **运行中的桌面 host 不是 JSON-RPC/ACP 服务端**：它是 Electron 主进程内的 plugin tree（PID 59861），只监听 `127.0.0.1:19387` 的 Web HTTP/WS。
2. **同会话写锁排他**：每个会话目录有 `session.lock`，源码用 `tryLockExclusive`（`@deepseek-ai/node-addon-system/flock`）做**内核级排他锁**；第二个进程无法以 write 打开同一会话。headless README 也写明「同一进程内已有 Agent 占用该 id 时拒绝」。
3. **HTTP API 有认证栅栏**：实测

       curl -s -i http://127.0.0.1:19387/
       HTTP/1.1 401 Unauthorized
       dsh web authentication required; reopen the URL printed by dsh web.

   源码说明：进程启动时 mint 一个随机 launch token，Web 端把它放在 ?token= 上换取**签名 cookie**；签名密钥是 `ctx.credentials` 里 owner-scoped 的 `client-connection/browser-session` 记录，本地 provider 存在 `$DSH_HOME/.credentials.yaml`。静态资源公开，RPC/WS 一律要 cookie。

### 6.3 判定

- **「旁路客户端观测正在运行的桌面会话」→ 不可行**（无公开接口，且会话被排他锁占住）。
- **「自己起一个受控运行时并完整观测」→ 可行**，但那是另一条产品路线（桌宠驱动 agent），不是「对用户已有的 DSH 工作状态做反应」。
- D′（读 `~/.credentials.yaml` 伪造 cookie 直连 /api）**技术上做得到但不建议**：依赖未公开内部协议、要碰用户密钥、DSH 升级即碎。**结论：不采用。**

---

## 7. 路径 E：MCP

`dsh-mcp-client` 是 **DSH 作为 client 去连别人的 MCP server**。把桌宠做成 MCP server，只能让 **DSH 主动调用桌宠**（回答「桌宠能做什么」，比如 pet.say / pet.react），**方向与观测相反**：它不能订阅 DSH 的工作状态，也不会在 DSH 忙碌或等待审批时被通知。

**结论**：MCP 对 Phase 1 的事件观测没有价值。将来若要「agent 主动指挥桌宠」可另开一条工具通道，但那不是本任务的问题。

---

## 8. Phase 1 推荐方案

### 8.1 主路径 B

    用户 ~/.dsh/profiles/desktop/cordis.patch.yml
      └─ insert: { id: pet-bridge, name: '/绝对路径/agent桌宠/adapters/dsh/pet-bridge-plugin.mjs' }
             │   （跑在 DSH 主进程内，随 DSH 启动/热重载）
             ▼
    ctx.on('session/event' | 'session/created' | 'session/disposed')
             ▼  映射器（纯函数，与路径 A 共用同一份）
             ▼  Unix socket（契约 §5.1）：$TMPDIR/agent-pet/dsh.sock
             ▼  先 {"ctl":"hello"} → 等 {"ctl":"ack"}（§5.2）→ 再发事件
    桌宠 Hub（独立进程）→ pet.snapshot → 渲染层

- **谁在什么进程里跑**：映射 + 发送在 **DSH 进程内**（一个约 300 行、零依赖的 Cordis 插件）；状态机、聚合、渲染在**桌宠侧**——符合契约「适配器极薄」。
- **与契约 §5 的对接**：行分隔 JSONL；socket 路径 `$TMPDIR/agent-pet/<source>.sock`；连上先 hello/ack（3 s 超时、重试 2 次）；事件信封按 §2.1；`seq` per-`(source, sessionId)` 各自从 0 开始，后端级心跳用保留值 `sessionId="backend"`。
- **写插件时必须满足**：所有回调 try/catch；socket 断开时有界缓冲 + 丢弃并计数，绝不阻塞 `append()`；不传消息正文（`assistant/message` 只取 text 部分并截断 280 字符 + 标 `truncated`）；未知 `type` 计数不抛错。

### 8.2 兜底路径 A（已交付可运行实现）

`adapters/_reference/dsh-log-tail.mjs`：不需要用户改任何 DSH 配置，进程外 tail 会话日志 → 同一个 socket 协议。用途：① 路径 B 未上线时的 Demo 主路径；② B 上线后的**对账/取证**通道（两条路径输出应一致）；③ 离线回放与回归测试的数据源。

### 8.3 里程碑级实现步骤

| # | 里程碑 | 交付 | 验收命令 |
|---|---|---|---|
| M0 | 契约与 schema 冻结 | `schema/pet-event.schema.json` + 校验器 | `node schema/validate-pet-event.mjs --self-test` |
| M1 | 兜底适配器可跑 | `adapters/_reference/dsh-log-tail.mjs` | `node adapters/_reference/dsh-log-tail.mjs --latest --follow` |
| M2 | Hub socket + hello/ack | 桌宠侧 Hub | 起 Hub 后跑适配器 `--socket`（本文件 §4/§11 已实测握手） |
| M3 | 主路径插件 | `adapters/dsh/pet-bridge-plugin.mjs`（Cordis 插件，复用 M1 映射器） | 在 /tmp 复制 profile 上跑 §4.2 的实验 |
| M4 | 用户环境接入 | `~/.dsh/profiles/desktop/cordis.patch.yml` 加一行 insert（**需用户授权**） | 观察 DSH 内桌宠实时反应；HMR 生效则无需重启 |
| M5 | 演示脚本 | 一键起 Hub + 适配器 + 渲染层 | `kill -9` 适配器 → 45 s 内桌宠回 idle（契约 §7.2） |

---

## 9. DSH 原生事件 → 规范事件映射表（契约 §3 全覆盖：16 行 / 16 个 type 字符串）

图例：✅ 直接可得；🟡 需派生或启发式；❌ DSH 无法提供（附兜底）。

| # | 规范 type | DSH 原生来源 | 字段抽取 | 判定 |
|---|---|---|---|---|
| 1 | `session.start` | 日志首行 `{"type":"session",...}`；插件路径另有 `session/created` 扩展点 | `id`→nativeSessionId、`cwd`→workspace、`createdAt`→ts | ✅ |
| 2 | `session.end` | ❌ **日志无此事件** | — | ❌ 兜底：插件路径用 `session/disposed`；日志路径用 `--idle-end-ms` 在文件停止增长 N 秒后发 `reason:"unknown"`；`kill -9` 只能靠契约 §4.4 的 45 s 离线判定 |
| 3 | `pet.heartbeat` | ❌ 无原生事件 | load 无真实来源 → 恒 0；sessionCount 由适配器统计 | 🟡 适配器自产，每 15 s，`sessionId="backend"` |
| 4 | `turn.start` | `turn/start` | `data.turn`→turnId；inputKind 由前一条 `user/message` / `system/message` 推断（缺省 user） | ✅（inputKind 🟡） |
| 5 | `turn.end` | `turn/end` | reason.kind：completed→ok、aborted→aborted、其余→error；durationMs = 本事件 time − turn/start time | ✅ |
| 6 | `step.start` | `step/start` | `data.turn`+`data.step`→turnId/stepId/index | ✅ |
| 7 | `step.end` | `step/end` | 原生**只有** {turn, step}：status 需派生（该步内出现 `tool/result(isError)` → error，否则 ok）；durationMs 由两个事件时间差得到 | 🟡 |
| 8 | `message.assistant` | `assistant/message` | `data.message.content[]` 中 `type==="text"` 的部分拼接（reasoning / tool-call 部分**不传**），截断 280 + truncated | ✅（PTC 预设下中间消息常只有 reasoning，最终答复才有 text） |
| 9 | `tool.call` | `tool/call` | `data.name`→toolName、callId；`data.arguments`（JSON 字符串）解析 command/file_path/url→summary；category 由工具名分类；risk 由 category 映射 | ✅（category/risk 🟡） |
| 10 | `tool.result` | `tool/result` | `message.isError===true`→error；文本命中 denied/blocked 类词→denied；否则 ok；durationMs = 与 `tool/call` 的时间差 | ✅（denied 🟡） |
| 11 | `approval.request` | `approval/asked` | `data.id`→requestId、`data.toolName`→kind（bash/exec→command、写类→file-write、net→network、沙箱/权限→permission、其余→other）、`data.reason`→summary、`data.callId`→callId | ✅ |
| 12 | `approval.resolved` | `approval/decided` | `data.id`→requestId；outcome 折叠：allowed-once→allow、rejected→deny、unavailable→deny、cancelled→timeout；latencyMs = 与 asked 的时间差 | ✅（4→3 折叠有损） |
| 13 | `user.question` | ❌ 无原生事件 | 由 `tool/call` 中 name 匹配 ask_user* 映射：callId→questionId、`arguments.questions[0].question`→text、options[].label→options | 🟡 项目内约定（适配器启发式） |
| 14 | `user.answer` | ❌ 无原生事件 | 上述 tool/call 对应的 `tool/result` → user.answer | 🟡 |
| 15 | `agent.status` | ❌ 无原生事件 | 由 turn/start→thinking、step/start 与 tool/call→working、approval/asked→waiting 派生（只发 5 个允许值，绝不发 done） | 🟡 适配器自产 |
| 16 | `error.raised` | `tool/result(isError)`、llm/retry(-started)、`turn/end(reason≠completed)` | scope = tool / llm / session；**fatal 恒 false**（单事件不足以判定 source 死亡，交给 §4.4 离线判定） | ✅（fatal 保守） |

**DSH 无法提供（含兜底）**：`session.end`（无日志事件）、`user.question`/`user.answer`（无原生事件）、`pet.heartbeat` 与 `agent.status`（无原生事件，适配器自产）、`step.end.status`（需派生）、助手 token 流（v1 明确不做）。

---

## 10. 上游需求清单（若需 DSH 团队配合）

| 优先级 | 需求 | 为什么 | 最小可用形态 |
|---|---|---|---|
| P0 | **稳定的实时事件订阅接口**（进程外可用的只读事件流） | 路径 B 的 `session/event` 是**内部**扩展点，签名/字段无兼容承诺；路径 A 有 200 ms 批次延迟且要自己解 zstd | 一个开关即可：`dsh --event-stream unix:$TMPDIR/dsh-events.sock`，或让持久化层写盘后向该 socket 复制一份 JSONL（**不需要新增事件类型**） |
| P1 | **会话结束事件** | 契约 `session.end` 目前无可靠来源；正常结束与 kill -9 无法区分 | 在 `session/disposed` 时写一条 `session/end`（reason: done/aborted/error/unknown）到日志或事件流 |
| P1 | **会话日志「可安全只读 tail」的公开承诺**（或只读句柄） | 现在第二个进程读活跃会话没有语义保证 | 文档承诺追加写语义 + 一个 `dsh session tail <id> --json` 只读命令 |
| P2 | **hook 桥补齐 PermissionRequest / PostToolUseFailure** | 路径 C 拿不到审批与失败事件 | 在 `dsh-hooks-claude-code` 加两个 emit 点（与现有 PreToolUse 同构） |
| P2 | **`compression: 'none'` 的文档化** | 让外部适配器不必实现 zstd 帧扫描 | 文档 + 一个 profile 示例 |
| P3 | 官方 `dsh session tail <id> --json` | 所有第三方适配器不必各写一份 frame 扫描 | 复用现有 `open(id,'read')` |

---

## 11. 复现命令（可复制执行）

    # 0) 只读探测
    ps aux | grep -i "DeepSeek Harness" | grep -v grep | head -3
    lsof -nP -iTCP -sTCP:LISTEN | grep -i deepseek

    # 1) 证明「Node 只解第一帧」（打印 213 字节 = 首行 header）
    node -e "const z=require('node:zlib'),f=require('node:fs');console.log(z.zstdDecompressSync(f.readFileSync(process.argv[1])).toString())" \
      "$HOME/.dsh/sessions/--Users-demo-Desktop-agent~684C~5BA0--/session-0a1b2c3d-4e5f-4a6b-8c9d-1a2b3c4d5e6f/session.v4.jsonl.zstd"

    # 2) 参考适配器
    node adapters/_reference/dsh-log-tail.mjs --list
    node adapters/_reference/dsh-log-tail.mjs --latest | head -3
    node adapters/_reference/dsh-log-tail.mjs --self-check
    node adapters/_reference/dsh-log-tail.mjs --latest --follow --socket /tmp/agent-pet/dsh.sock
    #   ↑ 需要先有 Hub 在监听；无 Hub 时会按契约 §5.2 等 ack 3 s x 3 次后打印原因并以非 0 退出（不崩）

    # 3) schema 与 fixture
    node schema/validate-pet-event.mjs --self-test
    node schema/validate-pet-event.mjs fixtures/contract-sample.pet.jsonl

    # 4) 路径 B：/tmp 自建 profile 挂本地插件（不碰 ~/.dsh）
    mkdir -p /tmp/pet-probe/home/profiles/petprobe
    #    写入 package.json / cordis.patch.yml / probe-plugin.mjs（见 §4.2）
    DSH_HOME=/tmp/pet-probe/home \
      "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --profile petprobe --dump-config | tail -5
    DSH_HOME=/tmp/pet-probe/home \
      "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --profile petprobe

    # 5) 路径 D：确认运行中的 host 需要浏览器会话
    curl -s -i http://127.0.0.1:19387/ | head -3      # -> 401

> `dsh --profile desktop` 被 CLI 拒绝（名字保留给 Electron），所以第 4 步用自建 profile 名。

---

## 12. 未验证项与验证方法（诚实清单）

| 未验证项 | 为什么没验证 | 怎么验证 |
|---|---|---|
| 在真实 desktop profile 挂插件并观察用户真实会话 | 任务禁止改 `~/.dsh/profiles/desktop` | 用户授权后：备份该文件 → 追加一行 insert → 观察 → 还原 |
| desktop 组合下 `dsh-hmr` 是否真的监听 cordis.patch.yml | 同上 | 授权后改一个 config 值，看插件是否重新 apply（机制已在 /tmp 副本证明） |
| `llm/retry` / `assistant/attempt` 的 data 具体字段 | 本机日志出现过该类型但未取到样本 | 找到含该事件的历史会话后逐条打印 |
| `session.end` 的准确判定（正常退出 vs kill -9） | 需要真实杀掉 DSH 才能测 | 在 /tmp 自建 DSH_HOME 跑 headless 会话，两种退出各一次，对比日志尾部 |
| 45 s 离线判定在真实桌面端的行为 | 属 Hub 侧实现，不在本任务范围 | Hub 单测 + 契约 §7.2 |

---

## 13. 来源

- 本机 DSH 0.2.0-rc.2 包源码（asar 内 `dsh/node_modules/@deepseek-ai/**`）：`dsh-session`、`dsh-session-persistence-jsonl`（scanZstdFrames / enqueueLive 200 ms / compression 配置）、`dsh-hooks-claude-code`（7 个 emit 点、parseClaudeCodeConfig、transcript_path 恒空）、`dsh-sdk-jsonrpc-server`、`dsh-acp`、`dsh-headless`、`dsh-client-connection`（cookie 认证）、`dsh-host-webserver`、`dsh-user-approval`（OUTCOMES）、`dsh-tool-ask-user`、`cordis-plugin-loader`、`dsh-plugin-manager`、`dsh-app-boot`、`dsh`（CLI 用法）、`dsh-base/cordis.patch.yml`、`dsh-web-app/cordis.patch.yml`。
- 契约：[docs/00-interface-contract.md](./00-interface-contract.md) v1.2。
- RFC 8878（Zstandard 压缩格式：frame header / block header 布局）。
- 上游独立实测（Lead）：zstd CLI v1.5.7 可用；`zstd -l -v` 报告某会话 259 帧；magic 扫描法 410 帧 / 681 行 / 19 ms。
- 访问日期：2026-10-05。

---

## 14. 交付物清单（task-7）

| 文件 | 说明 |
|---|---|
| [docs/35-dsh-pet-bridge.md](./35-dsh-pet-bridge.md) | 本文件：A~E 路径实测、推荐方案、映射表、上游需求清单 |
| [schema/pet-event.schema.json](../schema/pet-event.schema.json) | 契约 **v1.2** 的 JSON Schema 2020-12（16 事件分支 + 4 控制帧分支，含 startedAt/endedAt/observes） |
| [schema/validate-pet-event.mjs](../schema/validate-pet-event.mjs) | 无依赖校验器 + `--self-test` |
| [adapters/_reference/dsh-log-tail.mjs](../adapters/_reference/dsh-log-tail.mjs) | 可运行的 DSH 会话日志 → 规范事件适配器（多帧 / 追加 / 半帧 / hello-ack 握手） |
| [docs/90-research-notes.md](./90-research-notes.md) | 「队友 D 段」：原始命令与输出片段 |
