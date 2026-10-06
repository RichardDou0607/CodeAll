# plugins/dsh-pet · DSH 桌宠桥接插件

> 契约：[docs/00-interface-contract.md](../../docs/00-interface-contract.md) **v1.3**
> 安装/回滚/协议/风险全在 [docs/54-dsh-plugin.md](../../docs/54-dsh-plugin.md)。本文件只讲「它是什么、怎么在 /tmp 预演」。

## 它是什么

一个**零依赖的 Cordis 用户插件**，跑在 DSH 主进程内，通过一个 Unix socket 暴露三件事：

| 能力 | 端点 | 做法 |
|---|---|---|
| 事件直推 | `GET /events`（长连 NDJSON） | `ctx.on('session/event')` → 契约 v1.3 事件；**进程内同步派发，<1 ms**（对比日志 tail 的 ~250 ms） |
| 输入投递 | `POST /input` | 首选 `ctx.get("sessionController").prompt(...)`，回退 `ctx.get("agents").get(id).followup(message)`（冷会话自动 resume） |
| 会话操作 | `POST /new` / `POST /open` / `POST /ctl` | `sessionController.create / resolveAgent`，回退 `agents.create / get / resume`；`catalog.get` 走只读扫描 |

默认 socket：`$TMPDIR/agent-pet/dsh-plugin.sock`（可用插件 config 的 `socket` 覆盖）。

## 挂载（用户自己的 profile，一行 insert）

    # ~/.dsh/profiles/desktop/cordis.patch.yml —— 在文件末尾追加：
    - insert:
        - id: dsh-pet
          name: '/Users/demo/Desktop/agent桌宠/plugins/dsh-pet/index.js'

**回滚 = 删掉上面这 3 行**。细节与精确 diff 见 [docs/54-dsh-plugin.md](../../docs/54-dsh-plugin.md)。

## /tmp 预演（不改 ~/.dsh、不改 /Applications）

    node plugins/dsh-pet/probe.mjs all        # prepare → dump-config → start → e2e
    node plugins/dsh-pet/probe.mjs stop       # 停止副本 DSH，清理 socket 与锁

预演做的事：在 `/tmp/pet-dsh-home` 建一个全新 DSH_HOME 与 profile（bundle 只有 `@deepseek-ai/dsh-base`），
用安装包自带 CLI（`--dump-config` / 直接启动）验证插件被组合进来，然后
`POST /new` → `POST /input` → **回到会话日志里找注入的文本**（决定性证据）。

## 隐私与安全边界

- 只推**元数据 + 截断摘要**：`message.assistant.text` ≤280 字符并标 `truncated`；`session.activity.text` ≤80 字符且**不含步骤序号 / 工具参数 / 命令原文 / 文件内容**（契约 v1.3 §3）。
- **不读不使用** `~/.dsh/.credentials.yaml`；**不写**用户会话日志；只读扫描 `$DSH_HOME/sessions/**` 的日志头。
- Phase 1 **只读**：`hello` 里声明 `canDecide:false`，插件不会代替用户批准任何东西。
- 所有回调与 socket 写都兜住异常：插件出错不能让 DSH 崩，也不能阻塞 `append()`。
