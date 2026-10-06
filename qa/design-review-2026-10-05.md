# 设计审查问题清单（2026-10-05）

> **修复进度（2026-10-05）**：批次一已完成并验证 —— **A-1、A-2、A-3、A-4、A-6、A-7、E-1、E-2、G-5、F-5 已修复**（demo/framed.mjs、demo/window.html、demo/test-window.mjs、apps/shell/src-tauri/src/lib.rs；顺带修复了「队列复制按钮事件挂错元素」的死代码缺陷）。运行时已重启并全链路验证（401/403、删除、轮转 200 条、清空、0600、token 注入）。A-5（过期语义）待产品决策。
>
> 审查范围：`demo/`、`adapters/`、`plugins/`、`schema/`、`scripts/` 全部源码，并与 `docs/00-interface-contract.md`（FROZEN v1.3）、`docs/10-architecture.md`（ADR/NFR）交叉对照。
> 总体结论：**架构文档（适配器 / Hub / 契约分层）本身是合理的，问题在于实现从未向契约收敛**——状态机没有单一权威实现、契约版本号三处打架、schema 落后于文档、双数据源无仲裁、唯一的用户数据持久化点（输入队列）没有生命周期设计。
> 统计：**P0 × 6 · P1 × 12 · P2 × 11 · P3 × 2**（共 31 项）。
> 优先级口径：P0 = 数据丢失/安全/契约硬性违反；P1 = 功能正确性或常驻资源问题；P2 = 规格脱节/统计失真；P3 = 打磨项。

---

## 问题索引

| ID | 优先级 | 一句话描述 | 位置 |
|---|---|---|---|
| A-1 | **P0** | 输入队列无删除/清空 API | demo/framed.mjs |
| A-2 | **P0** | 输入队列 UI 无删除/重发/清空入口 | demo/window.html |
| A-3 | **P0** | `input-queue.jsonl` 只增不删、无轮转无上限 | demo/framed.mjs |
| A-4 | P1 | 队列明文 0644 永久留存，违反自家 §5.3（0600） | ~/.agent-pet/ |
| A-5 | P1 | `queued` 条目永不被消费、不过期、不补发 | demo/framed.mjs |
| A-6 | P1 | `/api/input` 永远返回 `ok:true`，混淆传输/投递成功 | demo/framed.mjs:404 |
| A-7 | P2 | 前端 send() 失败时输入文本丢失 | demo/window.html:171-179 |
| B-1 | **P0** | framed.mjs 双状态机并行，UI 渲染的是非权威那份 | demo/framed.mjs:171-193 |
| B-2 | P1 | 契约外状态 `running`/`ended` 混入三层 | demo/framed.mjs、window.html、dsh-meta.mjs |
| B-3 | P1 | `step.end(ok)`/`tool.result(denied)` 应 no-op 却改状态 | demo/frame.mjs:80 |
| B-4 | P1 | `transient-error` TTL 自动恢复无人实现（含参考实现） | 全部 5 份状态机 |
| B-5 | P2 | `done` 2 秒回 idle 未实现，done 成死终态 | 全部实现 |
| B-6 | P1 | 45s 离线未清空会话聚合，只翻标志位 | demo/framed.mjs:257-259 |
| B-7 | P2 | 10 分钟 stale 清理、失败 3 连击升级未实现 | 全部实现 |
| B-8 | P1 | 并发审批 resolve 后错误离开 `waiting` | demo/frame.mjs:96 |
| B-9 | P2 | `recoveredErrors` 在错误发生时计数（语义错） | demo/frame.mjs:83 |
| B-10 | P1 | 5 份状态机实现互不一致（真值表多处偏离） | 见 §B 明细 |
| C-1 | **P0** | 插件 + 日志 tail 双通道同时喂数，事件重复计数 | demo/framed.mjs:414-415 |
| C-2 | P1 | 插件订阅 error/close 双重连链 | demo/framed.mjs:83-84 |
| D-1 | **P0** | 插件 hello 声明 `contract:3`，契约/schema 规定 `1` | plugins/dsh-pet/index.js:34 |
| D-2 | **P0** | type 数量 16（契约/schema）/ 15（注释）/ 18（实际）三方打架；schema 缺 `session.meta`/`session.activity` | schema/pet-event.schema.json |
| D-3 | **P0** | 插件 APPROVAL_OUTCOME 把契约 §3.3 折叠表做反 | plugins/dsh-pet/index.js:207 |
| D-4 | P2 | README 写「v1.2 冻结」，docs/00 实为 FROZEN v1.3 | README.md:17 |
| E-1 | **P0** | TCP 7799 零认证零 Host/Origin 校验，本机任意进程/网页可向 agent 注入输入 | demo/framed.mjs:410 |
| E-2 | P1 | `esc()` 不转义引号，用户文本注入 HTML 属性 | demo/window.html:96,159 |
| E-3 | P2 | 插件 Unix socket 无鉴权（多用户机器为真实风险，未在文档标注） | plugins/dsh-pet/index.js |
| F-1 | P1 | Hub 去重 `seen` Set 无上限增长（内存泄漏） | demo/frame.mjs:48 |
| F-2 | P1 | 800ms 全文件 readFileSync + fs.watch 双触发 | demo/framed.mjs:247-264 |
| F-3 | P2 | 每 5s 全目录同步扫描 + 每 2s 全量 SSE 快照 | demo/framed.mjs:138-144,264 |
| F-4 | P1 | 插件在 DSH 主进程内做全量同步磁盘扫描（阻塞宿主） | plugins/dsh-pet/index.js:401-452 |
| F-5 | P2 | `persistInput` 记录的 sessionId 与实际投递目标不符 | demo/framed.mjs:309 |
| G-1 | P2 | 会话行按 label（basename）匹配项目，同名目录会串 | demo/window.html:120 |
| G-2 | P2 | 插件 `session/disposed` 一律 `reason:'unknown'`，丢弃真实原因 | plugins/dsh-pet/index.js:805-807 |
| G-3 | P2 | 契约 §9 依赖 PR 流程，但目录不是 git 仓库 | 仓库根 |
| G-4 | P3 | README 承诺的行数上限/折叠/高度公式未实现 | demo/window.html |
| G-5 | P3 | `/api/input` 超 8192 直接 destroy，无响应无状态码；且按字符不按字节 | demo/framed.mjs:397 |

---

## A. 输入队列生命周期（用户点名的问题）

队列是全项目**唯一的用户数据持久化点**，却没有任何生命周期设计。

### A-1 无删除/清空 API —— P0
`framed.mjs` 只有 `POST /api/input`（[framed.mjs:395](../demo/framed.mjs)），`persistInput` 只会 `appendFileSync`。全仓库（demo/adapters/plugins）grep 确认不存在任何 DELETE/清空/ack 消费端点。
**修复建议**：增加 `DELETE /api/input/:id`（删单条）与 `POST /api/queue/clear`（清空），服务端同步重写 `input-queue.jsonl`（写临时文件 + rename，避免半写）。

### A-2 UI 无删除/重发/清空入口 —— P0
[window.html:157-160](../demo/window.html) 队列项只有「复制」。
**修复建议**：每条加 ✕（删除）与 ↻（重发）；队列标题行加「清空」。

### A-3 文件只增不删、无轮转无上限 —— P0
`loadInputQueue(8)` 只限制**显示**最近 8 条，文件本身无限增长。架构文档 §4 给了 records（20MB×7 天）和 logs（5MB×3）的轮转规格，唯独没有输入队列的。
**修复建议**：追加后检查行数/字节，超限（如 200 行或 1MB）时保留最近 N 条重写；或按天分文件 + 保留 7 天。

### A-4 明文 0644 永久留存 —— P1
实测 `~/.agent-pet/input-queue.jsonl` 权限 `-rw-r--r--`，内容为用户发给 agent 的完整原文（≤2000 字符、未脱敏），违反架构文档 §5.3「录制类文件默认仅本机可读（0600）」的自定标准。目录下还有 `input-queue.jsonl.bak-20261005-135635`、`.bak2-141119` 两个**手工备份**——证明实际使用中只能靠手动挪文件清队列，且副本永久残留。
**修复建议**：创建文件时 `fs.writeFileSync(path, data, {mode: 0o600})`；提供清理后顺带提示删除遗留 `.bak`。

### A-5 `queued` 条目永无结局 —— P1
一旦配置了 `PET_INPUT_CMD` 或挂载插件，历史 `queued` 条目不会补发、不会过期、没有重试/丢弃语义，唯一结局是被反复读出来展示。
**修复建议**：定义队列语义——`queued` 仅在「无投递通道」时产生；通道可用时可手动「重发」（复用 A-2）；启动恢复时超过 X 天的 `queued` 标记 `expired`。

### A-6 `ok:true` 混淆传输与投递 —— P1
[framed.mjs:404](../demo/framed.mjs) 无论 `item.status` 是 `delivered/failed/queued` 都返回 `{ok:true}`，客户端无法区分。
**修复建议**：`ok` 表投递结果（delivered=true），`item` 带完整状态；或返回 HTTP 202 + 状态体。

### A-7 前端失败丢文本 —— P2
`send()` 先清空 textarea 再 fetch，失败时不恢复（[window.html:171-179](../demo/window.html)），与「断电后不丢用户发过的消息」的注释承诺矛盾。
**修复建议**：失败时 `el.value = text` 恢复 + 提示。

---

## B. 状态机：契约与实现系统性漂移

契约 §4 自称「唯一权威真值表」，但仓库里有 **5 份独立实现**：`demo/frame.mjs createHub`、`demo/framed.mjs applyEvent`、`adapters/_reference/hub-minimal.mjs`、`demo/assets/frame-player.js`、`scripts/replay-check.mjs`，互相不一致且都不符合契约。

### B-1 framed.mjs 双状态机并行，UI 渲染非权威那份 —— P0（结构性）
`applyEvent`（[framed.mjs:171-193](../demo/framed.mjs)）维护自己的 `state.sessions`，同时调用 `hub.apply(ev)`；而 `snapshot()` 的会话行来自 `state.sessions`，只有 `agg` 来自 hub。**用户看到的状态机不是被测试验证过的那份 Hub**。直接违反 ADR-2「Hub 独占状态机、渲染层无业务状态」。
**修复建议**：删掉 `applyEvent` 的状态维护，`snapshot()` 全部从 `hub.sessions` 投影（补齐 label/activity 字段到 hub 会话对象即可）；5 份实现收敛为 1 份（frame.mjs 的 createHub 提为共享模块，frame-player/replay-check 引用一个纯函数内核）。

### B-2 契约外状态混入 —— P1
- 契约状态集：`idle/thinking/working/waiting/error/done`（+`transient-error`）。
- framed.mjs 用 `running`（[framed.mjs:182](../demo/framed.mjs)），window.html 的 `STATE_LABEL/COLOR` 按 `running` 写。
- `dsh-meta.coarseState()` 输出 `running`/`ended`——`ended` 在 window.html 连颜色映射都没有（渲染成灰色原文）。
三套状态词汇表并存。
**修复建议**：统一映射为契约状态（`running→working`，`ended→done`）；coarseState 产出的状态只允许契约枚举值。

### B-3 no-op 分支改变了状态 —— P1
契约真值表：`step.end(ok)`、`tool.result(denied)` = no-op。实现里 frame.mjs 把 `step.start`/`step.end` 合并成同一个 case 置 `working`（[frame.mjs:80](../demo/frame.mjs)），framed.mjs 同样；`tool.result(denied)` 在 framed.mjs 置 `running`（「命令被拒绝」）。
**修复建议**：拆开分支，按真值表逐条对齐，并给 replay-check 加对应负例。

### B-4 `transient-error` TTL 无人实现 —— P1
契约 §4.7 明确 TTL 2s/1.5s 后自动回上一个稳定状态。hub-minimal 声明了 `TTL_TRANSIENT` Map 但**从不触发**（[hub-minimal.mjs:11](../adapters/_reference/hub-minimal.mjs)）；frame.mjs 记录 `sess.stable` 但从不使用。一旦进入瞬态错误，只能等下一个事件解救——UI 上会长期挂着「出错」。
**修复建议**：Hub 内用定时器实现 TTL 恢复 + `recoveredErrors` 计数；这是验收标准 §7.1「复现全部 6 个状态与 5 类特效」的一部分。

### B-5 `done` 成死终态 —— P2
契约：`turn.end(ok)` → `done` 2 秒后自动回 `idle`。所有实现置 `done` 后就停在那里。
**修复建议**：与 B-4 一并做成统一的「定时迁移」机制。

### B-6 45s 离线只翻标志位 —— P1
契约 §4.4 要求离线时「清空该 source 全部会话聚合与未决登记」。framed.mjs 只设置 `counters.offline`（[framed.mjs:257-259](../demo/framed.mjs)），会话卡片照旧显示旧状态。
**修复建议**：离线触发 `hub` 内按 source 清理会话 + 广播。

### B-7 stale 清理与失败连击未实现 —— P2
10 分钟 stale 清理（§4.5）、连续 3 次瞬态错误升级持久（§4.7）在所有实现中缺失。后端静默死亡时 UI 会永久显示「忙碌」——这正是该规则要防的场景。
**修复建议**：Hub 加一个 30s 巡检定时器，按 `lastStateChangeTs` 执行两条规则。

### B-8 并发审批恢复逻辑错 —— P1
所有实现按单个 request 的 `before` 恢复（[frame.mjs:96-99](../demo/frame.mjs)）。两个并发审批时，先 resolve 的会把状态拉离 `waiting`，而 `s.pending` 仍 >0，违反 §4.3「只要有未决即 waiting」。
**修复建议**：resolve 后若该会话仍有未决项，保持 `waiting`；否则恢复到「最早未决项的 before」。

### B-9 `recoveredErrors` 计数语义错 —— P2
在错误发生时 `++`（[frame.mjs:83](../demo/frame.mjs)），契约定义为「TTL 到期恢复时」计数。修复随 B-4。

### B-10 真值表偏离汇总 —— P1
除上述外：hub-minimal 的 `session.end` 不处理 `done` 分支（契约要求 → done）；`agent.status` 无 §3.4 的优先级/10s 时效/`force` 校验，直接覆盖。**修复建议**：以 replay-check 为基准，把 §4.2 真值表逐行写成参数化测试（每个 type × 每个分支一条），5 份实现共用一个内核后一次修复。

---

## C. 双通道重复喂数

### C-1 插件 + 日志 tail 同时运行，无仲裁 —— P0
[framed.mjs:414-415](../demo/framed.mjs) 无条件同时启动 `startFollower()` 与 `connectPlugin()`，插件连上后**日志 follower 不会停**。同一 DSH 事件走两遍（插件 <1ms 一遍、日志 ~250ms 一遍），且两条路径 seq 各自独立（插件自己的 `nextSeq`、日志 mapper 用原生 seq），Hub 去重键 `(source,sessionId,seq)` 拦不住；`applyEvent` 并行状态机更是零去重——计数翻倍、`pending++` 翻倍、审批重复登记（第二遍变 orphan）。
**修复建议**：插件连接成功即暂停日志 follower（`clearInterval` + 忽略 watch），插件失联再启用；或给两条路径的事件统一在进入 `applyEvent` 前按 `(type, ts, 关键 ID)` 二次去重。

### C-2 重连双链 —— P1
`subscribePlugin` 的 `error` 和 `close` 各自 `setTimeout(connectPlugin, 3000)`（[framed.mjs:83-84](../demo/framed.mjs)），断线一次会开出两条重连链 → 多个并发订阅连接，事件再次翻倍。
**修复建议**：加 `reconnecting` 守卫标志，或只挂 `close` 一个钩子。

---

## D. 契约版本与校验体系自相矛盾

### D-1 插件声明 `contract:3` —— P0（硬性违反）
[index.js:34](../plugins/dsh-pet/index.js) `CONTRACT = 3`，hello/ack/catalog 帧都带 `contract: 3`。而契约 §5.2、架构 ADR-4、schema（`hello.contract` 为 `const: 1`）都规定 `1`。**项目自己的校验器会拒收自己插件的握手帧**——「文档修订号 v1.3」被误当成了契约主版本。
**修复建议**：改回 `CONTRACT = 1`；在契约文档里再加一句显式警告「v1.x 是文档修订号，禁止填入 contract 字段」。

### D-2 type 数量三方打架，schema 落后 —— P0
v1.3 新增 `session.meta`/`session.activity` 后实际 **18 种** type；契约标题与验收标准仍写「16 种/16 行」（§3、§7.1）；framed.mjs 头注释写「15 种」；[schema 枚举](../schema/pet-event.schema.json)只有 16 个（无 meta/activity）——插件发的这两类事件会被自家 schema 判不合法，且被 `createHub` 计入 `unknownEvents`。
**修复建议**：schema 补两个 type；契约改为「以 schema 枚举为准」并去掉硬编码计数；framed.mjs 的 `applyEvent`/`createHub` 补 `session.meta`（更新会话元信息）与 `session.activity`（更新活动文案、no-op 状态）分支。

### D-3 APPROVAL_OUTCOME 折叠表做反 —— P0（硬性违反）
契约 §3.3：`unavailable/expired → timeout`；`rejected/cancelled → deny`。插件实现（[index.js:207](../plugins/dsh-pet/index.js)）：`unavailable: 'deny'`、`cancelled: 'timeout'`——**正好相反**。timeout 会触发瞬态 error 分支而 deny 不会，下游状态机行为完全不同。
**修复建议**：交换两个映射值，补一条单测。

### D-4 README 版本口径滞后 —— P2
[README.md:17](../README.md) 写「契约 v1.2 冻结」，docs/00 实为 FROZEN v1.3。冻结契约一天内改两版且文档互相打架，说明缺机器可读的唯一真相源（schema 落后于文档即证据）。
**修复建议**：README 同步 v1.3；长期看把「type 枚举、必填字段、真值表」全部下沉到 schema + 参数化测试，文档只写设计意图。

---

## E. 安全设计

### E-1 TCP 7799 零认证，丢掉了 Unix socket 的隐含鉴权 —— P0
架构 ADR-3 特意选 Unix domain socket，理由「本机零端口、零认证」——socket 文件权限即同用户鉴权。[framed.mjs:410](../demo/framed.mjs) 的本地服务监听 `127.0.0.1:7799` 后，这层隐含鉴权消失，又没有补任何 token：
- 任何本机进程可 POST `/api/input` **向用户 agent 会话注入指令文本**、`/api/new` 建会话、`/api/open` 恢复会话。
- 浏览器侧：`/api/input` 对 `text/plain` 也接受（JSON 解析失败当纯文本），任意网页可用表单直接投递；DNS rebinding 可绕过同源策略读写全部接口（服务端不校验 Host/Origin）。
**修复建议**（任选其一或组合）：① 启动时生成随机 token 写入 `~/.agent-pet/`（0600），页面由服务端注入 token，API 校验 `Authorization` 头；② 服务端校验 `Host` 必须为 `127.0.0.1:<port>`；③ POST 类接口校验 `Origin`/`Sec-Fetch-Site`。

### E-2 `esc()` 不转义引号 → 属性注入 —— P1
[window.html:96](../demo/window.html) 的 `esc()` 只处理 `&<>`；[window.html:159](../demo/window.html) 把用户文本拼进 `data-copy="…"` 双引号属性。含 `"` 的输入（如 `" onmouseover="…`）可注入属性（self-XSS，但输入会进 HTML 的本地 UI 恰恰最该防）。
**修复建议**：esc 补 `"'\`` 转义，或队列渲染改用 `textContent`/`dataset` 赋值。

### E-3 插件 Unix socket 无鉴权 —— P2
`$TMPDIR/agent-pet/dsh-plugin.sock` 任何能写该目录的进程均可连接并调用 `/input`（向 agent 注入）。单用户 mac 上 socket 权限可接受，但多用户机器是真实风险，文档未标注。
**修复建议**：`listen` 后 `fs.chmodSync(socketPath, 0o600)`；在 docs/54「权限与隐私边界」补一条说明。

---

## F. 资源与生命周期

### F-1 去重 `seen` Set 无限增长 —— P1
[frame.mjs:48](../demo/frame.mjs) 每个事件留一个 `(source|sessionId|seq)` 字符串键，永不回收。契约验收标准 §7.3 还要求长流 RSS 漂移 <5%，这个结构恰恰保证漂移。
**修复建议**：改为 per-`(source,sessionId)` 只记「最大连续 seq + 最近窗口内的 seq 集合」（乱序窗口本来就只有 2s/32 条）。

### F-2 800ms 全文件读取 + watch 双触发 —— P1
[framed.mjs:247-264](../demo/framed.mjs) 每 800ms `readFileSync` **整个**会话日志（本机最大 2.6MB）再从 offset 解码，外加 `fs.watch` 触发同一 `read()`。而 session-catalog.mjs 已实现窗口化读取（头 64KB 按需翻倍）——同一仓库两种 IO 策略，且全部同步阻塞事件循环。
**修复建议**：用 `fs.stat` 比较 size/mtime 决定是否读；只读增量 `subarray(offset)`；watch 加 100ms 去抖。

### F-3 常态开销超出 NFR 预算 —— P2
每 5s 一次全目录 `scanCatalog`（~19ms 同步阻塞）+ 每 2s 一次全量 SSE 快照（含 40 条 history + catalog + plugin info，可达数十 KB/次）。
**修复建议**：快照做增量（只推变化的会话）；catalog 改为 mtime 触发的按需扫描；SSE 心跳只推 `ts`。

### F-4 插件在 DSH 主进程内做全量同步磁盘扫描 —— P1
`buildCatalog`（[index.js:401-452](../plugins/dsh-pet/index.js)）在 DSH 主进程内 readdir/stat/读日志头，`catalog.get` 每次都全量扫，无缓存——违反架构 §8「桌宠绝不阻塞后端」的边界承诺。
**修复建议**：插件只报 live 会话（`agents.list()`，内存操作）；磁盘扫描一律由 framed.mjs 侧的 catalog 服务承担，两边按 sessionId 合并。

### F-5 审计数据错位 —— P2
`persistInput` 记录 `target?.session`（日志 follower 跟随的会话，[framed.mjs:309](../demo/framed.mjs)），而非插件实际投递到的会话（插件可能自行推断）。排障时会误导。
**修复建议**：`deliverInput` 把插件返回的 `sessionId` 回填 item 后再持久化。

---

## G. 其他

| ID | 描述 | 建议 |
|---|---|---|
| G-1 | 会话行按 label（workspace basename）匹配项目（[window.html:120](../demo/window.html)），两个同名目录的项目会串 | live 会话带上 `cwd`/`projectId`，按其匹配 |
| G-2 | 插件 `session/disposed` 一律发 `reason:'unknown'`（[index.js:805-807](../plugins/dsh-pet/index.js)），丢弃契约 enum 里可用的 done/aborted/error | 从 session 状态取真实原因，取不到才 unknown |
| G-3 | 契约 §9 规定「任何改动 = 一个 PR」，但目录不是 git 仓库（只有 .gitignore） | `git init` + 首次提交，否则变更流程无从谈起 |
| G-4 | README 承诺「行数上限 5、第 6 行折叠、高度 = 40+28×N」在 window.html 未实现（只有 max-height 滚动） | 实现折叠，或 README 标注「规格未落地」 |
| G-5 | `/api/input` 超 8192 直接 `req.destroy()`（[framed.mjs:397](../demo/framed.mjs)）——无响应无状态码，且按字符串长度不按字节（与契约 8192 UTF-8 字节口径不一） | 返回 413 JSON；用 `Buffer.byteLength` 判定 |

---

## 修复批次建议

1. **批次一：用户数据与安全（A-1~A-4、E-1、E-2）**——输入队列的删除/轮转/0600 + 本地服务 token/Host 校验。改动小、全在 demo 层，先堵住唯一的数据与注入面。
2. **批次二：契约收敛（D-1、D-2、D-3、B-1）**——`CONTRACT=1`、schema 补 18 type、折叠表交换、删掉 framed.mjs 并行状态机改从 hub 投影。做完这批，「契约是唯一真相源」才重新成立。
3. **批次三：正确性（C-1、C-2、B-4、B-6、B-8）**——双通道仲裁、TTL 恢复、离线清理、并发审批。以 replay-check 参数化真值表为验收。
4. **批次四：资源与打磨（F-1~F-5、其余）**——常驻内存/IO 收敛 + 统计口径修正。

> 每批完成后建议跑：`node scripts/check-fixtures.mjs`、`node scripts/replay-check.mjs --selftest`、`node demo/test-window.mjs`、`node schema/validate-pet-event.mjs fixtures/contract-sample.pet.jsonl`，并新增对应用例（尤其 B-4/B-8 的负例与 D-3 的折叠表单测）。
