# 54 · DSH 桌宠插件（进程内桥接）：协议、挂载与回滚

> 作者：队友 D（dsh-bridge-researcher），task-14。日期 2026-10-05。
> 代码：[plugins/dsh-pet/index.js](../plugins/dsh-pet/index.js)（Cordis 插件，零依赖）+ [plugins/dsh-pet/probe.mjs](../plugins/dsh-pet/probe.mjs)（/tmp 预演）。
> 契约：[docs/00-interface-contract.md](./00-interface-contract.md) **v1.3**。前置实测：[docs/35-dsh-pet-bridge.md](./35-dsh-pet-bridge.md) 路径 B。
> **当前状态：已在 /tmp 副本 profile 端到端验证；尚未挂到用户的 desktop profile（等授权）。**

---

## 1. 它解决什么

| 问题 | 插件做法 | 实测结果 |
|---|---|---|
| 日志 tail 有 ~250 ms 写批次延迟 | 进程内 `ctx.on('session/event')` → 立即推帧 | **同步派发，<1 ms**（docs/35 §4.2） |
| 悬浮窗只能看、不能操作 | `POST /input` 把文本投进会话 | ✅ 已投递成功（见 §6） |
| 多项目/多会话 | `POST /new`、`POST /open`、`POST /ctl {"ctl":"catalog.get"}` | ✅ 全部可用（见 §6） |

---

## 2. Socket 协议

传输：**Unix domain socket 上的最小 HTTP/1.1**（不是契约 §5.1 的裸 JSONL 行协议）。
理由：请求/响应需要同步返回 `{ok,detail}`，HTTP 让 curl 一行可测；事件推送仍用契约的行分隔 JSONL（NDJSON 长连响应）。

- 默认路径：`$TMPDIR/agent-pet/dsh-plugin.sock`（macOS 上 `$TMPDIR` 是每用户私有临时目录）
- 覆盖：插件 config 的 `socket` 字段；预演脚本用 `PROBE_SOCK`
- 单实例：同目录写 `dsh-plugin.lock`（`{pid, at, source}`，5 s 心跳）；已有存活锁则**拒绝启动**；退出时释放并删除自己的 socket，**不 unlink 他人的 socket**
- 请求体上限 256 KB；端口不占用（纯文件系统 socket，不开 TCP）

### 2.1 端点

| 方法 + 路径 | 请求体 | 响应 |
|---|---|---|
| `GET /health` | — | `{ok, contract, source, pid, socket, startedAt, subscribers, events, unknownEvents, capabilities}` |
| `GET /events` | — | **长连 NDJSON**：先一条 `ctl:hello`，随后是契约 v1.3 事件帧 |
| `POST /input` | `{"text":"…","sessionId"?,"mode"?:"followup"|"steer"}` | `{ok, via, sessionId, mode, sessionSource}` 或 `{ok:false, code, detail}` |
| `POST /new` | `{"cwd":"/abs/path"}` | `{ok, via, sessionId}` |
| `POST /open` | `{"sessionId":"…"}` | `{ok, via, sessionId, live?}` |
| `POST /ctl` | `{"ctl":"catalog.get"|"session.open"|"session.new"|"ack"}` | 对应结果；`catalog.get` 同时向所有 `/events` 订阅者广播 `ctl:catalog` |
| `POST /diag` | — | 运行时诊断：各服务句柄（sessionController/agents/…）的方法表 + prompt 调用形态试验 |

### 2.2 `/events` 帧格式（契约 v1.3）

第一帧固定是 hello（含能力协商）：

    {"ctl":"hello","contract":3,"source":"dsh","adapterVersion":"0.1.0","resumeAfter":null,
     "canDecide":false,"canCatalog":true,"canOpen":true,"canCreate":true,
     "observes":["session.*","turn.*","step.*","tool.*","approval.*","message.assistant","error.*","pet.heartbeat"]}

之后是事件帧（`v/seq/ts/source/sessionId/workspace/agent/type/data` 信封，`seq` per-`(source,sessionId)`）。本插件会产出：

- 16 个基础 type 中 DSH 能提供的部分（`session.start`/`turn.start`/`step.start`/`tool.call`/`approval.request`/`message.assistant`/`error.raised`/`agent.status`/`pet.heartbeat` …）
- **v1.3 新增**：`session.meta`（agentName/model/reasoningEffort/agentPreset/title）、`session.activity`（≤80 字符粗粒度摘要，**不含步骤序号/工具参数/命令原文/文件内容**）
- 控制帧：`catalog`（由 `catalog.get` 触发，也广播给订阅者）
- 原生 `session/disposed` → `session.end`（`reason:"unknown"`，DSH 日志无原生结束事件）

### 2.3 调用示例

    SOCK=`${TMPDIR:-/tmp}/agent-pet/dsh-plugin.sock`
    curl -s --unix-socket "$SOCK" http://localhost/health
    curl -s --unix-socket "$SOCK" -X POST -H 'content-type: application/json' \
         -d '{"cwd":"/Users/me/proj"}' http://localhost/new
    curl -s --unix-socket "$SOCK" -X POST -H 'content-type: application/json' \
         -d '{"text":"帮我看一下测试"}' http://localhost/input
    curl -sN --unix-socket "$SOCK" http://localhost/events      # 长连事件流

### 2.4 实测补充（2026-10-05 下午，desktop profile）

1. **投递顺序 = agents 优先**：desktop 进程内直调 `sessionController.prompt` 会丢 cancellation signal（`signal.throwIfAborted` 抛 undefined，与是否传 signal 无关；Web 端走 mux 不受影响）。`agents.get/resume + followup/steer` 在 desktop 与 /tmp 预演均真实送达（落盘 `user/message` 可查），故 `/input` 以 agents 为首选，prompt 仅作回退。
2. **HMR 竞态**：重载时新旧实例同进程共存，旧实例 dispose 曾无条件 unlink 后继实例的 socket → 「内核在听、文件不在」的孤儿（ENOENT）。现 dispose 按 inode 对照只删自己的 socket，锁加 token 区分实例，且锁心跳每 5s 自检 socket 丢失并自动重绑。
3. **模块缓存**：宿主进程内插件模块只导入一次；`cordis.patch.yml` 变更只重新 apply（不重导入）。**插件代码更新需重启 DSH**。
4. `/diag` 与 socket 同目录 `plugin-debug.log`（生命周期日志）用于现场排查。

---

## 3. 挂载步骤（**等用户授权后再执行**）

### 3.1 前置条件

- 插件的**绝对路径**（下面的示例用本项目路径）。
- 目标 profile：desktop（Electron 主进程）。它已经组合了 `dsh-base` + `dsh-web-app`，因此 `ctx.get("sessionController")` 与 `ctx.get("agents")` 都存在 —— 插件会走首选路径 `sessionController.prompt`。
- **不需要**改 `/Applications/DeepSeek Harness.app`，**不需要**重启 DSH（HMR 会在 ~1 s 内热挂载；见 docs/35 §4.3）。

### 3.2 精确 diff（只有这一段）

文件：`~/.dsh/profiles/desktop/cordis.patch.yml`（**追加到文件末尾**，不动任何现有行）

    @@ 文件末尾 @@
    +
    +- insert:
    +    - id: dsh-pet
    +      name: '/Users/demo/Desktop/agent桌宠/plugins/dsh-pet/index.js'

就是 3 行新增（外加 1 个空行）。`name` 写**原始路径**即可——loader 会自己编码成
`file:///Users/demo/Desktop/agent%E6%A1%8C%E5%AE%A0/plugins/dsh-pet/index.js`
（`--dump-config` 实测输出，见 §6.1）。

### 3.3 挂载后自检

    SOCK="`${TMPDIR:-/tmp}`/agent-pet/dsh-plugin.sock"
    curl -s --unix-socket "$SOCK" http://localhost/health | head -c 300

期望：`{"ok":true,"contract":3,...,"capabilities":{"canDecide":false,...}}`

---

## 4. 回滚

**删掉 §3.2 的那 3 行**，保存即可：

- HMR 生效时：插件立刻卸载 → 关闭 socket、删除 `dsh-plugin.lock` 与 socket 文件（`ctx.effect` 的 disposer）。
- 若没生效：重启 DSH 一次。
- 插件**不写**任何持久状态，因此回滚后无残留；socket/锁文件都在 `$TMPDIR` 里，系统重启或手删都行：

      rm -f "`${TMPDIR:-/tmp}`/agent-pet/dsh-plugin.sock" "`${TMPDIR:-/tmp}`/agent-pet/dsh-plugin.lock"

---

## 5. /tmp 预演（不改用户环境，随时可跑）

    node plugins/dsh-pet/probe.mjs all     # prepare → dump-config → start → e2e
    node plugins/dsh-pet/probe.mjs stop

预演会在 `/tmp/pet-dsh-home` 建一个**全新 DSH_HOME**，profile 只含 `@deepseek-ai/dsh-base` +
`@deepseek-ai/dsh-workspace` + `@deepseek-ai/dsh-client-file-upload` + `@deepseek-ai/dsh-api-session-controller` + 本插件，
并用安装包自带 CLI（`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`）启动。

---

## 6. 实测证据（2026-10-05，全部在 /tmp）

### 6.1 组合结果（`--dump-config`）

    == dump-config: exit=0
    # == /tmp/pet-dsh-home/profiles/petprobe/cordis.patch.yml
    - id: session-controller
      name: '@deepseek-ai/dsh-api-session-controller'
    - id: dsh-pet
      name: >-
        file:///Users/demo/Desktop/agent%E6%A1%8C%E5%AE%A0/plugins/dsh-pet/index.js
      config:
        socket: /tmp/pet-dsh-home/sock/dsh-plugin.sock
        adapterVersion: probe

### 6.2 插件起来后的 `/health`

    {"ok":true,"contract":3,"source":"dsh","pid":86561,"socket":"/tmp/pet-dsh-home/sock/dsh-plugin.sock",
     "startedAt":1791178924415,"subscribers":0,"events":0,"unknownEvents":0,
     "capabilities":{"canDecide":false,"canInput":true,"canCatalog":true,"canOpen":true,"canCreate":true}}

### 6.3 **输入投递（核心）**：POST /new → POST /input → 会话日志出现该文本

    == e2e POST /new
      {"ok":true,"via":"agents.create","sessionId":"session-3d4e5f6a-7b8c-4d9e-bf0a-4d5e6f7a8b9c"}
    == e2e POST /input: PET-PROBE-1791179043585
      {"ok":true,"via":"agents.followup","sessionId":"session-3d4e5f6a-...","mode":"followup","resumed":false}
    == e2e POST /open
      {"ok":true,"via":"agents.get","sessionId":"session-3d4e5f6a-...","live":true}
    == e2e 会话日志里是否出现注入文本
      {"file":"/tmp/pet-dsh-home/sessions/--tmp-pet-probe-ws--/session-3d4e5f6a-.../session.v4.jsonl.zstd",
       "type":"agent/inbox/spliced","seq":3,"time":1791179043585}
      {"file":"...","type":"user/message","seq":8,"time":1791179043612}

`agent/inbox/spliced` 的 `time` 与 POST 的时刻**完全一致**（1791179043585）→ 投递是同步进入 inbox 的。

### 6.4 **冷会话投递**：重启 DSH 后不指定 sessionId，插件自动推断并 resume

    {"ok":true,"via":"agents.resume+followup","sessionId":"session-3d4e5f6a-...",
     "mode":"followup","sessionSource":"disk-newest","resumed":true}
    # 会话日志：agent/inbox/spliced seq 18 time 1791179126309 含 "COLD-RESUME-测试"

### 6.5 目录与打开

    /tmp/pet-probe-ws2 -> session-edd98157-4be(live)
    /tmp/pet-probe-ws  -> session-3d4e5f6a-fc0
    scannedLogs 2

    # 打开不存在的会话：明确失败，不假装成功
    {"ok":false,"code":"open-rejected","via":"agents.resume",
     "sessionId":"session-does-not-exist","detail":"session \"session-does-not-exist\" not found"}

### 6.6 事件流（`GET /events`）

    HTTP 200 application/x-ndjson; charset=utf-8
    [ctl] hello  {}
    [evt] pet.heartbeat  {"nativeSessionId":null,"load":0,"sessionCount":2}

---

## 7. 能力矩阵与失败模式

| 场景 | 结果 |
|---|---|
| 投给**活跃**会话（agent 在线） | ✅ `agents.followup`（排队 + 唤醒）；`mode:"steer"` 仅在该 agent `status==="running"` 时可用 |
| 投给**冷**会话（进程重启后） | ✅ `agents.resume` → followup；日志里出现 `agent/inbox/spliced` |
| 不指定 sessionId | ✅ 推断：最近有事件的活跃会话 → 否则磁盘上 mtime 最新的会话（`sessionSource` 字段说明来源） |
| 投给不存在的会话 | ❌ 明确失败 `{ok:false,code:"open-rejected"|"prompt-rejected",detail}`，**不假装成功** |
| 投给**用户正在跑的那个** desktop 会话 | ⚠️ **未验证**（插件还没挂到 desktop profile）。机制上就是 Web 输入框的同一条路径 `sessionController.prompt`，风险点是「模型正在生成时投递」会被排队到下一轮而不是打断当前轮 |
| 空文本 / 非 JSON / 超大 body | ❌ `empty-text` / `bad-json` / 400（>256 KB） |
| 第二个插件实例 | ❌ 被 `dsh-plugin.lock` 拒绝（契约 §5.1 单实例） |
| 插件内部异常 | 全部 try/catch + `logger.warn`；socket 写失败只丢订阅者，**不阻塞 DSH** |

**Phase 2 才会做的**：`canDecide:true` → `ctl:decide` 写回审批决定；Phase 1 插件在 `hello` 里固定声明 `canDecide:false`，不会替用户批准任何东西。

---

## 8. 权限与隐私边界

- **只读 DSH 状态**：插件不改 DSH 安装包、不写用户会话日志、**不读不使用** `~/.dsh/.credentials.yaml`。
- 目录扫描是**只读**的 `$DSH_HOME/sessions/**`，且只解压每个日志的**第一帧**（session header）——不读对话正文。
- 出站帧的隐私约束（契约 §3）：`message.assistant.text` ≤280 字符并标 `truncated`；`session.activity.text` ≤80 字符，**禁止**步骤序号 / 工具参数 / 命令原文 / 文件内容；不传 token 流、不传工具 stdout 全文。
- 插件跑在 DSH 主进程内 = **拥有 DSH 的全部权限**。这是它能做到 <1 ms 与真正投递的原因，也是最大的风险面：代码必须保持小而可审计（当前 ~740 行、零依赖、无网络出站）。
- `plugins/dsh-pet/index.js` **不发起任何网络连接**（只有 Unix socket 监听），也不 spawn 子进程。

---

## 9. 未验证项（诚实清单）

| 未验证 | 原因 | 验证方法 |
|---|---|---|
| 挂到真实 desktop profile 后的行为 | 用户还没授权改 `~/.dsh/profiles/desktop/cordis.patch.yml` | 授权后按 §3.2 加 3 行 → `curl /health` → 在 GUI 里发一条消息 → 看 `/events` 是否收到帧 |
| `sessionController.prompt` 首选路径 | /tmp 副本里 `session-controller` 因缺 `connection`/`fileUploads` 依赖没激活，实测走的是 `agents` 回退路径 | desktop profile 有 web-app，挂载后 `/health` + `/input` 的 `via` 字段应变成 `sessionController.prompt` |
| 向**正在生成**的会话投递的排队语义 | 需要真实模型会话 | 授权后：会话跑长任务时 POST /input，观察是排到下一轮还是被拒绝（预期：`followup` 排队到下一轮；要打断用 `"mode":"steer"`） |
| Windows 命名管道 | 本机是 macOS | 按契约 §5.1 换成 `\\.\pipe\agent-pet-dsh-plugin`，代码里 `http.Server.listen(pipe)` 原生支持 |
