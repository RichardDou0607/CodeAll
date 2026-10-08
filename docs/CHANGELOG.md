# 变更日志（文档与契约）

## 2026-10-08
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
