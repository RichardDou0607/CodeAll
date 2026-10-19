# 演示（Demo）· CodeAll / 战术终端

> **2026-10-09 当前范围**：以 [v0.1.0 CLI + DSH 对话收口](../docs/23-v0.1.0-scope.md) 为准。发送前必须选定主会话；DSH 仅经已授权插件直投，插件断线时留在本地队列。本文下方的原演示功能记录保留，但不代表全部是本版发布门槛。

当前正式界面采用 CodeAll「战术终端」布局：首次打开默认使用亮色主题，顶部可切换亮色、深色或跟随系统；迷你条与主界面共享 `agent-pet-theme` 偏好。界面使用本地 Agent 原始图标与 CodeAll 自有图标，不依赖外部网络资源。

> 状态：**可运行演示**（2026-10-05，契约 v1.3）。已跑通：**真实 DSH 会话（多帧 zstd，只读）→ 规范事件 → 状态机 → 悬浮窗（多项目/多会话状态 + Agent·模型·思考程度 + 缩减输入框）**。
> 尚未实现：Tauri 真·桌面悬浮窗（队友 H 进行中：apps/shell）、常驻 Hub 守护进程、多后端适配器（Claude Code / Codex…）。

---

## 一键启动

```bash
node demo/framed.mjs --port 7799     # 本地服务：只读会话日志 + SSE 推送 + 目录/输入接口
open http://127.0.0.1:7799/          # 悬浮窗页面（demo/window.html）
node demo/test-window.mjs            # 渲染自检：55 项断言
node demo/test-window-actions.mjs    # 主界面行为回归（不发送真实 Agent 输入）
node demo/test-input-api.mjs         # 隔离服务端：新建约束、队列重发与 ZCode 终态
node demo/test-zcode-control.mjs     # 模拟 app-server：精确投递与模型恢复
node demo/test-cli-create.mjs        # 模拟 CLI：新建时模型和思考强度传递
node demo/test-model-registry.mjs    # 模型注册表：动态模型/思考强度/创建能力
node demo/test-model-map.mjs         # 模型名映射：注册名 → 实际请求名（Claude env / Codex 切换器 / 覆盖文件）
node demo/test-crash-window.mjs      # V05 崩溃窗口：投递执行前落盘，kill -9 后重启「结果未确认」
node demo/test-html.mjs              # 回放页自检：8 项断言
```

## 悬浮窗里有什么

| 区域 | 内容 |
|---|---|
| 工具栏 | **项目切换器**（自动发现 `~/.dsh/sessions` 下的项目）+ 会话三档视图（活跃/完成/隐藏，计数即当前口径）+ **形态切换**（全部 / CLI / 桌面 / IDE，按会话 `variant` 过滤实时行与历史行，计数与顶部口径联动）+「历史会话」折叠 +「+ 新建会话」（无能力位时禁用并说明原因） |
| 状态行 | 聚合状态（思考中 / 运行中 / 等待你 / 出错 / 已完成）+ 计数 chips |
| 会话行 | 来源徽标（含形态：DSH·桌面 / CLAUDE·CLI / CLAUDE·桌面 / CODEX·桌面 / KIMI·CLI …，悬停有全文）+ 会话名 + **`Agent 软件名 · 模型 · thinking:思考程度 · 预设`** + 状态 + 该状态持续时间 + 待办数 |
| 列表口径 | **会话成员 = 磁盘全集**（`~/.dsh/sessions` 扫描，docs/52 §1.2：workspace 注册表只登记 GUI 打开过的子集）：项目顺序沿用注册表；未注册为 workspace 的磁盘项目各自成组；子代理与已归档会话一律不显示；项目计数旁的「N 进行」= 有效状态为进行中的会话数（5 分钟滞留修正，与目录扫描同口径）。右侧口径行：未选项目时显示三档计数（活跃=进行中/10 分钟内完成/1 小时内有活动）；**选中项目（钻取）时列表 = 该项目全部会话**，口径行改为「列出全部 N（活跃 x · 完成 y · 隐藏 z）」，数字与列表行数一致，三档只作参考。**Codex 桌面端的任务工作目录**（`~/Documents/Codex/<日期>/<任务名>`，每任务一个一次性目录）不各自成组，折叠为单一「Codex 任务目录（临时）」组沉底（可用 `CODEX_TASKS_ROOT` 环境变量改根目录）；claude/kimi 在同目录下开的会话不受影响 |
| 输入框 | 先选主会话；Enter 发送 / Shift+Enter 换行；发送后进入投递队列，带状态（待投递 / 执行中 / 失败）与「复制 / 重发 / ✕删除」按钮，队列尾部有「清空」 |
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
| GET | `/api/stream` | SSE 实时推送（变化推全量快照，无变化每 2s 发轻量 tick；**有客户端连接时每分钟兜底强制重扫目录+用量并推全量**——mini 条状态/日历桶计数最迟 ~1 分钟可见，测试可用 `PET_REFRESH_MS` 缩短周期，回归 `demo/test-minute-refresh.mjs`；无客户端时保持懒触发零后台扫描） |
| POST | `/api/input` | `{"text":"…","sessionId":"明确的主会话 ID"}` → 投递；无目标返回 400，唯一前缀可用，歧义前缀/子代理拒绝；ZCode 实验管道 accepted 后返回 202 执行中，终态再从队列移除或标失败 |
| DELETE | `/api/input/:id` | 从队列删除一条（文件与内存同步） |
| POST | `/api/input/:id/resend` | 原位重发（沿用原来源、模型与目标）；可能已接收的失败消息需 `{"confirm":true}`，避免重复投递 |
| POST | `/api/queue/clear` | 清空队列 |
| POST | `/api/open` | `{"sessionId":"…"}` → 定位/恢复会话，按来源分流：CLI 源（Claude/Codex/Kimi/ZCode）在 Terminal 续接；DSH 会话或目录外 ID 交插件（`sessionController.resolveAgent`） |
| POST | `/api/new` | `{"source":"…","cwd":"…","model":"…","reasoningEffort":"…","text":"首条消息"}` → 必须有首条消息、已注册模型和该模型支持的思考强度；`cwd` 必填且必须是该 Agent 自己项目列表里的文件夹（`cwd-required` / `cwd-not-registered`，不接受任意路径）；DSH 经插件创建并向新 ID 投递，ZCode 经 app-server create+send；失败若已创建则返回 `sessionId` 供向原会话重发 |

**鉴权（2026-10-05 起）**：服务监听 `127.0.0.1` TCP，写接口（POST/DELETE）需带 token——header `x-pet-token` 或查询参数 `?t=`。token 在 `~/.agent-pet/token`（0600，首次启动自动生成），页面由服务端注入、浏览器同源脚本自动携带。curl 示例：

```bash
curl -X POST http://127.0.0.1:7799/api/input \
  -H 'content-type: application/json' \
  -H "x-pet-token: $(cat ~/.agent-pet/token)" \
  -d '{"sessionId":"<从 /api/catalog 选出的主会话 ID>","text":"你好"}'
```

另有两道防线：请求 Host 必须是 `127.0.0.1/localhost`（DNS rebinding 防线）；GET 类接口（state/catalog/stream）只读、免 token（Tauri 外壳探针兼容）。

**队列文件生命周期**：`~/.agent-pet/input-queue.jsonl` 权限 0600、原子写（tmp+rename）；超过 **200 条或 1MB** 自动丢弃最旧；删除/清空即时重写文件。ZCode 被接受的消息在队列中保持「执行中」至回合终态；服务重启后未决项标为结果未知，需核对会话后确认重发。

## 「打开已存在会话 / 新建会话 / 选择投递目标」的真实状态

**现在能做的（插件已挂载并实测，2026-10-05）**：

- 列出全部项目与**主会话**（含模型/思考程度/状态/更新时间；子代理不混入列表）、按项目筛选；
- **点击任一会话行选中为投递目标**（实时/历史均可，再点一次恢复自动；composer 顶部显示当前目标）；
- `POST /api/open` 定位/恢复会话（DSH 经 `sessionController.resolveAgent`，前缀匹配 ✅；CLI 源固定走 Terminal 续接，插件在线不受影响）；
- `POST /api/new` 新建会话（`sessionController.create` ✅）；模型与思考强度来自 `GET /api/state` 的 `modelRegistry`：Claude 读取桌面端发布目录，Codex 读取 `codex debug models`，Kimi 用 `kimi provider list --json` 解析其实际配置并传注册别名，ZCode 合并用户/内置 provider 配置和模型规则，DSH 用插件透出的 llm 注册表目录（任一注册模型可选，新建时经 `sessionController.selectModel` 安装；目录不可用时回退单条当前选择）；**模型名一律按「实际请求名」展示**（2026-10-09）：Claude Code 从 `~/.claude/settings.json` 的 `ANTHROPIC_DEFAULT_*_MODEL` ↔ `*_MODEL_NAME` 取实际请求的上游模型名，Codex 从 `~/.codex/config.toml` + 切换器（cc-switch）当前供应商的路由表取；两源都可用 `~/.agent-pet/model-map.json` 覆盖（`{"codex":{"gpt-6-sol":"glm-5.3"}}`）。**选择键是注册名，但请求参数、展示、会话详情与用量表一律用实际请求名**（`claude --model glm-5.3-flash`，实测直传 200）；切换器换掉整张上游模型表时（如只配 GLM 供应商），目录里没有映射的模型（`hidden:true`）**直接从新建下拉隐藏**并把可用的排到最前（`mapping[<源>].restrict`，隐藏项仍留在 `/api/state` 供诊断；ZCode 登录态 `account:*` 的「仅展示」不受影响）；`/api/state` 的 `modelRegistry.mapping[<源>]` 透出当前生效的映射供核对。ZCode `account:*` 登录态模型只展示、不允许独立 app-server 新建。没有登记思考强度的模型不能满足必填要求，显示但禁用；**工作目录限定为该 Agent 自己项目列表里的文件夹**（下拉选择，不可手输任意路径；打开时预选左侧当前项目，服务端同规则校验）；
- **投递即新建（2026-10-08）**：`POST /api/input` 支持目标 `new:<source>:<cwd>`——会话尚不存在时，首条消息直接交给 CLI 无头新建形态（claude `-p` / codex `exec` / kimi `-p` / zcode `--prompt`），回合落盘后目录自动出现新会话（实测 kimi：`new:kimi-code:/tmp/...` → 会话秒级可见）；CLI 缺失时入队，20s 周期自动重试；
- **按会话分队列（2026-10-08）**：队列条目带 `targetKey`（`sess:<id>` | `new:<source>:<cwd>`）与 `source`，UI 按 targetKey 分组展示（组标题 + 按组清空）；重发携带原条目 source/targetKey（修复此前重发丢源、被误路由到 DSH 的问题）；旧队列文件读取时自动迁移；
- `POST /api/input {"text","sessionId"?}` 直接送达（`agents.get/resume + followup` ✅，落盘可查）。

**投递链路说明**：desktop profile 进程内直调 `sessionController.prompt` 会丢 cancellation signal（DSH 侧问题，已实测），插件按 **agents 优先、prompt 回退** 的顺序投递；插件自身 socket 有 inode 对照 + 5s 自愈重绑（HMR 重载不再产生「活着却连不上」的孤儿）。插件**代码**更新需重启 DSH（宿主进程内模块缓存）；`cordis.patch.yml` 变更只重新 apply。

**为什么不能绕过**：运行中的会话日志有排他锁（直写会损坏会话）；DSH 的 GUI 接口需要浏览器会话密钥（`~/.dsh/.credentials.yaml`），让悬浮窗持有它属于越权。插件在 DSH 自身进程内调用官方 API 才是权限最小的做法。

## 投递通道可见性矩阵（v0.1.1 CLI-1，2026-10-17 复核收口；同日代码复核纠偏）

投递动作哪些「全程后台无窗口」、哪些「必然可见」，逐通道明示（实测口径，详见 [docs/25 §2](../docs/25-v0.1.1-scope.md)）：

| 通道 | 可见性 | 定性 |
|---|---|---|
| `/api/input` → CLI 无头续会话（claude/codex/kimi） | **全后台**（detached spawn，输出落 `~/.agent-pet/cli-control/*.log` 0600） | 设计意图 |
| `/api/new`（含 `new:<source>:<cwd>` 投递即新建）→ CLI 无头新建 | **全后台**（同上） | 设计意图 |
| ZCode 投递/新建 → app-server 管道（含 `account:*` 登录态会话，逐条 `modelSelection` 覆盖到非登录态 provider，见 [docs/40 §3.12](../docs/40-adapters.md)） | **全后台**（stdio 全 pipe，无窗口） | 设计意图（无 UI 粘贴回退：`deliverViaZcodeUi`/account 回落分支未接线、`PET_ZCODE_UI_DELIVER` 失效；无非登录态 provider 时如实失败） |
| 「打开会话」按钮 → `POST /api/open` | **可见**：CLI 会话新开/聚焦 Terminal 窗口；ZCode `account:*` 会话走 `zcode://workspace/open` 深链（App 前台）；DSH 会话交插件（进程内，无新窗口） | 设计意图（用户显式交互动作，要的就是窗口；当前**唯一**已接线的可见通道） |

**纠偏说明（2026-10-17 代码复核）**：①「新建会话窗口 → `newCliSession`（Terminal/tmux 新窗口）」通道**未接线**（全仓无调用方；实际 `/api/new` 一律走上面的无头后台新建；属 [docs/22](../docs/22-post-release-roadmap.md) 审查遗留 M1 死代码），不列为可见通道；② ZCode `account:*` 会话投递实际走 app-server 管道（全后台），不存在 UI 粘贴回退（上游限制下无个人 Key provider 时如实失败），不再标注「可见/技术必然」。

另：无头投递有**并发上限 2**（PERF-5）——在途进程台账在 `/api/state` 的 `inFlight` 字段可见（pid/来源/开始时间/日志文件）；超出的投递自动入队（`autoRetry` 标记），由 20s 周期冲刷自动重试（测试可用 `PET_FLUSH_MS` 缩短周期；回归：`demo/test-headless-cap.mjs`），不误标失败。

另：Token 用量扫描为**四级增量**（PERF-7，v0.1.2，[docs/27](../docs/27-v0.1.2-scope.md)）——①扫描分块让出事件循环（冷扫不卡 SSE）；②文件缓存跨重启持久化于 `~/.agent-pet/usage-checkpoint.json`（`PET_USAGE_CHECKPOINT` 可覆盖；重启后未变文件零重读，P7-b 实测 readBytes=0）；③增长文件尾读（DSH/Codex/Kimi；Claude 例外整读）；④ZCode sqlite 水位增量（稳态 409ms→40ms）。`?refresh=1` 五源强刷并重建检查点（坏缓存自愈）；证据口径 `stats.readBytes`=实际读取字节。回归：`demo/test-usage-checkpoint.mjs`（服务级两段式重启）+ perf-verify P7 + `scripts/usage-check.mjs` UC-D2/UC-B2/UCC3 尾读对抗组。

## 其它演示

```bash
node demo/frame.mjs                  # 终端实时工作框（跟随真实 DSH 会话）
node demo/frame.mjs --once           # 打一帧（截图/CI）
node demo/frame.mjs --replay fixtures/contract-sample.pet.jsonl --speed 8   # 离线回放（合成契约样本）
node demo/record-replay.mjs          # 真实会话 → fixtures/session-replay.pet.jsonl（只留本地，已 gitignore）
node demo/build-html.mjs && open demo/frame.html   # 自包含可视化回放（全部为合成事件：契约样本 + 多会话演示）
```

## 诚实边界

| 已经是真的 | 还没做 |
|---|---|
| 事件与元信息全部来自真实 DSH 会话日志（只读） | Tauri 真·桌面悬浮窗（apps/shell 进行中，见 docs/53） |
| 状态机与契约 v1.3 一致（`scripts/replay-check.mjs` 独立验收） | 其它 agent 后端（Claude Code / Codex…，见 docs/40 适配矩阵） |
| 多项目/多**主**会话发现（子代理过滤）；选择投递目标、打开、新建、直投均实测可用 | 宠物形象/皮肤（默认关闭） |
| 输入队列 + 投递状态（插件直投 / 复制手动投递兜底） | |

> 已知限制：终端的 `frame.mjs` 按 CJK 双宽排版；浏览器版用 CSS 布局，不受影响。会话标题若从未生成过会显示「(未命名会话)」。
