# 变更日志（文档与契约）

## 2026-10-27（十）
### 用量刷新节奏收口【v0.1.4 增补，未发版】：一分钟自动节拍 + 手动按钮，打开页面不再触发扫描（用户定向「用量刷新应该保持在一分钟+手动」）

- **移除端点懒触发（framed.mjs 三处）**：`/api/usage`、`/api/usage/calendar`、`/api/plan-usage` 的「≥60s 陈旧即异步重扫」分支全部移除——打开用量页/订阅页、无参 API 调用一律**只读缓存立即返回**（哪怕数据是旧的，生成时间可见）。perf-verify P3③ 的「纯空闲零后台扫描」口径保持，且不再有页面打开引发的计划外扫描。
- **自动刷新 = 分钟节拍（MRF-1 保持不变）**：有 SSE 客户端（应用开着）时每 60s 自动重扫一轮；无客户端零扫描。首轮在启动后 1 分钟内出现（boot 5min 兜底仅防极端情况）。
- **手动 = 刷新按钮**：用量页「重新扫描」（`?refresh=1` 强制）不变；订阅页「刷新」升级为**强制重扫用量 + 重算计划层**（此前只重算轻量层）。
- **文案同步**：订阅页 legend/空态、用量页首扫空态改为「每 60s 自动一轮 + 手动按钮」口径。
- **测试**：test-minute-refresh M1–M3 全过（M1 明确绕开懒触发通路——不受影响）；test-usage-calendar 6/6、test-plan-usage 4/4、test-window 正常；perf-verify 同步三处后 14/17（回到既有基线，失败仅 P1-a/P4-a/P5 三个已定性环境项）：P3② 改「手动 refresh=1 触发」、P3③ 文案更新、triggerAndAwait 懒触发改手动、**P7-b 第二段改走分钟节拍路径**（refresh=1 是强制重扫会跳过检查点加载——节拍扫描才是检查点复用的真实验证，dsh read=0 恢复）。
- **边界**：`?refresh=1` 仍是强制重扫唯一入口（除分钟节拍外）；并发保护（usageCache.busy）不变。

### 用户标注档位机制【v0.1.4 增补，未发版】：Kimi=Pro、Qoder=Free 如实上屏（用户纠偏「月之暗面目前订阅的是 pro，证明没有成功；Qoder 的订阅是 free」）

- **深挖结论（两轮只读侦察）**：Kimi（credentials/config.toml/client-configs 缓存/query-store 16 分片/telemetry 属性键/运行日志/桌面 App leveldb）与 Qoder（main.sqlite 全部 110 表逐列扫档位值/qoder-data.v1.json/Preferences/leveldb）**均无订阅档位缓存**——档位真值只在厂商云端（Kimi CLI 的 membership/quota 属在线查询；Qoder 客户端在线拉取）。本地证据路线已穷尽。
- **用户标注机制（不破红线）**：新增 `~/.agent-pet/plan-overrides.json`（0600，用户可编辑）——`{ "<planId>": {"planName":"Pro","asOf":"2026-10-27","note":"…"} }`（字符串简写亦可）；scanPlanUsage 每轮现读并应用：planName 以标注为准、`planNameSource='user-asserted'`、证据行留痕、signed-in/not-signed-in 状态升级为 active；与本地证据冲突时以标注为准并提示。UI「标注」徽标（黄）+ 悬停说明来源与自动升级规则；本地实测档位（Cursor=Free、GLM）不带徽标。
- **实机验证**：qoder 档位=Free（user-asserted）、kimi 档位=Pro（user-asserted）、glm/cursor 保持 local-evidence。测试 4/4（MU-PU1 补标注断言 + MU-PU7/8 补 Kimi 卡片与「标注」徽标断言）。
- **边界**：标注文件属用户数据（不入库）；未来厂商落盘档位时本地提取器自动接管（标注与实测不一致时界面提示冲突）。

### 订阅独立页上线【v0.1.4 增补，未发版】：新增「订阅」导航页——卡片式完整计划信息 + 5h 滚动窗口 + 限额与刷新口径（用户定向「额外页面展示 coding plan；完整用量与限额；5h/周/月额度；刷新时间」）

- **新增导航页（window.html）**：导航「会话/用量/订阅/软件」四页（新增 i-credit-card 图标）；订阅页卡片式布局——厂商图标 + 档位/账号打码 + 状态徽标 + **五个窗口格（5 小时/今日/7 日/30 日/全部）** + 限额区（DeepSeek 余额即剩余额度·对账日；其余厂商如实标「限额数值在厂商云端」）+ 窗口语义行（sem：GLM 5h 滚动/Claude 5h+周/Copilot 月度等公开产品口径，未核实者如实标）+ 刷新元数据（数据生成时间/最后请求时间/身份缓存日期）+ 证据明细折叠；未安装厂商折叠单卡；页首 legend 行说明窗口口径与刷新机制。
- **5h 滚动窗口（plan-usage.mjs）**：ZCode model_usage 逐请求账本新增 h5 窗口列（started_at >= now-5h，requests/in/out/cache 全套）——GLM 的 5h 用量**精确**（实测 27 请求/18.5M tokens）；其余源本地只有自然日语桶，h5 如实标 —（placeholder 带 reason，悬停可见）。GLM 窗口不再依赖 usage 扫描完成（账本直读，--fast 亦可算）。
- **legend 元数据**：/api/plan-usage 透出 legend（h5/today/d7/d30/all/refresh 口径说明）；UI 页首与 tooltip 消费。
- **回归**：test-plan-usage 4/4（新增 MU-PU8 订阅页渲染：卡片/5h 窗/限额/刷新时间/未安装折叠；MU-PU1/4/5 补 h5 与 sem/legend 断言）；test-window/window-actions/usage-calendar/mini/open-routing 全部 0 失败；重建安装后烟测 v3（含订阅页专项 + GLM/ZCode 今日一致性 diff=2）。
- **限额边界（重申）**：statusbar 插件目录复核无配额数值缓存（仅运行时元数据）→ 限额值继续如实标云端；不做持凭证调云 API。

### 面板交互优化 + multi-source-check 修复【v0.1.4 增补，未发版】：Coding Plan 区可视化降噪、MU5/MU6 断言跟上八源+估算口径、MU5 懒触发补齐

- ** Coding Plan 区 UI 优化（window.html）**：厂商行加图标（复用八源 logo 资产，PLAN_LOGO 映射：GLM→zcode、DeepSeek→deepseek、Claude/Codex/Kimi/Qoder/Cursor 各归位，无资产者 codeall-mark 兜底）；新增汇总 chips 行（家厂商/订阅在用/API/余额计费/已登录/未安装）；**7 行「未安装」折叠为单行**（厂商名内联 + 「安装并登录后自动出现」）；数值 cell 加悬停 tooltip（精确 tokens/请求数、账本单位、估算语义）；计划身份/余额配 tooltip。MU-PU7 断言同步（图标/chips/折叠行/无泄漏不变）。
- **MU5/MU6 断言修复（scripts/multi-source-check.mjs）**：`bySource===6`→`=== 8`（2026-10-22 估算模式后 qoder/cursor 以估算源在列，断言停留在七源口径已过时）；MU6 `qoder/cursor degraded===true`→`estimatedTokens===true && degraded===false`。
- **MU5 懒触发补齐（根因修复）**：MU5 只轮 `/api/state` 空等——该端点不触发用量扫描（P3③：无客户端懒触发、开机 5min 兜底），实测 120s+ 仍 pending；先打一次 `/api/usage`（与真实客户端打开用量页同路径）后冷扫 ~10s 出数。轮询预算 40s→120s（冷启动+并发负载余量）。前一轮 40 分钟运行与本次空等两个现象同根因。
- **回归**：multi-source-check 从 4 项失败降到 2 项（余 ML5 扫描性能 673-846ms>300ms 旧基线、MC5 DSH 注册表口径——均为已定性既有环境项）；test-plan-usage 3/3、test-usage-calendar 6/6、test-window/mini 正常；重建安装后烟测 22/22（含 4 项新 UI 专项 + GLM/ZCode 今日窗一致性 glm=181/zc=178）。

### Coding Plan 使用情况面板上线【v0.1.4】：15 家主流厂商「订阅身份 × 本地用量 × 配额/余额」一屏看全（用户定向「接入全部主流厂商的 coding plan 使用情况，展示完整的信息」）

- **澄清与口径**：需求为 coding plan 的**使用情况**（非新增会话观察源）。三家证据等级实测（[A]，只读侦察 2026-10-26）：GLM（entitlement 缓存 + `model_usage` 逐请求账本按 provider 拆分）与 DeepSeek（余额账本，余额即配额）双全；Cursor（`stripeMembershipType=free`）/ Copilot（`copilotSku=free_limited_copilot`）档位明确；Claude（未登录，env 有 ANTHROPIC_AUTH_TOKEN 键名 → API 计费）/ Codex（auth_mode=apikey）/ Kimi（登录态、档位不落盘）/ Qoder（登录态、订阅档未缓存）部分证据；**各家云端配额数值均不落盘——不持凭证调云 API（红线重申），如实标注**。
- **实现**：`adapters/plan-usage.mjs`（15 家注册表：8 probe 提取器 + 7 安装检测；身份层 60s 缓存；ZCode `model_usage` 一条 GROUP BY 出 provider×时间窗聚合，`account:*` = 登录态 coding plan，自备 key 如实归属提示；DeepSeek 账本单位实测纠正为 **1 单位 = 1e-8 元**）；framed `planUsageCache` + `GET /api/plan-usage`（懒触发，`refreshUsage` 完成跟随刷新，快照不带该块）；用量页「Coding Plan 使用情况」表格（状态徽标/账号打码/四时间窗/余额，每行 details 证据与明细）+ 懒加载与 usage.generatedAt 联动（与日历同模式）。
- **隐私**：凭证文件只读**键名/白名单 claim**（Codex JWT 只解 chatgpt_plan_type；token 值不进内存输出）；邮箱/账号/登录名一律打码；MU-PU2 断言输出 JSON 不含 fixture 凭证值与完整账号。
- **回归**：`demo/test-plan-usage.mjs`（MU-PU1～PU7：身份/隐私/账本换算/窗口分桶/三口径透传/未安装/UI 渲染）3/3 ✔；`test-usage-calendar` 请求数断言按日历路径过滤 + mock 单独应答 plan 端点后 6/6 ✔；test-window 等其余 UI 回归 0 失败；端到端 framed:7831 `/api/plan-usage` 实测 15 家、GLM 今日窗 84 请求/26.7M tokens、DeepSeek 余额 643.62 元。真相源 [docs/29](./29-v0.1.4-scope.md)。
- **既有失败（非本轮）**：`catalog-check` A13（深扫 <300ms）stash 对照同样失败（1,322ms）——DSH 日志增长所致环境性偏差，v0.2.1 复核。


## 2026-10-22（九）
### 估算模式上线【未发版】：Qoder/Cursor token 以包络估算呈现（用户定向「使用估算模式」；≈ 前缀、绝不并入精确合计）

- **估算模型（文档化假设 + 真实信号调制）**：Qoder——一回合内第 i 次请求 `in ≈ 6k + (i-1)×2.5k`（事件自带的 request_index 是**真值**；agentic 循环上下文逐迭代增长），out ≈ 700，按 200k 截断（chat_model_preferences 实测 context_window=1M 的实用上限）；Cursor——无模型/迭代信息，统一 in ≈ 9k / out ≈ 550。本机估算结果：Qoder in 72.6M / out 833K（1190 请求），Cursor in 765K / out 46.75K（85 请求）。
- **纪律（估算与精确不混排）**：`estimatedTokens` 标记贯通 scan→serialize→overview→calendar→UI；usageOverview 对估算源**只并入真实的 requests**，token 不进合计与跨源合并模型表（实测 merged byModel 无 dfmodel）；bySource/byModel 的估算值 hitRate 置 null；UI 每源表 ≈ 前缀（dim）+「估」徽标 + 行下注记，会话行 meta 显示「≈tok 全量 …（估算）」，u-note 置顶声明「Token 合计为精确口径（不含 Qoder/Cursor）」。`PET_USAGE_ESTIMATE=0` 可整体关闭（退回纯请求级）。
- **MU14 断言**：估算开启（in/out>0 且 estimatedTokens）+ 隔离性（overview 只含两源 requests、无估算 token、合并模型表无估算模型）+ bySource.estimated 标记——全绿。


### Qoder/Cursor token=0 定性收口【未发版】：UI 从「0（像坏了）」改「—（云端计费）」（用户反馈「tokens 始终为 0，之前的软件都正常」——穷尽本地路径后维持不虚估口径）

- **第五轮穷尽扫荡（全部落空，铁证收口）**：Qoder——main.sqlite 全库 schema 无 usage 表、context_usage 12 行 totalTokens/rawMaxTokens 全 0、qoder-data.v1.json 零数值命中（turns 空）、turn-payload-buffer 瞬态空表、partner_plan_snapshots 仅订阅元数据、segments 1190 事件 token 字段全 0；Cursor——ItemTable 139 键无 usage、cursorDiskKV 11 类键前缀（泡 tokenCount 全 {0,0}）、全部 CLI store.db blob 零 usage 命中、ai-tracking 仅代码行数。
- **根因（结构性，非实现缺口）**：「之前的软件正常」是因为 DSH/Claude/Codex/Kimi/ZCode/OpenCode 都是引擎/CLI 产品、逐请求写本地日志；Qoder 与 Cursor 是云端围墙花园——**计费 token 只存在厂商服务器**，本地字段是占位（写 0 或不写）。读云端需拿凭证调官方 API（cursorAuth/accessToken 等）——触碰凭证违反安全红线，不做。
- **UX 修正**：tokensUnavailable 源的 token 五列（in/cache读/cache写/out/命中率）显示「—」而非误导性的 0；请求列与模型数保持真实值；u-note 置顶说明「Token 合计不含 Qoder/Cursor……两源请求/模型/工具调用为本地真实数据已计入」。
- **不做的事（红线重申）**：不估算——按「每请求约 N token」造数会污染精确累计口径与跨源合并表，且误差不可控；若未来厂商落盘真值（BYOK/新版本），采集字段已在位、非零即自动入账。


### Qoder 用量计数单位修正【未发版】：回合 → 模型请求（用户报障「明显用量不正确」）

- **问题（用户报障）**：上一轮 Qoder 计入 119 次「请求」明显偏低。复盘定位**计数单位错误**：以 turn.started/finished 配对计请求，但实测 159 个回合内含 **1190 次 `model.response.completed`**（Qoder 一回合跑多次 agentic 模型请求，主回合分布：68% 为 1-3 次、6 个回合 9-15 次）——与其它源（Claude usage.requests=API 调用、ZCode=message 行）的「模型请求级」单位不可比，量级压低约 14×。
- **第二处错（配对泄漏）**：fork 后台代理（Explore/plan，约 900 次请求）**不写 turn.started/finished**——按回合配对时这些请求被 pendingModel 状态机错记/漏记（报出的 119 既非回合数也非请求数，是配对 bug 的产物）。
- **修复**：计数基元改为 `model.response.completed`（一次事件=一次模型请求，事件自带 model 字段无需配对）；子代理/fork 消耗一并计入（Kimi「子代理归入父会话」口径——segment 在父会话目录下自动归父）。修复后**与原始事件审计逐模型全等**：dfmodel 783 / dmodel 182 / mmodel 112 / qfmodel 87 / qmodel_38max 26 = 1190。
- **Cursor 同步修正**：子代理 composer 的消息泡此前被排除——现在并入（Kimi 口径），本机 35 → 85 次请求。
- **回归**：MU12 加强为单位断言（requests ≥ 用户提交回合数 159 且 ΣbyModel ≡ totals.requests）全绿；demo 21 项 exit 0。


### Qoder/Cursor 计入用量【未发版】：请求级真实计数（用户反馈「没有被计入 tokens 用量」——三重证据确认 token 真值不在本地，不虚估；请求/模型/工具调用如实计入）

- **token 真值三重证据（本地不存在）**：Qoder——segments 的 token 字段实测恒 0（1190 个 model.response.completed + 6 个 fork.agent.completed 全零，provider 全为 qoder 托管模型）、main.sqlite context_usage.tokenCountsAvailable=false、turn-payload-buffer 为瞬态空表；Cursor——99 个消息泡 tokenCount 全 {inputTokens:0,outputTokens:0}（modelInfo 仅 2/99 且为 'default'）、CLI store.db 响应 blob 无 usage 字段、ai-tracking 只有代码行数。计费均在厂商云端 → **token 不虚估**（估算百分比会造垃圾数据，违反「如实」红线）。
- **请求级真实计数（新口径 `tokensUnavailable`）**：
  - Qoder：segments 的 turn.started/finished 配对 → 1 次请求（带真实模型名 qfmodel/dfmodel/mmodel/dmodel/qmodel_38max——**唯一拿到 per-request 模型归属的新源**）+ tool.execution.finished → 工具调用；本机实测 119 请求 / 68 会话 / 1454 工具调用；文件级增量缓存（size+mtime，241 文件二轮全命中）。
  - Cursor：assistant 泡（type=2 + completedAtMs）= 1 次请求，toolResults 长度 = 工具调用；只枚举非归档非子代理 composer；本机实测 35 请求。模型名如实标「(模型未落盘)」。库级缓存（state.vscdb size+mtime）。
  - 两源从 `degraded`（此前整体缺席）改为可用源进入 overview/bySource/byModel/日历（tokens 0 / requests 真实）；`serializeUsageScan` 透出 `tokensUnavailable` 标记，UI 用量表下追加「请求级计数（N 次请求真实计入）；token 真值在云端——不虚估」注记行。
- **隐私口径微调（MG7 改判据）**：Cursor 消息泡允许**计数级**读取（type/completedAtMs/toolResults.length——与 Kimi wire.jsonl 用量采集同口径）；红线聚焦「原文不取不外传」：subtitle（prompt 原文）/text_preview/.text/.thinking/.richText 断言不出现。Qoder 侧 parseQoderSegmentUsage 同样只读 turn 事件计数字段。
- **回归**：MU12/MU13 重写为请求级断言（requests≥1 且 tokens=0 且 tokensUnavailable）全绿；demo 21 项 exit 0（test-tick/test-crash-window 一次并发环境竞争失败、单独复跑均过）；/api/usage 实测 overview.requests 58,169 含 qoder 119 + cursor 35。


### Qoder CLI 接入【未发版】：qoderclicn 通道 + segments 事件流——Qoder 从「观察-only」升级为全通道（用户定向「现在把 qoder CLI 也接入」）

- **侦察修正（推翻上午「无 CLI」结论）**：Qoder CLI = `qoderclicn`（~/.qoder-cn/bin/qoderclicn/qoderclicn-<版本>，版本化命名；~/.local/bin 有符号链接；用户 14:41 装入）。与桌面**共用 chat_sessions 库**（`--list-sessions` 按项目列出同一批 UUID）——桌面会话可经 CLI 续接、反之亦然。
- **控制**：`qoderclicn -p -r <id> <text>`（无头续接）/ `-p <text>`（新建+首投）/ `-m <model>`（--list-models 12 模型：Auto/Fast/Qwen3.8-Max/…/GLM-5.3）；`--reasoning-effort` 有 flag 无公开取值表 → 单 'default' 档如实标注；**不用** `--dangerously-skip-permissions`/`--permission-mode bypass_permissions`。`resolveQoderCliBin()` 解析版本化二进制（cli-control/model-registry 共用）。framed 移除上午的 qoder「只入队」守卫与「打开禁行」分支——现走 CLI 投递与 Terminal `qoderclicn -r` 续接。
- **segments 事件流（三次侦察发现）**：`~/.qoder-cn/logs/sessions/<编码cwd>/<sid>/segments/*.jsonl` 是桌面与 CLI **共用**的结构化事件流（turn.started/turn.finished，文件名带时间戳+pid）。关键事实：**CLI 回合只写 segments、不回写 main.sqlite**（实测 -r 续接桌面会话后 chat_sessions.updated_at 不动）→ ① 目录的 updatedAt/状态以 segments 优先（sqlite 供标题/cwd/会话清单）；② 跟随器从 sqlite 轮询**重写为 segments 尾读**（文件偏移增量；turn.reason: end_turn/max_turns→ok、abort→aborted、error/failed→error；实测 144 回合分布 124/14/6）——Qoder 会话从此有**实时回合事件**（此前只有目录级），子代理回合按 is_subagent 跳过。红线：`input.prompt.*` 含 text_preview（prompt 原文）不读不解析（MQ11 扫源码）；segments token 字段实测恒 0（1123 个 model.response.completed 全零）→ **用量仍如实降级**。
- **形态口径**：CLI/桌面共用库且无来源标记（extra_json.source=workspace、消息 source=引擎投影）→ 会话 variant=null（同 opencode），软件状态页拆 qoder-cli/qoder-desktop 两行（进程路径分家）；UI 形态筛选去掉 qoder 档。
- **闭环实测**：经 API 向桌面创建的旧会话 5696510f 无头投递 → 回合完成（回复 ok）落 segments → 目录状态 done/快照可见；跟随器回放含该回合；用户进行中的 CLI 会话实时显示「思考中」LIVE 行。
- **回归**：demo 21 项 exit 0（test-window 85 项：卡片 13→14）；multi-source-check MC4 七通道 + MQ3（variant=null）/MQ10（qoderclicn 通道）/MQ11（segments 红线）全绿；既有 ML5/MC5/MU5 环境失败不变（基线同样失败）。


### 三家新源接入【未发版】：OpenCode（CLI+桌面）/ Qoder（桌面）/ Cursor（桌面+CLI）——五源扩到八源，软件状态 8 行扩到 13 行（用户定向「现在帮我把 Qoder，opencode desktop&CLI 接入 CodeAll」+「在测试完毕后对 cursor 的 desktop 和 CLI 均进行接入」；docs/22 W2 AGT-2/3/4 提前落地）

- **OpenCode（`adapters/opencode-adapter.mjs`，M-I/AGT-2）**：观察 = `~/.local/share/opencode/opencode.db`（WAL 只读并发；CLI 与桌面共用同一后台服务与库）。
  - **双消息存储**（2026-10-22 实测，v1→v2 迁移双写）：≤1.18 走 `message`+`part`（与 ZCode 同构，`step-finish.reason=stop` 收回合）；≥2.x 服务端写 `session_message`（type 是**表列**：user/assistant/idle，`idle.outcome=succeeded|failed` 收回合；tool 内联在 assistant.content）。粗状态/跟随/用量三链路都走双路径，**「有 v2 行的会话只认 v2」**去重（不去重总量精确翻倍：实测 ΣcacheRead 314.9M vs 账本 157.4M）。
  - **用量对账**：assistant 行自带权威 tokens（input **不含** cacheRead，Anthropic 式）+ 顶层 providerID/modelID（键 `provider/model`，跨 provider 同名不混账）；MU11 双账本对账漂移 <0.5%（在途会话）。tool 调用计数走 part 的 tool 行 + v2 `json_each` 展开 content。
  - **控制**：`opencode run --session <id>`（无头续接）/ `run -m <model> <msg>`（新建+首投，**-m 是 run 子命令 flag**，前置即错）；不用 `--auto`（无头未授权按拒绝，不越权）。**PWD 修复**：opencode v2 客户端按 `$PWD`（非 getcwd）判定会话目录——`headlessRun` 现同步 `env.PWD=cwd`（实测 spawn cwd=/tmp 仍写宿主目录）。
  - **形态口径诚实**：CLI/桌面共用库、库内无形态标记 → 会话 `variant=null`（不冒充 cli/desktop），软件状态页仍按进程路径拆行；模型注册表 `opencode models` 45 模型（CLI 无思考档 flag → 单 'default' 档如实标注）。
  - **性能**：目录扫描两段式窗口查询（先排 id 不搬 data 大字段——part 均值 ~50KB 的 tool 输入原文；668MB 库实测 600ms→46ms）。
- **Qoder（`adapters/qoder-adapter.mjs`，AGT-3 spike 落地）**：阿里 AI IDE（Qoder CN 0.4.8，纯桌面无 CLI/hook/ACP）。观察 = `~/Library/Application Support/com.qodercn.app.stable/main.sqlite`（WAL 只读）的 `chat_sessions` + `chat_session_messages` **结构化列**（role/status/sequence）——**隐私最高档：任何 SQL 不 SELECT 消息原文列**（payload 与原文同列，列级排除；比 Kimi lastPrompt 更严，MQ7 断言源码字面量）。`status=interrupted` → aborted（手动停止口径一致）；划词问答（sideChat）/自动化执行不进列表；token 真值客户端不落盘（context_usage 仅百分比）→ 用量如实降级；无控制通道 → 投递只入队如实说明。
- **Cursor（`adapters/cursor-adapter.mjs`，AGT-4）**：桌面 + CLI 双源。
  - 桌面（3.26.16）：`User/globalStorage/state.vscdb` 的 `composerHeaders`（目录：name/isArchived/**isSubagent**/lastUpdatedAt）+ `cursorDiskKV` 的 `composerData:<id>.status`（completed→done / aborted→aborted / running→running+5min 滞留修正）；模型 best-effort 来自 `~/.cursor/ai-tracking` 的 conversation_summaries。**隐私红线**：value 里的 `subtitle` 是用户 prompt 原文——只取 name/unifiedMode；消息泡（bubbleId/agentKv blob）完全不读（MG7 断言）。workspaceId 不透明 → 桌面会话 cwd=null（如实「Cursor（未开文件夹）」组）。
  - CLI（cursor-agent 2026.10）：`~/.cursor/chats/<hash>/<sid>/meta.json`（cwd/时间戳/hasConversation）目录级观察；会话内 `store.db` 是请求转录原文（system prompt/用户内容）——红线不读，回合级观察如实缺席；控制 = `cursor-agent -p --resume <id>`（续接）/-p（新建+首投），**不用 --force/--yolo**（Run Everything 越权）；模型注册表 `--list-models` 265 模型（档位内嵌模型名 → 单 'default' 档）。桌面 composer 会话无外部通道：投递入队如实说明、打开如实回报（不转交 DSH 插件）。
  - 用量：per-request token 在云端（客户端不落盘）→ 如实降级。
- **接线面**：`local-agents` 注册表 8→13 行（OpenCode CLI/桌面、Qoder、Cursor CLI/桌面，进程路径分家 + 四态验证）；`framed.mjs` 八源目录/用量/跟随器/投递/打开路由；`cli-control` 六通道（+opencode/cursor）；`model-registry` +opencode/cursor；UI 八源 tab/图标（qoder/opencode/cursor 三枚 SVG letter-mark）/形态筛选（cursor 双档、opencode 不给档）/新建对话框只列有通道的源；`usage-collect` 八源（+MU11 双账本对账/MU12·MU13 如实降级）。
- **闭环实测（本机）**：opencode 新建+首投（zhipuai-coding-plan/glm-5.3）回合完成落库、快照 done ✅（glm-5.3-highspeed 会话被套餐拒：错误如实回报不冒充成功）；cursor-agent 新建+首投回复 ok、新会话 hasConversation=true ✅；Qoder 投递入队 ✅；三家只读红线（建表拒绝）全过。
- **回归**：demo 全部 21 个测试 exit 0（test-window 85 项：卡片 8→13、tab 6→9、七源图表；test-ui-fixture 扩八源）；`multi-source-check` 新增 MO1–MO10（OpenCode）/MQ1–MQ8（Qoder）/MG1–MG9（Cursor）+ MU11–MU13 全绿；既有失败仅 ML5/MC5/MU5 三项——**HEAD 基线（git worktree 对照）同样失败**，属环境负载/DSH 侧既有口径问题，非本轮回归。ML4 补 `aborted` 合法态（v0.1.3 时检查脚本未跟上）。
- **文档**：docs/40 适配矩阵补三家（含数据位置与实测口径）；docs/22 AGT-2/3/4 状态更新；README 能力表五源→八源。

## 2026-10-19（三）
### 手动停止 ≠ 出错【v0.1.3 · 契约 v1.4】：用户中断的会话不再永久显示「出错」（用户反馈）

- **问题（用户反馈：被中断的对话在 mini 条一直显示「出错」）**：ZCode 被用户停止时把在飞工具行落盘为 `state.status='error'` + 固定取消签名错误文本（`"Agent was cancelled…"` / `"Bash was cancelled and the child process was asked to stop"` / `"TaskOutput was cancelled…"` / `"WebFetch was cancelled…"` / `"MCP tool … was cancelled"`，2026-10-19 本机全库实测分布），**且不再写回合终态**——跟随链 `mapZcodeRow` 把它映射成 `tool.result(error)` → `transient-error`；而 `transient-error` 在 `PINNED_PROGRESS` 里永不过期、目录结论也修正不了它（`effectiveState` 只修正 TIMED_PROGRESS），mini 条从此常驻「出错」。
- **修复（三层口径，契约 v1.4）**：新增会话态 **`aborted`（手动停止，中性终态）**——优先级与 `done` 同级、不计入错误、非进行中：
  ① `zcode-adapter`：`isCancelledToolError()`（/cancell?ed|interrupted/）识别取消签名——`mapZcodeRow` 里取消工具 → `tool.result(aborted)`（真错误仍 `error`）；粗状态 `finish=interrupted` → `aborted`；**滞留修正回看窗口内最后工具行**（真实形态：中断会话尾部 `tool-calls` 消息比取消工具行晚 ~5ms、盖住取消行——`stale>5min` 时最后的工具行是取消 → `aborted` 而非 `idle`）。
  ② 状态机：`framed.mjs` `applyEvent` 与 `demo/frame.mjs` hub 的 `turn.end`/`session.end`/`step.end`/`tool.result` 的 `aborted` 分支统一置 `aborted`（此前 `turn.end(aborted)` 落 `idle`）；`aborted` 不进 `PINNED_PROGRESS`/`TIMED_PROGRESS`，24h 退役照常。
  ③ 前端：mini 条与主界面显示「手动停止」（`--done` 色系）、时间位「停止」、排序/优先级与完成同级（不抢占 waiting/running/error 的显示）；主界面 chips 有 `aborted` 会话时追加「停止 N」，会话归类与 `done` 同档（短暂展示后进完成档）。
- **验证**：新增 `demo/test-aborted-state.mjs`（21 项：签名识别 3 + 映射分流 4 + 目录粗状态 7 + hub 3 + mini 渲染 4，全绿）；真实库回归——本机 4 个被中断会话（含当日 07:01「分析实验课需求评估…」、03:24「结束子代理后暂停执行」）现正确标 `aborted`；demo 全部 23 个测试 exit 0。**注意：已安装的 `/Applications/CodeAll.app` 内打包副本需重打包（`tauri build` 自动经 bundle-service 复制）或从源码 `run.sh --restart-server` 才能生效。**
- **文档**：契约 [docs/00](./00-interface-contract.md) 升 **v1.4**（`tool.result` 词汇新增 `aborted`；§4.1 状态集合补中性终态；§4.2 真值表 `turn.end`/`step.end`/`session.end`/`tool.result` 的 `aborted` 行）；`scripts/replay-check.mjs`（契约校验器）同步 `aborted` 分支与 `PRIORITY`；真相源 [docs/28（v0.1.3）](./28-v0.1.3-scope.md)。

## 2026-10-19（二）
### PERF-7 用量扫描四级增量【v0.1.2】：P0 修正 2 + 让出 + 检查点 + 尾读 + ZCode 水位（评审驱动，perf-verify 17/17）

- **P0-1 `stats.readBytes` 语义修正**：原实现对缓存命中文件也 `+= stat.size`（冷热两轮数字相同、无证明力）——改为实际读取字节（缓存命中 0 / 尾读增量段 / 整读全量），新增 `resumedFiles`/`corpusBytes`；这是后续所有「省读」断言的证据基础。
- **P0-2 `?refresh=1` 真强刷**：原 `refreshUsage()` 无参调用 + CLI `--refresh` 漏传 zcode——「强制重扫」在服务端与 ZCode 上实际不存在；现 `refreshUsage(force)` 走 `FORCE_SCAN_OPTS` 五源强刷（含 zcode 清水位/LRU 重建），并跳过检查点加载、扫后覆盖写（坏缓存自愈）。
- **第①级 事件循环让出**：文件间/每 512 行/DSH 帧粒度/ZCode `iterate()` 游标；ZCode 不加 SQL ORDER BY（无索引时 sqlite 首行前全表物化+排序 ≈228ms 同步块）。实测：DSH 全量扫描 20ms 计时器最大停顿 22ms（原整块 ~1.3s）、ZCode 23ms（原 ~409ms）；P7-a 64MB 冷扫 5.6s 期间 SSE 最大间隔 2001ms。
- **第②级 检查点**：`~/.agent-pet/usage-checkpoint.json`（0600 原子写、SCANNER_VERSION 失效、逐条目丢弃、8MB 护栏、`PET_USAGE_CHECKPOINT` 可覆盖）；重启后未变文件零重读——P7-b 实测 dsh readBytes=0 vs 对照组全量 67,109,043B。
- **第③级 尾读**：DSH 帧边界续读（实测截断 zstd 帧**不抛错**而「成功」解出半段——PERF-2 同款坑，末帧「非空且以 \n 收尾」才消费、否则推迟；inode+魔数双锚）；Codex `prevTotal/calls.seen` + 字节精确偏移（0x0A 切行）+ 64B 锚点哈希；Kimi 同构；**Claude 保持整读**（byMsg 全量 seen-id 持久化会致 checkpoint MB 级膨胀，评审选型）。对抗用例 UCD2/UCB2/UCC3（半写补齐/同路径更大替换/fork 累计跨界/重复 callId 跨界）全绿。
- **第④级 ZCode 水位**：spike（[spikes/zcode-usage-watermark](../spikes/zcode-usage-watermark/README.md)，只读真实库回放）**推翻「tokens 只在终态写入」假设**（29,781/31,457 行处于中间态 tool-calls）→ delta 追账 + 双 LRU（msgLru 差量负截 0 / partLru (sid,callId) 去重）6000 随检查点持久化（不持久化重启实测丢 495 万 token）；staleMiss=「未命中 LRU 且 tc 早于 LRU 最早条目」可观测；稳态 409ms→40ms（time_updated 前置短路 json_extract）。lag 双场景（同进程 30s 补 tokens / 停机补 tokens 重启）fixtures 入 `usage-calendar-check`。
- **修复（实现途中抓获）**：`addInto` 对显式 `requests:0` 走「有 token 即 +1」回退（zcode 差量行多计请求）；`deZcodeState` partLru 误用 Set（`lruTouch` 需 Map.set → 静默 degraded + 跨重启 part 重计，测试补 `s4.degraded===undefined` 断言）；zcode 状态未绑定 dbPath（跨库串台）；SSE 测试挂具必须消费 body（未消费的流式响应 abort 后污染 undici 连接池）。
- **回归**：usage-check **36 项**、usage-calendar-check **7 测试**、test-usage-checkpoint **6/6**、test-minute-refresh 5/5、demo 15 项、**perf-verify 17/17（P7-a/b/c 新增，480s）**。
- **文档**：真相源 [docs/27（v0.1.2 范围/验收/风险）](./27-v0.1.2-scope.md)；docs/40 §3.13 四级增量改写（含 spike 结论与 staleMiss 口径）；demo/README 用量行为注记；docs/25 §3/§4/附录 C 保持 v0.1.1 终态并加移出指针；「1.1GB≈2s」作废，实测基线（Claude 4,951ms/1.09GB 等）入册。

## 2026-10-19
### 分钟兜底刷新【v0.1.2】：修复空闲期 mini 条状态 / 日历桶计数无限滞留（PERF-1 盲区；用户反馈）

- **问题（用户反馈：mini 条状态延迟、日历桶计数不刷新）**：PERF-1 后空闲期快照只在脏时重建，而五源目录 TTL 缓存是**惰性**缓存——`snapshot()` 不被调用就永不重扫；PERF-3 又把用量 60s 周期重扫改为纯懒触发（`/api/usage*` 命中或启动 +5min）。纯空闲下两条链路自锁：静默信号（四态 mtime 15s / `WORKSPACE_STORE` mtime 5s）未覆盖的变化（CLI 会话收尾状态、用量日历桶计数等）**无限滞留**，直至任一事件/信号唤醒。
- **修复（`demo/framed.mjs` 2s 节拍内）**：有 SSE 客户端连接时，每 `REFRESH_MS`（默认 60s，`PET_REFRESH_MS` 可注入，下限 5s）强制重扫目录五源（`forceCatalogRescan` + 脏标记 → 全量快照推送）并触发用量重扫（完成即 broadcast，客户端按 `usage.generatedAt` 翻新自动重拉日历）——mini 条状态与日历桶计数最迟 **~1 分钟**可见（用户指定的口径）。**无客户端时跳过**：纯空闲零后台扫描口径不变（perf-verify P3③「无客户端 70s 无后台重扫」继续成立），代价仅在有 UI 在看时支付（每分钟一次目录五源重扫 ~170ms + 用量增量扫，v0.1.0 本就每 60s 扫一次）。
- **验证**：新增 `demo/test-minute-refresh.mjs`（5/5：有客户端→≤1 周期首轮自动扫 + 追加后 ≤1 周期重扫吸收 + 全量推送；无客户端→≥2 周期零后台重扫；新会话文件 ≤周期+节拍可见）；`scripts/perf-verify.mjs` bootService 注入 `PET_REFRESH_MS=600000` 隔离（P1-a 平均字节 / P4-a 8s 下界 / P3③ 各自只测自身机制），P3③ 检查名同步改为「无客户端时分钟兜底不运行」；**perf-verify 14/14 全绿（286s）**，受影响回归全绿（test-tick 11/11、service-hardening、usage-calendar、headless-cap、mini、window 等 20 项 exit 0）。首轮 perf-verify 曾 11/14——`lastAutoRefresh` 锚 0 导致「首个客户端连上的节拍」立即强制重扫（首轮用量全量扫描混进 P2 测量窗口：P2-large CPU 20801ms），锚定启动时刻后回落（P2-large CPU 63ms）。
- **文档**：真相源 [docs/27（v0.1.2）](./27-v0.1.2-scope.md) §2/§4（目录变化极端情况由分钟兜底封顶 ≤~62s；用量行「有 UI 连接时 ≤~1 分钟自动重扫」）；demo/README `/api/stream` 行补刷新语义；docs/25 §4 同位置留 v0.1.1 终态与移出指针。

## 2026-10-18
### 两轴审查修正（qa/v0.1.1-code-review-2026-10-18.md 修订版全项落地）：文档硬伤 1 + 证据链 1 + 口径 1 + 重构 4；perf-verify 升 14/14

- **文档硬伤（S1）**：docs/26 §1 表格行、SPIKE-4 ②、§5 风险表的 ZCode `account:*` 表述与本批 CLI-1 纠偏口径矛盾（称「现回退 UI 粘贴」/「沿用 UI 通道既有模式」，实际该回退在当前接线**不可达**、account 走 app-server 管道且无 provider 时如实失败）——三处均已对齐 docs/25 §2/docs/40 §3.14 口径；SPIKE-4 ② 改为「可行性重估（当前为不可达死代码）」。
- **证据链（P1）**：① perf-verify 新增 **P2-large**（64MB（>50MB 档）日志 20s 空闲 readBytes 增量 **0 B（readOps 0）**、CPU 44ms/20s，实测入册 `qa/perf/verify-2026-10-18.txt`）；② **P2-correct 补「坏帧重同步 + 乱序不丢不回退」断言**，凑齐 PERF-2 完成条件「乱序/坏帧/半帧/轮转」四类；③ 原「>50MB 独立测量 0 B vs 旧 ~2.64GB」表述不实（无脚本/产物、2.64GB 系估算）——docs/25 §3/§4/附录 A 锚点/附录 C 与本 CHANGELOG 两处历史条目（首轮/PERF-0 段，均已加校正注）统一改为：新码 64MB 实测 0 B + 旧实现读量**算术推算**口径（≈25 次 × 64MB ≈ 1.6GB + watch 双触发，旧代码已不在树上无法实测）。
- **口径校准（P3）**：PERF-4「15s TTL + 2s 节拍」名不副实（TTL 为惰性缓存不主动触发）——docs/25 §3 与 perf-verify P4-a 检查名改为「**四态活动目录 mtime 15s 轮询信号 + 2s 节拍；不改 mtime 的变化才由 15s 惰性 TTL 兜底**」（机制与延迟数字不变）。
- **重构（S2–S5，行为零变化）**：`isolatedEnv`/`DSH_SCRUB` 三份同形实现收敛到 `demo/test-env.mjs` 导出（perf-baseline/perf-verify 改 import，helper 并入 TMPDIR 隔离）；`zcode-adapter` `pump()` 尾部改调 `slowDown()`（退避封顶单一来源）；`framed.mjs` catalog/ws/multi 三缓存提取共享 `makeTtlCache()`（错误占位/无 onError 上抛语义保持）；`window.html` 移除 `sinceNum` 不可达回退（按 S5 定性为可选死代码清理——该回退本是同帧字段相减、docs/51 §3.2 T2 允许，非契约问题）。
- **发布余项补登记（P2）**：docs/25 §4「发布前余项」补两项——**非 `--live` 的 `multi-source-check`** 与 **带插件的实机复测**（部署口径目前只有标准档近似）。
- **夹具修正（复跑抓获）**：perf-verify `buildCorpus` 的 claude 用量文件 mtime 未置旧——四态连接 45s 新鲜度边界落进 P1-a 空闲窗口造成假失败（全量 3 > 阈 2）；已 `utimesSync` 置旧，P1-a 恢复「全量 2、tick 9」。
- **回归**：隔离测试 **20 个文件全绿**；perf-verify **14/14 全绿（282s，exit 0）**（含 P2-large、扩展 P2-correct 与更名后 P4-a：10.8s 可见）。发布余项不变（V01–V06 修正后实机回归、multi-source-check（含 --live）、带插件复测、应用包重建复验，见 docs/25 §4）。

## 2026-10-17（二轮：审查修正）
### 审查修正轮：产品修复 9 项 + 验证套件 6 项补强 + 文档纠偏（用户授权；终轮 task-10 数字已回填）

- **产品修复**：① PERF-5 阻塞缺陷——`readInputFile()` 丢弃 `autoRetry`，并发满入队的续会话永不自动重试、重启后全丢；修正保留字段 + `PET_FLUSH_MS` 可注入；② 静默变化驱动：`WORKSPACE_STORE` mtime 5s 检查 + 四态变化 → `forceCatalogRescan`（补目录/工作区漏推路径）；③ 插件 `pet.heartbeat` 数据无变化改发 `broadcastTick`（部署态不再每 15s 全量快照）；④ `read()` 无新字节时仍执行 45s offline 边沿判定；⑤ `PET_PERF_PROBE` 增 readBytes/readOps（PERF-2 改直接测量）；⑥ 日志轮转以 inode 变化检测；⑦ `broadcast()` 快照成功后再清脏 + 异常保底；⑧ `demo/window.html` tick 补全会话行计时器/45s 活动边界/分类跨界（新增 `demo/test-tick.mjs`）；⑨ ZCode `fp()` NULL/Buffer 兼容 + DB 缺失时退避。
- **验证套件修正**：`perf-verify`/`perf-baseline` 显式隔离 `DSH_*`（修复 DSH 环境下假故障）；sseRecord 跨 chunk 稳健解析；P1-b① 持久 SSE + 精确时间戳（忽略连接首帧）；P2-diff 改 readBytes/readOps 直接断言；P4-a 改 SSE-only；P4-b 间隔增长断言；P6-b 改基线子进程差分重做；`test-headless-cap` 增「槽位释放后自动重投」端到端断言；新增 `demo/test-env.mjs` 隔离 helper。
- **文档纠偏**：docs/25 §2 可见性矩阵（仅「打开会话」可见；`newCliSession` 与 `account:*` UI 粘贴为既有死代码；`account:*` 实际走 app-server 管道）、§4 延迟 tradeoff 与 readBytes 口径、附录 A/B/C 数值与数据 provenance（pre 原始数据从 /tmp 入册 `qa/perf/`；纯空闲 CPU **-82.4%/-83.8%**（190 vs 1080/1170）、SSE **-94.3%**；插件部署以标准档近似 **-85.8%/-46.5%～-57.1%**（心跳改 tick 后应更优，待插件实机）；测试计数 **20 文件/16 断言套件**）；CHANGELOG 删除/改写「三条可见通道」「20s 冲刷自动重试」「window tick 计时文本」「P6-b 证明旧实现」等不实/夸大表述；qa 验收记录修正 V06 标记归属并登记「修正前构建、修正后回归待补」。
- **终轮（task-10）结果（2026-10-17 晚，clean-env）**：全量隔离测试 **20 个文件（16 个断言套件）全绿**（总耗时 75.4s）；perf-verify **13/13 全绿（237s，exit 0）**；perf-baseline 修正后复跑（`qa/perf/after-pure-fixed.json`）：标准档 idle CPU 1001/1248→**536**（-46.5%/-57.1%）、active 1454/1992→**617**（-57.6%/-69.0%）、**纯空闲 CPU 1080/1170→190（-82.4%/-83.8%）**、**纯空闲 SSE 4,753,983/4,754,373→270,932 B（-94.3%）**、标准档 idle SSE -85.8%/-86.2%、p50 21/20→**5ms**、启动 7.3～7.7s→**0.62s**、标准档 idle readBytes **0 B/0 ops**；文档/验收记录已回填终值。

## 2026-10-17
### 首轮：真优化验证套件制定（perf-verify 12/12 首测）＋抓获并修复 DSH 跟随器截断帧丢失缺陷（v0.1.0 即存在）

- **新增 [scripts/perf-verify.mjs](../scripts/perf-verify.mjs)**（docs/25 附录 C）：逐项证明 PERF-1～6 机制真实生效而非「测试绿」——空闲心跳轻量化（2 全量+9 tick/20s、平均 2785B）、脏冲刷不漏推、用量懒触发（就绪即查 pending + 70s 零后台重扫）、目录 TTL 10.1s 可见、**增量读差分**（1MB vs 8MB 日志空闲 CPU 差 -2ms；二轮改用探针 readBytes/readOps 直接测量复核：>50MB 日志空闲 20s 读取 0 B vs 旧实现约 2.64GB（**2026-10-18 校正：当时 >50MB 档无产物入册、旧值系估算；现已补 P2-large 64MB 实测 0 B 入册，旧值改推算口径，见 docs/25 附录 C**））、ZCode 退避（空闲 5s 6 轮、回基准 204ms；二轮改为间隔增长断言）、并发上限（复用 test-headless-cap；二轮增自动重投端到端断言）、指纹去重（touch 不重放/UPDATE 重放）与**差分内存**（首轮 2.5 万行×6KB 同指纹 vs 异指纹 RSS 差 0.13MB；**该设计未测旧实现、+35MB 为算术估算，二轮重做为基线子进程差分 <6~8MB**）。全隔离可复跑（约 4 分钟；**二轮补：须清 DSH_* 环境变量，否则会跟随真实 ~/.dsh 产生假故障**），任一失败退出非零。
- **首跑抓获真实缺陷（产品代码修复）**：`zstdDecompressSync` 对截断帧不抛错而「成功」解压为空——跟随器读到写到一半的帧时当空帧消费，**该帧事件永久丢失**（v0.1.0 整文件读取同样存在，靠下一帧魔数重同步掩盖；PERF-2 增量模式下余字节成孤儿前缀暴露）。修复：`decodeFrames` 末帧必须非空且以完整行（`\n`）收尾才消费，连续 3 轮不合格放行（防真实无换行尾帧永久滞留）。修复后 perf-verify 12/12、隔离测试 18 个文件全绿（其中 3 个 helper、实际 15 个断言套件；二轮后 20 文件/16 套件（终轮实测））；V06 安装包已同步 /Applications（**属修正前构建**；二轮修正后需重建复验，见 qa 验收记录「修正后回归待补」）。

## 2026-10-17
### v0.1.1 实机验收（首轮，对应修正前构建）：V01–V06 复跑全部通过（用户授权，专用测试会话 + 最小自检消息）

- **V01 CLI 对话闭环 ✅**：claude（aa273dac…）/ codex（01a1492d…）/ kimi（session_5e7733c5…）各一个专用会话，投递即新建 + 首条送达 + 第二轮同 ID 上下文连续（均正确回忆指令词 "ok"）；claude 实际请求 `--model glm-5.2`（cc-switch 映射生效）。
- **V02 同 cwd 隔离 ✅**：标记只进 A（3 处，B 0 处），回复 "A-ok"；未知 ID 404、无目标 400。
- **V03 DSH 插件闭环 ✅**：session-ae69aa9d… 三轮 plugin:agents.followup（ok/ok/recovered），turn/end(completed)×3，状态机回流 done/已完成 + title 从日志派生。
- **V04 ✅ / V05 ✅**：重启后插件重连、队列无幽灵、目录恢复，重启后投递 "recovered"；upsertInput 执行前落盘在位，test-crash-window 四场景全绿。
- **V06 安装包 ✅**：新包 121.79 MiB + DMG 39.84 MiB（包内 v0.1.1 标记核对：PET_PERF_PROBE/broadcastTick/headlessInFlight/PET_HEADLESS_CAP/zcode 指纹全部在位）；干净安装后包内 Node 自起 7799，插件 connected、四源注册表 available，包服务投递闭环（claude A → "packaged"）。现 /Applications/CodeAll.app 是**修正前** v0.1.1 构建（**二轮更正：PET_HEADLESS_CAP 位于 `adapters/cli-control.mjs`，不在 framed.mjs**）。
- **二轮登记**：本次实机验收对应**修正前构建**；修正后（autoRetry/静默变化驱动/心跳轻量化/readBytes/inode/window tick/ZCode NULL 等）V01–V06 实机回归待补，应用包需按修正后代码重建复验（见 [qa/v0.1.1-acceptance-2026-10-17.md](../qa/v0.1.1-acceptance-2026-10-17.md)「修正后回归待补」）。
- **环境事件登记（非产品缺陷）**：验收中本机 cc-switch 代理（127.0.0.1:15721）未运行，claude 首轮 CLI 侧 ConnectionRefused——会话文件如实留痕（诚实边界的正面样本），启动 CC Switch 后同会话重发即送达。
- 队列终态：32 条全 delivered、无残留。证据：[qa/v0.1.1-acceptance-2026-10-17.md](../qa/v0.1.1-acceptance-2026-10-17.md)。`multi-source-check --live` 未在本轮授权范围，余项由用户决定。

## 2026-10-17
### v0.1.1 开发完成（首轮）：PERF-1～6 + CLI-1 全部落地（无插件纯空闲 CPU -70.4%、SSE 推送 -94.3%；18 个隔离测试文件）

- **PERF-1 快照脏标记**：显式变化点（事件/队列/投递/用量完成）仍即时全量推；静默变化（目录 TTL 重扫、四态刷新）以 `stableJson` 比对（剔除 scannedAt/tookMs 等易变字段）挂脏，由 2s 节拍冲刷；无变化心跳降为轻量 tick（仅 `ts`，`{v:1,tick:true}`），qa M4「无 DSH 日志也有消息流」语义保留；`broadcast()` 无客户端时跳过重建。**二轮审查发现 B3：window.html 会话行 elapsedMs、45s「活动中/静默」边界、活跃/完成分类在 tick 下冻结，违反「UI 计时/状态无退化」；已补全并加 `test-tick` 回归**。纯空闲口径（**无插件**）**CPU 1080/1170→190 ms/分钟（-82.4%/-83.8%，终轮定稿；首轮 320、二轮 240 为过程值）、推送 4.7MB→271KB/分钟（-94.3%）**，双达标；插件部署近似以标准档终测 **-85.8%/-46.5%～-57.1%** 计（二轮 pet.heartbeat 改 tick 后应更优，待插件实机复测）。
- **PERF-2 跟随器增量读**：DSH 日志跟随从「800ms 定时 + fs.watch 双触发整文件 readFileSync」改为 **fs.open+定长定位尾读**（无增长零读取），fs.watch 500ms 去抖 + 5s 增量兜底轮询；未完成帧留 pending 缓冲拼接，轮转/截断重置重读。
- **PERF-3 用量懒触发**：去掉启动即扫与 60s 周期；首轮延后至 +5min，`/api/usage` 与 `/api/usage/calendar` 在缓存 ≥60s 陈旧时异步触发重扫（响应仍回当前缓存）。
- **PERF-4 轮询矩阵**：四态 3s→15s、五源目录/工作区缓存 TTL 5s→15s（重扫结果比对挂脏）、ZCode sqlite 1.5s→2s 且无新增行指数退避（≤10s，有变化立即回基准）；Claude/Codex/Kimi 跟随 1.2s 维持（实时事件路径，纯空闲已达标故不加退避）。
- **PERF-5 投递台账 + 并发上限**：`headlessRun` 在途台账（pid/来源/开始时间/日志，进程退出即移除）暴露于 `/api/state.inFlight`；无头并发上限默认 2（`PET_HEADLESS_CAP` 可覆盖），超出返回 busy → 入队 `autoRetry`，`flushNewQueues` 设计为同时冲刷 new: 与 autoRetry 条目；ZCode 链保持全局串行不动。**二轮审查抓获阻塞缺陷：`readInputFile()` 重建条目时丢弃 `autoRetry` → busy 续会话永不自动重试、重启后全丢；已修复（保留字段 + `PET_FLUSH_MS` 可注入）**。新增 `demo/test-headless-cap.mjs`（挂起 mock：2 在途封顶/第 3 条入队/退出即释放；**二轮增「槽位释放后自动重投」端到端断言**）；test-cli-create 显式抬高测试上限（其意图是参数与环境，非限流）。
- **PERF-6 ZCode 指纹瘦身**：`seen` 表值改 sha256 指纹（原全文本 data），命中 delete+set 重触构成 LRU；容量 6000 与批量淘汰 2000 口径不变。**二轮审查修正：`fp(r.data)` 对 NULL/Buffer 抛 TypeError（v0.1.0 容忍 NULL）→ 已兼容；DB 缺失/查询错误时更新退避。**
- **CLI-1 文档收口**：投递通道可见性矩阵落 demo/README 与 docs/40 §3.14。**二轮纠正：可见投递/打开通道仅「打开会话」（Terminal；ZCode account 会话走 zcode:// 深链）；「新建会话窗口」`newCliSession` 未接线（docs/22 M1 死代码）、`account:*` 的 UI 粘贴回退 `deliverViaZcodeUi`/`PET_ZCODE_UI_DELIVER` 在当前接线不可达（`deliverViaCli` 对 zcode 无条件走 app-server 管道）；`account:*` 上游拒绝时如实失败、不谎报。首轮「三条可见通道」表述不实，已改写。**
- **对比口径**：标准档（含挂具 /api/state 采样）空闲 CPU 1001/1248→727/795 ms/分钟、/api/state p50 21/20→**8/7**ms（p95 57/60→67 如实登记为变差；启动 7.3～7.7s→**0.62s**）；改动前代码经 git worktree 同款脚本对照；**pre 纯空闲原始数据已入册 `qa/perf/pre-pure.json`（1080ms/4,753,983B）、`pre-pure-rerun.json`（1170ms），after 过程值 `after-pure-rerun.json`（240ms），终轮定稿 `after-pure-fixed.json`（190ms/270,932B）**，全部数字与 provenance 见 [docs/25 附录 B](./25-v0.1.1-scope.md)；**待用户授权**：`multi-source-check --live`；修正后 V01–V06 实机回归待补。

## 2026-10-17
### PERF-0 完成：v0.1.1 开销基线表在册（工具 + 探针 + 两档复跑）

- **新增 [scripts/perf-baseline.mjs](../scripts/perf-baseline.mjs)**：隔离 HOME + 合成五源确定性语料（**二轮更正单位：DSH 主日志 1.1MiB/其余 0.3MiB、Claude 1.6MiB（实占 1.65）、Codex 0.6MiB、Kimi 0.3MiB、ZCode 480 行；初版把 MiB 写作 MB**），起 framed 服务采「空闲 60s / 合成活跃 60s（每 2s 追加一轮事件）」两档：CPU、读写次数、RSS、SSE 推送条数与字节、/api/state（snapshot 全量重建）时延、启动耗时。macOS rusage 无 in/out-block；**二轮后 `PET_PERF_PROBE` 直接输出 readBytes/readOps，PERF-2 完成条件改为直接测量（>50MB 日志空闲 20s 0 B vs 旧 ~2.64GB；**2026-10-18 校正：旧值为估算非实测，64MB 档实测已入册**）**。
- **framed.mjs 增 env 门控资源探针**（`PET_PERF_PROBE=<file>`，每 5s 追加 CPU µs/RSS 采样，二轮再增 readBytes/readOps；默认不开启、零行为影响）；**17 个隔离测试文件（其中 3 个 helper、14 个断言套件）通过**。
- **基线（docs/25 附录 A，run1/run2）**：空闲 CPU 1001～1248ms/分钟（1.7～2.1%），空闲 SSE 推送 32～33 条/分钟 × ~149KB ≈ **4.8MB/分钟/客户端（零变化全量推）**；活跃档 121 条/分钟；/api/state p50 4～21ms / p95 35～60ms；复跑噪声 CPU ±25%、条数/字节 <0.1%。PERF-1 锚点：优化后空闲 CPU ≤500～625ms/分钟、空闲推送字节 ≥90% 下降。

### v0.1.1 与 v0.3.0 立项（用户定向：性能优化补丁线 + 桌面端通道攻坚）

- **v0.1.1 = 性能优化 + CLI 后台化收口**（真相源 [docs/25-v0.1.1-scope.md](./25-v0.1.1-scope.md)）：仅 macOS、功能语义零变化、不吸收 v0.2.1 清单。依据 2026-10-17 全量开销分析定位五大根因（broadcast 每 2s 全量重建 snapshot、日志跟随器整文件重读、用量扫描 60s 周期、各路固定轮询矩阵、每次投递独立 agent 进程）；任务 PERF-0 基线 → PERF-1 快照脏标记 / PERF-2 日志增量读（最大头）→ PERF-3/4/5/6 + CLI-1 后台化文档收口，合计约 5.5～9.5 人日。CLI 后台化复核结论（**二轮纠正**）：投递链路已实测全后台；可见通道**仅「打开会话」Terminal**（设计意图）；「新建会话窗口」`newCliSession` 未接线、ZCode `account:*` 的 UI 粘贴回退不可达，均为既有死代码；`account:*` 实际走 app-server 管道，上游拒绝时如实失败。
- **v0.3.0 = 桌面端信息传输通道攻坚**（真相源 [docs/26-v0.3.0-scope.md](./26-v0.3.0-scope.md)）：把 docs/24「继续暂停」中的「Claude/Codex/Kimi 桌面 App 原生控制」升级为 v0.3.0 主目标（前置依赖 v0.2.0 完成；ACP/更多 Agent 在其后重启）。2026-10-17 本机实测确认：五家桌面 App 均无 AppleScript 脚本面，除 ZCode app-server 管道外无官方外部输入协议，「进程内插件」仅对自有软件 DSH 可行；SPIKE-1～5 全量 spike（只读/沙箱，证据卡进 docs/40）后按证据择优落地 1～2 家（DESK-1，预估优先级 DSH 深化 > ZCode account 加固 > Kimi Code > Claude/Codex 桌面）。
- **同步**：docs/22 头部 2026-10-17 更新（v0.1.1/v0.3.0 定向，其余工作流继续暂停）；docs/24 §1「继续暂停」行指向 docs/26；README 前言、文档索引、§四当前开发任务（中英双语）同步三线排期。

## 2026-10-10
### v0.2.0 开发计划立项（用户定向：跨平台 Win/Linux）

- **方向裁决**：v0.1.0 收口后按 docs/23 留话「v0.2 恢复顺序需重新确认」征询用户，定向沿用 docs/22 历史排期——**v0.2.0 = W3/PLAT 跨平台**；v0.1.0 验收登记的遗留小修（claude-code `--resume` 就绪信号调研、`/api/new` dsh 审计字段、DEF-1、M1/M3/M5 与 frame.mjs 拼写）**排 v0.2.1**。
- **Linux 架构口径（用户问询后确认）**：适配代码架构无关（全仓唯一 arch 引用是 session-catalog.mjs:157 的 DSH flock addon 参数化命名；服务纯 JS，Node/Tauri 双架构一等支持，bundle-service 从构建机复制 node 天然 per-arch）——按 Ubuntu Desktop LTS 24.04 单基线适配，v0.2.0 验收锁单一架构（默认 amd64、以物理机为准），另一架构仅 CI 出包并标注未实机验证；Linux 真实风险轴是 webkit2gtk/Ubuntu 版本与 X11-Wayland，非 CPU 架构（docs/24 §1/§6）。
- **新增 [docs/24-v0.2.0-scope.md](./24-v0.2.0-scope.md)（v0.2.0 真相源）**：源可用性矩阵（各 CLI/DSH/ZCode 按平台实测接线，无发行版诚实标注）；DSH 插件桥按发行版决定（unix socket → Windows 命名管道，flock addon 平台参数化是积极信号）；ZCode 维持实验；外壳降级阶梯（Windows 不透明迷你条、Wayland 声明）。开发顺序 PLAT-0（验证机先行，新增）→ PLAT-1 平台抽象层 → PLAT-2 Windows → PLAT-3 Linux → PLAT-4 CI（remote 已建，docs/22「当前无远程」前提已满足），合计 17～27 人日、不做日期承诺。发布门槛 W01–W07（macOS 零回归 + 双平台安装即用/观察/控制/外壳 + 三平台收口）；验证纪律明确 VM 只做冒烟、窗口行为与安装包验收须物理机。
- **技术盘点依据**（写进 docs/24 §2 的四个差异点 + 一处收编）：`local-agents.mjs`（ps/PlistBuddy/安装路径）、`cli-control.mjs`（osascript 终端链）、`framed.mjs:49`（插件 unix socket + TMPDIR）、`lib.rs`（`#[cfg(target_os="macos")]` 窗口行为块）、`session-catalog.mjs:158`（DSH addon 回退路径写死 /Applications）；Tauri 打包目标目前仅 app+dmg。
- **同步**：docs/23 头部标注真相源移交 docs/24；docs/22 头部/PLAT-4 前提/DEF 节更新（W3 恢复、其余继续暂停、DEF 排 v0.2.1）；README 前言、文档索引、§四当前开发任务同步。

## 2026-10-10
### v0.1.0 收口：V05 崩溃窗口落盘 + V01–V06 实机验收全部通过

- **V05 代码缺口（CORE-4，唯一写代码项）**：`demo/framed.mjs` 此前 CLI / DSH 插件 / 投递即新建三条路径都是 `await` 投递完成后才落盘——执行中被 kill -9/断电时消息可能已送达而队列无痕（插件 4s 超时窗口尤甚）。修复：`persistInput`（只追加）改为 **`upsertInput`（按 id 原位替换）**，四条真实投递路径（新建、CLI 无头、DSH 插件、失败重试原位置 pending）**执行前先落盘 pending**，终态原位更新——同一消息不产生第二条队列记录；磁盘不可写时内存态仍原位可见（维持 qa M2 口径）。重启时残留 pending 由既有启动迁移标「结果未确认」。
- **合成回归 `demo/test-crash-window.mjs`（新）**：隔离 HOME + mock CLI（`mock-cli-create.cjs` 新增 `MOCK_CLI_MODE=hang|early-fail`，默认行为不变）+ 假插件 socket，四场景：A CLI 续会话投递中 kill -9；B 插件 4s 窗口内 kill -9（假插件已收到请求=「可能已送达」）；C 投递即新建执行中 kill -9；D cli-exit 快速失败可辨（V04）+ 重发执行中 kill -9。断言：重启后条目在、failed + 「结果未确认」、原文/目标/来源保留、文件内单条、重启后不自动重发。全套隔离回归 16 套通过（界面行为 34/34）。
- **实机验收（专用测试会话 + 最小自检消息，证据 [qa/v0.1.0-acceptance-2026-10-10.md](../qa/v0.1.0-acceptance-2026-10-10.md)）**：**V01** 三 CLI（claude 94226702… / codex 01a124e2… / kimi session_b344fd88…）各完成「新建+首条送达+第二轮同 ID 上下文连续」，回复与转录/rollout/wire 增量逐字核对；**V02** 同 cwd 双会话标记只进 A（B 0 处），未知 ID 404、无目标 400；**V03** DSH 专用会话（session-d5311040…，flash·low）两轮 plugin:agents.followup，回复回流 turn/end(completed)、目录侧 state=idle；**V04** cli-exit 合成 + 服务重启（队列/目录/插件恢复，重启后投递 "recovered"）；**V06** 含当日修复的新包（CodeAll.app 121.78 MiB + DMG 39.84 MiB）干净安装，包内 Node（v24.18.0）自起服务，四源注册表 + 插件在线，包服务投递闭环（"packaged"）。
- **观察项（登记，不阻塞）**：① claude-code 无头新建后 1–4 分钟内 `--resume` 偶发 `No conversation found`（CLI 侧会话索引未就绪；本轮实测 T+76s 失败、T+4min 起正常，手动/净化 env 均正常）——队列如实失败，confirm 重发即成，v0.2 调研就绪信号；② `/api/new` dsh 成功路径 item.accepted=false 与 CLI 路径不一致（审计字段，v0.1.x 小修）。
- **文档**：docs/23 §3 CORE-1..5 全部置为已完成、§4 V01–V06 证据落位、§5 测试清单补 test-crash-window 并记录 2026-10-10 收口轮结论。

## 2026-10-09
### 用量口径统一：Token 改为「全量」口径（用户报障：本对话十几兆，面板只显示 789,088）

- **现象**：用户对比 DSH 自身计数（本对话约 15M tokens）与面板 DSH 当日值（789,088，差 ~19 倍），怀疑计数器坏了。
- **定位（不是计数错，是口径错）**：DSH/Claude/Kimi 的 `inputTokens` **不含缓存读**（Anthropic 式），Codex/ZCode 的 `input` **含缓存读**（OpenAI 式）。旧口径「Token = in + out」把两种语义混在一列：本对话实测 in 121,081 + out 106,812 = 227,893，而 cacheRead 15,139,712 完全不计 —— 而各 Agent 自己的计数器（与 DSH 官方投影 `uncachedInput+cacheRead+output+cacheWrite` 一致）是**含缓存读**的。
- **修复（采集器 + 界面同源）**：`adapters/usage-collect.mjs` 的 `decorate()` 新增 `promptTokens`（= 全量 prompt，含缓存读：DSH/Claude/Kimi = input + cacheRead；Codex/ZCode = input）与 `totalTokens`（= promptTokens + cacheWrite + output）；`usageCalendar()` 的**日桶 tokens 改为 totalTokens**（另透出 promptTokens/freshInput/inputIncludesCache），`usageOverview` 的 totals 与跨源合并模型行同样带派生值，`serializeUsageScan` 一致。界面（日历日值、来源对比图、chips、各表 in 列、软件页 Token、会话详情）统一走 `promptOf()/totalOf()`：**in（含缓存读）/ Token 全量**，与各 Agent 自带计数可比。
- **实测（本机，改后）**：DSH 当日 tokens 802,965 → **60,138,740**（全量）；Kimi 当日 212,381 → 1,688,221；Codex/ZCode 不变（其 input 本就含 cache）；「全部」DSH 4.5M → 335.7M、Claude 73.9M → 2,109.5M、Kimi 3.85M → 128.3M。命中率、cache 分项、freshInput 均保留，恒等式 Σ日桶 tokens = 源 totalTokens（MU10 断言）。
- **对账**：新增 **UCE5**（两种 input 语义的折算都对）、**MU10**（五源 Σ日历日桶 tokens = 「全部」totalTokens）；UI fixture/断言同步（in 列改「in（含缓存读）」、图表标题改「Token · 全量（含缓存读）」、「Token 全量」chip）。

## 2026-10-09
### 模型名映射（续）：请求参数也用实际请求名 + 不可调用的目录项从下拉隐藏（用户追问「为什么还带 Claude 系名」／「直接隐藏，保证简洁」）

- **为什么「请求名」里还有 `claude-*`**：cc-switch 的**本地代理接管**模式就是这么写的——tier 别名进 `ANTHROPIC_DEFAULT_*_MODEL`、真正上游模型进 `*_MODEL_NAME`，`ANTHROPIC_BASE_URL` 指向 `http://127.0.0.1:15721`。Claude Code 发出的 `claude-opus-5` 只存在于「CLI → 本地代理」这一跳，代理改写后上游收到 `glm-5.3-flash`（本机代理库实测：`req=claude-opus-5 → upstream=glm-5.3-flash`，200）。上游其实没有 Claude 模型，Claude 系名只是客户端一侧的路由键。
- **改法一：请求参数直接用实际请求名**（`adapters/model-map.mjs` 的 `cliModel` 不再区分 routed/direct）——`claude --model glm-5.3-flash`、`codex -m glm-5.3`。上一版为「怕切换器路由表失配」保留别名属过度保守；本机实测背书：代理日志中 `app_type=claude` 直传 `glm-5.3-flash` 76 次、`glm-5.3` 6 次，全部 200。
- **改法二：切换器换掉整张上游模型表时，未映射的目录项不再假装可新建**（用户报障：只配了 GLM 供应商，下拉里却仍列着 Opus 5.5 / Sonnet 5.5 / Fable 5.1 / Opus 4.8…，选中必然打不通）。`loadModelMap` 新增 `restrict`（映射后的实际模型名不属于该目录的模型家族，如 Claude 目录 → `glm-*`）：未映射项置 `canCreate:false` + `unavailableReason`（「该模型没有映射到当前供应商的上游模型」），可用的映射项排到下拉最前；`/api/state` 的 `modelRegistry.mapping[<源>].restrict` 可核对，切回官方供应商后自动恢复。
- **改法三（用户定向：简洁优先）**：这些不可调用的目录项不再以下拉里灰着的形式出现——注册表给它们打 `hidden:true`（仍留在 `/api/state` 供诊断与队列重试给出准确原因），新建对话框直接过滤掉；工具提示改为「…另有 N 个目录模型在当前供应商下没有上游模型，已隐藏」。ZCode 登录态 `account:*` 的「仅展示、不可新建」是既有且被测的独立行为，维持不变。
- **回归**：`demo/test-model-map.mjs` 增补断言（请求参数=实际请求名、未映射项 `hidden`、`restrict` 透出、切换器路由表口径）；`demo/test-window-actions.mjs` 增补「hidden 项不进下拉」（行为回归 34/34）；17 套隔离测试全部通过。

## 2026-10-09
### 用量口径修复：Codex「全部」总量与日历日桶对不上（用户报障）

- **现象（用户截图）**：同一页面上「来源对比」图表（全部时间）Codex 459.4M / ZCode 3.65B / DSH 4.1M / Claude 73.9M，而日历当日明细 Codex ≈55.5M / ZCode 164.2M / DSH 374,905 / Claude「—」；用户判断「两个数据不统一，且可能影响日历桶的 tokens 统计」。
- **定位**：① 窗口不同——图表按所选时间范围（默认「全部时间」）聚合，日历明细是**单日**（默认今天），两者本就不可相加比对，界面上却没有写清窗口；② 真正的账目 bug 只在 Codex：`collectCodexFile` 的会话扁平值取「最后一条 `total_token_usage`」，日桶却取 Σ`last_token_usage`，两个口径互不相容（其余四源 Σ日桶 ≡ 总量，逐字段精确）。
- **证据（本机 43 个 rollout 独立反读）**：Σ各文件末条累计 in 456,381,625 vs Σ日桶 394,726,516（差 62.2M）。其中 Σ「继承前缀」= 93.5M——子代理/fork rollout 的首条累计 = 父会话当时累计（实测子 01a000c0 的 C0 = 20,258,011 ≈ 父 019ffed3 当时 20,273,467），逐文件求和把父会话 token 重复计入；Σlast 另被重复上报抬高 8.8%（298 条「累计值不动」的 token_count 事件，例如同一 last=141,720 连报 3 条）。
- **修复**：`adapters/usage-collect.mjs` Codex 改为**累计值差分归日**——首条事件只认自身 `last_token_usage`（新会话实测 C0 == L0；forked 实测 L0 = 0，前缀是父会话的账），其后每条取 Δ累计（负值截 0，重复上报天然按 0 计）；`flat` 由逐事件归因累加得到，**Σ日桶 ≡ 源总量**由构造保证；`foldFile` 新增 `dayIdentityMismatched` 恒等式自检（五源通用）。
- **对账（修复后本机实测）**：五源 Σ日桶 逐字段 == 总量；Codex in 363,559,612（旧 456,381,625，排除继承前缀 92,822,013）、requests 3,689 不变；重复上报 298 条只计请求不计 token。**MU9** 升级为「五源全部精确 + 自检零失配」，**MU2** 改为独立反读「首条 last + Δ累计」，新增 **UC-B3/UC-B4** fixture（fork 继承前缀 + 重复上报：旧口径 4600 → 新口径 2600）。
- **顺带修**：MU3 只数「最新一条 wire」——子代理 wire 比 main 新时必然对不上（实测 main 6 行 + agent-0 12 行 = 18，却拿 6 去比），改为会话全部 wire 求和；界面把窗口写进图表标题（「全部时间」/「当日」…）并注明日历是单日口径，Codex 归日说明改为「按会话累计差分归日（Σ日桶=全量）」。
- **生效范围**：修复在源码；`/Applications/CodeAll.app` 内是 11:36 的旧构建，需重新打包（`apps/shell/run.sh --install`）或从源码起服务才生效（README「运维口径」）。

## 2026-10-09
### 模型名按「实际请求名」展示（用户定向：Codex CLI / Claude Code CLI 经 cc-switch 映射）

- **问题**：新建会话的模型下拉与会话模型列用的是 CLI 侧注册名。切换器（cc-switch 等）会把它映射成上游真实模型——Claude Code 本机实测注册名 `claude-opus-5` 实际请求 `glm-5.3-flash`（`claude-sonnet-5`→`glm-5.2`、`claude-fable-5`→`glm-5.3`），界面上看到的却是那个不存在的名字。
- **新增 `adapters/model-map.mjs`**（只读、30s 缓存、任何失败降级为「无映射 → 原名」，不外泄凭据）：按「实际请求配置」解析注册名 → 实际请求名，优先级 ① `~/.agent-pet/model-map.json` 显式覆盖（`{"codex":{"gpt-6-sol":"glm-5.3"}}`）② Claude Code：`$CLAUDE_CONFIG_DIR|~/.claude/settings.json` 的 env 成对变量（`ANTHROPIC_DEFAULT_<TIER>_MODEL` ↔ `_MODEL_NAME`；只有 `_MODEL` 时按档位记 direct——直连模式下该值本身就是请求名）③ Codex：`~/.codex/config.toml`（model/model_provider/base_url，识别供应商是否指向本地路由代理）+ cc-switch 当前激活供应商（`~/.cc-switch/cc-switch.db` 只读）的 meta 路由表与 settings_config 的 env 成对变量。切换器 DB 里存的正文会过期（本机实测存的 `gpt-5.6-terra` vs 现网 `gpt-6-sol`），只作诊断透出、**绝不参与映射**（`demo/test-model-map.mjs` F 场景锁死）。
- **注册表**（adapters/model-registry.mjs）：`value` 仍是注册标识（选择/校验/CLI 参数的键），`label`/`requestModel` 换成实际请求名，附 `mapping{from,to,mode,via}`；**routed 模式 CLI 参数不变**（Claude Code 请求里带的是 `ANTHROPIC_DEFAULT_*_MODEL` 的值，换成上游名会让切换器路由表失配），direct 模式才替换 `cliModel`。目录缓存键并入映射签名，配置文件一变下一轮快照即重算。
- **会话与用量展示**（adapters/codex-adapter.mjs、adapters/claude-code-adapter.mjs、demo/window.html）：会话 `model` 输出映射后的实际请求名、原名留在 `modelRaw`（`metaSources.model` 追加指针）；新建对话框下拉按实际请求名显示并加「模型（必选 · 实际请求名）」标注、title 给出「注册名 → 实际请求」；用量表模型列同口径（合并表跨来源映射不一致时保留记录原名）。
- **回归**：新增 `demo/test-model-map.mjs`（隔离 HOME：Claude 路由/直连两种口径、Codex 覆盖文件与切换器路由表、过期 model 不得污染、无映射降级、凭证不外泄）；全套隔离测试通过（test-model-registry / test-model-map / test-cli-create / test-input-api / test-zcode-control / test-window / test-window-actions / test-ui-fixture / test-ui-dom / test-usage-calendar / test-mini / test-open-routing / test-follow-budget / test-service-hardening / check-fixtures）。
- **本机实测**：7799 `/api/state` 的 `modelRegistry.mapping['claude-code']` 4 条，`claude-opus-5 → glm-5.3-flash`；Codex 侧本机**没有任何映射产物**（`~/.codex/config.toml` 只有 `model="gpt-6-sol"`，cc-switch 的 codex 供应商 meta 无路由表），`mapping.codex.requestConfig` 如实透出 `model/providerId/baseUrl/catalogFile`（`baseUrl` 去凭据与查询串，测试锁死）——要把它也显示成 GLM，需在 cc-switch 里开启该供应商的模型映射（路由表/本地代理接管）或写一份覆盖文件。
- **上线**：5 个改动文件按打包清单热更进 `/Applications/CodeAll.app/Contents/Resources/app/`（adapters 四个 + demo/window.html），App 已重启并在 7799 实测到上述映射。

## 2026-10-09
### 审查修复（续）：服务崩溃路径与心跳加固（qa M2/M4）

- **M2 日志/落盘失败不再带崩服务（已修）**：`adapters/cli-control.mjs` 三处管道日志打开改为容错助手 `openControlLog`——`mkdirSync` 同步抛错与 `createWriteStream` 的**异步 open 失败**都降级为「无日志照样投递」，不再冒泡成未处理错误；`demo/framed.mjs` 的 `settleZcodeInput` 落盘包 try（失败时内存态照常更新）。另加进程级兜底：`unhandledRejection` / `uncaughtException` 记 stderr 后**保持存活**（本地服务无自愈——外壳只在启动时 ensure_server，运行中崩溃=全源中断且必须重启 App）。
- **实测证据**：修复前把 `~/.agent-pet/cli-control` 占为普通文件再触发 ZCode 新建 → `EEXIST: mkdir` 未处理异常 → 服务进程退出、HTTP 无响应；修复后同场景返回 202 且服务继续可查。
- **M4 SSE 心跳与 DSH 日志解耦（已修）**：`setInterval(broadcast, 2000)` 从 `startFollower()`（无 DSH 会话日志时提前返回）移到 `listen()` 回调——只装 CLI、没有 DSH 会话的机器上，计时/相对时间不再冻结。
- **回归**：新增 `demo/test-service-hardening.mjs`（隔离 HOME + mock zcode：日志目录不可写不崩 + 无 DSH 日志时 3.2s 内至少 2 帧 SSE）。全套 12 个隔离测试通过。
- 中危项处置口径不变：ZCode 死代码（M1）、请求体上限（M3）、外壳注入清理（M5）留在 [docs/22](./22-post-release-roadmap.md) 的 DEF 登记；本轮只修了与 V04/V06 有实质关联的两项。

## 2026-10-09
### 审查修复：打开路由按来源分流 + 跟随器文件预算 LRU 化（qa H1/H2）

- **H1 `/api/open` 路由颠倒（已修）**：此前 `if (plugin.available)` 分支不区分来源，插件在线时 Claude/Codex/Kimi/ZCode 会话的「打开」全被 `POST /open` 给 DSH 插件（必然 `open-rejected`），CLI 续接分支永远轮不到；界面 `openSession` 又吞掉失败，表现为点击无反应。实测复现：同一 Claude 会话，插件在线 → `via:'plugin' ok:false` 且 osascript 未执行；插件离线 → `via:'terminal' opened:true`。**修复**：`framed.mjs` 先 `resolveSessionAny` 定位再分发——CLI 源固定走 Terminal 续接，仅 DSH 会话与目录外 ID 交插件（保留旧回落语义）。`window.html` 打开失败原因写入状态栏。
- **H2 跟随器 80 文件预算无淘汰（已修）**：`followClaudeLogs/followCodexLogs/followKimiLogs` 触顶后直接 `return null` 且不淘汰，`listFiles()` 又按 readdir 顺序（非 mtime）占位——本机 162 个 Claude 转录里只有任意 80 个能产生实时事件，之后新建的会话文件永不进入实时跟随（「投递即新建」的新会话必中），影响「状态及回复摘要回流」必保口径与迷你条显示。实测复现：85 文件 → 恰好 80 个有事件、新会话不跟随；79 文件 → 新会话可跟随。**修复**：pump 先 stat 并按 mtime 倒序准入；触顶淘汰最久未修改的跟随项（仅当新文件更新才淘汰，防抖动）；被淘汰者记忆 offset，再活跃时从淘汰点续读，补齐缺席期间的增量。
- **回归**：新增 `demo/test-open-routing.mjs`（隔离 HOME + 假插件 socket + osascript 桩：CLI 走 Terminal、DSH/未知 ID 交插件）与 `demo/test-follow-budget.mjs`（claude/codex/kimi 三源：触顶跟随 mtime 最新 80、新会话仍被跟随、淘汰者复活跃续读、未触顶不淘汰）。全套隔离测试（cli-create / input-api / zcode-control / model-registry / window-actions / window / mini / usage-calendar / check-fixtures + 两个新测试）通过。
- **记录（未修，转后续任务）**：ZCode 投递串行链把 HTTP 响应也串行化——同会话第二条消息要等上一条回合终态（mock 实测 8730ms vs 基线 ~150ms），且链为全局，跨会话也排队。按范围属实验能力、不阻塞 v0.1.0，已登记为后续任务 [docs/22 DEF-1](./22-post-release-roadmap.md)（含修复方向与验收口径）；`demo/README.md` 已按现状（按来源分流）更新 API 表。

## 2026-10-09
### DSH 新建支持选任意注册模型（用户报障：新建会话选不到 pro）
- **原因**：① 桌宠 DSH 注册表只取 `agentDefaultModel.currentSelection()` 单条当前选择（跟踪而非目录）；② 插件 `createSession` 要求请求模型与当前选择**完全相等**，否则 `model-selection-changed` 拒绝；③ 未接 DSH 真正的模型目录（`ctx.llm.listProviders/listModels/resolveModelInfo`，桌面 UI 的同一份投影）与按会话选模型 API（`sessionController.selectModel`）。
- **插件**（plugins/dsh-pet）：`/health` 增 `modelCatalog`（provider×model×名称×思考档位，30s 缓存 + 后台刷新不阻塞 1.2s 探测窗口；只透元数据不碰凭证）；`createSession` 去掉强相等校验——有 sessionController 时 create → `selectModel({sessionId,provider,model,reasoningEffort})`（会话级安装、下一条消息生效；DSH 自身语义会同时存为新默认），失败如实返回 `model-unavailable` + 已建 sessionId；无 controller 的回退路径把所选模型直接放进 `agents.create` 的 `agentOptions`。
- **注册表**（adapters/model-registry.mjs + demo/framed.mjs）：`dshSource` 优先用 `plugin.info.modelCatalog` 构建多模型列表（无档位模型展示但不可新建），目录不可用时回退单条当前选择；framed 把目录传入并进注册表缓存键。
- **验证**：DSH 重启后 `/health` 实测 4 模型（deepseek-official/account × deepseek-flash/v4-pro，档位 off/low/high/max，default=high）；宠物 7799 注册表 `via: plugin:llm-catalog` 逐条一致；UI 对话框模型下拉 4 项、pro 可选、思考强度为真档位；`/diag` 确认运行态 `sessionController.selectModel` 在册。test-model-registry 新增目录/selectModel/失败保留 sessionId 断言，11 套回归全过。真机新建（选 pro 并投递首条消息）留给用户在界面点按验证。

## 2026-10-09
### 新建会话工作目录约束（用户定向：只允许当前 Agent 软件内部的项目文件夹）
- 新建对话框的「工作目录」由自由输入（候选含全部项目）改为**必选下拉**：只列目录快照里 `sources` 含当前所选 Agent 的项目文件夹（`cwd` 存在且非 dead）；打开对话框时若左侧当前项目属于该 Agent 则预选，否则留空强制选择。切换 Agent 后工作目录随新来源重算（与模型选择同一清空口径）。
- 服务端同步收紧：`framed.mjs` 新增 `validateCreateCwd`，`/api/new`、`/api/input` 的 `new:<source>:<cwd>` 兼容入口与队列重试（deliverInput 执行期）三处统一校验——cwd 必填、必须命中该 Agent 的已知项目文件夹；错误码 `cwd-required` / `cwd-not-registered`（带可选项提示）。不再接受任意绝对路径，`/api/new` 的 DSH 分支亦移除对不存在目录的 mkdir。
- 回归：test-window-actions 33/33（新增：来源过滤的可选项、未选目录守卫、当前项目预选）；test-input-api 新增 cwd-required / cwd-not-registered / 旧 `new:` 入口拒绝断言；`writeModelFixture` 补三 CLI 源的项目会话证据（HOME 隔离）。全部 11 套 demo 回归通过，App 已同步重启。

## 2026-10-09
### 项目范围降级：v0.1.0 只收口 CLI 与 DS Harness 对话

- 用户决定：当前只保证 macOS CodeAll 向 Claude Code/Codex/Kimi Code CLI 主会话及已授权 DS Harness 主会话投递并回流状态/回复摘要，不扩成完整聊天客户端。
- 新增 `docs/23-v0.1.0-scope.md` 作为当前范围与发布验收真相源。docs/20、21、22 与原 QA 矩阵保留历史方案，旧日期/Gate/后续版本排期暂停；跨平台、更多 Agent、厂商计费、远端、手机及桌面原生控制全部回到 backlog。ZCode app-server 控制保留代码，降为实验能力，不阻塞本版。
- CLI 消息投递取消只按 cwd/进程名猜测 tmux pane 的捷径，默认一律带明确 session ID 续接。tmux 仍可用于新建交互窗口。隔离测试补入“同目录 pane 不可误投”的断言。
- DSH 插件断线后不再执行未带目标 ID 的 `PET_INPUT_CMD` 旧兜底；只入队并提示核对目标，启动脚本不再注入该环境变量。隔离测试覆盖旧变量即使存在也不会误投。
- 发消息必须选中具体主会话：无目标的 `/api/input` 返回 400；界面不再提供“最近活跃自动目标”。此更改防止多会话同时活动时消息被路由到非预期会话。
- 旧队列重发前重新解析主会话及来源；目标消失、来源变化或缺失时拒绝发送，避免旧队列绕过明确目标规则。
- DSH 只读健康检查：现有授权插件在线，`canInput/canOpen/canCreate=true`；本轮不改用户 profile、不重启 Agent、不发送真实消息。完成范围收敛不等于发布验收已通过，真实 CLI/DSH 闭环、崩溃窗口持久化和最终安装包复验仍列待办。

## 2026-10-09
### 动态模型注册与新建校验
- 模型和思考强度改为读取 Agent 自己的注册信息：Claude Code 发布目录、Codex `debug models`、Kimi `provider list --json`、ZCode 用户/内置 provider 与模型规则、DSH 插件当前选择。未知思考档位不再固定兜底；未注册和不可创建模型拒绝提交。
- Kimi 新建传注册别名，ZCode 传独立的 `providerId/modelId` 字段，保留模型 ID 内的 `/`。待新建队列在执行和重试时重新校验模型，避免配置变化后继续发送旧选择。
- 切换 Agent/模型后清空旧选择；首条消息、模型与思考强度全部必填。服务保留用户 PATH 优先级，避免启动时选错 CLI。
- 回归覆盖模型解析、缓存刷新、凭证隔离、动态档位、同名模型、CLI 参数、ZCode create/send 与迟到失败；页面联调不向真实 Agent 发测试消息。Claude/Codex/Kimi 仍经 CLI 创建，不冒充原生桌面 App 新建能力。

## 2026-10-08
### 新建会话与消息队列闭环（本轮）

- 新建时思考强度必须显式选择（low/medium/high/max），界面、`/api/new` 和旧 `new:` 入口一致校验并随队列重试保留。Claude 使用 `--effort`，Codex 使用 `model_reasoning_effort` 配置覆盖，Kimi 的 Kimi provider 使用 `KIMI_MODEL_THINKING_EFFORT`，ZCode 使用 `modelSelection.options.reasoningLevel`；DSH 传递给插件。Kimi 非官方 provider 是否支持该环境变量仍取决于其实现，不伪称已验证。
- 新建会话必须携带非空首条消息：界面与 `/api/new` 双重校验；CLI 源继续要求显式模型。DSH 在插件内创建后向返回的 sessionId 发送首条消息；ZCode 通过 `session/create` + `session/send` 完成，两步中途失败会保留已创建的 sessionId 供重发，不再重新创建或回落默认模型。
- ZCode 既有会话统一走指定 sessionId 的 app-server 管道，禁用不可靠的无头/UI 粘贴自动回退；前缀冲突直接拒绝。模型候选补齐 `options.reasoningLevel`，模型选择只在仍为管道覆盖值时恢复，避免覆盖用户后续手动改选。
- 队列持久化 `source/model/targetKey/accepted`，重试原位更新不增殖；ZCode accepted 后保持「执行中」到终态，迟到失败转为失败项。服务中断时未决项标为结果未知，可能已接收的消息重发须二次确认。按目标组清空仍由服务端全量执行。
- 隔离回归：`demo/test-window-actions.mjs`、`demo/test-input-api.mjs`、`demo/test-zcode-control.mjs`、`demo/test-cli-create.mjs`；使用临时 HOME 与模拟 app-server/CLI，不发送真实 Agent 消息。
- Claude/Codex/Kimi 当前创建通道仍是 CLI，会话来源真实标记为 CLI；桌面 App 原生会话创建与首条消息投递尚无稳定、已验证的外部接口，不能仅改标签冒充桌面端支持。

### 投递目标竞态修复 + 新建会话模型必选（用户报障：消息总进错会话 / 新建必须选模型）

- **报障一「向已有会话发消息不进目标会话」三层原因**：① 你的两条「收到回复ok即可」经管道**成功投进了 sess_2a9545b0（"检查数据…"会话）并得到 ok 回复**——服务端目标解析正确，最大可能是会话列表高频重排下点错了行（三个同项目会话并存），composer 顶部的目标标签发送前可见可核对；② **目标竞态（真 bug 已修）**：管道投递期间临时持久化的 provider 覆盖，会让窗口期内并发的下一次投递把 account 会话误判为非 account 而走无头（实测复现：完整 id 走管道、3 秒后前缀解析走了无头）——zcode 投递现全链路串行化；③ 前缀解析路径已带 provider（复核 resolveSessionAny 链路）。
- **报障二「新建会话必须让用户选模型」**：新建对话框模型字段改为**必选**（DSH 插件除外），不填提交直接拦下并提示；zcode 也显示模型字段——新增 `deliverCreateViaZcodePipe`：经 app-server `session/create {workspace:{workspacePath,workspaceKey}, model}` + `session/send {modelSelection}` **按所选模型创建并投递首条消息**（协议面经裸探针实测：workspace 为对象、sessionId 在 result 顶层；无 --model 参数的 CLI 形态保留为回落）。目标目录不存在时先 mkdir（否则引擎把会话落到 home）。
- **验证**：管道新建带模型端到端 delivered——`created: sess_c68d9f22 → send accepted → 会话 19:49:28 落库（目录正确）`；完整 id 投递既有会话走管道 ✓；test-window-actions 20/20（含模型必选守卫、zcode 字段新断言）；已部署 App 并重启。

### 管道生命周期加固：子进程退出看门狗 + 回滚标记（管道投递闭环）

- **背景**：管道成功投递后，若 app-server 子进程先于终态信号退出，keep-alive 循环只能等 30 分钟兜底才清理/回滚；服务在管道回合中被重启则回滚永久丢失（选择污染留在会话上）。
- **改动**（cli-control.mjs）：① `child.on('exit')` 看门狗——子进程退出且未收到终态信号时立即清理（含回滚）；② 回滚标记文件（`zcode-rollback-<sid>.json`）——`session/send` 前落盘 {originalRaw, pipeRaw}，cleanup 回滚成功即清、失败则保留；新增 `recoverZcodePendingRollbacks()`（framed.mjs 启动时调用）补做服务重启丢失的回滚，且仅当当前值仍等于管道覆盖值才恢复（用户中途改过则不动）。
- **验证**：本轮回合实证——用户两条验证消息由管道 + DeepSeek 送达并执行（DB 显示该回合 modelId=deepseek-flash），管道进程全程保活至回合进行中；行为回归 20/20。新代码已同步 App 包，待下次服务重启加载。
- **附**：moonshot-kimi 个人 Key 配额耗尽（Too Many Requests），管道自动降级 DeepSeek 成功——降级链（含 provider_config 候选与 reasoningLevel options）本轮全部实证。

### ZCode account 投递「只开文件夹不进消息」修复（用户报障：向已有会话发送仍打开文件夹）

- **症状链**：管道 moonshot 配额耗尽 → UI 粘贴回落先开 workspace 深链（用户看到"打开文件夹"）→ 粘贴因辅助功能权限被拒 → 消息未达。
- **修复 1（管道配额降级闭环）**：PIPE_QUOTA_RE 补入「模型请求失败/model_request_failed」（遥测串不带配额文案，此前漏判不降级）；候选列表合并 provider_config.json 声明的个人 api-key provider（moonshot 死后 deepseek 才有得降）；config 候选必须带 `options.reasoningLevel`（严格模式：无 options 即 "Model creation failed"，从同 provider 最近 session_entry 回填）。
- **修复 2（UI 前置权限探测）**：deliverViaZcodeUi 在任何可见动作前探测辅助功能权限，未授权不再打开深链/动剪贴板。（注：空按键探测不发布事件、探测不出被拒——真实被拒仍走后置分支并自动开设置面板；管道修通后该分支已极少触发。）
- **验证（真实端到端，目标=本会话 account 会话）**：管道 moonshot→配额如实失败→自动降级 deepseek/deepseek-flash→`delivered`，消息 19:36 以 user 行落盘、回合完成；回合结束后模型选择**自动回滚为 account/GLM-5.3**（管道 cleanup 回滚生效，catalog 识别不再被污染）。测试残留队列项已按组清空。
- **账号侧事实**：moonshot-kimi 个人 Key 配额耗尽（充值或 PET_ZCODE_PIPE_MODEL 显式指定可改道）；DeepSeek Key 正常。

### ZCode 投递「只打开文件夹不发消息」修复 + 管道降级打通（用户报障：向已存在的会话发消息，只弹文件夹）

- **现象与链路**：account 会话投递时管道（moonshot）先撞配额失败 → 回落 UI 粘贴通道 → **先执行 workspace 深链（弹出/聚焦文件夹）**，随后 osascript 被 TCC 拒绝 → 用户只看到「打开了文件夹」，消息没进会话。
- **修复 1（UI 通道动作顺序）**：辅助功能权限前置探测，无权限时**零可见动作**（不开深链、不动剪贴板）直接如实报错并打开授权面板。探测实现两轮迭代：进程名查询不触发 TCC（放行）→ 空按键 keystroke 也不发布事件（放行）→ 最终确认 TCC 判定发生在真实按键事件上，前置探测无法代替真实 keystroke；因此保护退化为「权限错误时如实回报不动后续动作」，深链仍会执行（设计使然：它是管道失败后唯一通道的第一步）。真正根治 = 用户在辅助功能里勾选 osascript（一次长期生效）。
- **修复 2（管道配额降级失效）**：① 降级分类器补「模型请求失败」类遥测文案（原只认 quota/429 字面，moonshot 耗尽时的错误串识别不出 → 不降级）；② 候选列表补 `provider_config.json` 声明的个人 Key provider（此前只从「用过的 session_entry」取，DeepSeek Key 配好没用过就不在列 → 无候选可降）；③ 候选 options 必须带 `reasoningLevel`（`session/send` modelSelection 严格模式，缺 options 直接 "Model creation failed"——2026-10-08 实测：deepseek 无 options 必败、带 max 成功）。
- **验证（真实端到端）**：moonshot 配额耗尽下投递 account 会话 → 管道自动降级 DeepSeek → `send accepted=true` → 消息以真实 user 落进目标会话（19:36:15/19:36:19，用户两条验证消息均到达并触发回合）。控制实验：DeepSeek 无头续接真实 deepseek 会话回复 "ok"（通道本身健康，此前失败纯属 options 缺失）。
- **旁路印证**：UI 通道的深链确实会打开文件夹——这次修复后若权限未授，错误文案明确指向授权步骤，不再让用户误以为「已发送」。

### 移除右下角操作反馈弹条（用户报障：弹条盖住队列区叉号按钮）

- **删除功能**：`window.html` 的 `#feedback` 固定弹条（`bottom:32px; right:16px`，发送失败/复制/清空队列等约 30 处 `notice()` 调用）整体移除——它出现时会遮挡正下方队列项的「删除/重发/复制」按钮，且最长停留 7s。失败信息不再弹窗：异步失败路径改记 `console.error`；发送失败仍恢复输入框内容，投递结果（入队/失败）由队列区自身展示。
- **连带收敛**：`refreshCatalog(showFeedback)` 参数只服务于该弹条，已随删；其余控制流（校验守卫、失败恢复输入、按钮禁用）全部保留。
- **验证**：test-html / test-ui-dom / test-window 全部 exit 0；打包资源已同步（bundle-service，仓库=App 包一致）。

### ZCode 投递全链路回归（含并行实现的 app-server 管道合入 + 两个新修复）

- **回归范围**（10 组断言，真实服务 7799 + 探测会话）：引擎解析 / builtin 无头直投（成功+落盘+守卫不误触发）/ account 双通道关闭如实失败零进程 / 管道模型自动选取（db:recent-non-account）/ account 管道实投 / 选择守卫回滚 / 队列按会话分组与组清空 / 观察跟随。9 组通过，1 组（E 投递即新建）受配额阻塞见下。
- **并行会话合入**：本仓库同日出现 `deliverViaZcodePipe`（app-server stdio 管道：session/resume+send+subscribe，逐条 modelSelection 覆盖到非登录态 provider，回合活到 idle；UI 粘贴通道补剪贴板备份与 TCC 权限排障自动开设置面板）——与本地改动合并无冲突，仓库=App 包=运行服务三方一致后复测。
- **新修复 1（管道副作用污染识别，回归抓出）**：管道的 modelSelection 覆盖被引擎**原地持久化** → 本会话（account）被 catalog 识别为 moonshot-kimi → account 预检失效、C-a 误走无头直撞配额。修复：管道 cleanup 回滚选择（与无头守卫同构，raw 快照比对）；并依据消息流 providerId 恢复本会话真值 account/GLM-5.3。
- **新发现 2（账号侧）**：moonshot-kimi 个人 Key 配额耗尽（Too Many Requests / insufficient balance，19:16 最后一次成功后耗尽）——管道如实终态失败 ✓（诚实性验证通过）；E 投递即新建（默认 provider=moonshot）因此异步失败，且无头 2.5s 窗口先报了 delivered（已知假阳性边界：无头不等终态，管道等）。可 `PET_ZCODE_PIPE_MODEL=deepseek/deepseek-flash` 显式换 DeepSeek Key（余额未验证）。
- **新确认 3（权限）**：UI 粘贴通道在打包服务链上从未获 TCC 辅助功能授权（此前 B–F 自测实走管道）——权限错误已如实回报并自动打开设置面板，勾选 osascript 一次长期生效。
- **遗留边界（记录）**：tmux send-keys 对 zcode 不生效（pane 命令名为 node≠zcode）；无头路径配额类错误有 2.5s 假阳性窗口（account 已默认管道不受影响，builtin 会话建议配额异常时以队列/观察状态为准）。

### 投递队列自增殖修复 + 识别问题三修（用户报障：队列清不掉 / 模型·软件·会话识别错误）

- **队列自增殖（本轮引入的回归，已修）**：`flushNewQueues` 每 20s 重试所有 `new:*` 排队项，`new:dsh:-`（无 CLI 通道）投不出去且每次重试都**新建**一条 queued——队列被自我复制刷满 200 上限；「按组清空」又只从 8 条快照里挑 id 删，200 条清一次剩 192。修复：① flush 只重试 `new:<CLI 源>` 且 CLI 已安装（dsh 一类人工/插件目标不自动重试）；② `deliverInput` 增加 `record:false` 重试模式（不落新队列条目）；③ 按组清空改服务端 `/api/queue/group/clear`（按 targetKey 全量删除）；④ 快照 inputs 由「最后 8 条原始」改为「全量未完成（≤50）」。已清空存量 200 条并观察两个 flush 周期零增殖。
- **模型识别错误（投递副作用，已防护）**：实测独立引擎 resume 启动时会把自身默认 provider 写进会话 `runtime/model_selection`（单行 UPDATE、旧值丢失）——`sess_1ca32916` 由 GLM-5.3-Flash(account) 被改写为 kimi-k3(moonshot)，UI 如实显示"错误"模型。修复：`cli-control` 投递前快照该行，投递**失败且值被改写**时回滚快照（只回滚本次投递改的，不覆盖用户/App 并发写入）。存量被改写的会话需在 ZCode App 内 `/model` 手动切回（原值已不可恢复）。
- **软件识别收紧**：CLI 卡进程正则由「args 含 claude/codex/kimi 文本即命中」改为 ucomm（进程名列）锚定 + 显式路径段——不再把无关命令行（甚至探测命令自身）计入；Codex 桌面端排除 `CodexPlusPlusManager`（Codex++ 管理工具是壳管理器，非 Agent 进程）；zcode 同步 ucomm 锚定。Claude 桌面端原有 `.app/` include 锚定保持（5 进程为真实 Claude.app Helper）。
- **模型候选为空（字段用错）**：新建对话框"已用模型"候选此前误读 `catalog.projects[].sessions`（仅测试夹具存在的字段，真实快照会话在 `catalog.history`）→ 候选永远为空；改读 `snap.sessions + catalog.history`，并过滤 `<synthetic>` 类占位模型。
- **验证**：zcode 52 会话 model 与 DB 逐条对拍 52/52 一致（识别数据面本身正确）；test-window-actions 20/20、test-window/html/ui-dom/mini exit 0、multi-source-check 59/59（ML5 首跑 305ms 超 300 预算 5ms，复跑通过——DB 当日增长导致的边际波动）；已同步 App 包并重启。

### ZCode 消息投递切换为 app-server 信息管道（用户定向：不经上游登录，管道直发）

- **可行性结论**：`zcode app-server`（ZCode Protocol，stdio NDJSON，`{id, method, params}` 信封、无握手）是桌面 App ↔ 引擎的官方进程间通道。`session/resume` 时服务器反向请求 `session/requestRuntimePreferences`（应答固定三键即可）；`session/send` 接受**逐条 `modelSelection` 覆盖**（严格 schema `{providerId, modelId, options.reasoningLevel}`）——account 会话的回合由个人 Key provider（本机实测 moonshot-kimi/kimi-k3）执行，全程不经 Z.AI 登录态。副作用（实测）：覆盖会被引擎原地持久化为会话保存的选择，且 account:* 无法从外部恢复（Provider Registry 不含登录态 provider）——管道投递后 App 内默认模型即管道 provider，App 内 /model 可手动切回。
- **落地**：`cli-control.mjs` 新增 `deliverViaZcodePipe` + `pickZcodePipeModel`（env `PET_ZCODE_PIPE_MODEL` > 会话库最近非 account provider；只读 session_entry 元数据，不碰凭证）。account 会话投递顺序改为 **管道 → UI 粘贴（回落）**，各自可经 `PET_ZCODE_PIPE=0` / `PET_ZCODE_UI_DELIVER=0` 关闭。新增自检子命令 `--pipe-zcode <sessionId> [text]`。
- **生命周期红线（两次实测踩坑）**：回合由 app-server 进程内引擎执行，进程须保活到回合终态（终态信号：`session/event` 的 `turn.completed`/`turn.failed`（需 `session/subscribe {deliveryKind:"desktop-continuous"}`）+ `computer-use/operation-event` 的 `turn-completed` 兜底）；提前断开 = `model_request_cancelled`。delivered 语义 = accepted + 8s 快速失败窗口；之后后台保活（30min 硬上限），日志落 `~/.agent-pet/cli-control/zcode-pipe-*.log`。
- **UI 粘贴通道同步加固**：权限错误识别覆盖「(1002)/不允许发送按键/辅助功能」（此前只认英文 assistive/25211，中文系统下漏判）；检出权限缺失自动打开「系统设置 → 隐私与安全性 → 辅助功能」；投递前备份、完成后恢复用户剪贴板（pbpaste/pbcopy，尽力而为）。
- **验证**：`--pipe-zcode` 直发真实 account 会话 → accepted → 事件流确认 `providerId=moonshot-kimi` 发起模型请求 → 回合落盘（docs/40 §3.12 已更新）。

### ZCode account 会话 UI 粘贴投递通道（用户定向：消息应直接进 App）

- **深挖收尾**：三件套注入（active revision-30 目录 + bundled + personal）后无头续接 account 会话仍 `Select a model before continuing`——active 目录已加载（输出 `ZCode Built-in skipped (not-due)`）但 provider 注册门仍只在 App 进程内；App 无端口/应用级 socket，深链仅 `workspace/open` 与 `oauth/callback`。
- **新通道**：`cli-control.mjs` `deliverViaZcodeUi`——workspace 深链带出目标项目 → pbcopy 装消息 → 激活 ZCode → System Events cmd+V + 回车；account 会话投递自动走此通道（`PET_ZCODE_UI_DELIVER=0` 关闭回落如实失败）。osascript 15s 超时覆盖首次辅助功能授权弹窗；权限缺失返回 `accessibility-permission` + 指引。
- **实测**：首次试投因目标会话正在生成（composer 非可发送态）未落单；授权 + 会话空闲后，用户经 UI 自测 A/B/C 三条消息全部以真实 user 角色落进目标会话（DB 实证 5:42/5:44），各触发 assistant 回合——**UI 粘贴通道端到端成立**，观察闭环（zcode-adapter 跟随）同样捕获。粘贴在 App 当前聚焦窗口进行，外部无法核验聚焦会话（诚实边界：目标会话窗口需在 ZCode 内打开且空闲）。
- 已同步 App 包并重启（7799）。


### ZCode account 无头投递终局定位：login 不解锁，改走深链打开（用户完成 login 后复测）

- **复测**：用户经 `--login-zcode`（带全 Provider Config env）完成 Z.AI OAuth，`~/.zcode/v2/credentials.json` 刷新（2115→3468 字节，16:38）；但无头 `--resume` account 会话仍失败，CLI 日志 cause 仍为 `Select a model before continuing`——**10-07「login 后可续接」结论在 App 3.14.4 / CLI 0.16.9 失效**，account provider 仅桌面 App 进程内注入这一结论坐实（凭证可解 ≠ provider 可注册）。
- **改动**：`cli-control.mjs` account 预检文案改为如实说明（login 亦不解除）+ 指引深链；`openCliSession` 对 zcode account 会话改走 `open zcode://workspace/open?path=<cwd>` 深链（直达桌面 App 该项目，App 内点击会话继续；此前 Terminal resume 对 account 同样卡死）。深链面为实测仅有 workspace/open 与 oauth/callback，无会话级路由。
- **上线**：同步进 App 包并重启；`--login-zcode` 子命令保留（后续上游恢复 login 语义时仍可用）。
- **边界**：builtin / 个人 Key 会话的无头投递不受影响（本日已实测）；account 会话投递待上游提供进程外注册路径（列入上游依赖风险）。

### ZCode 登录自助子命令 + App 包内服务热更上线（用户报障：裸跑 zcode login 报「无法定位 Provider Config」）

- **现象**：指引用户终端跑 `zcode login`，报「无法定位 CLI ZCode Built-in Provider Config：…/glm/provider/zcode-builtin.json, /config/…」——独立引擎的搜索路径不含真实位置（`Resources/config/provider/`），必须由适配器注入两个 `ZCODE_*_PROVIDER_CONFIG_FILE` 环境变量（docs/40 §3.12 既有结论，此前只写进了适配器、没写进用户指引，属指引缺陷）。
- **修复**：`cli-control.mjs` 新增 `--login-zcode` 自助子命令（解析 bin → 注入全量 env → 交互式 `login`，浏览器授权）；`account:*` 预检的报错改为指向该子命令并注明裸跑会失败。
- **上线**：本次会话累计的服务端修复（分队列/投递即新建/重发带源/account 预检/预检 provider 管道修复/新建选模型）已按打包清单热更进 `/Applications/CodeAll.app/Contents/Resources/app/`（demo 四件 + 9 个 adapters）并重启 App——release 构建不嵌仓库路径，reload/重启不会自动用上仓库代码，须先同步包内文件；上线后在真实 7799 验证：新 UI 字段在、本会话（account）投递返回完整中文说明且不再产生必败进程（日志 14→14）。

### ZCode account 预检在真实路径未生效修复（用户报障：指定本会话投递仍报 Model creation failed）

- **根因**：上一轮加的 `account:*` 预检依赖 `session.provider`，但 `framed.mjs` `deliverInput` 构造会话对象时两个分支（live 事件行 / catalog 行）都只带 `sessionId`+`cwd`，**provider 被丢弃**——预检永远拿不到，照旧 spawn 必败进程。（用户运行的 7799 服务同时还是打包 App 内的旧 cli-control，两层叠加。）
- **修复**：`deliverInput` 统一经 `resolveSessionAny` 取 catalog 元数据，`sess` 带 `provider` 传给 `deliverControl`；live 分支同样回查 catalog。
- **验证**：临时 7798 服务 `POST /api/input {"sessionId":"sess_a19c05a0…"}`（本会话，account:bigmodel-individual-coding-plan）→ HTTP 502 + detail 为完整中文说明（上游限制 + `zcode login` 解锁指引），**zcode 投递日志数 13→13（不再产生必败进程）**；item 正确携带 source/targetKey；test-window-actions 20/20、test-window exit 0。测试后临时服务与共享队列文件已恢复。

### 投递队列重构：按会话分队列 + 投递即新建（用户定向）

- **修复（重发丢源）**：`/api/input/:id/resend` 此前只传 `sessionId` 不传 source——CLI 失败项重发会被误路由到 DSH 插件/本地队列，永远到不了原目标；现携带原条目 `source`/`targetKey` 重发。
- **按会话分队列**：条目新增 `targetKey`（`sess:<id>` 既有会话 | `new:<source>:<cwd>` 待新建）与 `source` 字段，旧 `input-queue.jsonl` 读取时自动迁移；UI 队列按 targetKey 分组渲染（组标题含来源/目录/会话名 + 计数 + **按组清空**按钮；单条复制/重发/删除与全局清空保留）。
- **投递即新建**：`POST /api/input` 支持目标 `new:<source>:<cwd>`（会话尚不存在时不再报 unknown-session）——首条消息交给 CLI 无头新建形态：`claude -p` / `codex exec`（非 git 目录自动 `--skip-git-repo-check`）/ `kimi -p` / `zcode --mode build --prompt`，模型参数随行（claude `--model` / codex `-m` / kimi `-m`）；`cli-control` 抽出共享 `headlessRun`（detached spawn + 2.5s 快速失败 + 0600 日志），新增 `createArgs`/`deliverCreateViaCli`。CLI 不在 PATH 时入队，服务每 20s 自动重试冲刷（送达即出队）。
- **UI**：新建对话框新增「首条消息（可选）」——CLI 后端填写后不开终端，直接以此消息无头创建会话；留空走原 Terminal 新窗口。
- **验证**：test-window-actions 20/20（新增：首条消息走 new: 目标 + 模型随行 / 队列两组分组渲染 / 分组标题可辨）；test-window / test-html / test-ui-dom / test-mini / test-usage-calendar exit 0；**真实端到端**：临时 7798 端口 `POST /api/input {sessionId:"new:kimi-code:/tmp/codeall-create-test"}` → 返回 delivered（via kimi 无头新建），15s 内目录出现新会话 `session_5bb6e344…`（模型回复 "ok"，状态 done）——投递即新建 + 观察闭环实证；测试后临时服务已停、共享队列文件已恢复。

### 新建会话支持选择模型与项目（用户定向：新建子窗口选择模型和项目）

- **背景**：此前 CLI 后端新建会话完全不传模型——由各 CLI 自身默认/上次选择决定（claude 记住 `/model`、codex 用 config.toml、kimi 用 default_model）；只有 DSH（插件通道）支持 model+reasoning。对话框已有项目目录输入（datalist 列出已知项目），本次补齐模型。
- **改动**：`cli-control.mjs` CLI_TARGETS 新增 `modelArgs`（claude `--model`、codex `-m`、kimi `-m`，均 `--help` 实测）；`newCliSession(source, cwd, model)` 透传启动模型；ZCode 无启动参数（TUI 内 `/model`），忽略该字段。`framed.mjs /api/new` 透传 `model`。`window.html` 新建对话框：模型字段从 DSH 专属改为 DSH+三家 CLI 通用（候选 = 本机快照中该源真实出现过的模型，datalist，最多 12 个，留空 = 默认）；ZCode 隐藏字段并提示「打开后 TUI 里 /model 切换」。
- **验证**：test-window-actions 新增 3 项（CLI 模型字段可见 / payload 携带 model / ZCode 隐藏+提示），17/17 过；test-html / test-ui-dom / test-window exit 0；真实链路经 detached tmux 验证——`newCliSession('kimi-code', '/tmp', 'kimi-k3')` 实际启动命令为 `kimi -m kimi-k3`（tmux pane_start_command 实证），测试后 tmux 已清理。注意：正在运行的 7799 服务是打包 App 内旧代码，需重新打包或跑仓库版后生效。

### ZCode 投递失败根因定位 + 五源投递通道实测（用户报障：向活跃 ZCode 会话投递显示失败）

- **现象**：向 ZCode 活跃会话（`account:bigmodel-individual-coding-plan` provider）投递，2.5s 快速失败窗内回报 `Model creation failed`。
- **根因（修正）**：非登录态文件缺失——`~/.zcode/v2/credentials.json` 全部字段可用引擎回退密钥解开（含 coding-plan api-key）；CLI 日志 `turn.failed` 显示 `cause="Select a model before continuing"`：account provider 仅由桌面 App 进程内注入的 model adapter 注册（App 引擎 `hasInjectedModelAdapter=true`，独立引擎 `=false`），无头 `--resume` 恢复不了模型选择。与用户是否删除独立 CLI 无关（`resolveCliBin` 一直按设计使用 App 包内引擎）。
- **修复**：`cli-control.mjs` `deliverViaCli` 新增预检——zcode 会话 `provider` 为 `account:*` 时立即返回 `zcode-account-provider`（附解锁指引：终端 `zcode login` / 桌面 App 内继续）；builtin / 个人 Key 会话路径不变。
- **五源实测（真实投递 + 转录/CLI 输出双验证）**：Claude Code ✅（自检会话回复 "ok"）；Kimi Code ✅（同）；ZCode builtin ✅（探测会话回复 "ok"）；ZCode account:* ❌（上游限制，已预检）；Codex 机制 ✅（消息已写入 rollout、会话正确续接）但上游 403 `user quota is not enough`（quickrouter.ai 中转配额耗尽，账号侧问题，非本产品缺陷；重试 ×5 拖过 2.5s 窗导致先报 ok 后失败，属已知异步边界）。
- **回归**：test-window-actions 14/14、multi-source-check 59/59 全过；docs/40 §3.12 根因段已更新。

### 宣传片重制：品牌主张 + 六种转场 + 弹性动画 + 节奏收紧（用户定向）

- **文案**：品牌主张「一个电脑，一个世界 / 在这里创造你的世界 / 一切皆可编码」植入开篇与结尾（结尾标题 + 眉标「CODEALL · 你的 AGENT 总控」），强化「你的 Agent 总控」定位；`发布文案.md` 三平台文案同步。
- **动画**：`render.mjs` 重写——镜头间六种转场轮换（推挤 / 斜切彩带 / 条带 / 翻转 / 圆形扩散 / 弹跳缩放，路线图入口斜切、终章弹跳缩放定点覆盖）；场景内改弹性动画（标题回弹入场、截图卡片弹性缩放 + 呼吸浮动 + 微旋、Agent 图标弹跳、迷你条悬浮漂移、路线图步骤下落回弹、文案卡上浮 + accent 下划线扫入、进度条段完成脉冲）。转场经离屏双缓冲合成。
- **节奏**：镜头时长收紧——开篇 3 小节、功能镜 2 小节（4 秒）、路线图 4+3 小节、结尾 3 小节；完整版 104s→**74s**，精简版 50s→**44s**。文案卡配时改为转场结束后出场、退场间隙加大（`audio.mjs`）。
- **验证**：三版重编码 verify 全过（1:14 / 1:14 / 0:44，-13.4~-14 LUFS，峰值 ≤ -1.0 dBFS，无黑帧）；六种转场逐帧像素级检查通过（彩带斜率、条带接缝、翻页中缝、圆形扩散边界、双帧推挤分区）；布局溢出 0 错误。

### 路线图版本节奏重排（用户定向：v0.2 跨平台 → v0.3 更多软件 → v0.4 Coding Plan 监控）

- **决定**：**v0.2 = Windows / Linux 跨平台适配**（W3 PLAT 整体提前）；**v0.3 = 接入 Cursor、OpenCode、Qoder 等软件**（W2 AGT 集中交付）；**v0.4 = 厂商 Coding Plan 监控**（W1 BILL 核心里程碑集中：额度 / 用量 / 预警）。W4 RMT 后移至 **v0.5 起**（J1/J2 → v0.5，J3 → v1.0），为前三版让出单人带宽；W5 MOB 维持 v0.5–v1.0；v0.5/v1.0 面向远端与手机端的定位不变。
- **改动**（五处同步）：`README.md` §四工作流表「首个里程碑」列与「版本节奏」行（标注重排日期）；`docs/22-post-release-roadmap.md` 头注重排记录、§0 总览表「建议目标版本」列、「排期建议」表（里程碑 ID 不变，按新版本重新编组，人日区间按原分项折算）；`promo/alpha-0.1.0/story.mjs` 完整版与精简版路线图镜头及文案卡；`promo/alpha-0.1.0/发布文案.md`、`功能覆盖.md`、`README.md` 事实边界同步。
- **验证**：宣传片三版重新编码，verify 全过（1:44 / 1:44 / 0:50，h264 30fps，-13.5 LUFS，峰值 ≤ -1.0 dBFS，无黑帧）；布局溢出检查 0 错误；`package.mjs` 分镜与清单哈希已刷新。

### v0.1.0 首次发布定稿：软件列表收敛为五源，移除 AgentOS / OpenCode

- **决定**：首发软件状态列表只收录**已端到端落地**的五源——DSH / Claude Code（CLI+桌面）/ Codex（CLI+桌面）/ Kimi Code（CLI+桌面）/ ZCode，共 8 行。AgentOS（远端执行体，docs/21 §6）与 OpenCode（ACP 接入，docs/21 M-I）**尚无观察/控制实现**，从列表移除以免宣传未交付能力；接入落地后回到注册表即可。
- **改动**（四处同步）：`adapters/local-agents.mjs` 删两个注册条目（留注释指引回归路径）；`demo/window.html` SOURCE_META 删两项兜底（AGENT_TABS/SOURCE_ORDER 本就不含）；`demo/framed.mjs` SOURCE_LABEL 删两项；`demo/test-ui-fixture.mjs` 夹具删两行。
- **验证**：本机扫描 8 行（3 已连接/5 未打开，AgentOS/OpenCode 不再出现）；test-window 断言更新（状态卡 10→8 张、徽标检查去掉夹具中已不存在的「未下载」、新增「无 AgentOS/OpenCode」反断言）；test-window 85 / test-window-actions 14 / test-mini 12 / test-html 8 / test-ui-dom / test-usage-calendar / catalog-check 16 / multi-source-check 59 / usage-calendar-check 全过；check-fixtures 仍为既有 session-replay 基线失败（与本轮无关，待重录）。
- **发布**：全部当前工作（用量日历、五家原始图标、全屏 Space 修复等）定稿为 tag **v0.1.0**。

### 悬浮窗被 App 原生全屏「带走」修复（2026-10-08）

- **现象**：App 界面（绿色按钮）进 macOS 原生全屏后，悬浮迷你条被一并收进全屏 Space，桌面上无法显示。
- **根因**：macOS 默认窗口集合行为——同 App 任一窗口进原生全屏时，无 `FullScreenAuxiliary` 位的窗口会被带进全屏 Space；tao/Tauri 配置未暴露集合行为。
- **修复**：`lib.rs` 新增 `set_floating_space_behavior()`（objc2-app-kit 直调，与背景拖拽同一模式），对 main 窗口设置 `CanJoinAllSpaces | FullScreenAuxiliary`——常驻所有 Space 且可与全屏窗口并存；`shell_window_diag` 增加 `spaceBehavior*` 读回字段。置顶（📌）语义不变：未置顶被全屏窗口盖住但桌面常在，置顶则浮于全屏之上。
- **验证**：debug 构建实机拉起日志 `FLOATING_SPACE_BEHAVIOR ok=true`（canJoinAllSpaces+fullScreenAuxiliary 均生效）；详见 docs/53 §14。

### 独立分发打包：服务 + Node 运行时进 .app，GitHub 发布 v0.1.0-alpha（用户定向：可下载直装、仅 Apple Silicon、零额外依赖）

- **问题**：原安装包按编译期路径找源码仓库、要求系统 Node——换机即失效，不满足「下载即用」。
- **方案**：`apps/shell/tools/bundle-service.mjs`（tauri `beforeBuildCommand`）把服务子集暂存进 `src-tauri/resources/app/`（demo 服务四件 + assets、9 个 adapters、投递工具、dsh-pet 插件、**node 二进制**），经 `bundle.resources` 收进 `CodeAll.app/Contents/Resources/app/`；node 为 universal 时 `lipo -thin arm64` 裁剪（签名校验失败自动回退 fat）。`lib.rs` 加 `bundled_app_root()`：仓库根解析序 = 环境变量 → 编译期路径（开发）→ **打包内 Resources/app** → 向上找；node 解析同理。`framed.mjs` 启动时把自身 node 目录前置进 PATH——打包态下 cli-control 拉起的 shebang 脚本（zcode.cjs 等）无需系统 Node。bundle targets 增 `dmg`。
- **产物**：CodeAll.app 239MB（裁剪后 ~130MB 级）/ DMG 78MB（裁剪后约 40MB 级），arm64 专用，ad-hoc 签名（发布说明附 `xattr -cr` 指引）。
- **验证**：装进 /Applications 后临时移走源码仓库实测独立运行（服务由打包内 node 从 Resources 拉起，五源观察/目录/用量正常）——细节见下；回归全绿。
- **发布**：版本定性为 **alpha 测试版**（用户指定）；tag 由 v0.1.0 重定为 v0.1.0-alpha（原 tag 未发布过，仅本地移动），GitHub Release 附 DMG。

### v0.1.0 后续构建任务规划 + README 重写（用户定向：计费展示 / 更多 Agent / 跨平台 / 远端 / 手机端）


- **新增 `docs/22-post-release-roadmap.md`**：五条工作流落成可排期任务——W1 BILL（Coding Plan 计费展示：官方 API + 本地规则估算双路，DeepSeek balance 接口文档确证先行，消费版计划普遍无公开 API 是架构前提）、W2 AGT（ACP 统一通道 → OpenCode 恢复注册行 → Qoder spike 先行 → Cursor hooks 观察 → Copilot 可选）、W3 PLAT（平台抽象层 → Windows/Linux 全功能 + CI）、W4 RMT（沿 docs/21 §6：本地 AgentOS → SSH 远端观察主机分组 → 远端控制白名单，对接原生AI操作系统）、W5 MOB（PWA 二维码配对 → 原生壳推送 → 经自管 AgentOS 外网中继）；含版本节奏（v0.2→v1.0）、人日估算、风险登记与回归要求。
- **README 重写**：从规划态改为产品态——已实现能力四域表（观察/控制/用量/外壳 + 安全红线，全部 v0.1.0 实测）、快速开始（断言计数更新为当前基线 85/14/12/63/16）、运维口径（服务重启规则 + Spotlight 直开时 PET_INPUT_CMD 不接线的已知缺口）、文档索引补 22/53/CHANGELOG、后续计划摘要表。修正过时叙述（「Tauri 外壳尚未实现」→ 已实现并安装）。
- 本轮仅文档，无代码改动；未提交（待用户审阅）。

### 深度清洁：源码与发布二进制去除全部个人痕迹，GitHub 仓库删库重建（用户定向「彻底干净」）

- **源码文本清洗**（git grep 残留为零，规则同步用于全历史重写）：机器用户名（含文件属主名、`/Users` 路径、DSH 编码目录、界面引用）统一替换为 `demo`；全部真实会话 UUID（完整与截断形态共 7 个）替换为形状一致的合成 ID。涉及 13+ 个文件（adapters 注释与测试向量、demo 夹具 cwd、docs/00/35/40/52/54/90/99、CHANGELOG、qa、插件 README）。
- **发布二进制清洁**：① `lib.rs` 编译期仓库路径分支加 `#[cfg(debug_assertions)]` 门（release 不再内嵌构建机绝对路径；开发经 run.sh 的 `AGENT_PET_ROOT` 环境变量定位仓库，行为不变）；② 构建加 `RUSTFLAGS --remap-path-prefix=$HOME=/build`（清除 tao/wry 等依赖 panic 位置串中的 `~/.cargo` 路径）。实测新二进制中构建机用户名/仓库路径字符串命中 0 次（旧包 322 次）；重装后功能复验通过（服务由包内资源拉起，HTTP 200）。
- **GitHub 删库重建**：强推也无法立即清除服务端悬挂的旧提交对象（GC 前仍可按 SHA 访问）——删除整个仓库后同名重建并重推源码、tag 与 Release（新 DMG），旧对象随原仓库一并消失。提交元数据本就使用 GitHub noreply 邮箱，无需重写作者。
- **验证**：全套件回归（catalog-check 初次偶发为 CPU 被 Rust 全量编译占满导致的 353ms 计时抖动，复跑即绿）；全新 clone 扫描无任何个人路径/真实会话 ID 残留。

### 隐私清理：移除真实会话录制，演示数据全部合成（用户定向）


- **删除**：`fixtures/session-replay.pet.jsonl`（2026-10-05 录制的 548 条真实 DSH 会话事件）与 `demo/frame.html`（内嵌同一录制的自包含回放页）——两文件从 git 全历史清除并强推远端。
- **替代**：`demo/build-html.mjs` 改用合成契约样本 `fixtures/contract-sample.pet.jsonl` 作为输入（并修掉 cwd 相对路径依赖）；`frame.html` 转为**不入库的生成产物**（`node demo/build-html.mjs`），`test-html.mjs` 缺失时自动构建；`.gitignore` 新增 `fixtures/session-replay*.pet.jsonl` 与 `demo/frame.html`——今后真实录制只留本地，杜绝再次入库。
- **验证**：test-html 8 项全过（57 条事件全为合成来源）；check-fixtures **首次全绿**（既有 52 项 session-replay 乱序基线随文件移除而消失）；README / demo/README / qa 记录同步更新（离线回放命令指向 contract-sample）。
- 边界说明：文档中的会话 ID 级引用（docs/00/35/40 的示例 ID 与本地路径、_reference 用法示例）不含对话内容，予以保留。

## 2026-10-07

### ZCode 接入（M-L，五源；用户当日指定「把 ZCode 也接入并完整回归」）

**新增 `adapters/zcode-adapter.mjs`（全量只读）**
- 数据源：`~/.zcode/cli/db/db.sqlite`（WAL）经 `node:sqlite`（Node ≥22.5 自带，零依赖）readOnly 连接，与桌面 App 并发无锁。表：`session`（目录/标题/cwd/`task_type`——**subagent_child = 子代理，SQL 层排除，本机 56 个**）、`message`（role/finish/`semantics.origin`——合成注入不产事件）、`part`（step-start/finish、tool(callID,state.status running|completed|error)、text）、`session_entry`（runtime/model_selection → 模型/思考档/providerId）。
- 三入口与 kimi 适配器同构：`scanZcodeCatalog()`（本机 18 项目 / 39 主会话，~90ms，窗口函数一次取每会话最近 14 行推导粗状态）、`followZcodeLogs()`（**time_updated 水位轮询 + (tbl,id)→data 指纹去重**——捕获 tool running→completed 的同行 UPDATE；对正在运行的会话实测实时可见，本次调研查询本身即出现在事件流里）、`scanZcodeStatus()`（四态面板数据）。
- 映射：real_user→turn.start；tool running/completed→tool.call/result；step-start/finish→step.start/end；assistant finish(stop|completed→ok/failed→error/interrupted→aborted)→turn.end；text→message.assistant(280 截断)。**无审批族**（permission 表为项目配置、本机 0 行），observes 如实声明。
- 形态：库内无 CLI/桌面标记 → ZCode 会话不打形态徽标（与 DSH 同口径）。

**framed.mjs / local-agents / cli-control / UI 接线**
- framed：五源目录合并（dsh/cc/cx/km/zc）、实时跟随、`/api/catalog` perSource、跨源定位投递路由；SOURCE_LABEL/UI tab「ZCODE」。
- local-agents：新增 ZCode 行（进程特征 `ZCode.app/`、`zcode-cli`、`zcode-host-local-1`；活动 = db.sqlite* mtime；39 会话精确计数）。
- cli-control：新增 zcode 通道——bin 兜底到 App 包内 `glm/zcode.cjs`；`extraPaths` 机制替代硬编码兜底；投递 `--resume <id> --mode build --prompt`（**显式 build 压掉无头默认 yolo**，守不越权红线）。

**实测发现并修复的两个真问题**
1. **独立 CLI 缺 provider 环境**：脱离桌面 App 运行报「无法定位 CLI ZCode Built-in Provider Config」→ Model creation failed。修复：按 bin 位置推导并注入 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`（App 包 config）+ `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`（~/.zcode/v2）；投递（spawn env）与新建/打开（Terminal/tmux 前缀 export）三条路径全覆盖。
2. **上游登录态限制（定位成文，不修——留给用户一次性 `zcode login`）**：`~/.zcode/credentials.json` 不存在，桌面登录态未共享给独立 CLI → 无头 `--resume` **account:\* provider**（coding-plan，本机大多数会话）的会话必失败；builtin provider 会话实测可记忆续接（探测会话记住 42 并答对）。**配套修复：cli-control 投递加 2.5s 快速失败检测**——立即退出的 CLI（Model creation failed / Not logged in 类）读日志尾如实回报 failed，不再谎报「已投递」（与 ME3 的 pid-undefined 假成功同类；对四家 CLI 一致生效，实测 account 会话投递返回 `failed: Error: Model creation failed`）。

**验收（全量回归）**
- multi-source-check：新增 ML1–ML10（目录/子代理排除/元信息/状态集/性能/行映射×3/信封/滞留修正/**只读红线：建表被拒**）；MC1/MC4/MD1 升级为五源/四通道；`--live` 新增 ML11（探测会话真实投递 → session.time_updated 增长闭环）；live 选样上限 300KB→1MB（连续 --live 会把上轮投过的最小会话顶出上限，假失败）。共 52 项全过 ✅。
- test-window：mock 增加 zcode 实时/历史行、状态卡、cliChannels；新增 6 断言（ZCODE tab、无形态徽标、独立页卡片 39 会话、tab 过滤、项目侧栏过滤）；受影响计数断言同步（tab 6 个、活跃档 6 行、全部 15、状态卡 10 张）。59 项全过 ✅。
- test-mini / test-html / catalog-check / schema 自测 / replay-check / cli-control 自测 全过；check-fixtures 仍为既有 session-replay 基线失败（与本轮无关，待重录）。
- 真实实例验证：/api/catalog perSource.zcode=18 项目/39 会话；实时区出现本会话（ZCode·running·运行命令）；四态面板 ZCode=打开·已连接/observe/39 会话。
- 文档：README（五源/新命令/断言数）、40-adapters（TL;DR #13 + §3.12 全节）、21 计划 v3.1（§1 盘点 #12 + M-L 里程碑）。

### 用户报障「显示没有会话」排查（2026-10-07 下午，已解决）

- **现象**：接入完成后 App 界面无会话。**根因不是代码**：生产服务进程是 2026-10-06 23:32 启动的旧代码（`perSource` 无 zcode 证实），而 window.html 已是新版——旧服务没有 ZCode 观察器、其它源当时全为 done/idle，活跃列表自然为空。
- **修复**：重启 AgentPet（外壳引导页按需重拉 `demo/framed.mjs`，从磁盘加载新代码）。重启后实测：五源齐、实时区出现当前 ZCode 会话（运行中）、侧栏 34 项目、三档 9/70/78、ZCODE 标签页正常；清理了检测残留的失败队列项。
- **运维口径（重要）**：`demo/framed.mjs` 代码更新后**必须重启服务/应用**才生效（外壳只在端口无监听时拉起，页面自动刷新只覆盖 HTML，不覆盖 Node 进程内存）。

### 修复：ZCode 活跃数虚高 / 完成会话滞留不进完成·隐藏档（用户报障，2026-10-07 下午 II）

- **症状**：与此前 claude/codex/kimi 接入时同类——活跃会话数不对；回合结束转空闲后不进完成/隐藏档。
- **根因（两个，叠加）**：ZCode 的 `message.time_created` 是**生成开始时间**，早于它自己的 part 行；`finish=stop` 等终态是**行内 UPDATE**（time_updated 晚于 part 落盘）；且 `step-finish` part 在消息终态**之后**才 INSERT。而适配器两层都按 `time_created` 排序：
  1. 跟随器把 `turn.end(done)` 发在最终 step-start 之前 → 状态机被迟到的 step 事件拉回 `running`，回合结束仍滞留「运行中」；
  2. 粗状态推导的最新显著行是 step-finish（→running）而非完成消息（→done）→ 目录也说 running → `effectiveState` 的 5 分钟滞留修正失效（修正源本身是错的）→ `running/thinking` 不设时间上限（UI classify 规则），永远算活跃。
- **修复**（`adapters/zcode-adapter.mjs`）：
  1. 两层统一改按 **time_updated（真实完成序）**：跟随器 `ORDER BY time_updated`，事件 ts 取 `time_updated ?? time_created`；目录窗口函数与粗状态遍历按 `time_updated DESC`。
  2. **step-start/step-finish 不再映射为事件、粗状态不认领 step-finish**（对齐 Kimi 口径）：迟到的 step 边界再也无法把 done 拉回 running。
- **验证**：真实数据状态分布从「全 idle」变为 1 running / 39 done / 5 idle（完成的会话正确显示完成档）；端到端——向探测会话真实投递一个回合，实时行 `thinking → done 已完成` 且 40s 无反弹；生产实例同样实时跟踪该回合落定 done；侧栏「进行中」=1（仅当前运行会话），历史三档复算 完成 108 / 活跃 1 / 隐藏 46 与事实一致。multi-source-check 新增 ML12（完成回合时序回归）并更新 ML7，49 项全过；全套件回归全绿。

### 修复：ZCode 会话数量虚高且波动（用户报障，2026-10-07 下午 III）

- **症状**：会话计数仍不对且数字会自己变。
- **根因**：`selection_side_chat`（**划词问答**）被当普通会话计数并列出。它是 ZCode 桌面端的瞬态 UI 产物——在 App 里选中一段文字提问即生成一条（标题恒为「Selection side chat」），随使用增减（当日 1→2 条），ZCode 自身的会话列表不视为对话；快照审计确认无重复行、三档复算一致，剔除该项后计数即与真值对齐。
- **修复**（`adapters/zcode-adapter.mjs` 三处 + 状态快照）：目录扫描排除（计入 `stats.sideChats`）、跟随器 SQL 排除（不产行）、四态面板 sessionCount 同口径；CLI 树显示「划词问答 N 不列出」。
- **验证**：会话数 46→44（= DB interactive 真值）；multi-source-check 新增 ML13，50 项全过；全套件回归全绿；服务重启后 perSource.zcode=44、侧栏「进行中」=1。
- 附注：调试期间用无头 CLI 建的探测/测试会话（如「只回复 ok」×3、「请记住数字42」）是真实数据，按只读红线不做删除；它们位于 /tmp 临时组（沉底标注），1 小时无活动后自动进隐藏档。

### Token 用量计数（M-U：五源 per-Agent × per-Model 计数，usage-collect；分支 feat/token-usage-counting）

**新增 `adapters/usage-collect.mjs`（独立慢通道，零依赖）**
- 动因与架构：usage 需要**全文件**精确累计（本机 Claude 转录 1.1GB / 164 文件），不能进 5s 目录热路径 → 独立 **60s 慢缓存 + 文件级增量**（size+mtime 不变直接复用上次结果：首轮全量 ~2s，之后只重读有增长的文件）；流式 readline + 行 marker 预过滤（不含 `"usage"`/`"token_count"` 的行不 JSON.parse）+ 15s 软时限（partial=true 截掉最旧文件，下轮续扫）。
- 各源口径（字段全部本机实测）：
  - **Claude Code**：assistant 行 `message.usage` 按 **message.id 去重**（流式分块多行快照，后写覆盖=最终值）累加；input_tokens 不含 cache（Anthropic 语义）；sidechain 行与新版子代理链路 `<sid>/subagents/agent-*.jsonl`（本机 164 文件中 106 个在此结构下）都计入，子代理消耗**归入父会话**。
  - **Codex**：会话扁平值 = 最后一条 `token_count.info.total_token_usage`（**权威累计值**）；`last_token_usage` 增量实测比权威总量**少 ~25%**（未触发事件的请求不产增量）→ **单模型会话整额归属该模型，多模型会话保留增量归属（近似）**；input 含 cache（OpenAI 语义）；子代理 rollout 计入。
  - **Kimi Code**：`usage.record` 每请求一条直接累加（inputOther→input、inputCacheRead→cacheRead、inputCacheCreation→cacheWrite）；会话内全部 `agents/<id>/wire.jsonl`（含子代理流）计入。
  - **ZCode**：一条 SQL 按 `(session_id, modelId)` 聚合 `message.data.tokens`（与 `part.step-finish` 路径**双路实测一致**）；input 含 cache.read；`subagent_child` 会话计入。
  - **DSH**：多帧 zstd 会话日志逐帧解压（明文 jsonl 直读，与 framed.mjs decodeFrames 同款）；`assistant/message` 的 `data.usage`（inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/totalTokens，**每调用一组**，input 不含 cache）累加；model 归属按行序取 `request/header` 的 `header.config.model`；每会话目录只取最高代日志（复用 `pickLogFile`：v3+v4 并存不双计）；自带**恒等式对账**（∑分量 = ∑totalTokens，失配文件计入 stats.identityMismatched）。
- 汇总：`usageOverview()` 跨源按模型**小写归并**（`GLM-5.3`[zcode] 与 `glm-5.3`[claude] 同模型合并，13→11 个）；CLI：`node adapters/usage-collect.mjs [--json|--refresh]`。

**framed.mjs / UI 接线**
- framed：`refreshUsage()`（启动即扫 + 60s 轮询，完成立刻 broadcast）；快照新增 `usage` 块（totals / byModel / bySource；首轮未完成时 `{pending:true}`）；实时行与历史行附带扁平 `usage`；新端点 **`/api/usage`**（overview + perSource 五源 byModel/bySession 明细；`?refresh=1` 异步触发重扫）。
- window.html：顶部导航新增**「用量」页**（合计 chips + **各 Agent 消耗量汇总表** + 跨源合并模型表 + 分源模型表 + 口径脚注）；会话行 meta 追加 `tok in/out`。

**验收（multi-source-check 57 项全过 ✅，新增 MU1–MU7 独立对账）**
- MU1 Claude 去重证明（requests=去重 message.id ≤ 独立重数原始 usage 行；per-model 折叠一致）；MU2 Codex 独立反读最后一条 total_token_usage 与扫描器相等 + per-model ≈ 总量（≤2%）；MU3 Kimi usage.record 原始行数 = requests；MU4 ZCode message.tokens = part.step-finish 双路互证；MU5/MU6：framed 快照 usage 块（五源）+ 历史行附带 + `/api/usage` 五源明细；**MU7 DSH 恒等式零失配 + 独立解压重数 usage 行 = requests**（与采集器不同代码路径）。
- 真实实例：/api/state totals in≈2.09B · out≈20.2M · cacheRead≈4.33B · 请求 20,962；DSH 37 会话 in 1.7M · out 2.0M · cacheRead 272M · 1,341 请求（deepseek-flash）。
- 边界：DSH 的 title 生成小额消耗无 usage 事件、不计（成文）；input「是否含 cache」随源而异（Claude/Kimi/DSH 不含 / Codex·ZCode 含），统一折算与价格表（models.dev）留给后续独立层。

### Token 用量二期（当日补）：时间窗 × 形态 × 缓存命中率

- **三个新维度**：
  - **时间窗**：按本地自然日分桶（dayKey=yyyymmdd——**绝对口径**，文件级增量缓存跨天仍正确），聚合层按 now 切 **当日 / 7 日内 / 30 日内 / 全部** 四窗；每窗都有 totals/bySource（含形态拆分）/byModel。
  - **形态（CLI/桌面/IDE）**：Claude=entrypoint / Codex=session_meta.originator / Kimi=clientMetadata(composer)——与目录扫描同源判定，**文件级归属**；全量口径用 byVariantFlat（权威值恒等 Σ形态=总量），Codex 时间窗内的形态为事件增量近似（成文）。
  - **缓存命中率**：hitRate = cacheRead/(fresh+cacheRead)，fresh 按「input 是否含 cache」的源语义折算（DSH/Claude/Kimi 不含 → fresh=input；Codex/ZCode 含 → fresh=input−cacheRead）；跨源合并行也通过 freshInput 累计算出统一命中率。
- **UI**：用量页新增**时间窗切换器**（客户端即时切换，零往返）；「各 Agent 消耗量」表新增**命中率列**与**形态拆分行**（CLAUDE·桌面 / CLAUDE·CLI / CLAUDE·IDE / CODEX·桌面 / KIMI·桌面——与软件状态页标签同源）；模型表（合并+分源）均带命中率列。
- **验收（multi-source-check 59 项全过）**：**MU8** 五源 Σ形态=总量（文件级权威归属恒等）+ Claude ≥2 种 / Codex·Kimi ≥1 种形态；**MU9** Σ日桶=总量（requests 五源精确 / input 非Codex精确、Codex≥70%）+ today≤d7≤d30≤全部单调；MU5 升级（ranges+形态）。test-window 69 项（切换器、形态行、命中率、当日切换）。
- **真实实例**：合计命中率 **96.4%**（当日 96.5 / 7日 97.4 / 30日 96.8）；Claude 三形态 CLI 0.8M（90.5%）/ 桌面 60.4M（97.1%）/ IDE 2.6M（90.2%）；当日 Claude 桌面 11.0M。

### Token 用量完整测试轮（当日补二；用户指定「对这个功能进行完整的测试」）

- **新增 `scripts/usage-check.mjs`（合成数据单元测试，15 项 ✅）**：可控 fixture 精确验证真实数据测不到的边界——Claude message.id 去重/后写覆盖/无 id 行/sidechain 计入/子代理文件归父会话/超大行跳过、Codex 权威累计 vs 增量日桶、Kimi 子代理 wire 并入+别名取尾段、DSH **多帧 zstd 自造双帧**+v3/v4 防双计+恒等式、命中率两种语义折算、ranges 当日/7日/30日归属、**文件级增量缓存三态**（不变→全命中且逐字节一致；文件增长→仅该文件重读且增量精确；refresh→强制重读）。测试自身幂等、临时目录自清理。
- **全套仓库测试**：multi-source-check 59 ✅（MU1–MU9 真实数据独立对账）· test-window 69 ✅ · test-mini 12 ✅ · test-html 8 ✅ · catalog-check 17 ✅ · replay-check --selftest 15 ✅；check-fixtures 失败确认为**既有** session-replay fixture 基线问题（§2.4 乱序窗口，早于本功能、CHANGELOG 已记录待重录，与 usage 无关）。
- **缓存与实时行为实测**：双轮 scanAllUsage 3529ms → 77ms（**45.8x**，四源 247 文件全部缓存命中且结果逐字节一致）；zcode 双轮差异归因为**活数据**（本会话自身在写库，静默窗口 Δ0、当日单调增长——实时性旁证）；framed 启动 pending(0.6s)→ready(5.6s) 转换、`/api/usage?refresh=1` 异步重扫 0.3s 完成（缓存生效）、`dayApproximate` 诚实标注在列；SSE 单帧 264KB（usage 块 24.7KB/9.4%，大头为本就存在的 155 条历史行全量字段）。
- **浏览器实测（IAB）**：真实页面加载 → 用量页渲染完整（四时间窗按钮、合计 chips 含命中率 96.4%、Agent 表 9 行形态拆分 CLAUDE·CLI/桌面/IDE + CODEX·CLI/桌面 + KIMI·桌面 + 未识别形态单列、合并模型表带命中率列）；切「当日」全表联动（2.21B→279.4M、CLAUDE·桌面→11.0M、DSH→0 正确）；截图存档。注：IAB 面板未前台化时 Playwright 点击可达性受限，经页内 click 处理器触发（与按钮点击等价）完成验证。

### ZCode 用量准确度三方对账（用户基准：官方 UI「今日消耗 5.4 亿」；当日晚，已确认）

- **发现官方账本表**：`~/.zcode/cli/db/db.sqlite` 里有 ZCode 自己的用量账本 **`model_usage`**（每请求一行：input/output/reasoning/cache 三件套 + provider/computed_total_tokens；另有 turn_usage/tool_usage）——即官方 UI 数字的来源，此前未被发现与使用。
- **三方对账结果**：
  1. **采集器 vs message 表（采集器的声明数据源）**：今日四字段（in/out/cacheRead/cacheWrite）**差值全部为 0**——采集管道 100% 精确。
  2. **message 表 vs 官方账本 model_usage（逐行）**：有 assistant_message_id 的行**逐字段完全相等**（in=164036/cr=163456/total=164073 级别的逐行对齐）；表间 ~1-2% 差异来自边界（账本含 title 生成/错误重试请求；message 表个别流式中断行 tokens 归零——这些行被采集器正确跳过）。
  3. **vs 用户基准 5.4 亿**：官方 UI「今日消耗」口径 = **全口径 Σ(input+cacheRead+cacheWrite+output)**，此刻实测 5.358 亿（535.8M），与 5.4 亿差 **0.7%**——由会话进行中的实时增长 + 读数时刻不同解释（官方账本同口径 5.276 亿，两个表都 < 用户读数，因为数字一直在涨）。
- **修正一个语义误判（本次对账的真正价值）**：逐行模式证明 **ZCode message.tokens 的 input 是 fresh 口径（不含 cacheRead）**……**该结论当晚被推翻**，见下节再修正。

### ZCode input 语义再修正（用户质疑「不可能 40 几的命中率」——用户正确，96.4% 为准）

- **裁决实验（两 个，均指向 input 含 cacheRead）**：
  1. **官方账本 raw_usage_json**（provider 原始返回，此前未查）：`{"inputTokens":139716,"outputTokens":454,"totalTokens":140170,"cacheReadTokens":138688}`——`totalTokens = inputTokens + outputTokens`，即 **inputTokens 是全量 prompt（OpenAI 式含 cache）**，fresh 仅 1028；
  2. **同会话连续请求递推**：若 input 含 cache，则 `cr[t+1] ≈ in[t]`（上次输入即全上下文，下次全量命中）——实测累计误差 **1.7 万**；若 input 为 fresh，则 `cr[t+1] ≈ in[t]+cr[t]`，误差 **35 万（20 倍）**。样本：in=25041 → 下条 cr=25024（Δ17），全序列吻合。
  3. 旁证：全日 Σ(in−cr)/请求 ≈ 5k/次（每请求新增内容的合理量级）；fresh 说会推出 155k/次新内容——上下文无法持续，不可能。
- **错误原因复盘**：上一轮把「in=164036/cr=163456 → fresh=580」的解读方向弄反了——该模式恰恰证明 input 含 cache；而引用的「账本 input_tokens 与 message 逐行相等」根本不能区分两种语义（相等与含不含无关）。**教训入库：语义判定必须用递推/原始报文这类结构性证据，不能用字段名类比。**
- **回滚**：usage-collect `inputIncludesCache: zcode → true`（回到最初实现）、window.html 两处脚注、docs/40 §3.13 表格、test-window mock。**ZCode 命中率恢复 96.4%**（fresh = in − cr ≈ 9.3M，hit = cr/(fresh+cr)）。
- **对 5.4 亿基准的影响**：不变——`in+cacheRead+cacheWrite+output = 5.431 亿` 是对官方 UI 数字的精确复现（该公式即 ZCode UI 的「今日消耗」定义，input 含 cache 时它把 cache 计了两遍，属官方口径自身的定义，照实对齐）。

## 2026-10-05

### 契约 v1.2（Lead 冻结，docs/00-interface-contract.md）
- **计数口径统一**：**16 个 type 字符串 / 16 行**（v0.1 文本误写「14 种」；v1.2 又把 step.*/tool.* 拆成独立行，故行数与 type 数均为 16）。
- **必填标注规则**写入 §2.3：`*` 必填、`?` 可选、未标注 = 必填。
- **审批/提问强制关联 ID**：`approval.request/resolved` 必填 `requestId`；找不到未决项计 `orphanApprovals`/`orphanAnswers`（≤不再按 FIFO 猜）。
- **控制帧概念**：`ctl = hello | ack | decide | snapshot`（与事件区分）；补 ack 超时/重试、版本不匹配回包、`resumeAfter` 续传。
- **超时拆分为两条独立规则**：§4.4 的 45 s 判连接（source 离线并清聚合）、§4.5 的 10 min 清会话（基准 `lastStateChangeTs`，心跳不刷新）。
- **状态枚举统一**：`agent.status.state` 仅 `idle|thinking|working|waiting|error`（`done` 为本地过渡态）。
- **新增 §4.7 瞬态/持久错误**：`step.end/tool.result(error)` = `transient-error`（TTL 2 s）；`turn.end(error)`/`error.raised(fatal)` = 持久；连续 3 次瞬态升级。
- **会话级例外条款**：`turn.end(aborted)`/`session.end(aborted)` 只改该会话状态，不打断其他会话的 `waiting`。
- **Phase 1 只读**：明确桌宠不回写任何决定；Phase 2 通过 `canDecide` 能力协商才允许 `ctl:decide`。
- **工作框保证（§8）**：`pet.snapshot` 必须含 `now`/`counters`/`clearedPending`；新增 `sessions[].title/workspace/lastTool/elapsedMs/pending` 与顶层 `degradedSources`；会话行渲染规则（首行 40 px + 会话行 28 px × 最多 5 行 + `+N` 脚注）。
- **`observes` 能力协商（§5.2.1）**：适配器声明实际能产生的事件族，工作框据此隐藏不可用指标。
- **`unknownEvents` 语义澄清**：只统计不在 §3 的 16 个 type 内的类型；已知但 no-op 的事件计 `noop`。
- **Windows 命名管道更正**为 `\\.\pipe\agent-pet-<source>`；socket 增加单实例锁文件。

### 用户方向更新
- **产品主界面 = 工作框（Work Frame）**：默认悬浮卡片；首行显示状态/动作/计时/未决，其下每会话一行；**宠物形象默认关闭**，可选开启（用户 2026-10-05 确认）。
- 内存验收口径定为 `phys_footprint` 合计（RSS 参考）。
- 分发方式倾向 DMG 直分发（`macOSPrivateApi` 与 App Store 审核冲突，见 R-12）。

### 任务与产出
- T1 技术栈 spike（Swift/Tauri/Electron）、T2 产品规格、T3 后端适配矩阵、T5 风险登记册、T7 DSH 桥接验证、T8 工作框规格 均已完成；T4 路线图与 T6 独立验收进行中。
- 独立验收（docs/99）首轮报出的 4 个 P0 + 16 个 P1 已在 v1.2 逐条闭环（详见 docs/99 的 v1.2 复验节）。

### 修复（2026-10-05 下午，悬浮窗三问题：选会话投递 / 新建会话 / 子代理误识别）

**demo/framed.mjs**
- 插件探测端点 `/state` → **`/health`**（插件只有 /health，原探测永远 404 → canCreate/canOpen/canInput 恒 false、直投恒不可用）；能力位从 `capabilities` 子对象归一化。
- `POST /api/input` 接受可选 **`sessionId`**（支持前缀），`resolveTarget` 校验目标必须是已知**主**会话，子代理目标 404 拒绝；`deliverInput(text, targetId)` 显式目标优先，重发沿用原目标。
- 子代理不再混入会话列表：snapshot 的 `sessions`/`catalog.history` 过滤 `kind==='subagent'`；项目摘要新增 `mainCount/subagentCount`；`pluginTargetSession` 跳过子代理；日志跟随默认目标改为「最新主会话日志」（原按 mtime 全局挑最新会选中子代理日志）。

**demo/window.html**
- 新增**投递目标选择**：点击会话行（实时/历史）选中为投递目标（高亮 + composer 顶部目标行，点击目标行恢复自动）；发送携带 `sessionId`；陈旧目标自动回退自动。
- 项目下拉显示主会话数；子代理行双重过滤。

**plugins/dsh-pet/index.js**
- **HMR 竞态修复**：dispose 改为 inode 对照只删自己的 socket、锁加 token 区分同进程新旧实例（原 dispose 无条件 unlink 会删掉后继实例的 socket，造成「内核在听、文件不在」的孤儿，插件活着却 ENOENT 不可达）；锁心跳定时器每 5s 自检 socket 文件，丢失自动重绑。
- **投递顺序改为 agents 优先**：desktop profile 进程内直调 `sessionController.prompt` 必丢 cancellation signal（`signal.throwIfAborted` 抛 undefined，DSH 侧问题），实测 `agents.get/resume + followup` 在 desktop 与 /tmp 预演均真实送达；prompt 降级为回退并保留诊断。
- `buildCatalog` 跳过子代理（live 按 delegationDepth/parent，磁盘按 header.origin）。
- 新增 `POST /diag`（服务句柄/方法探测 + prompt 形态试验）与 socket 同目录 `plugin-debug.log` 生命周期日志。

**实测（真实 desktop profile，2026-10-05 15:4x–16:0x）**：`/api/new` 经 `sessionController.create` 建会话 ✅；`/api/open` 经 `resolveAgent` 定位（前缀匹配）✅；`/api/input` 显式 sessionId 经 `agents.followup` 送达并落盘会话日志 ✅；子代理目标被拒 ✅；`node plugins/dsh-pet/probe.mjs all` 全绿 ✅。注意：插件代码更新需重启 DSH（宿主进程内模块缓存，patch 变更只重新 apply）。

### 追加修复：悬浮窗页面「未连接」（token 注入损坏脚本，2026-10-05 16:0x）

- **根因**：服务端注入 token 用 `html.replace('__PET_TOKEN__', TOKEN)`，而该占位符在页面里的**首次出现是 `window.__PET_TOKEN__` 的属性名**（非字符串字面量），被替换成 `window.<hex>`——数字开头的非法标识符 → 整个内联脚本 `SyntaxError` → SSE/render 均未运行，页面停在「未连接」。渲染自检此前只跑占位符版本，抓不到该问题。
- **修复**：字符串字面量改用独立占位符 `'__PET_TOKEN_VALUE__'`（页面中唯一出现），服务端只替换带引号的这一处（`demo/window.html` + `demo/framed.mjs`）。
- **防回归**：`demo/test-window.mjs` 新增断言「token 注入后脚本仍可执行」（22 项断言全过）；浏览器实测：SSE 连接、聚合状态/会话行/主会话计数渲染、点击选投递目标、控制台零报错。

### 修复与增强（2026-10-05 16:1x：新建会话落错项目 / 置顶可关 / 一键安装）

1. **新建会话落进指定项目**（两个根源都修了）：
   - 插件 `createSession`：DSH 的 create 只带 `cwd` 时**不会**把会话挂进 workspace（界面归到默认项目）。现先 `workspaceRegistry.resolveByPath/create` 拿到 workspace，优先带 `workspaceId` 创建（DSH 内部会 attachSession），agents.create 回退路径手动 `attachSession`；带 workspaceId 被拒时退回纯 cwd。预演实测：`/new` 返回 `workspaceId`，且会话出现在 workspace 的 `sessionIds` 里。**注意：需重启 DSH 加载新插件代码后生效。**
   - 外壳注入的 `wireNewHint`：能力位 `canCreate=true` 后不再接管「新建会话」按钮（原先一次点击会触发两次 `/api/new`——页面 handler + explainNew 的 `cwd:''`——多出一个落进默认项目的会话）。
   - 附带发现：`workspaceRegistry.create` 对不存在的目录会失败，因此 /api/new 的 cwd 必须是已存在的项目目录（UI 里列出的都是真实项目，不受影响）。
2. **置顶可关**：窗口默认 `alwaysOnTop=false`（可被其他窗口正常覆盖）；标题栏新增 📌 按钮随时切换置顶（偏好记忆在 localStorage）；远程能力补 `core:window:allow-set/is-always-on-top`。已重建并替换运行中的外壳（日志确认 `WINDOW_SHOWN always_on_top=false`）。
3. **一键启用**：`apps/shell/run.sh --install` 构建并安装到 `/Applications`，以后从启动台/Spotlight 打开「AgentPet」即可（外壳自动拉起本地服务）；README 快速开始已更新。

### 会话列表 = DSH 左侧列表（workspace 注册表为准），2026-10-05 16:4x

**口径变更**：悬浮窗的项目/会话列表不再按磁盘扫描自由组织，改以 **DSH 左侧会话列表的唯一真相源**（`~/.dsh/storages/workspace.json`，只读）为准：
- 项目 = 注册表 workspace，顺序 = `global.workspaceIds`（= DSH 侧栏顺序）；成员 = 各 `workspace.sessionIds`（保留注册顺序）；已归档会话不显示。
- 子代理彻底消失：注册表本就不含子代理，另有目录 kind + 插件 `session.start` 新增的 `origin`/`delegationDepth` 字段双保险（后者零延迟，不等 5s 目录缓存）。
- 未注册进任何 workspace 的主会话（如旧版 cwd-only 创建的）归入末尾「未归入项目」组，不打乱注册表项目成员。
- `pet.heartbeat`/`sessionId='backend'` 的来源级帧不再被画成会话行（修掉名为 backend 的幽灵行）。

**配套修复**（上一轮分析报告的四点方案）：
1. 项目过滤改按 **projectKey**（workspaceId）匹配：曾按 `label===项目名` 过滤，label 是目录名、项目名是 workspace 标题，口径不一致 → 选中项目后实时行 100% 消失（实测 10 行→0 行）。快照的实时行/历史行/项目现在都带 `projectKey`，前端匹配之（旧快照回退 cwd 匹配）。
2. 渲染抗竞态：`#sessions` 与项目下拉 innerHTML **内容不变不重写**。此前每 ~1.2s 全量替换（2s 心跳 + 每事件），mousedown/mouseup 之间节点被换 → click 落到容器被吞（「点不中会话行」实测主因之一）。
3. `/api/new` 对不存在的 cwd 先 `mkdir -p`：`workspaceRegistry.create` 对不存在目录会失败，导致会话落不进项目。
4. 插件 `session.start` 携带 `origin`/`delegationDepth`；`adapters/session-catalog.mjs` 新增 `readWorkspaceIndex()`（order/byId/byPath/sessionOwner/archived/pinned）。

**验证**：`test-window.mjs` 25 项断言全过（新增 projectKey 过滤/未注册组/注入执行）；实测：项目下拉=DSH 侧栏顺序+未归入组、选中 agent综合管理平台 只显示其 1 个注册会话、无 backend/子代理行、6 连点目标切换全部生效。注意：DSH 重启后插件才会在新建时挂 workspace（旧模块 cwd-only 创建的会话会进「未归入项目」组）。

### 启动方式落地 + 多 Agent 接入计划（2026-10-05 22:1x）

- **免命令行启动（已实测）**：`apps/shell/run.sh --install` 一次性装入 /Applications（并注册 LaunchServices）；日常从 启动台/Spotlight 打开「AgentPet」即全自动（外壳自拉 demo/framed.mjs、连 DSH 插件、出窗口）。开机自启可选：系统设置 → 登录项 添加 AgentPet。注意：仓库移动后需重跑 --install（编译期路径定位）。
- **新增 docs/21-multi-agent-adoption-plan.md**：多 Agent（Claude Code / Codex / ACP）接入总体计划——复用契约 v1.3 多源设计与 KNOWN_AGENTS 扩展点；M-A/B 观察适配（映射草案基于本机 292 Claude 转录 + 32 Codex rollout 实测）→ M-C 多源目录/UI → M-G 打包常驻 → M-D/E 控制（tmux 注入 / `--resume -p` / `codex exec`，方案待 spike）→ M-F ACP 杠杆；含排期（W1–W4+）与风险对策。

## 2026-10-06

### 多 Agent 接入计划升级 v2（docs/21）
- **全盘软件盘点**（§1 新增）：PATH/npm/brew + /Applications Info.plist + AS 数据目录 + 进程四路核对，确认本机 11 项 agent 相关软件，逐项标注版本/证据/数据位置/接入分级（A 核心 / B 新增 / C 观望 / D 元信息 / E 排除）。
- **后端清单扩充**：新增 Kimi Code 1.0.4（M-H，先 spike 数据位置）、OpenCode（M-I，首选 ACP、备选 opencode.db 只读快照）、AgentOS M1 自研 CLI（M-J，兼作控制通道实验场）、CC Switch 供应商元信息（M-K）。
- **排除项成文**（§1.3）：Claude.app/ChatGPT.app（无本机观察通道）、影刀 RPA（范式不符）；Codex++/Nowdex/CC Switch 定性为壳/工具而非 agent 本体。
- **阻塞项发现**：codex CLI 与 opencode CLI 当前均不在 PATH（仅存数据目录与桌面壳）——M-E 落地前需恢复；观察通道不受影响。
- **新增里程碑** M-H/M-I/M-J/M-K 与排期调整（W3 加 Kimi spike，W4 加 OpenCode，W5+ ACP/AgentOS）；风险表增补 3 条（Electron 存储不稳、第三方壳目录分叉、卸载残留误接入）。

### 多 Agent 接入计划 v3（同日，用户方向确认）
- **首批接入范围锁定（用户指定）**：DSH（已完成）+ Claude Code + Codex + **Kimi Code（M-H 由 P1 提入首批）**；W1 即排 Kimi 数据定位 spike，W2 末目标改为**四源同窗演示**。当前仅更新计划，未启动开发。
- **终局架构定性（§6 新增）**：AgentPet = Agent 总控，**双域模型**——本地域直接控制各 agent 软件；远端域经 AgentOS（自研执行体，每台远端服务器一个实例）同时控制多台服务器。远端机器不装各家桌面 agent，AgentOS 是远端唯一汇聚入口。
- **M-J 重构为三步轨道**：J1 本地观察（提前至 W4，兼作控制通道彩排）→ J2 远端观察（SSH 只读，Phase 3）→ J3 远端控制（`ssh <host> agent -s` 白名单投递，Phase 3）。
- **source 命名规范提案**：远端 AgentOS 用 `agentos@<host>`，per-(source, sessionId) seq 天然隔离，契约 v1.3 无破坏性变更（待 Lead 确认写入附录）。
- **安全红线成文（§6.4）**：总控不存储/不代理 SSH 凭证；远端投递仅 `agent` 子命令白名单；远端回传仅状态级字段。
- **风险表 v3 增补 3 条**：远端链路抖动误判离线（断连=链路中断≠会话结束）、远端命令注入/越权、多主机规模（首版 ≤5 台预算）。
- **README 同步**：产品定位改为「工作框 / Agent 总控」（观察+控制+远端）；目标表新增 Phase 3 行。

### 本地域开发：软件四态面板（2026-10-06，代码）
- **新增 `adapters/local-agents.mjs`**：本机 agent 软件四态探测（DSH / Claude Code / Codex / Kimi Code / AgentOS M1 / OpenCode）。三级探测全只读：安装 = App 包/CLI/配置目录存在性（cc-switch 同款思路），运行 = 每轮单次 `ps axo pid,ucomm,args` + 每 agent 一条收窄正则（大小写敏感防误匹配 Claude.app），连接 = 观察通道 45s 内有数据（对齐契约 §4.4；DSH 插件 socket = 真连接，由 framed 注入）。本机实测 38ms/轮。
- **framed.mjs**：快照新增 `agents`/`agentCounts` 字段 + `GET /api/agents` 端点；3s 轮询，探测失败保持上次结果。
- **window.html**：新增「软件状态」面板（aggbar 与会话列表之间，可折叠）：每软件一行四态（已连接/已打开·未连接/未打开/未下载）+ 版本 + 通道（插件/日志）+ 进程数 + 上次活动相对时间；缺 agents 字段显示探测占位不报错。
- **test-window.mjs**：24 → 35 项断言（四态文案/通道/折叠/缺字段容错等 11 项新增），全部通过。
- **本机实测**：DSH 已连接（插件通道，5 进程）、Claude Code 已连接（日志通道）、Codex/Kimi Code/AgentOS/OpenCode 未打开（含版本与上次活动时间）。
- **注意**：正在运行的 AgentPet（7799）需重启外壳/服务才能加载新快照字段；window.html 是每请求读盘、刷新即生效。

### 人机交互总体方案 v1（2026-10-06，docs/55 新增）
- **双面模型**：常驻层（悬浮卡片，docs/51 全规格保留，只答「在干什么/多久了/等我没有」）+ 控制台层（demo/window.html 演进版，承载全部控制功能）；同源双视图、控制台可关、待办是唯一双向入口。
- **软件四态 × 动作表**：每态一个明确动作无死路——已连接=过滤其会话、已打开未连接=差异化连接指引、未打开=启动（只启动不代装）、未下载=安装指引+里程碑；探测失败显式 ⚠ 不回退。
- **选择模型三规则**：行点击=设投递目标；过滤器只影响显示不影响目标（目标被过滤时黄色警示条，替换现状的静默回退——列为 P0 投递安全项）；「打开」独立于选择。
- **术语统一**：队列用户文案只用 待投递/已送达/失败/已取消；toast ≤3s；删除 5s 可撤销。
- **新增 10 条 UX-A 验收断言** + 与现状差异清单（7 项，P0 两项：目标不静默回退、软件区可点联动）+ 与 51/50 冲突消解表 + 远端主机分组（Phase 3）与用户旅程。

### 多 Agent 观察适配落地：Claude Code / Codex / Kimi Code + 多源同窗（2026-10-06，代码，docs/21 M-A/M-B/M-C/M-H ✅）

- **新增 `adapters/claude-code-adapter.mjs`（M-A）**：`scanClaudeCatalog()`（窗口化目录：头 24KB + 尾 160KB，单行 >512KB 跳过；本机 11 项目 / 48 会话，中位 ~18ms）+ `followClaudeLogs()`（多文件字节偏移增量 tail，1.2s 轮询，截断重建自愈，启动从 EOF 起不回放）+ `mapClaudeLine()` 纯函数（user→turn.start、tool_use→tool.call（category 复用 categoryOf）、end_turn→turn.end(ok)、turn_duration→turn.end、api_error→error.raised(fatal:false)、custom-title/ai-title/agent-name→session.meta；sidechain 行逐行忽略）。元信息：标题三级回退、模型（assistant.message.model，CC Switch 供应商可见）、版本、cwd（行内权威，目录名有损兜底）。
- **新增 `adapters/codex-adapter.mjs`（M-B）**：`scanCodexCatalog()`（首行 session_meta 实测 20~51KB → 头窗口 96KB；本机 13 主 + 19 子代理，中位 ~19ms）+ `followCodexLogs()`（首遇文件读 session_meta：权威 sessionId + 子代理判定，**子代理 rollout 整文件跳过**，防幽灵实时行）+ `mapCodexLine()`（task_started→turn.start、function_call/custom_tool_call→tool.call、output→tool.result、task_complete→turn.end(ok)+message(截断280)、turn_aborted→turn.end(aborted)、session_meta→session.start）。**Codex++ 通路验证：全部 rollout originator="Codex Desktop"，落同一 `~/.codex/sessions`，单 root 覆盖。**
- **新增 `adapters/kimi-code-adapter.mjs`（M-H Step 1+2）**：spike 结论——Kimi Code 无 JSONL/SQLite/日志，会话仅在 Chromium LevelDB（键名 `session_<uuid>` 等，只扫键名不解码 value）→ 按风险分级**降级**：`scanKimiStatus()` 存活 + 近似会话计数（≈9，显式 approximate）+ mtime 连接判定；`observes=['session.heartbeat']`，不产生会话行/事件（红线：降级不伪造）。
- **`demo/framed.mjs`（M-C）**：`multiCatalog()` 三源合并（5s 缓存，合计 ~55ms）；快照 projects 带 `sources[]`；claude/codex 会话按 cwd 挂靠 DSH workspace（未命中则 `path:<cwd>` 自立组）；历史行跨源合并（截 40）；`followClaudeLogs`+`followCodexLogs` 与 DSH tail/插件共用同一 `applyEvent` 状态机；**投递目标守卫**——非 DSH 会话：UI 黄色警示 + 服务端 `resolveTarget` 404 拦截（M-D/M-E 未落地说明），自动挑目标仅限 DSH 主会话；`/api/catalog` 三源合并视图（perSource 统计）、`/api/open` 跨源定位并如实说明。
- **`demo/window.html`**：历史行来源列改 `s.source`；Kimi 近似计数进四态面板（≈N 个会话）；非 DSH 目标行黄色警示；空态/底注/帮助文案多源化。
- **`adapters/local-agents.mjs`**：kimi-code 补 LevelDB activity（连接判定生效）+ 会话计数（30s 缓存）。
- **测试**：新增 `scripts/multi-source-check.mjs`（19 项断言全绿：MA1–7 / MB1–6 / MH1–2 / MC1–4，MC 组起真实 framed 实例验证多源快照与投递拦截）；`demo/test-window.mjs` 35 → 38 项全绿（历史来源列 / Kimi 计数 / 非 DSH 目标警示与颜色 / DSH 目标正常态）。
- **实测**：本会话自身被 Claude 跟随器实时观察（running · 运行命令 · glm-5.3）；`鹈鹕测试变体策划[dsh+claude-code+codex]` 同 cwd 三源归并同窗；对 claude 会话投递被 404 + 明确原因拒绝。
- **文档**：docs/21（M-A/M-B/M-C/M-H 标 ✅ + 落地形态 + §5 现状快照更新）、docs/40（Kimi Code 补行：§0 表 #12 + §3.11 [A] 证据）、README（多源演示命令）。
- **已知既有问题（与本次无关）**：`scripts/check-fixtures.mjs` 对 `fixtures/session-replay.pet.jsonl` 的乱序窗口断言在改动前的基线上即失败（乱序窗口 ts 跨度 5797ms > 2000ms，非连续 seq），留待 fixture 重新录制修复。

### Kimi Code 升级 A 路径 + Codex CLI 恢复（2026-10-06 下午，代码）

- **勘误（M-H spike 误判根因）**：上午结论「Kimi 会话仅在 Electron LevelDB → 降级」有误——探测命令 `ls -d ~/.kimi* ~/kimi*` 因 `~/kimi*` 无匹配被 zsh 整体中止，`~/.kimi-code/` 从未被列出。Kimi Code 实为 CLI-first 架构，agent 核心写文件级数据；LevelDB 只是前端层缓存。
- **`adapters/kimi-code-adapter.mjs` 重写（A 路径）**：`scanKimiCatalog()`（state.json 整读 + wire 头/尾窗口，本机 4 项目 / 9 会话 ~4.4ms；标题/titleKind/cwd/模型(modelAlias)/思考档/归档过滤）+ `followKimiLogs()`（`agents/main/wire.jsonl` 多文件增量 tail；非 main agent 流 = 子代理整文件跳过）+ `mapKimiLine()`（turn.prompt→turn.start、loop tool.call/result→tool.call/result、turn.ended(completed/cancelled)→ok/aborted、**interaction.request/resolved 原生审批对（同 id 配对）**、agent.message.appended→message.assistant(280)、turn.step.retrying→error.raised 瞬态）+ `scanKimiLegacyCount()`（LevelDB 计数降为第三层兜底）。state.json 的 lastPrompt（用户原文）不读取。hooks 通道（app.asar 实测 20 事件、command 型、config.toml [hooks]）留作授权升级项。
- **Codex CLI 恢复（M-E 前置解除）**：`/usr/local` 无写权限 → `npm i -g --prefix ~/.local @openai/codex` → `~/.local/bin/codex` v0.160.1，`codex login status` 确认复用既有 auth.json（API key）已登录。本机 CLI 三件套齐：claude（~/.local/bin）/ kimi（~/.kimi-code/bin/kimi）/ codex。
- **`adapters/local-agents.mjs`**：kimi-code 安装证据 + `~/.kimi-code` 与 CLI 路径、processRe 匹配 kimi CLI、activity 加 sessions 目录（core）并保留 LevelDB（兜底）；会话计数改为目录精确（LevelDB 兜底才标 ≈）；codex 版本探测（npm package.json，实测 v0.160.1）。
- **`demo/framed.mjs`**：multiCatalog 四源（+kimi）；`followKimiLogs` 接入同一状态机；/api/catalog perSource 加 kimi-code；快照 source 标注四源。
- **`demo/window.html`**：Kimi 会话计数精确/近似条件显示；底注与帮助文案更新为四源。
- **测试**：`scripts/multi-source-check.mjs` 19 → 26 项全绿（新增 MK1–9：A 路径目录/元信息/性能/wire 映射含审批对/非降级 observes/LevelDB 兜底仍在；MC1 升级为要求四源历史行）；`demo/test-window.mjs` 38 项全绿。
- **实测**：`agent综合管理平台[dsh+claude-code+kimi-code]` 三源同项目；浏览器实测 23 项目 / 92 会话同窗、7 条 KIMI 历史行（真实标题/模型/思考档/状态）、四态面板 kimi-code 精确计数 9、控制台零报错。
- **文档**：docs/21（M-H 勘误+A 路径落地、M-E 前置解除、§5 快照与 CLI 三件套）、docs/40（§0 表 #12 与 §3.11 重写，含勘误记录）、README。

### 控制层落地：Claude Code / Codex / Kimi Code 投递·新建·打开全通（2026-10-06，代码，docs/21 M-D/M-E/M-H 控制 ✅）

- **新增 `adapters/cli-control.mjs`**：三后端统一控制通道——投递（tmux 服务在跑则 `send-keys -l` 到「该 cwd 里跑着对应 CLI」的 pane；否则无头续会话 detached spawn：`claude --resume <id> -p` / `codex exec resume <id>` / `kimi -S <id> -p`，输出落 `~/.agent-pet/cli-control/*.log` 0600）；新建/打开（tmux window / Terminal.app osascript 新窗口，参数全 shell-quote）。安全边界：只走官方 CLI 能力，不注入不绕权（各 CLI 权限模式照常生效）。
- **两个实测坑与修复**：① 宿主进程带 `ANTHROPIC_*/CLAUDE*` 环境变量时无头 claude 报 "Not logged in"（内部 BASE_URL 抢了 settings.json 优先级）→ spawn 前净化环境（剥 `ANTHROPIC_/CLAUDECODE/CLAUDE_CODE_` 前缀），CC Switch 供应商配置正常生效；② `codex exec` 在非 git 目录被 "Not inside a trusted directory" 挡 → 非 git cwd 附加 `--skip-git-repo-check`（仅跳过 git 检查，沙箱/审批不动）。
- **`demo/framed.mjs`**：resolveTarget 返回 source 并放行三后端目标；deliverInput 按来源路由（DSH=插件/队列，CLI 后端=deliverControl）；`/api/new` 接受 `source` 走 `newCliSession`（Terminal/tmux 新窗口）；`/api/open` 对 CLI 会话真实打开（Terminal resume）；capabilities 增加 `cliChannels`，canInput/canCreate/canOpen 随 CLI 通道点亮；`resolveSessionAny` 补上 kimi 源（曾致 404）。
- **`demo/window.html`**：目标行由「暂不支持投递」警示改为「经 CLAUDE-CODE CLI 投递」通道标注（默认色）；新建按钮按项目 sources 自动挑后端（DSH 插件优先，否则 CLI）；hint 三模式（cmd/cli/manual）；帮助页补控制层与安全边界说明。
- **测试**：`scripts/multi-source-check.mjs` 26 → 28 静态项（MD1/2 控制通道与语法表；MC4 改为能力位）+ `--live` 真实投递 3 项（MD3/ME3/MH3：各挑**最小**旧会话发一条「只回复 ok」，等待会话文件字节增长验证控制→观察闭环）——**31 项全绿，三家真实闭环全部打通**；`demo/test-window.mjs` 40 项全绿（CLI 通道场景：按钮可用 + hint 模式 + 目标行通道标注）。
- **实测**：浏览器点击 CLAUDE-CODE 历史行 → 「投递目标：demo · 经 CLAUDE-CODE CLI 投递」；canInput/canCreate/canOpen 全亮，cliChannels 三家齐。
- **文档**：docs/21（M-D/M-E ✅ 落地 + M-H 控制层 + §5 快照「观察+控制四源全通」）、README。

### 操作界面全面改版：迷你悬浮条 + App 界面双形态（2026-10-06，UI）

- **新增 `demo/mini.html`（新悬浮框，外壳默认入口 `/`）**：参考 Codex mini(pet) 的单行形态——状态点 + 状态·动作·计时·未决 单行进度；一行内三级切换：agent 软件（全部/DSH/CLAUDE/CODEX/KIMI）→ 项目 → 会话（级联过滤，实时会话带 ● 且来源可辨：`标题 · SRC`）；无选中会话时回退聚合行；⤢ 展开为 App。
- **`demo/window.html` 重构为 App 界面（`/window.html`）**：**顶部** agent 软件切换 tab + 聚合状态；**左侧** 项目列表（含进行中计数，点击过滤）+ 软件四态面板；**中部** 会话列表（实时+历史，来源列 + 项目名进 meta——任何一行都能分辨「哪个会话 × 哪个项目 × 哪个 agent 软件」）；**底部** 会话控制（投递目标 + 输入 + 队列 + 新建/历史）。
- **队列行为变更**：只显示未完成项（待投递/投递中/失败）——**成功送达的消息不再显示**，改为发送后在 note 闪一次「已送达 ✓ via …」；磁盘审计日志（input-queue.jsonl）仍完整保留。
- **双形态切换**：mini ⤢ ↔ App 「▤ 迷你条」；Tauri 外壳内自动调窗口尺寸（mini 360×44 / App 980×640，经 `set_size` 能力，浏览器演示优雅降级）。外壳启动页重定向到 `/` → 默认即迷你条。
- **顺手修**：聚合态 `working` 缺中文文案/配色（两页都补「工作中」绿色；此前顶部一直显示英文 working）。
- **测试**：`demo/test-window.mjs` 重写为 App 断言 24 项；新增 `demo/test-mini.mjs` 9 项——全绿。浏览器实测：mini 42 会话可选、自动选中活跃会话；App 顶部切 CLAUDE（项目 23→11、实时 2→1、历史 30→16）、左侧点项目（agent综合管理平台 · 2 进行）、行选中目标全链路可用。
- docs/55 人机交互方案的双面模型与新形态的对应关系待 v2 修订（常驻层=迷你条、控制台层=App）。

### 双窗口并存 + 迷你条动态机制 + 原生窗口控制（2026-10-06 晚，UI/shell）

- **App 界面与迷你条改为两个窗口并存**（如 Codex 软件本体与 pet 的关系，不再同窗口跳转）：
  - 外壳（tauri.conf）新增 `app` 窗口（1000×680，原生标题栏），main=迷你条（380×46）；capabilities 放行双窗口。
  - 迷你条 ⤢ = `show+set_focus` app 窗口；App 红色关闭按钮 = 隐藏不销毁（CloseRequested → prevent_close + hide，⤢ 可再唤出）；托盘新增「显示 App 界面」。
  - lib.rs：start_url_watcher 双窗口化（REMOTE_COMMITTED[main]/[app]）；REMOTE_INJECT 按 `agentpet-solid` meta 跳过透明化（App 窗口用原生标题栏，不再注透明 CSS）；webui/app.html 引导页（探活优先，避免与 main 引导页双拉服务进程）。
- **迷你条改动态单行机制**：始终显示「优先级最高（等你确认 > 出错 > 运行 > 思考）→ 最新」的会话，其余隐藏；⟳ 按钮轮换锁定（环回一圈恢复自动）；出现 waiting/error 紧急会话时自动抢占回最新；行内容 = `来源 · 标题 · 项目 · 模型 · 状态 · 计时 · ⏳`（可分辨会话×项目×agent）。无实时会话时显示聚合行。
- **App 用 macOS 原生窗口控制**：decorations=true（红=隐藏/黄=缩放/绿=全屏），移除自绘标题栏按钮。
- **拖拽 bug 修复**：根因是外壳注入脚本只认 `.titlebar` 挂 mousedown 拖拽，新版式没有该元素。迷你条改为自挂 mousedown → start_dragging（整条可拖，按钮除外），App 走原生标题栏。
- **验证**：cargo check 干净；`run.sh --install` 重建安装；受控启动日志确认 `REMOTE_COMMITTED[main]+[app]`、REMOTE_IPC_OK、单服务进程（app 引导页探活优先生效）；浏览器实测迷你条动态机制（自动跟随 CLAUDE 运行中会话 → ⟳ 锁定 DSH → 环回自动）；test-mini 重写 11 项、test-window 调整后 24 项全绿。

### 双窗启动即并存 + 迷你条定位为附属 + 区分命令行/桌面版本（2026-10-06 深夜）

- **启动即双窗并存**（此前 app 窗口 visible:false 依赖 ⤢ 唤出，跨窗口 show 若失效则"无法并存"）：app 窗口改为 `visible:true`——启动即 **App 主界面 + 迷你条同屏**，不依赖任何按钮；⤢/托盘仍是唤出/聚焦的补充路径。重建安装并受控重启实测：`REMOTE_COMMITTED[main]+[app]`、SHELL_NAVIGATE ×2、单服务进程。
- **迷你条定位为附属品**：App 是主界面（启动聚焦）；迷你条新增 ✕ 自隐藏按钮，App 头部新增「◧ 迷你条」开关（跨窗口 show/hide），托盘「显示悬浮窗」为保底唤回路径。
- **区分命令行版本与桌面版本**（每个会话/每软件可辨来源形态）：
  - 适配器新增 `variant` 字段：Claude ← `entrypoint`（本机实测 cli×13 / sdk-cli / claude-desktop-3p×243 / claude-vscode → CLI/桌面/IDE）；Codex ← `session_meta.originator`（Codex Desktop → 桌面，CLI 发起 → CLI）；Kimi ← `turn.prompt.origin.clientMetadata` 含 kimi_code_composer → 桌面，否则 CLI（本机 CLI 3 / 桌面 6）。
  - UI：来源徽标带形态（`CLAUDE·桌面` / `CODEX·桌面` / `KIMI·CLI`），迷你条同款；软件四态面板每行显示「CLI n · 桌面 m 会话」计数（实测 Claude Code：CLI 13 · 桌面 33 · IDE 4）。
- 验证：34 项验收（新增 MA8/MB7/MK10 形态断言）+ App 24 项 + 迷你条 11 项全绿；浏览器实测 App/迷你条徽标与面板计数。

### 实时会话退场 + 连接语义修正 + 软件状态独立页（2026-10-06 夜）

- **实时区自动隐藏已完成会话**：done/idle 状态超过 12s 的会话退出实时列表（此前每条跑完的会话都永久留在实时区）；历史区仍可查。
- **连接语义修正**（"没发消息就显示未连接"的误判根因）：「已连接」改为 = 观察通道健康——进程在跑 + 数据目录可读；不再要求 45s 内有写入。静默≠断连；活跃度单独表达（状态页显示「活动中 Ns 前 / 静默 Ns 前」）。DSH 维持插件 socket/事件流的真连接口径。实测三家开着即已连接（observe 通道）。
- **软件状态独立页**（不再挤在侧栏）：App 头部新增视图导航「会话 / 软件」——软件页为整页卡片视图（6 张卡：四态徽标、版本、观察通道、进程、活跃度、CLI/桌面会话形态计数、Kimi 计数、证据路径），与会话视图互斥不重叠；侧栏恢复纯项目列表。
- 验证：test-window 新增状态页场景断言（视图互斥/卡片/通道/活跃度/形态计数）全绿；实测 done 会话 12s 退场、三家 connected/observe、状态页 6 卡（4 已连接 + 2 未打开）。

### 已完成会话改手动隐藏 + 最终烟测回归（2026-10-06 深夜 II）

- **手动隐藏**（替换上一轮的 12s 自动退场）：已完成/空闲会话常驻实时区；工具栏「隐藏已完成 N」批量隐藏 + 行内 ✕ 单条隐藏；「恢复已隐藏 N」一键复原；被隐藏会话再次活动自动复现；偏好存 localStorage。修一处补丁失配导致的 loadHidden ReferenceError（浏览器烟测抓到）。
- **烟测新 bug（已修）**：投递目标会话的 cwd 被删除时 spawn 异步 ENOENT（pid undefined）被误报已投递——deliverViaCli 现判 pid 缺失为失败；验收脚本跳过 cwd 失效会话（ME3 复绿）。
- **最终烟测+回归**：9 套件通过（App 34 / 迷你 11 / 静态 31 / live 34 / 目录 15 / schema / replay / cli-control / html），正式版双窗+端点+四态+形态计数+手动隐藏闭环全部实测；报告见 qa/final-smoke-2026-10-06.md。

### 会话区三态视图：所有对话 / 完成会话 / 隐藏会话（2026-10-06 深夜 III）

- App 会话区新增分段控件三态切换：
  - **所有对话**：默认视图（实时 + 历史开关），历史行同样尊重手动隐藏；
  - **完成会话**：仅 state==='done' 的会话（实时 ∪ 历史，跨四源，不受历史开关限制）；
  - **隐藏会话（未活跃）**：手动隐藏集的专属管理视图——行内「恢复」按钮单条复原，与工具栏「恢复已隐藏」并存。
- 被隐藏会话再次活动自动复现的规则不变；隐藏偏好 localStorage 持久（跨刷新/重启）。
- 验证：test-window 新增三态断言（分段控件渲染/done 仅含完成/hidden 仅含隐藏集带恢复/清空复原）全绿；浏览器实测：完成页 22 条跨源、隐藏页恢复按钮、恢复后计数清零、持久化生效。

### 隐藏会话改为自动判定（1 小时活跃窗口）+ 正在活跃分区（2026-10-06 深夜 IV）

- 语义修正（用户反馈：无法识别隐藏会话）：「隐藏会话」不再依赖手动隐藏集合，改为**自动判定——1 小时内无消息活动的会话即不活跃（隐藏）**。进行中状态（思考/运行/等你确认/瞬态错误）无视窗口保持活跃——等审批的会话不会被藏掉。
- 「所有对话」视图新增**正在活跃 / 不活跃两个分区**（绿点「● 正在活跃 N」/ 灰「○ 不活跃（1 小时无消息）N」，历史行并入对应分区）；实测本机 13 活跃 / 29 不活跃自动分好。
- 三态视图重定义：所有对话（分区展示）/ 完成会话（仅 done，实测 22 条）/ 隐藏会话（自动不活跃，实测 29 条）。撤掉手动隐藏 UI（✕ / 隐藏已完成 / 恢复已隐藏）；framed 为实时会话新增 lastActiveMs（每事件刷新）。
- 验证：test-window 场景重写（分区归属 / 30 分钟前完成=活跃 / 2 小时无活动=不活跃 / waiting 超窗仍活跃）全绿；浏览器实测分区与三视图计数正确。

### 三档会话规则重定义（互斥完备）+ 计数键修复（2026-10-06 深夜 V）

- **规则重定义**（旧规则「完成」与「隐藏」重叠、命名与内容矛盾）——每会话按优先级**恰好归入一档**：
  ① 进行中（思考/运行/等你确认/瞬态错误）→ 活跃（不限时间）；② 完成且结束 ≤10 分钟 → 活跃（缓冲期反馈）；③ 空闲/持久出错且 1 小时内有消息 → 活跃；④ 完成且结束 >10 分钟 → 完成；⑤ 其余（空闲/出错超 1h 无消息）→ 隐藏（未活跃）。
- 三视图 = 三档互斥分档；活跃视图按「等你确认 > 瞬态错误 > 运行 > 思考 > 刚完成 > 空闲」排序，不再内嵌分区标题；分段按钮带规则 tooltip 与实时计数；空态文案说明各档规则。
- **计数键修复**：classify 返回 'active' 而计数键为 'all' 导致活跃计数恒 0（浏览器复测抓到）——统一分档键名。
- 验证：test-window 断言重写全绿（三档互斥归属/缓冲期/排序/waiting 超窗仍活跃）；实测 活跃 8（live 2 + 历史 6）/ 完成 21 / 隐藏 13，合计=全部会话。

### 四项修复：陈旧"思考中" / 完整会话列表 / CLI 与桌面端拆行（2026-10-06 深夜 VI）

- **陈旧"思考中"修复（根因）**：目录粗状态取"尾部最后一个信号"，会话被中断/废弃时停在 user/task_started（中间态）且无时效修正——死会话永远显示思考中/运行中。四家适配器统一加规则：**thinking/running 信号超 5 分钟无后续事件 → 降级 idle**（终态不受影响）。实测 claude 17 条、DSH 3 条、kimi 2 条陈旧态清零，仅保留真实运行中的会话。
- **完整会话列表**：去掉三处截断（framed 历史 40 → 全量；UI histPool 60 → 全量；侧栏未注册 12 → 100），实测 102 条全量展示。
- **CLI 与桌面端拆行**（参考 cc-switch 按安装位置/进程路径区分的方法）：local-agents 三家各拆两行（claude-code-cli / claude-code-desktop、codex-cli / codex-desktop、kimi-cli / kimi-desktop）——进程按路径特征分家（桌面=`.app/Contents`、`Claude-3p`、`Codex++`；CLI=裸二进制路径），安装证据分开（CLI=npm bin；桌面=App 包/App Support），版本分开（npm package.json vs PlistBuddy）；状态页 9 张卡片，每行带自己形态的会话计数（Claude CLI 14 / 桌面 34·IDE 4；Kimi CLI 5 / 桌面 5）。会话级区分不变（entrypoint/originator/composer）。
- **修复链**：scanLocalAgents 输出补 base/variantTag 透传（形态计数曾不显示）；状态页会话总数条件改通用。
- **完整测试**：6 套件回归 + --live 34 项（三家真实投递闭环）全绿；正式版重启终验（历史 102 全量、陈旧态 0、9 行软件拆分）。

### 手动隐藏回归（叠加在自动三档之上，2026-10-06 深夜 VII）

- 完整规则：**tierOf = 手动隐藏（且无新活动）→ 隐藏；否则按自动三档**。手动隐藏对任意状态会话生效（活跃的也能藏）；被隐藏会话**有新活动（lastActiveMs/updatedAt > hiddenAt）自动解除**；隐藏视图内手动项带「手动」徽标 + 行内恢复按钮，自动未活跃项不带；全部视图行内 ✕ 可隐藏，localStorage 持久（agent-pet-manual-hidden）。
- 验证：test-window 新增 4 断言（活跃会话可藏/藏后进隐藏视图带徽标与恢复/新活动自动解除/自动项无手动徽标）；浏览器实测 ✕ 隐藏 → 手动徽标 → 恢复清零全链路。
