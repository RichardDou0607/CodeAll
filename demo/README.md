# 演示（Demo）· Agent 悬浮窗 / 工作框

> 状态：**可运行演示**（2026-10-05，契约 v1.3）。已跑通：**真实 DSH 会话（多帧 zstd，只读）→ 规范事件 → 状态机 → 悬浮窗（多项目/多会话状态 + Agent·模型·思考程度 + 缩减输入框）**。
> 尚未实现：Tauri 真·桌面悬浮窗（队友 H 进行中：apps/shell）、常驻 Hub 守护进程、多后端适配器（Claude Code / Codex…）。

---

## 一键启动

```bash
node demo/framed.mjs --port 7799     # 本地服务：只读会话日志 + SSE 推送 + 目录/输入接口
open http://127.0.0.1:7799/          # 悬浮窗页面（demo/window.html）
node demo/test-window.mjs            # 渲染自检：12 项断言
node demo/test-html.mjs              # 回放页自检：8 项断言
```

## 悬浮窗里有什么

| 区域 | 内容 |
|---|---|
| 工具栏 | **项目切换器**（自动发现 `~/.dsh/sessions` 下的项目）+「历史会话」折叠 +「+ 新建会话」（无能力位时禁用并说明原因） |
| 状态行 | 聚合状态（思考中 / 运行中 / 等待你 / 出错 / 已完成）+ 计数 chips |
| 会话行 | 来源（DSH / CLAUDE-CODE / …）+ 会话名 + **`Agent 软件名 · 模型 · thinking:思考程度 · 预设`** + 状态 + 该状态持续时间 + 待办数 |
| 列表口径 | **= DSH 左侧会话列表**（workspace 注册表，只读）：项目顺序/成员一致；未注册进项目的会话在「未归入项目」组；子代理与已归档会话一律不显示 |
| 输入框 | Enter 发送 / Shift+Enter 换行；发送后进入投递队列，带状态（待投递 / 已送达 / 失败）与「复制 / 重发 / ✕删除」按钮，队列尾部有「清空」 |
| 底部 | 目录扫描统计（项目数 / 会话数 / 耗时）+ 最后事件 |

**实测数据（本机 2026-10-05）**：3 个项目 / 16 个会话，扫描 **19ms**；示例：

```
项目 agent桌宠（9 会话 · 3 进行中）
  running  | 帮我计划开发agent桌宠的项目        | deepseek-flash · max
项目 鹈鹕测试变体策划（3 会话）
  done     | 创建一个HTML，内容是SVG绘制一…    | deepseek-v4-pro · high
```

元信息来源（全部可复核）：`model/reasoningEffort ← request/header.data.header.config`；`title ← session/title`（fallback 标题会剥掉 system-reminder 噪声，改用首条 user/message）；`preset ← agent-preset/selected`；`state ← 末尾事件的 type`（粗粒度，不含步骤）。

## 接口（都可 curl 验证）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 快照：聚合状态、实时会话（含 agentName/model/reasoningEffort/kind）、计数器、输入队列、目录摘要（主会话口径）、能力位 |
| GET | `/api/catalog` | 项目 → 会话目录（**只含主会话**，子代理计入 `subagentCount`；`?refresh=1` 强制重扫） |
| GET | `/api/stream` | SSE 实时推送 |
| POST | `/api/input` | `{"text":"…","sessionId"?}` → 入队并投递；`sessionId` 支持**前缀**，必须是主会话（子代理目标 404 拒绝）；`ok` 只在真正送达时为 `true`（queued=202、失败=502） |
| DELETE | `/api/input/:id` | 从队列删除一条（文件与内存同步） |
| POST | `/api/input/:id/resend` | 重发一条队列项（沿用原投递目标）；送达后自动移除原条目 |
| POST | `/api/queue/clear` | 清空队列 |
| POST | `/api/open` | `{"sessionId":"…"}` → 定位/恢复会话（插件连通时经 `sessionController.resolveAgent`，已实测可用） |
| POST | `/api/new` | `{"cwd":"…"}` → 新建会话（插件连通时经 `sessionController.create`，已实测可用；未连通时 501 + 原因，**不使用 DSH 凭证绕过**） |

**鉴权（2026-10-05 起）**：服务监听 `127.0.0.1` TCP，写接口（POST/DELETE）需带 token——header `x-pet-token` 或查询参数 `?t=`。token 在 `~/.agent-pet/token`（0600，首次启动自动生成），页面由服务端注入、浏览器同源脚本自动携带。curl 示例：

```bash
curl -X POST http://127.0.0.1:7799/api/input \
  -H 'content-type: application/json' \
  -H "x-pet-token: $(cat ~/.agent-pet/token)" \
  -d '{"text":"你好"}'
```

另有两道防线：请求 Host 必须是 `127.0.0.1/localhost`（DNS rebinding 防线）；GET 类接口（state/catalog/stream）只读、免 token（Tauri 外壳探针兼容）。

**队列文件生命周期**：`~/.agent-pet/input-queue.jsonl` 权限 0600、原子写（tmp+rename）；超过 **200 条或 1MB** 自动丢弃最旧；删除/清空即时重写文件。

## 「打开已存在会话 / 新建会话 / 选择投递目标」的真实状态

**现在能做的（插件已挂载并实测，2026-10-05）**：

- 列出全部项目与**主会话**（含模型/思考程度/状态/更新时间；子代理不混入列表）、按项目筛选；
- **点击任一会话行选中为投递目标**（实时/历史均可，再点一次恢复自动；composer 顶部显示当前目标）；
- `POST /api/open` 定位/恢复会话（`sessionController.resolveAgent`，前缀匹配 ✅）；
- `POST /api/new` 新建会话（`sessionController.create` ✅）；
- `POST /api/input {"text","sessionId"?}` 直接送达（`agents.get/resume + followup` ✅，落盘可查）。

**投递链路说明**：desktop profile 进程内直调 `sessionController.prompt` 会丢 cancellation signal（DSH 侧问题，已实测），插件按 **agents 优先、prompt 回退** 的顺序投递；插件自身 socket 有 inode 对照 + 5s 自愈重绑（HMR 重载不再产生「活着却连不上」的孤儿）。插件**代码**更新需重启 DSH（宿主进程内模块缓存）；`cordis.patch.yml` 变更只重新 apply。

**为什么不能绕过**：运行中的会话日志有排他锁（直写会损坏会话）；DSH 的 GUI 接口需要浏览器会话密钥（`~/.dsh/.credentials.yaml`），让悬浮窗持有它属于越权。插件在 DSH 自身进程内调用官方 API 才是权限最小的做法。

## 其它演示

```bash
node demo/frame.mjs                  # 终端实时工作框（跟随真实 DSH 会话）
node demo/frame.mjs --once           # 打一帧（截图/CI）
node demo/frame.mjs --replay fixtures/session-replay.pet.jsonl --speed 8   # 离线回放
node demo/record-replay.mjs          # 真实会话 → fixtures/session-replay.pet.jsonl
open demo/frame.html                 # 自包含可视化回放（548 条真实事件 + 17 条合成多会话事件）
```

## 诚实边界

| 已经是真的 | 还没做 |
|---|---|
| 事件与元信息全部来自真实 DSH 会话日志（只读） | Tauri 真·桌面悬浮窗（apps/shell 进行中，见 docs/53） |
| 状态机与契约 v1.3 一致（`scripts/replay-check.mjs` 独立验收） | 其它 agent 后端（Claude Code / Codex…，见 docs/40 适配矩阵） |
| 多项目/多**主**会话发现（子代理过滤）；选择投递目标、打开、新建、直投均实测可用 | 宠物形象/皮肤（默认关闭） |
| 输入队列 + 投递状态（插件直投 / 复制手动投递兜底） | |

> 已知限制：终端的 `frame.mjs` 按 CJK 双宽排版；浏览器版用 CSS 布局，不受影响。会话标题若从未生成过会显示「(未命名会话)」。
