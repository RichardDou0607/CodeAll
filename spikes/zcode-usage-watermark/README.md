# Spike：ZCode 用量水位增量可行性（第 3a 步，2026-10-19）

只读回放真实库（`~/.zcode/cli/db/db.sqlite`，31,457 条 tokens 行 / 141k part 行），回答实现前的四个问题。
运行：`node spikes/zcode-usage-watermark/replay.mjs`（零写入）。

## 结论（实现依据）

| 问题 | 结果 | 对实现的影响 |
|---|---|---|
| S1 tokens⇒终态冻结 | **被推翻**：29,781/31,457 tokens 行处于中间态 `finish=tool-calls`（另有 `(null)` 175、`stream_recovery_discarded` 67）；终态（stop/completed/failed/interrupted）仅 1,434 | tokens 在长会话中**多次递增**——冻结假设只能表述为「终态后冻结；LRU 记忆期内 delta 可精确追账；淘汰后重见按冻结跳过（staleMiss 计数）」。本机实测：LRU 6000 下 staleMiss=0 |
| S2 part 重复 callID | 多行 `(sid,callId)` 组 = 0（本机无跨分钟重复） | partLru 去重键 `(sid,callId)`；容量内即可精确 |
| S3a 常驻回放（LRU 持久） | in/out 与全量真值**逐 token 一致**（6,252,130,308 / 29,585,025）；轮数 51,327、淘汰 13 批、staleMiss 0、单轮最大 46 行 | delta 算法（新−旧、负截 0）在可观测量事件流上收敛；单轮积压小，游标 iterate+yield 足够 |
| S3b 无持久化对照（每 200 轮丢 LRU） | in 少计 **4,952,925 tokens**（staleMiss 24：重启后行不在 LRU、tc 早于 LRU 最早条目 → 被跳过） | **LRU 必须随 checkpoint 持久化**（msgLru + partLru），否则重启即丢账 |
| S4 增量 SQL 耗时 | time_updated 预过滤 9.3ms vs 全量 json_extract 过滤 38.0ms（count 探针；无索引仍表扫，省的是 json_extract 常数） | 增量收益主要 = 少算行 + 免折叠；如实登记，不虚标 |

## 观测事件模型（回放方法的边界）

sqlite 只存行**当前状态**，历史不可回放。回放用可观测量构造：每行 = 插入@`time_created`（message 无 tokens 时不被查询命中）+ 终态@`time_updated`（最终 tokens）。该模型下 delta 算法收敛到真值；唯一风险路径是 LRU 淘汰/重启丢账——S3a/S3b 分别量化。

## lag 复核（与评审一致）

`time_updated−time_created`：p50=13.7s / p90=57.1s / p99=301s / max=2.35h；>60s 2,947 行、>5min 315 行——纯「watermark−固定窗」跳过规则会漏计大量首计行，故 staleMiss 规则定为「未命中 LRU **且** tc 早于 LRU 中最早条目的 tc」才跳过。
