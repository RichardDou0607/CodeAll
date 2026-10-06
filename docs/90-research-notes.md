# 90 · 调研原始证据

> 各队友在此记录可核验的来源与命令输出摘要（按小节署名）。

## 队友 A 段

> 负责人：pet-runtime-scout（T1）。记录 2026-10-05（Asia/Shanghai）本机实测与来源。原始日志：`spikes/*/artifacts/app-stdout.log`。

### A1 实测环境（命令 → 输出要点）

| 命令 | 输出要点 |
|---|---|
| `sw_vers` / `uname -a` | macOS 27.0.1 (Build 26A434) / Darwin 27.0.0 arm64 T8142 |
| `node -v` / `pnpm -v` | v24.18.0 / 12.9.1 |
| `swiftc --version` | Apple Swift 6.4 (swiftlang-6.4.0.34.1)，target arm64-apple-macosx27.0.0 |
| `rustc --version` | 初始**无 Rust**；本次 rustup `--profile minimal` 安装后 1.99.0 (b940084d7 2026-09-28) |
| `printenv \| grep -i electron` | **`ELECTRON_RUN_AS_NODE=1`**（继承自 DSH，导致 Electron 退化为 Node，spike 必须 `env -u`） |

### A2 体积 / 启动 / 内存（全部实测，方法：`du -sh`、spawn→READY 墙钟、`ps -o rss=`、`/usr/bin/footprint` phys_footprint）

| 栈 | 产物体积 | 启动 | 空闲 RSS 合计 | 空闲 phys_footprint 合计 |
|---|---|---|---|---|
| Tauri v2.12.1 | 二进制 3.9 MB / `.app` 4.0 MB | 475 ms（内部 t_ms=123） | 185 MB（93.6 app + 44.7 WebContent + 31.0 GPU + 16.0 Networking） | **57.1 MB**（23.0+17.0+12.0+5.1） |
| Electron 44.5.1 | 运行时 288 MB | 276 ms（内部 t_ms=144） | 375.3 MB（155.7+99.6+73.5+46.5，4 进程） | **89.2 MB**（39.0+22.0+21.0+7.2） |
| Swift 6.4 + AppKit | 122 KB | ≈411 ms（spawn→进程 352 ms + →READY 59 ms） | 45.0–47.3 MB（单进程，3 次采样） | **13.0 MB** |

- RSS 口径会把共享框架页在每个进程重复计入；`footprint` 的 `phys_footprint`（≈活动监视器"内存"列）更接近真实。**两个口径差 1.4–2.7 倍，验收指标必须指定口径。**
- Tauri 的 WKWebView 辅助进程由系统 XPC 启动、**不在进程树内**：用"启动前后 WebKit 进程 pid 差集"归属（脚本 `spikes/tools/footprint-sum.sh`）。
- 命令示例：`footprint -p <pid> | grep phys_footprint`；`node spikes/tools/tree-rss.mjs <pid>`。

### A3 窗口能力（独立工具交叉核对：`spikes/tools/bin/wininfo`，CGWindowList）

| 应用 | 输出 | 结论 |
|---|---|---|
| swift-pet | `layer=3 alpha=1.0 onscreen=true bounds=(x:735 y:423 w:240 h:240)` | 置顶成立（`NSWindow.level=.floating`） |
| tauri-pet | `layer=5 alpha=1.0 onscreen=true bounds=(x:735 y:423 w:240 h:241)` | 置顶成立（`alwaysOnTop:true`），层号与另两家不同 |
| Electron(44.5.1) | `layer=3 alpha=1.0 onscreen=true bounds=(x:735 y:436 w:240 h:240)` | 置顶成立（`setAlwaysOnTop(true,'floating')`） |

- 透明像素级证据（仅 Swift spike）：进程内 `cacheDisplay` 快照 → `SNAPSHOT ... corner_alpha=0.0 pet_alpha=0.0`。
- Tauri/Electron 的窗口级截图**失败**：`screencapture -x -o -l 2882` → `could not create image from window`（缺"屏幕录制"权限）→ 其像素级透明标 **未验证**。
- `NSView.hitTest` 在穿透 ON/OFF 两态都返回同一 view → **不能**用作穿透判定依据（实测反例，已写入 30 文档）。

### A4 契约接口验证（同一份 JSONL：`spikes/jsonl-feed/feed.mjs`）

| 验证 | 结果 |
|---|---|
| demo 11 条事件（session.start→…→agent.status） | Swift：`applied=7 states=thinking>thinking>working>working>working>waiting>idle`；Tauri：6 次 DOM 应用；Electron：7 次 DOM 应用 |
| 可见性证据 | 每态落一张 PNG，SHA-256 互不相同（`shasum -a 256 artifacts/*.png`）；同态两张哈希相同（符合预期） |
| 契约 §7.3 未知风暴 | `./run-spike.sh unknown-storm` → `FEED_DONE events=1000` / `SUMMARY applied=0 unknownEvents=1000`，无崩溃 |
| 握手/心跳/乱序 | **未实现**（spike 只验解析与状态驱动），留给正式骨架 |

### A5 本地依赖源码证据（比网页更硬，可 `grep` 复核）

| 事实 | 位置 |
|---|---|
| Tauri `set_ignore_cursor_events(bool)` | `~/.cargo/registry/src/*/tauri-2.12.1/src/webview/webview_window.rs:2260`（`window/mod.rs:2357` 同） |
| `macOSPrivateApi` → cargo feature `macos-private-api` | `tauri-utils-2.10.1/src/config.rs:3374`（serde rename）、`:3529` |
| `transparent`/`decorations`/`always_on_top`/`shadow` | `tauri-utils-2.10.1/src/config.rs:2063/2072/2078/2144` |
| 透明生效路径 `with_transparent` | `tauri-runtime-wry-2.12.1/src/lib.rs:1038,4740` |
| Electron `setIgnoreMouseEvents`/`transparent`/`setAlwaysOnTop` | `spikes/electron-pet/node_modules/electron/electron.d.ts:3392/4080/3197` |
| 版本 | Cargo.lock: `tauri 2.12.1`、`tauri-utils 2.10.1`；`@tauri-apps/api 2.12.1`；`electron 44.5.1` |

### A6 外部来源（访问日期 2026-10-05）

- Electron `BrowserWindow`（`transparent` 等）<https://www.electronjs.org/docs/latest/api/browser-window>（已抓取）
- Electron 自定义窗口交互 <https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions>（已抓取）
- Flutter `window_manager` 0.5.2（macOS/Windows/Linux）<https://pub.dev/packages/window_manager>（已抓取）
- Flutter `flutter_acrylic` `acknowledgeMouseEvents` <https://pub.dev/documentation/flutter_acrylic/latest/window/Window/acknowledgeMouseEvents.html>（未抓取）
- Wails v3 「Windows 上透明与穿透不可兼得」<https://github.com/wailsapp/wails/issues/5812>（仅搜索摘要，原文未打开）
- Godot `DisplayServer` <https://docs.godotengine.org/en/stable/classes/class_displayserver.html>（已抓取但关键词未命中 → 未验证）
- Godot 穿透资产 <https://store.godotengine.org/asset/jakub-hubacek/windows-mouse-passthrough/>（未核验）
- Qt `Qt::WindowTransparentForInput` <https://doc.qt.io/qt-6/qt.html>（本机不可达 → 未核验）
- Live2D SDK 授权 <https://www.live2d.com/en/sdk/license/> 、发布许可 <https://help.live2d.com/zh-CHS/sdk/>（本机不可达 → 未核验，**Phase 1 必须闭环**）
- Spine 运行时授权 <https://esotericsoftware.com/spine-runtimes-license>（本机不可达 → 未核验）

**本机网络**：可访问 electronjs.org / docs.godotengine.org / pub.dev / github.com（慢）；**不可访问** tauri.app、doc.qt.io、live2d.com、esotericsoftware.com、raw.githubusercontent.com、registry.npmjs.org、docs.rs。故 Tauri 事实改用本地 crate 源码作证据。

### A7 复现入口

`spikes/README.md`（三步复现 + 已知坑 7 条）；横向对照见 [30-implementation-stack.md](./30-implementation-stack.md) §4.4。

## 队友 B 段

> 负责人：product-experience（T2/T5）。记录 2026-10-05（Asia/Shanghai）实测命令与来源。**本机网络限制**：`www.live2d.com`、`esotericsoftware.com`、`github.com` 直连不可用；可用通道 = harness `web_fetch`/`web_search`、`api.github.com`、`api.npmjs.org`、`cdn.jsdelivr.net`、`store.steampowered.com/api`、`developer.apple.com`、`vrm.dev`、`eur-lex.europa.eu`、`npc.gov.cn`、`cac.gov.cn`。

### B1. 本机 DSH 事实（静态只读，未修改 /Applications）

命令：
```bash
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "/Applications/DeepSeek Harness.app/Contents/Info.plist"
# → 0.2.0-rc.2
ls -l "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"   # → 115.8 MB（asar）
node /tmp/asar-list.cjs   # 自写脚本：解析 asar 头部 JSON（offset16 起，长度 = u32@12），列出 12973 个文件
```

要点：
- `app.asar!` 顶层：`dsh/`、`node_modules/`、`lib/`、`renderer/`、`package.json`；`lib/` 仅 `main.js` + `preload-*.cjs`（**本次在 lib/ 未发现 Electron `Tray` 用法**）。
- `app.asar!/dsh/desktop-runtime.json`：`version 0.2.0-rc.2`、`hostProtocolVersion 4`、`nodeVersion 24.18.1`、`pnpmVersion 11.7.0`、`platform darwin`、`arch arm64`。
- `app.asar!/dsh/node_modules/@deepseek-ai/` 共 **290 个包**；含 `cordis 4.0.4`、`dsh-hook-protocol`、`dsh-hooks-claude-code`、`dsh-hooks-codex`、`dsh-desktop-host`（"Private Node-mode host process for the Electron desktop application"）、`dsh-client-ui-slots`、`dsh-client-ui-plugin-manager`、`dsh-client-hmr`。
- `dsh-hook-protocol/README.zh.md` 原文要点：「**只有 command 钩子会运行；`http`、`mcp_tool`、`prompt` 与 `agent` handler 会被跳过并给出警告**」；退出码 2 = 阻塞并以 stderr 为原因；其他退出码=非阻塞失败；「Claude Code 钩子可以请求确认而非直接阻塞；**Codex 桥接不呈现此选项**」；`hook/invoked`/`hook/result` 是仅日志事件（非 surface 事件）。
- 对项目的直接影响：**适配器必须是命令行可执行程序**（stdin JSON → Unix socket），不能依赖 http hook（见 docs/60 R-01）。

### B2. 外部许可原文（经 jsDelivr 抓取官方仓库原文）

| 来源 | URL | 实测 | 关键原文 |
|---|---|---|---|
| Live2D Cubism SDK | `https://cdn.jsdelivr.net/gh/Live2D/CubismWebSamples@develop/LICENSE.md` | 200，2648 字符 | 「*All business* users must obtain a Cubism SDK Release License. "Business" means an entity with the annual gross revenue more than ten million (10,000,000) JPY for the most recent fiscal year.」；组件走 Live2D Open Software License，Cubism Core 走 Live2D Proprietary Software License |
| Spine Runtimes | `https://cdn.jsdelivr.net/gh/EsotericSoftware/spine-runtimes@4.2/LICENSE` | 200，1469 字符（Last updated April 5, 2025） | 「...provided that **each user of the Products must obtain their own Spine Editor license** and redistribution ... must include this license and copyright notice.」→ 对面向终端用户分发的桌宠不可行 |
| VRM Public License 1.0 | `https://vrm.dev/en/licenses/1.0/` | 200，18697 字符 | 模型授权 = 每模型自带 License Settings + 本许可；含商用/改変/再分发开关 |

网络异常证据（用于说明为何未验证 live2d.com 链接）：
```bash
curl -sS -L -m 20 -v https://www.live2d.com/en/sdk/license/
# → 解析到 223.26.52.12；"SSL: no alternative certificate subject name matches target host name 'www.live2d.com'"
curl -sS -L -m 15 http://www.live2d.com/en/sdk/license/
# → harness 报 "cross-origin redirect to https://bl4.kkarhw.cn is not followed"（DNS/跳转劫持）
```

### B3. 竞品与市场数据（官方 API 实测）

- GitHub 元数据：`https://api.github.com/repos/<owner>/<repo>`（星标/许可证/最后推送），搜索 `https://api.github.com/search/repositories?q=...`。抽样（2026-10-05）：
  BongoCat ⭐23,790 Apache-2.0 Rust（Tauri+Live2D）；cc-haha ⭐14,863 MIT；Vibe Kanban ⭐28,264 Apache-2.0；Claude-Code-Usage-Monitor ⭐8,732 MIT；clawd-on-desk ⭐6,364 AGPL-3.0；Mate-Engine ⭐3,738；OpenPetsHQ/openpets ⭐1,261 MIT（plugin SDK + MCP）；agentpet ⭐376 MIT；oc-claw ⭐353；clawd-conduit ⭐180 MIT；claude-pets ⭐107 MIT；alterhq/openpets ⭐98 MIT；UniPet ⭐38 MIT。
- npm 下载（早期市场规模信号）：`https://api.npmjs.org/downloads/point/last-month/uni-pet` → `{"downloads":40}`；`.../clawd-pet` → 39（区间 2026-09-04～2026-10-03）。
- Steam 价格锚点：`https://store.steampowered.com/api/appdetails?appids=3301060&cc=us&l=english` → Desktop Mate `is_free=true`、`dlc` 24 项；`appids=3533450|3681420|3929250|4145000` → 均为 `$11.99`（原价 $14.99）。
- 竞品 README 原文（经 `https://cdn.jsdelivr.net/gh/<repo>@master/README.md`）：clawd-conduit「all 15 Claude Code lifecycle hook events」「The card **never auto-dismisses** (`permissionBubbleAutoCloseSeconds: 0`)」；UniPet「connectors send facts, while UniPet owns behavior, bubbles, and rendering」；BongoCat「Fully open source... no collection of user data. Works offline with no network access」。

### B4. 合规来源（本机实测可达）

- GDPR 全文：`https://eur-lex.europa.eu/eli/reg/2016/679/oj`（200）。
- 《个人信息保护法》全文：`http://www.npc.gov.cn/npc/c2/c30834/202108/t20210820_313088.html`（200，23761 字符）；网信办配套页 `https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm`（200）。
- Apple 公证：`https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution`（200）。
- Apple TCC/MDM 预授权 payload：`https://developer.apple.com/documentation/devicemanagement/privacypreferencespolicycontrol`（200）。
- 不可达（标 [未验证]）：`https://support.apple.com/guide/...`（unsupported content type）、`https://gdpr-info.eu/`（fetch failed）。

### B5. 复用脚本

`/tmp/asar-list.cjs`、`/tmp/asar-read.cjs`、`/tmp/asar-read2.cjs`：解析 Electron `app.asar` 头部并读取内部文件（只读，未改动任何 App 文件）。如需长期复用，建议由 Lead 决定是否移入 `scripts/`（当前不在我 write scope 内，未提交）。

## 队友 C 段

> 负责人：adapter-recon（T3）。记录 2026-10-05（Asia/Shanghai）本机实测与外部来源。完整分析见 [40-adapters.md](./40-adapters.md)。

### C1 本机实测证据（命令 → 输出要点）

| 命令 | 输出要点 |
|---|---|
| `/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "/Applications/DeepSeek Harness.app/Contents/Info.plist"` | `0.2.0-rc.2`（DSH 版本） |
| `node -v` / `node -e "typeof require('zlib').zstdDecompressSync"` | `v24.18.0` / `function`（Node 原生 zstd 可用） |
| `ls ~/.dsh/sessions/*/*/session.v4.jsonl.zstd` | 11 个会话日志；路径规则 `~/.dsh/sessions/<cwd 转义>/<sessionId>/session.v4.jsonl.zstd` |
| `node -e "zstdDecompressSync(readFileSync(p)).length"` | **366,642B → 209B**：单帧解压只出第一行（多帧陷阱，见 40 文档 §2.4） |
| `node scripts/dsh-session-to-pet.mjs <log> --agent-version 0.2.0-rc.2` | 11 个日志：帧 2,952 / 解帧失败 0 / 原生事件 5,257 / 规范事件 1,893 / 单事件最大 931B |
| `node scripts/check-fixtures.mjs` | fixture 40 行=37 事件+3 控制帧；16/16 规范 type；乱序窗口 2 条；orphan=0；6 状态全覆盖 → `✓ 全部测试通过（契约 v1.1）` |
| `node scripts/scan-claude-transcripts.mjs` | 289 文件 / 75,493 行 / 最大单行 1,803,475B；`tool_use=18,928`、`tool_result=18,961`；工具 Top：Read/Bash/Edit/Write/Agent |
| `node scripts/scan-codex-rollouts.mjs` | 32 文件 / 16,903 行 / 最大单行 5,093,685B；`item_completed.item.type`：Reasoning/AgentMessage/FileChange/SubAgentActivity/CommandExecution/McpToolCall |
| `ps -Ao pid,comm \| grep -i claude` | Claude Code **2.1.284** 在本机运行（`~/Library/Application Support/Claude-3p/claude-code/2.1.284/...`，Claude.app 2.19675.0） |
| `ls ~/.cursor ~/.gemini ~/.aider* ~/.copilot ~/.codex` | cursor/gemini/aider **未安装**；copilot（config+logs）与 codex（config.toml+sessions/auth.json）**已安装**；`~/.claude/settings.json` 无 hooks 配置 |
| `node -e '解析 app.asar 头'` | asar 内 12,973 个文件；抽出 `known-event-types.js`（58 个原生 type）、两个 hooks 桥 README、`@agentclientprotocol/sdk` 1.4.0（含 370KB schema.json） |

隐私说明：以上扫描**只统计类型名/字段名**，不打印任何消息内容；**未读取** `~/.codex/auth.json`、`~/.claude/.credentials.json` 等凭据文件。

### C2 外部来源（访问日期均为 2026-10-05；⭐ = 官方仓库原文经 jsDelivr 读取）

| 来源 | 结果 | 关键获知 |
|---|---|---|
| `https://code.claude.com/docs/en/hooks.md` | 200，85,900 字符 | Claude Code **33 个 hook 事件**（逐行抄录）、公共输入字段（`session_id/prompt_id/transcript_path/cwd/scratchpad_dir/permission_mode/effort`）、退出码 0/2/其他、`additionalContext` 等 10,000 字符上限 |
| `https://cursor.com/docs/hooks.md` | 200，47,682 字符 | Cursor **21 个事件**、`~/.cursor/hooks.json` 与 `.cursor/hooks.json`、`failClosed`/`loop_limit`、`CURSOR_*` 环境变量 |
| `https://geminicli.com/docs/hooks` | 200（仅导航） | 公告：「Gemini CLI was replaced by Antigravity CLI on June 18th, 2026」→ 战略降级理由 |
| ⭐ `cdn.jsdelivr.net/gh/google-gemini/gemini-cli@main/docs/hooks/index.md` + `reference.md` | 200 | Gemini CLI **11 个事件**、settings.json schema、退出码 0/2、stdin/stdout 严格 JSON |
| ⭐ `cdn.jsdelivr.net/gh/github/docs@main/content/copilot/concepts/agents/hooks.md` + `reference.md` | 200，7,225 / 48,032 字符 | Copilot CLI **8 个事件**、`.github/hooks/*.json` 与 `~/.copilot/hooks/*.json`、command/http handler、**PascalCase Claude 兼容载荷** |
| ⭐ `cdn.jsdelivr.net/gh/openai/codex@main/docs/config.md` | 200 | 官方确认托管 hook 策略 `allow_managed_hooks_only` |
| 第三方镜像 `cdn.jsdelivr.net/gh/mehmetbaykar/codex-docs-skill@main/.../hooks.md`（声明 source=`learn.chatgpt.com/docs/hooks`） | 200，41,732 字符 | Codex **12 个事件**（含 `Interrupt`/`SessionEnd`）、信任流程 `/hooks`、并发执行语义 —— 标 [C] 需官方复核 |
| 第三方镜像 `cdn.jsdelivr.net/gh/whit3rabbit/agent-config@main/docs/agents/windsurf.md` | 200 | Windsurf `.windsurf/hooks.json` 与 `pre_*/post_*` 事件名 —— 标 [C]，官方 docs.windsurf.com 本次不可达 |
| ⭐ `cdn.jsdelivr.net/gh/zed-industries/agent-client-protocol@main/docs/protocol/v1/{overview,prompt-turn,tool-calls}.mdx` | 200 | ACP 方法流与 `session/update` 11 个变体、`ToolKind` 10 值、`session/request_permission` |
| ⭐ `cdn.jsdelivr.net/gh/modelcontextprotocol/modelcontextprotocol@main/docs/specification/2025-06-18/index.mdx` | 200 | MCP 2025-06-18：server 只能看到自己的工具调用 → **不能做观测主通道** |
| ⭐ `cdn.jsdelivr.net/gh/Aider-AI/aider@main/aider/website/docs/{scripting,config/options}.md` | 200 | Aider 无 hooks；`--message/--stream`、`.aider.chat.history.md`、`.aider.input.history`、Python `Coder` API |
| `https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox.md` | 200，Apple 官方 | App Sandbox 容器互访边界（跨容器访问会弹权限询问） |

网络不可达（本次实测）：`github.com`、`raw.githubusercontent.com`、`learn.chatgpt.com`、`agentclientprotocol.com`、`docs.windsurf.com`、`developers.openai.com`（403）、`docs.claude.com`、`support.apple.com`。**对策**：GitHub 内容改走 jsDelivr（`cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>`），JS 渲染文档改读其上游 Markdown 源。

### C3 本任务交付物

- `docs/40-adapters.md`：逐后端矩阵、P0/P1/P2 优先级、4 张「规范事件 ← 原生事件」映射表、进程级降级设计、隐私边界、对契约 v1.1 的 8 条复核意见。
- `fixtures/contract-sample.pet.jsonl`：40 行（37 事件 + 3 控制帧），覆盖 16 个 type 字符串 / 16 行、6 状态、审批超时、乱序窗口、3 条未知 type。
- `scripts/check-fixtures.mjs`：契约 v1.1 自检（帧分类、逐 type 必填/枚举、seq 作用域与乱序窗口、approval/question 配对、§4.2 真值表回放）。
- `scripts/dsh-session-to-pet.mjs`：DSH 会话日志 → 规范事件的最小可行实现（多帧 zstd 解码已实测）。
- `scripts/scan-claude-transcripts.mjs` / `scripts/scan-codex-rollouts.mjs`：只读、脱敏的本机证据复现脚本。

## 队友 D 段

> 负责人：dsh-bridge-researcher（T7）。记录 2026-10-05（Asia/Shanghai）本机实测。**全程只读**：未改 /Applications/DeepSeek Harness.app、未改 ~/.dsh 现有文件、未干扰正在运行的 DSH 会话；实验产物在 /tmp/pet-probe/** 与项目内 schema/、adapters/。
> 主交付：[35-dsh-pet-bridge.md](./35-dsh-pet-bridge.md)；Schema：[../schema/pet-event.schema.json](../schema/pet-event.schema.json)；参考实现：[../adapters/_reference/dsh-log-tail.mjs](../adapters/_reference/dsh-log-tail.mjs)。

### D1. 会话日志 = 多帧 zstd 拼接（路径 A 的核心事实）

| 命令 | 输出要点 |
|---|---|
| `node -e "const z=require('node:zlib'),f=require('node:fs');console.log(z.zstdDecompressSync(f.readFileSync(process.argv[1])).length)" <log>` | **213** 字节 = 只有首行 `{"type":"session","version":4,...}`（文件本身 372 837 B） |
| 同上但用 `zlib.createZstdDecompress()` 流式 | 输出同样 **213** 字节 → 流式 API 也在第一帧末停止 |
| 扫描 magic `28 b5 2f fd` | 该文件 **171 处命中**（含压缩数据内偶发误命中），说明约 170+ frame |
| 结构化 frame 扫描（交付实现） | 376 273 B → **176 完整帧 / 305 行事件 / 0 行解析失败**；392 207 B → 185 帧 / 322 行；另一会话 166 945 B → **4 帧 / 179 行**（说明帧数≈批次，不由事件数决定） |
| `zstdcat <log>`（Lead 独立实测） | 完整解码，活动会话 416+ 行 |
| `zstd -l -v <log>`（Lead 独立实测） | 某会话 "Zstandard Frames: 259" |
| magic 扫描法（Lead 独立实测） | 410 帧 / 681 行 / **19 ms**，0 失败，5 会话全通过 |

结论：**「只能读到 session 头」的根因是多帧容器，不是权限/加密**。DSH 自己的 `dsh-session-persistence-jsonl/lib/index.js` 里就有 `scanZstdFrames`（magic + frame header + block header 结构扫描），交付实现与它同规则。

写批次窗口证据（源码 `enqueueLive()`）：

    this.batchTimer = setTimeout(() => { this.batchTimer = void 0; this.drainLive()... }, 200);

### D2. 追加写入 / 尾部半帧（torn tail）实测

命令：`node /tmp/torn-test.mjs <log>`（把日志复制到 /tmp 后切片/追加/半帧，源文件只读）

    [copy] frames 185 lines 322 tornStart undefined
    [torn cut=196103] frames 109 lines 199 tornStart 195928
    [torn cut=392200] frames 184 lines 320 tornStart 391357
    [append] frames 186 lines 323 last line {"type":"turn/end","seq":999,...}
    [torn-append] frames 185 lines 322 tornStart 392207

要点：追加=追加一个 frame；半帧起点可被精确定位；用 `ZSTD_e_flush` 做前缀恢复时只保留以换行收尾的完整行，半个 JSON 绝不出门；参考实现再叠一层原生 `seq` 高水位去重。

### D3. 路径 A 端到端延迟（实测）

方法：每 100 ms 轮询「最近修改的最多 3 个会话日志」，记录事件首次落盘可见时刻 − 事件自带 `time`。

    total 3258 samples；lag<10s 的 218 个：min 14 ms / p50 247 ms
    buckets {"<200":91,"200-300":67,"300-500":12,"500-1000":3,"1-2s":1,"2-5s":24,"5-10s":20}

72% 的样本 ≤300 ms，与 200 ms 写批次窗口吻合。p90/尾巴是测量伪影（只盯 3 个文件，被挤出 top-3 的会话会攒一批一次读到）。**结论：路径 A 延迟 ≈ 200 ms 批次 + 一个轮询周期。**

### D4. 路径 B（Cordis 用户插件）实测 —— 事实清单

| 命令 / 文件 | 输出要点 |
|---|---|
| `DSH_HOME=/tmp/pet-probe/home .../runtime/cli/bin/dsh --profile petprobe --dump-config` | 组合结果最后一行：`- id: pet-probe / name: file:///tmp/pet-probe/probe-plugin.mjs` → **补丁层 insert 支持本地文件路径** |
| 真启动该 profile（插件订阅 `ctx.on('session/event')`） | `{"t":"event",...,"seq":3,"type":"turn/start","time":1791173141586,"at":1791173141586}` → **time 与 at 差 0–1 ms（同步派发）** |
| 运行中改写该 profile 的 `cordis.patch.yml`（给插件加 config） | `grep -c plugin-applied` 由 1 → 2，新记录带 `{"marker":"hmr-v3"}` → **同进程热重载生效** |

扩展点（源码 `dsh-session/lib/index.js`）：`ctx.on('session/created' | 'session/event' | 'session/disposed')`，回调签名 `(session, event)`，`event = { type, seq, time, data }`。
注意：CLI **拒绝** `dsh --profile desktop`（名字保留给 Electron），所以验证必须在 /tmp 复制 profile 上做；在真实 desktop profile 上的端到端确认**未验证**（需用户授权改一行配置）。

### D5. 路径 C（hooks.json command hook）实测

| 命令 / 文件 | 输出要点 |
|---|---|
| profile 加 `@deepseek-ai/dsh-hooks-claude-code` + `configPath: /tmp/pet-probe/hooks.json` | 桥加载成功（无 skip 告警以外的报错） |
| 触发 `tools/pre-execute` / `tools/post-execute` 缝 | hook 进程真实启动，stdin 收到：`{"session_id":"","transcript_path":"","cwd":"/private/tmp","hook_event_name":"PreToolUse","tool_name":"bash","tool_input":{...},"tool_use_id":"call_probe_1"}`；PostToolUse 另带 `tool_response` |

延迟：两次 hook 时间戳相差 **33 ms**（≈单次 30 ms，Node 冷启动为主）。
覆盖：SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / SubagentStart / SubagentStop **共 7 点**；http / mcp_tool / prompt / agent 被跳过并告警（`parseClaudeCodeConfig` 的 `skipped`）。`transcript_path` **恒为空串**（源码注释：默认 zstd 日志对外部脚本不可读）。
缺口：无 step.*、无 message.assistant、无 approval.*（PermissionRequest 未桥接）、无 PostToolUseFailure。

### D6. 路径 D / D′ / E 的实测否决依据

    curl -s -i http://127.0.0.1:19387/
    HTTP/1.1 401 Unauthorized
    dsh web authentication required; reopen the URL printed by dsh web.

- 运行中的桌面 host（PID 59861）只监听 `127.0.0.1:19387` 的 Web HTTP/WS，**不是** JSON-RPC/ACP 端点。
- 每个会话目录有 `session.lock`，源码用 `tryLockExclusive`（`@deepseek-ai/node-addon-system/flock`）做内核级排他锁 → 第二个进程无法以 write 打开同一会话。
- cookie 签名密钥是 `ctx.credentials` 的 `client-connection/browser-session` 记录，本地存在 `$DSH_HOME/.credentials.yaml` → D′ 要碰用户密钥，不采用。
- MCP：`dsh-mcp-client` 是 DSH **作为 client 出站**连 MCP server；桌宠做成 MCP server 只能被 DSH 调用，**方向与观测相反**。

### D7. 契约一致性自查（可复跑）

    node schema/validate-pet-event.mjs --self-test
    # -> self-test OK (16 个事件 type + 4 种控制帧全部通过)
    node schema/validate-pet-event.mjs fixtures/contract-sample.pet.jsonl
    # -> {"knownValid":34,"controlFrames":3,"unknownTypes":3,"malformedLines":0,"invalidKnown":0}
    node adapters/_reference/dsh-log-tail.mjs --self-check
    # -> self-check OK：多帧 / 追加 / 半帧 / 基础映射 全部通过
    node adapters/_reference/dsh-log-tail.mjs --file <某个真实会话> > /tmp/replay.pet.jsonl
    node schema/validate-pet-event.mjs /tmp/replay.pet.jsonl
    # -> {"knownValid":165,...,"invalidKnown":0}

socket 握手也实测过（自建假 Hub）：

    node adapters/_reference/dsh-log-tail.mjs --file <log> --socket /tmp/pet-probe/hub.sock
    # stderr: 已连接 /tmp/pet-probe/hub.sock
    #         握手成功：contract=1 heartbeatMs=15000 canDecide=false
    # Hub 侧收到 165 条规范事件（hello → ack → 事件，契约 §5.2）

### D8. 来源（访问日期 2026-10-05）

- 本机 DSH 0.2.0-rc.2 包源码（只读 asar，自写 30 行解析脚本）：`dsh-session`、`dsh-session-persistence-jsonl`、`dsh-hooks-claude-code`、`dsh-hook-protocol`、`dsh-sdk-jsonrpc-server`、`dsh-acp`、`dsh-headless`、`dsh-client-connection`、`dsh-host-webserver`、`dsh-user-approval`、`dsh-tool-ask-user`、`cordis-plugin-loader`、`dsh-plugin-manager`、`dsh-app-boot`、`dsh`、`dsh-base/cordis.patch.yml`、`dsh-web-app/cordis.patch.yml`。
- RFC 8878 Zstandard 压缩格式（frame header / block header 布局）：<https://www.rfc-editor.org/rfc/rfc8878>（本机未抓取原文，按已知规范实现；如需引用请由 Lead 决定是否补抓）。
- Lead 独立实测（同任务并行）：zstd CLI v1.5.7 路径 `/opt/homebrew/bin/zstd`；magic 扫描法性能数据。
- 契约：[docs/00-interface-contract.md](./00-interface-contract.md) v1.1。

**未验证项（诚实标注）**：真实 desktop profile 的插件挂载与 HMR、`llm/retry` 的完整 data 字段、`session.end` 在正常退出 vs `kill -9` 下的区分、45 s 离线判定的真实表现。验证方法见 [35-dsh-pet-bridge.md](./35-dsh-pet-bridge.md) §12。

---

## 队友 G 段

> 负责人：session-catalog（T12）。记录 2026-10-05（Asia/Shanghai）本机实测。完整结论见 [52-session-catalog.md](./52-session-catalog.md)。

### G1 交付物与复跑命令

    node adapters/dsh-meta.mjs --selftest        # 45/45 通过（纯函数单测）
    node scripts/catalog-check.mjs               # 15 项断言全过（真实数据 + 性能）
    node adapters/session-catalog.mjs --bench 10 # 目录树 + 10 轮耗时
    node adapters/session-catalog.mjs --json --frame    # 契约 §2.2 ctl:catalog 载荷
    node adapters/session-catalog.mjs --deep     # 整文件深扫（精确元信息）

### G2 本机实测数据（2026-10-05 13:15）

    $ node scripts/catalog-check.mjs --runs 10
    本机实际：3 个项目 / 16 个会话（主 8 · 子代理 8 · 活跃 2 · 降级 0）
    性能：10 轮 min 15.1 / 中位 16.4 / max 22.5 ms（阈值 300 ms；实际读取 1722 KB）

- 任务书写的是「12 个会话」，实测已 **16 个**（队友子代理会话在增长）→ 自检断言用 `≥12`。8 个是 `origin==='subagent'` 的子代理会话，UI 必须能与主会话区分。
- 快扫 = 只解**前 8 帧 + 末 2 帧**，只读文件头/尾窗口（不整文件读入）：16 会话 **16.4 ms**、读 1.7 MB。深扫（整文件 14.2 MB）**203 ms**。两者都 < 300 ms，但只有快扫随会话数线性可扩展。
- 诚实差异：快扫 vs 深扫在本机 **2/16（12.5%）** 会话上不一致（会话中途换过模型/标题，最后一次元信息事件落在第 8 帧之后、倒数第 2 帧之前）→ 自检 A12 把它固化成受控指标，详情面板用 `--deep`。

### G3 字段来源（实测，两条曾被写错的）

| 字段 | 来源原生事件 | 证据 |
|---|---|---|
| `provider/model/reasoningEffort` | `request/header` → `data.header.config`（生效值）；回退 `model/selection`、`subagent/descriptor` | 13/16 会话取自此；`session-e50dd07b` 走 `model/selection` 得 `deepseek-v4-pro/high` |
| `title` | `session/title` → `data.title`；子代理会话优先 `subagent/descriptor` → `data.label` | 子代理 `session/title` 是 `<system-reminder>…` 回显，label 才是「T12 会话目录与元信息解析」 |
| `agentPreset` | `agent-preset/selected` → `data.agentPreset`；回退 header.`agentPreset` | `session-4e6c3d30` = `cordis`；**不是** `permission/preset` 的 `data.preset` |
| `agentVersion` | app bundle：`Info.plist CFBundleShortVersionString` = `@deepseek-ai/dsh/package.json` = **0.2.0-rc.2** | header 的 `version`=4 是**日志格式版本**，不是应用版本（自检 A5 专门盯这个） |

目录名 `--Users-…-agent~684C~5BA0--` 是 DSH `projectKey()` 编码（有损）；**cwd 权威来源是 header.cwd**，自检 A11 用真实 cwd 反推编码与磁盘目录名 3/3 吻合。

### G4 flock 独立复核（与 D 段结论一致，独立路径）

用 DSH 自带原生插件 `node-addon-system-darwin-arm64/bin/system.node` 的 `tryLock(fd,cb)` 直接探测（errno 0=空闲 / 35=EAGAIN=被占用；先在 /tmp 用 python `fcntl.flock` 做对照校准）：

    HELD: session-0a1b2c3d（GUI 主会话，PID 59861）/ 4e5f6a7b、5f6a7b8c（正在跑的子代理）
          session-1b2c3d4e、session-2c3d4e5f（GUI 仍持有写句柄）
    FREE: 77245dbf / eace28a4 / 12177095 / 09403664 / ca4a05f5 / 2bcb0062 / 4e6c3d30 / 7343d83b / e50dd07b / 6f304224 / ed4bcf8d

源码：`dsh-session-persistence-jsonl/lib/index.js` —— 非阻塞 `flock(2)` on `session.lock`，write-open 取锁、close 释放，争用 → `SessionAlreadyOwnedError`，读者不碰锁。

### G5 「打开 / 新建」的本机实测（命令 + 退出码）

    $ dsh --help                                  # exit 0（CLI 真实存在，入口 = app.asar 内 dsh-desktop-host/lib/cli.js）
    $ dsh --profile desktop --help                # error: profile "desktop" is managed exclusively by the Electron application ; exit 1
    $ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:19387/    # 401（密钥在 .credentials.yaml，未读取未使用）

源码证据（未实测，因为都要写 `~/.dsh`）：`dsh-headless --session-id <id>` = 「adopt the persisted Session」；但 `assertAdoptable()` 硬拒 `origin==='subagent'` / 有 `parentSession` / 无 `cwd` / cwd 不匹配的会话 —— 即本机 8 个子代理会话**结构上不可能**被这样打开。新建则对应 `ctx.agents.create()` / `ctx.sessions.create(sessionId,{meta})`（dsh-agent / dsh-session README），需要 Phase 2 插件落到用户 profile。

**结论（能力位应诚实）**：`canCatalog=true, canOpen=false, canCreate=false`。Phase 1 的「打开多个项目/会话」= 只读多会话视图（不需要真的打开）；「新建会话」= 把 `dsh headless "…"` 命令复制给用户，由用户自己在终端执行。

### G6 隐私与红线

- activity 文案全部来自**固定字典**（思考中/读取文件/修改文件/运行命令/联网检索/撰写回复/等待你/…），结构上不可能带出步骤序号、工具参数、命令原文；自检 A7 用真实日志里的命令片段当探针断言零泄漏。
- 全程只读 `~/.dsh/sessions/**` 与 `~/.dsh/storages/workspace.json`；**未读取** `.credentials.yaml`；未启动任何占用 19387 的进程；实验文件都在 /tmp。
- 未实测项已在 [52-session-catalog.md](./52-session-catalog.md) §9 逐条列出（headless 启动、插件 API 实际调用、cp -R 后启动）。
