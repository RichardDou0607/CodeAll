# 21 · 多 Agent 接入总体计划（v3，2026-10-06）

> 目标：**Agent 总控（AgentPet）统一控制本机多个 agent 软件，并控制部署在远端服务器上的 AgentOS 实例**——本地与远端并列显示状态、会话，并支持输入投递（观察 → 目录 → 控制）。
> **v3 变更（2026-10-06，用户方向确认）**：
> ① **首批接入范围锁定**：DSH（已完成）+ Claude Code + Codex + **Kimi Code（M-H 从 P1 提入首批）**；当前只更新计划，不启动开发。
> ② **终局架构定性（§6 新增）**：AgentPet = 总控；**本地域**直接控制各 agent 软件，**远端域**通过 AgentOS（自研执行体，每台服务器一个实例）控制多台远端服务器；M-J 重构为「本地观察 → 远端观察 → 远端控制」三步轨道。
> v2 变更（同日）：全盘软件盘点（§1，11 项）+ 里程碑 M-H/I/J/K + 排期与风险更新。
> 前置事实：契约 v1.3（docs/00）从第一天就是**多源设计**（`source` 字段 + per-(source,sessionId) seq）；本机格式已实测（scripts/scan-claude-transcripts.mjs、scan-codex-rollouts.mjs）；后端优先级与工作量估算见 docs/40-adapters.md。
> 本文是执行计划：分里程碑、每步有验收标准，且**只读先行**（观察 → 目录 → 控制）。

---

## 0. 不变的架构原则（DSH 接入验证过的）

1. **契约优先**：每个后端一个适配器，输出同一套规范事件；Hub（状态机/计时/聚合）与悬浮窗零改动复用。**远端 AgentOS 同样只是一个 `source`**（§6.3），不破坏此原则。
2. **会话列表的「真相源」因后端而异**：DSH = `workspace.json` 注册表；Claude Code = `~/.claude/projects/<cwd转义>/`（目录即项目）；Codex = rollout 的 `session_meta.cwd`（`parent_thread_id` 非空 = 子代理，不进列表）；AgentOS = `~/agentos/.state/conv`（本地）或远端同路径（SSH 只读）。适配器各自负责把真相源翻译成统一的 `catalog` 结构。
3. **状态口径**：会话创建 ≠ 思考中；来源级心跳不建会话行；子代理永远不进列表、不可选为投递目标。
4. **只读优先，控制殿后**：日志 tail / SSH 只读是零侵入观察；输入投递与新建会话必须走各后端的官方进程内/API 通道，**总控不存储、不触碰任何凭证**（SSH 凭证留在用户 ssh-agent/终端）。
5. **隐私红线**：转录文件含敏感内容，适配器只输出「状态级」字段（类型/计数/工具名/标题），事件帧不带消息原文（契约 §3 本就如此）；**远端回传事件同样只回状态级字段，不回传远端文件内容**。

---

## 1. 本机 agent 软件盘点（2026-10-06 全盘实测，v2 新增）

> 盘点方法：PATH/npm/brew 扫描 + `/Applications` Info.plist 逐个核对 bundle id + `~/Library/Application Support` 数据目录 + 运行进程。证据标记沿用 docs/40：**[A] 本机实测**（有命令要点），**[U] 未验证**（写明验证方法）。

### 1.1 盘点总表

| # | 软件 | 版本 [A] | 形态 | 数据/进程证据 [A] | 会话数据位置 | 接入分级 |
|---|---|---|---|---|---|---|
| 1 | **DeepSeek Harness（DSH）** | 0.2.0-rc.2 | 桌面 App（com.deepseek.dsh），**运行中** | ps 可见；`~/.dsh/{sessions,profiles}` | `~/.dsh/sessions/<cwd转义>/session-*/session.v4.jsonl.zstd` | **A 已接入**（Phase 1 完成） |
| 2 | **Claude Code** | CLI 2.1.278（npm 全局）+ VSCode 插件 2.1.286 | CLI + IDE 插件 | `/usr/local/lib` npm 全局；`~/.vscode/extensions/anthropic.claude-code-*` | `~/.claude/projects/*/*.jsonl`（本机 12 项目） | **A 首批**（M-A/M-D） |
| 3 | **Codex**（含 Codex++ 桌面壳） | Codex++ 1.3.0 与 1.2.44 双版本 + 管理工具 1.3.0 | 第三方桌面壳（com.bigpizzav3.codexplusplus）；**`codex` CLI 当前不在 PATH** | `~/.codex/{auth.json,sessions}`（32 个 rollout）；`~/.local/bin/codex-disk-*` 工具族 | `~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl` | **A 首批**（M-B/M-E；Codex++ 会话若落同一目录则自动覆盖 [U]） |
| 4 | **Kimi Code** | 1.0.4 | 桌面 App（com.kimi.code.desktop，Electron） | `~/Library/Application Support/kimi-code-app`（含 `Partitions/kimi-browser`） | Electron 存储（IndexedDB/LevelDB/日志），**位置待 spike** [U] | **A 首批**（M-H；v3 由 P1 提入首批，用户 2026-10-06 指定） |
| 5 | **KimiCU** | 0.6.6 | 桌面 App（ai.kimi.cu，Kimi computer-use，含 Overlay/Permissions 捆绑） | `/Applications/KimiCU.app`；`AS/KimiCU` | 待 spike [U] | **C 观望**（computer-use 范式，P2） |
| 6 | **OpenCode** | 桌面版（ai.opencode.desktop）；**CLI 当前不在 PATH** | Electron 桌面 + `~/.config/opencode/opencode.json` | `~/.local/share/opencode/{opencode.db(+wal),storage/session_diff,auth.json}` | SQLite（opencode.db）或 ACP | **B 后续接入**（M-I，首选 ACP；先做活跃度检查） |
| 7 | **AgentOS M1（`agent`）** | 自研（shell，484 行） | CLI 任务代理：长对话 + 单发 + 上下文勾选（`~/agentos`） | `~/.local/bin/agent`；`~/agentos/.state/{agent,conv,ctx}` | 纯文本状态文件（自研可控） | **B 战略项**（M-J 轨道；**远端执行体**，见 §6） |
| 8 | **CC Switch** | 3.20.4，**运行中** | Claude Code 供应商切换器（com.ccswitch.desktop） | ps 可见 | —（改写 `~/.claude` 配置） | **D 元信息**：读激活供应商给 CLAUDE-CODE 行加标签（M-K） |
| 9 | **Nowdex** | 1.1.7 | Codex 用量监控（org.randynamic.nowdex，RevenueCat 订阅制） | `/Applications/Nowdex.app`（含 CodexUsage 许可文件） | 读 `~/.codex` 用量 | **D 不接入**：竞品参照——证明「用量/配额展示」是真实付费需求 → 产品 backlog |
| 10 | **Claude.app / ChatGPT.app** | —（均运行中） | 聊天桌面 App | `/Applications` | 无本机可读会话 API | **E 排除**（无观察通道，见 §1.3） |
| 11 | **影刀 RPA** | — | RPA 自动化 | `/Applications/影刀.app` | 私有 | **E 排除**（超出「编码 agent 工作框」边界，Phase 3 再议） |

### 1.2 接入分级定义（v3 微调）

- **A 首批**：用户 2026-10-06 锁定的第一批——DSH（已完成）、Claude Code、Codex、Kimi Code。全部只差计划推进，控制通道殿后。
- **B 后续/战略**：v2 盘点新发现、值得接入但不在首批（OpenCode）；或承担终局角色（AgentOS = 远端执行体，§6）。
- **C 观望**：范式不同（computer-use / 屏幕覆盖层），观察价值待定，P2 不排期。
- **D 不接入但相关**：自身不产生 agent 会话，但提供元信息（CC Switch）或产品启示（Nowdex）。
- **E 排除**：无观察通道或超出产品边界；**写明理由，防止后续重复评估**。

### 1.3 排除理由明细（防止重复评估）

- **聊天类 App（Claude.app / ChatGPT.app）**：会话在云端，本地只有 Chromium profile 缓存，无可解析的结构化会话日志，也无 local API；强行解析缓存违反「不碰无稳定性承诺的存储」原则。若未来官方开放本地事件 API，重新评估。
- **影刀 RPA**：流程自动化范式（录制/回放），非 LLM 会话型 agent；接入语义（步骤级）与契约的 16 事件不匹配。Phase 3 若做「泛自动化统一工作框」再议。
- **Codex++ / Nowdex / CC Switch**：工具与壳，不是 agent 本体。Codex++ 作为 Codex 的启动器，其会话应仍落 `~/.codex`（M-B 验收时验证）；Nowdex 与 CC Switch 按 D 级处理。

---

## 2. 里程碑

> **v3 优先序**：首批 = M-A → M-B → M-H（观察层，配合 M-C 同窗展示）；控制层 M-D/M-E 随后；AgentOS 轨道 M-J1 提前为远端控制铺路；其余（M-F/M-I/M-K）W5+。

### M-A · Claude Code 观察适配（P0，估 5～7 人日）✅ **观察通道已落地（2026-10-06，`adapters/claude-code-adapter.mjs`）**

- **事件源**：tail `~/.claude/projects/*/*.jsonl`（增量读取，参考 `adapters/_reference/dsh-log-tail.mjs` 的多帧/半帧处理，此处是纯 JSONL 更简单）。
- **落地形态**：`scanClaudeCatalog()`（窗口化目录：头 24KB + 尾 160KB，本机 11 项目 / 48 会话，中位 ~18ms）+ `followClaudeLogs()`（多文件字节偏移增量 tail，1.2s 轮询，产出规范事件喂 framed.mjs 状态机）+ `mapClaudeLine()` 纯函数。
- **映射（已实现）**：`user`(非 sidechain) → `turn.start`；`user.tool_result` 块 → `tool.result`；`assistant.tool_use` → `tool.call`（category 复用 frame.mjs 的 categoryOf）；`assistant`(end_turn) → `message.assistant` + `turn.end(ok)`；`system/turn_duration` → `turn.end(ok)`；`system/api_error` → `error.raised`(fatal:false)；`custom-title`/`ai-title`/`agent-name` → `session.meta`(title)。`queue-operation` v1 不映射。
- **元信息**：标题（custom-title > ai-title > agent-name）、模型（assistant.message.model，CC Switch 切供应商后即时可见）、版本（行内 version）、cwd（行内 cwd，目录名有损仅兜底）；sidechain 行内标记逐行忽略（子代理回合不产生事件）。
- **验收**：`scripts/multi-source-check.mjs` MA1–MA7 全绿（真实 48 转录 + 纯函数断言 + 性能 <300ms）；实测本会话自身被实时跟随（running → 运行命令 → glm-5.3）。

### M-B · Codex 观察适配（P0，估 4～6 人日）✅ **观察通道已落地（2026-10-06，`adapters/codex-adapter.mjs`）**

- **事件源**：tail `~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl`。
- **映射（已实现）**：`session_meta` → `session.start`（cwd/cli_version）；`event_msg.task_started` → `turn.start`；`item_completed(CommandExecution/FileChange/McpToolCall)` → 计数器（工具事件走 response_item 通道避免重复）；`response_item.function_call/custom_tool_call` → `tool.call`（apply_patch→write、exec_command→exec 等）；`*_output` → `tool.result`；`task_complete` → `turn.end(ok)` + `message.assistant`(截断 280)；`turn_aborted` → `turn.end(aborted)`。
- **子代理**：`parent_thread_id` 非空 = 子代理线程（本机 32 个 rollout 中 19 个）——目录层不进列表；跟随器首遇文件时读 `session_meta` 判定，**整文件跳过不产事件**（防幽灵实时行）。
- **v2 补充（已验证）**：本机全部 rollout 的 `session_meta.originator="Codex Desktop"`——**Codex++ 桌面壳的会话确实落同一 `~/.codex/sessions` 目录**，单 root 覆盖，无需第二 root。
- **验收**：`scripts/multi-source-check.mjs` MB1–MB6 全绿（32 rollout：13 主 + 19 子代理；session_meta 首行实测 20~51KB，头窗口 96KB 覆盖；中位 ~19ms）。

### M-C · 多源目录合并与 UI（P0，估 3～4 人日）✅ **已落地（2026-10-06，`demo/framed.mjs` + `demo/window.html`）**

- framed.mjs 的 `multiCatalog()` 扫描三源（DSH workspace 注册表 / Claude Code 目录 / Codex rollout），5s 缓存，合计 ~55ms；快照 `sessions[]/catalog.projects[]` 带 `source` 与 `sources[]`（来源构成）。
- 项目分组：按 `cwd` 归一——DSH 侧栏顺序（workspaceIds）保留为基准；claude/codex 会话 ① cwd 命中 workspace.path → 并进该项目（source 列区分），② 未命中 → `path:<cwd>` 自立组（claude 与 codex 同 cwd 进同一组）；DSH 未注册会话仍归「未归入项目」。
- 实时层：`followClaudeLogs` + `followCodexLogs` 与 DSH 日志 tail/插件共用同一个 `applyEvent` 状态机（信封含 source；Kimi 无事件）。历史行跨源合并按更新时间排序（截 40）。
- 投递安全：投递通道仍只有 DSH——选中 claude/codex 会话为目标时，UI 目标行黄色警示「暂不支持投递（观察通道）」，服务端 `resolveTarget` 二次拦截（404 + M-D/M-E 说明），绝不静默投错后端；自动挑目标也只挑 DSH 主会话。
- **验收**：`scripts/multi-source-check.mjs` MC1–MC4 全绿（真实 framed 实例：多源历史行、`鹈鹕测试变体策划[dsh+claude-code+codex]` 同 cwd 归并、multi 标注、非 DSH 投递被拒）；`demo/test-window.mjs` 38 项断言全绿。**四源同窗演示目标中的三源（DSH/Claude/Codex）+ Kimi 四态面板已达成。**

### M-D · Claude Code 控制（P1，估 5～8 人日，方案待定）

候选通道（按侵入性排序，全部需 spike 验证后择一）：
1. **tmux/终端注入**：若用户在 tmux 里跑 `claude`，`send-keys` 到对应 pane（零官方支持，但零侵入 UI 最像 DSH 插件路径）。
2. **`claude --resume <id> -p`**：冷启动续会话发一条（官方 CLI 能力；会开新进程，事件经转录回看）。
3. **Agent SDK**：以 SDK 起托管会话（改动最大，仅当 1/2 不可接受）。
- **新建会话**：`cd <项目> && claude`（终端/tmux 新窗口）——无进程内 API，这是与 DSH 的本质差异。
- **验收**：悬浮窗输入 → Claude Code 会话收到并产生回合；新建的会话出现在列表。

### M-E · Codex 控制（P1，估 3～5 人日）

- `codex exec resume <id>` / `codex exec <cwd>`（官方 CLI；同 M-D 的终端通道复用）。
- **前置条件（阻塞项）**：`codex` CLI 当前不在 PATH（盘点 §1.1 #3）。落地前先 `npm i -g @openai/codex` 恢复，或定位 Codex++ 内置二进制路径；观察通道（M-B）不受影响（tail 的是磁盘文件）。

### M-F · ACP 统一通道（P1 杠杆，估 8～12 人日）

- 一次适配覆盖所有 ACP 客户端（契约映射已在 docs/40 §ACP 行验证可达 11 类）；OpenCode（M-I）是 ACP 的第一个目标受益者。

### M-G · 打包与常驻（P0，估 3～5 人日）

- **启动方式（已落地）**：`apps/shell/run.sh --install` 一次性装进 /Applications → 日常 Spotlight「AgentPet」一键启动（盘点确认 AgentPet.app 0.1.0 已装且在运行）；可选在 系统设置→登录项 加 AgentPet 开机自启。
- 剩余工作：把 framed.mjs 的能力（目录/输入/插件探测）收进外壳进程内或守护进程（路线图 M1 的 Hub 常驻形态）；多后端探测的启动耗时预算（当前 DSH 单源 19ms，加三源预计 <80ms）。

### M-H · Kimi Code 观察适配（**首批**，估 4～6 人日，v3 提入首批）✅ **Step 1 spike 完成 + Step 2 降级落地（2026-10-06，`adapters/kimi-code-adapter.mjs`）**

- **Step 1 · 数据定位 spike（完成）**：排查 `~/Library/Application Support/kimi-code-app` 全目录 + `~/Library/Logs` + 家目录：
  - **无 JSONL / SQLite / 日志目录**；会话数据只存在于 Chromium **Local Storage（LevelDB）**：`Local Storage/leveldb/{*.log,*.ldb}`，键名可见 `session_<uuid>`（本机 9 个去重）/ `draft` / `draft-snapshot` / `wd_workspace_<hash>` / `workspace-order`（键名来自 strings 级扫描，**未解码任何 value**）。
  - `Partitions/kimi-browser` 是内嵌浏览器分区；`ui-state.json`/`browser-tabs.json` 只有 UI/浏览器标签状态；`~/Library/Logs/kimi-code-app` 不存在；家目录无 `~/.kimi*`。
- **Step 2 · 降级（按 §4 风险分级执行）**：LevelDB 无稳定性承诺 → **不做 tail**。落地 `scanKimiStatus()`：进程存活（经 local-agents ps 注入）+ **近似会话计数**（`session_<uuid>` 键名去重，只读字节流、压缩块可能漏计 → 显式 approximate）+ LevelDB mtime 连接判定（45s 窗口）。`observes = ['session.heartbeat']`——**不产生任何会话行/事件**（契约红线：降级不得伪造）。
- **验收**：`scripts/multi-source-check.mjs` MH1–MH2 全绿；四态面板实测「已打开 · 未连接 ≈9 个会话」（Kimi 运行但 45s 无写入时）与「已连接（日志通道）」（有写入时）两种形态均可复现。
- **备注（已回填）**：docs/40 适配矩阵已补 Kimi Code 行（§0 表 #12 + §3.11，证据等级 [A]）。

### M-I · OpenCode 接入（P2，估 2～4 人日）

- **首选：ACP 通道（M-F）**——OpenCode 支持 ACP，一次适配多家；M-F 就绪后本项近乎免费。
- **备选：SQLite 只读快照**——`~/.local/share/opencode/opencode.db`（带 WAL）：读时 `cp` + 只读打开，10s 轮询出快照目录（不追求事件级，够 catalog + 粗状态）；**不做增量 tail WAL**（风险高于收益）。
- **前置确认**：OpenCode CLI 当前不在 PATH（桌面版数据仍在）。先看 `opencode.db` 最后写入时间判断是否仍在使用；已弃用则维持 P2。

### M-J · AgentOS 轨道：本地观察 → 远端观察 → 远端控制（战略项，v3 重构）

> 定位变更（用户 2026-10-06）：AgentOS 不只是本机一个待观察后端，而是**总控控制远端服务器的执行体**（§6）。本轨道三步走，J1 为 J2/J3 验证格式与 UI。

- **M-J1 · 本地 AgentOS 观察（P1，估 1～2 人日，排 W4）**
  - `~/agentos/.state/{agent,conv,ctx}` 纯文本状态文件（自研，格式零漂移风险）：任务受理/进行/完成 → `turn.start`/`working`/`turn.end`；`conv` 目录 → 会话目录。
  - 价值：① 本地先跑通 AGENTOS source 的目录/状态/输入全链路 UI；② 验证 `agent -s` 单发作为输入投递目标——这是远端控制（J3）的本地彩排。
  - 验收：悬浮窗出现 AGENTOS 行；输入投递经 `agent -s` 成功执行一条任务。
- **M-J2 · 远端 AgentOS 观察（Phase 3，估 3～5 人日/台，需远端测试机）**
  - SSH 只读 tail 远端 `~/agentos/.state/*`（或远端 agentos 后续提供的只读事件端口，[U]）；source 命名 `agentos@<host>`（§6.3）。
  - 验收：≥2 台远端机器的 AgentOS 会话同窗显示，按 host 分组；拔网线/断 SSH 触发远端版离线判定（§6.5）。
- **M-J3 · 远端 AgentOS 控制（Phase 3，估 4～6 人日，在 J2 稳定后）**
  - 输入投递：悬浮窗输入 → `ssh <host> agent -s "<任务>"`（单发优先）或续接指定对话；新建对话 = `ssh <host> agent new`。
  - 凭证边界：总控只调用用户 ssh-agent/终端既有凭证，**不存储、不代理、不落盘**；命令走白名单（仅 `agent` 子命令，不开放任意 shell）。
  - 验收：悬浮窗对远端会话发一条任务，远端 AgentOS 执行完成且状态回流显示；多台远端并行任务互不串扰。

### M-K · CC Switch 元信息（P2，估 0.5 人日）

- 读 CC Switch 当前激活的供应商配置（其改写 `~/.claude/settings.json`，具体锚点 spike 确认），在 CLAUDE-CODE 会话行 metaLine 追加供应商标签（官方 API / 中转名）。
- **价值**：多供应商用户看事件时能区分「这条走的是哪家」，也为 token 用量统计（Nowdex 验证过的需求）铺路。

---

## 3. 排期建议（按 1 人全职折算，v3 调整：Kimi Code 提前、AgentOS J1 提前）

| 周 | 内容 |
|---|---|
| W1 | M-A（Claude Code 观察）+ M-C 骨架 + **M-H Step 1（Kimi Code 数据定位 spike）** |
| W2 | M-B（Codex 观察，含 Codex++ 通路验证）+ M-C 收尾 + M-H Step 2；W2 末：**四源同窗演示（DSH/Claude/Codex/Kimi）** |
| W3 | M-G（打包常驻）+ M-D spike（tmux 注入 vs --resume） |
| W4 | M-D/E 落地（M-E 先恢复 codex CLI）+ **M-J1（AgentOS 本地观察，为远端轨道铺路）** |
| W5+ | M-F（ACP，首先覆盖 OpenCode）+ M-K；M-H 控制层视 Step 2 降级程度再定 |
| **Phase 3** | **M-J2/J3（远端 AgentOS 观察 → 控制，多台服务器舰队化）**——需远端测试机（可与 docs/30 的 Win11 验证机合并考虑） |

（与 docs/20-roadmap 的 Phase 2 并轨：M-A/B/C/H 对应「多 Agent 工作框」核心演示，M-G 对应分发；M-J2/J3 对应 §6 终局方向，进 Phase 3。）

## 4. 风险与对策（v3 增补远端控制 3 条）

| 风险 | 对策 |
|---|---|
| 转录格式漂移（Claude/Codex 迭代快） | 适配器对未知行类型「忽略+计数」（契约 §1.5）；scan 脚本进 CI 做格式哨兵 |
| 大文件性能（单行最大 1.8MB/5MB） | 只读尾部窗口 + 增量 offset（dsh-log-tail 已有同款算法）；标题/元信息只解首尾帧 |
| 控制通道不可行（M-D 全部候选失败） | 降级为「复制即所得」的本地队列（兜底已实现）；输入列为 P1 不阻塞演示 |
| 隐私（转录含密文/路径） | 状态级字段白名单；事件帧禁止消息原文（schema 校验器加断言）；远端回传同口径 |
| Windows（命名管道/路径差异） | Phase 2 后按 docs/30 的 Win11 验证机计划 |
| Electron 应用存储不稳（Kimi Code / OpenCode 桌面）【v2】 | 观察通道分级：JSONL > SQLite 快照 > LevelDB/IndexedDB（只 spike 不依赖）> 进程级兜底；`observes` 能力协商自动降级 UI，永不因存储升级断更 |
| 第三方壳与官方 CLI 数据目录分叉（Codex++）【v2】 | M-B 验收含 Codex++ 通路验证；分叉则 `KNOWN_AGENTS` 加第二 root（目录即真相源设计天然支持） |
| 已装未用/卸载残留误接入（opencode CLI 不在 PATH 等）【v2】 | 每个 B 级后端先跑「活跃度检查」（数据目录 mtime、进程），确认仍在用才排期；已弃用维持 P2 |
| **远端链路抖动误判离线（SSH 断连 ≠ agent 死亡）**【v3】 | 远端 source 的离线判定与本地分开调参（§6.5）；断连显示「链路中断」而非「会话结束」，重连后按 `resumeAfter` 续传补齐 |
| **远端控制的安全边界（命令注入/越权）**【v3】 | 投递只走 `agent` 子命令白名单；输入文本经 AgentOS 既有脱敏（凭证模式截断）；sudo 类仍由远端 AgentOS 拦截交还终端；总控不存凭证（§6.4） |
| **多主机规模（host 数量增长）**【v3】 | source 命名规范先行（§6.3）；目录 UI 按 host 折叠分组；SSH 连接池与轮询间隔做预算（首版 ≤5 台，超出再做事件推送通道 [U]） |

## 5. 本机现状快照（2026-10-06 更新，多源观察已上线）

- DSH：观察+目录+输入+新建+打开 全链路可用；AgentPet.app 0.1.0 已装 /Applications 且在运行（外壳自动拉起服务）。
- **Claude Code：观察通道已上线（M-A ✅）**——转录目录 + 实时 tail（本机 11 项目 / 48 会话；CC Switch 供应商切换后的模型名即时可见）；控制（M-D）未开始。
- **Codex：观察通道已上线（M-B ✅）**——rollout 目录 + 实时 tail（13 主 + 19 子代理；**Codex++ 会话确认落同一 `~/.codex/sessions`**，originator=Codex Desktop）；控制（M-E）未开始，codex CLI 仍不在 PATH。
- **Kimi Code：降级通道已上线（M-H ✅）**——LevelDB 近似计数 + 四态面板（≈9 会话）；无会话行（按红线不伪造）。KimiCU 维持 C 观望。
- **多源同窗（M-C ✅）**：framed.mjs 三源合并目录 + 双跟随器接入同一状态机；同 cwd 项目归并（实测 `鹈鹕测试变体策划[dsh+claude-code+codex]`）；投递目标守卫（非 DSH 明确拒绝）。
- OpenCode：桌面版数据 + `~/.config/opencode/opencode.json` 在，CLI 不在 PATH，活跃度待确认（P2）。
- AgentOS M1：`~/.local/bin/agent`（shell，484 行）+ `~/agentos` 文档齐全（含 INSTALL-AMD64.md，已有 Linux 安装路径），状态文件可直接读——**远端执行体候选，见 §6**（M-J1 排 W4）。
- 排除项：Claude.app / ChatGPT.app（聊天，无本机通道）、影刀 RPA（范式不符）——理由见 §1.3。
- 下一步（按 §3 排期）：W3 M-G（打包常驻）+ M-D spike（tmux 注入 vs --resume）；W4 M-D/E 落地（先恢复 codex CLI）+ M-J1。

---

## 6. 终局架构：总控双域模型与远端 AgentOS（v3 新增，用户 2026-10-06 定向）

> 用户原话定向：「**把这个 Agent 总控软件去控制多个 Agent 软件，并控制远端的 AgentOS**」。本节把该目标落成架构决策与演进路径；实现全部在 Phase 3（M-J2/J3），本节当下只约束设计，不启动开发。

### 6.1 双域模型

```
┌─────────────────────────── AgentPet 总控（Hub + 悬浮窗）───────────────────────────┐
│                                                                                    │
│  本地域（直接控制）                       远端域（经 AgentOS 执行体）                │
│  ├─ DSH（已完成）                        ├─ agentos@server-a  ── ssh ──▶ 服务器 A │
│  ├─ CLAUDE-CODE（M-A/D）                 ├─ agentos@server-b  ── ssh ──▶ 服务器 B │
│  ├─ CODEX（M-B/E）                       └─ agentos@win-vm     ── ssh ──▶ Win 机  │
│  └─ KIMI-CODE（M-H）                        （每台一个 AgentOS 实例 = 唯一入口）    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

- **本地域**：总控经各适配器直接观察/投递本地 agent 软件（首批四家，后续 ACP 扩展）。
- **远端域**：远端服务器上**不装各家 agent 桌面软件，只装 AgentOS**（自研、shell 实现、安装文档已有 AMD64 路径）；总控把每台远端机器看作一个 `source`，与本地 agent 完全并列。远端机器上如果也跑 Claude Code/Codex，同样**经该机 AgentOS 代理接入**（AgentOS 是远端唯一汇聚点，总控不为远端机器单独开 SSH 适配器）。
- 这样切的理由：① 远端入口收敛为一种协议（自研，零漂移）；② AgentOS 已内建安全模型（脱敏截断、sudo 拦截、NO_NEW_PRIVS、`~/.ssh` 零授权、SSH_AUTH_SOCK 清除），与总控「不碰凭证」原则同构；③ 本地适配器框架（契约/source/目录）零改动复用到远端。

### 6.2 控制语义分级（本地与远端统一口径）

| 能力 | 本地域 | 远端域 | 契约依据 |
|---|---|---|---|
| 观察（状态/会话/进度） | 日志 tail / 插件 | SSH 只读 tail（J2） | `observes` 能力协商（§5.2.1） |
| 输入投递（既有会话） | 各官方通道（M-D/E） | `ssh <host> agent -s`（J3） | `ctl:decide` + `canDecide` |
| 新建会话 | 终端/tmux 新窗口 | `ssh <host> agent new` | `ctl:session.new` + `canCreate` |
| 打开/查看 | session.open | 同左（只读快照） | `ctl:session.open` + `canOpen` |

### 6.3 source 命名规范（需 Lead 确认后写入契约附录，不破坏 v1.3）

- 本地后端：现有大写短名（`DSH` / `CLAUDE-CODE` / `CODEX` / `KIMI-CODE` / `AGENTOS`）。
- 远端 AgentOS：`agentos@<host>`（例 `agentos@server-a`）；`sessionId` 仍是该机 AgentOS 的对话 id。per-(source, sessionId) seq 天然隔离各机器，契约无需破坏性变更。
- 目录（catalog）在远端域按 host 折叠分组，与本地域按 cwd 分组并列（UI 层改动，不动契约）。

### 6.4 凭证与安全边界（红线，先于一切实现定死）

1. 总控**不存储、不代理、不落盘**任何 SSH 私钥/密码；只复用用户终端与 ssh-agent 的既有会话。
2. 远端投递命令白名单 = `agent` 子命令（`-s`/`new`/`conv` 等），**不开放任意 shell**；参数做注入转义。
3. 远端回传事件只含状态级字段（§0.5）；远端文件内容、转录原文不出远端机器。
4. AgentOS 既有安全设计（sudo 拦截交还终端、凭证模式截断、记录目录 0700）在远端继续生效，总控不绕过。

### 6.5 链路与离线语义（远端版）

- 远端 source 的「45s 离线判定」需按网络现实调参（建议初始 90s，另加重连指数退避）——SSH 断连 ≠ agent 进程死亡：断连显示「链路中断」，不清会话行；重连后按 `ctl:ack.resumeAfter` 续传补齐缺口。
- 首版规模预算 ≤5 台远端（SSH 轮询间隔 5～10s）；超出再评估常驻连接/事件推送通道（AgentOS 侧加只读事件端口，[U]，需 AgentOS 侧排期）。

### 6.6 与现有文档的关系

- docs/20-roadmap：Phase 3 需新增「远端 AgentOS 舰队」阶段（待 W1 排期会后补，本文先行定方向）。
- docs/40-adapters：AgentOS 行从「P2 观察」升格为「战略通道（本地观察 J1 / 远端 J2/J3）」；Kimi Code 行待 M-H spike 后补。
- docs/60-risk-register：远端控制相关风险（§4 v3 三条）待同步登记。
