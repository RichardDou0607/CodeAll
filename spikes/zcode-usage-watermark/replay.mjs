#!/usr/bin/env node
/**
 * spikes/zcode-usage-watermark/replay.mjs — ZCode 用量水位增量的只读可行性 spike（第 3a 步）
 *
 * 要回答的三个问题（实现前必须证实，否则「测试通过、账不对」）：
 *   S1 冻结假设：tokens.input 非空的 message 行是否都已带终态 finish（tokens 只在终态一次写入、
 *      此后不再变）→ 若成立，message LRU 淘汰无漏账风险（被淘汰的行不会再更新）。
 *   S2 跨轮重复：part 的 (session_id, callID) 是否存在跨 >60s 的多次写入（淘汰后重见 → toolCalls 潜在多计）。
 *   S3 回放等价：用可观测量构造事件流（每行 = 插入@time_created + 终态@time_updated），模拟
 *      「60s 轮 + 2s 重叠 + 水位单调 + LRU 6000/batch2000」增量算法，末态对账全量真值；
 *      同时对比「LRU 不持久化（重启即丢）」的偏差，量化 checkpoint 持久化 LRU 的必要性。
 *   S4 增量 SQL 形状的本机耗时（time_updated 无索引：预期仍全表扫，但省 json_extract 常数）。
 *
 * 只读真实库（~/.zcode/cli/db/db.sqlite，readOnly），不写任何数据。运行：node spikes/zcode-usage-watermark/replay.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB = process.env.ZCODE_DB || path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
if (!fs.existsSync(DB)) { console.error('无 ZCode 库：' + DB); process.exit(0); }
const db = new DatabaseSync(DB, { readOnly: true });

// ---------- S1：tokens ⇒ 终态 finish（冻结假设的直接证据） ----------
const finRows = db.prepare(`
  SELECT COALESCE(json_extract(data,'$.finish'), '(null)') fin,
         json_extract(data,'$.tokens.input') IS NOT NULL hasTok,
         COUNT(*) n
  FROM message WHERE json_extract(data,'$.role')='assistant'
  GROUP BY fin, hasTok ORDER BY n DESC`).all();
const terminal = new Set(['stop', 'completed', 'failed', 'interrupted']);
let tokRows = 0, tokTerminal = 0, tokNonTerminal = [];
for (const r of finRows) {
  if (r.hasTok) { tokRows += r.n; if (terminal.has(r.fin)) tokTerminal += r.n; else tokNonTerminal.push(r); }
}
console.log('S1 tokens⇒终态：' + tokTerminal + '/' + tokRows + ' 行 tokens 行带终态 finish'
  + (tokNonTerminal.length ? '；⚠ 非终态带 tokens：' + JSON.stringify(tokNonTerminal) : '；✅ 无反例（tokens 只在终态写入一次）'));
console.log('   finish×tokens 分布：' + finRows.map((r) => r.fin + (r.hasTok ? '∧tok' : '∅tok') + '=' + r.n).join(' · '));

// ---------- lag 复核（评审口径）+ 观测事件规模 ----------
const lag = db.prepare(`
  SELECT time_created tc, time_updated tu FROM message
  WHERE json_extract(data,'$.role')='assistant' AND json_extract(data,'$.tokens.input') IS NOT NULL`).all();
const ds = lag.map((r) => r.tu - r.tc).sort((a, b) => a - b);
const q = (p) => ds[Math.min(ds.length - 1, Math.floor(ds.length * p))];
console.log('   lag（time_updated−time_created，ms）：p50=' + q(0.5) + ' p90=' + q(0.9) + ' p99=' + q(0.99)
  + ' max=' + ds[ds.length - 1] + '；>60s=' + ds.filter((d) => d > 60_000).length + ' >5min=' + ds.filter((d) => d > 300_000).length);

// ---------- S2：part (sid,callID) 跨 >60s 的重复 ----------
const dup = db.prepare(`
  SELECT session_id sid, json_extract(data,'$.callID') callId, COUNT(*) n,
         MAX(time_updated) - MIN(time_updated) spread
  FROM part WHERE json_extract(data,'$.type')='tool' AND json_extract(data,'$.callID') IS NOT NULL
  GROUP BY session_id, json_extract(data,'$.callID') HAVING n > 1 ORDER BY spread DESC`).all();
const crossMinute = dup.filter((r) => r.spread > 60_000);
console.log('S2 part 重复 callID：多行 (sid,callId) 共 ' + dup.length + ' 组，其中跨 >60s ' + crossMinute.length + ' 组'
  + (crossMinute.length ? '；最大 spread=' + crossMinute[0].spread + 'ms' : '；✅ 重复均落在同轮/重叠窗内（LRU 期内可去重）'));

// ---------- S3：可观测量事件流回放 ----------
// 事件模型：每行两个可观测量——插入（tc，message 无 tokens 时不被查询命中）与终态（tu，最终 tokens）。
// 算法 delta-收敛：只要终态事件被取到（tu > 水位−重叠），累计值收敛到真值；风险只在 LRU 淘汰/重启丢账。
const msgs = db.prepare(`
  SELECT id, session_id sid, time_created tc, time_updated tu,
         CAST(json_extract(data,'$.tokens.input') AS INTEGER) input,
         CAST(json_extract(data,'$.tokens.output') AS INTEGER) output,
         CAST(json_extract(data,'$.tokens.cache.read') AS INTEGER) cr,
         CAST(json_extract(data,'$.tokens.cache.write') AS INTEGER) cw
  FROM message WHERE json_extract(data,'$.role')='assistant' AND json_extract(data,'$.tokens.input') IS NOT NULL
  ORDER BY time_updated`).all();
const truthInput = msgs.reduce((a, r) => a + (r.input || 0), 0);
const truthOut = msgs.reduce((a, r) => a + (r.output || 0), 0);

function replay({ lruPersistAcrossRestart, restartEveryRounds }) {
  const lru = new Map();                    // id → {input,...}（已计入值）；Map 序 = LRU 序（touch 时 delete+set）
  let wm = -Infinity, accIn = 0, accOut = 0, staleMiss = 0, evictions = 0, fetched = 0, rounds = 0, maxBacklog = 0;
  const ROUND = 60_000, OVERLAP = 2_000, CAP = 6000, EVICT = 2000;
  const t0 = msgs.length ? msgs[0].tu : 0, t1 = msgs.length ? msgs[msgs.length - 1].tu : 0;
  let i = 0;
  const touch = (id, v) => { lru.delete(id); lru.set(id, v); if (lru.size > CAP) { let k = 0; for (const key of lru.keys()) { lru.delete(key); if (++k >= EVICT) break; } evictions++; } };
  for (let roundEnd = t0 + ROUND; roundEnd < t1 + ROUND; roundEnd += ROUND) {
    rounds++;
    if (restartEveryRounds && rounds % restartEveryRounds === 0 && !lruPersistAcrossRestart) lru.clear();   // 重启即丢 LRU（无持久化对照）
    let backlog = 0;
    while (i < msgs.length && msgs[i].tu <= roundEnd) {
      const r = msgs[i++]; backlog++; fetched++;
      if (r.tu <= wm - OVERLAP) continue;                       // 重叠窗外（水位回放中不会出现；防御）
      const old = lru.get(r.id);
      if (old) {
        accIn += Math.max(0, (r.input || 0) - old.input); accOut += Math.max(0, (r.output || 0) - old.output);
      } else {
        // staleMiss 规则：未命中且 tc 早于 LRU 中最早条目的 tc → 视为冻结期外更新，跳过并计数
        let minTc = Infinity; for (const v of lru.values()) minTc = Math.min(minTc, v.tc);
        if (lru.size && r.tc < minTc) { staleMiss++; continue; }
        accIn += r.input || 0; accOut += r.output || 0;
      }
      touch(r.id, { input: r.input || 0, output: r.output || 0, tc: r.tc });
    }
    maxBacklog = Math.max(maxBacklog, backlog);
    if (i > 0) wm = Math.max(wm, msgs[i - 1].tu);               // 水位单调
  }
  return { accIn, accOut, staleMiss, evictions, fetched, rounds, maxBacklog };
}
const a = replay({ lruPersistAcrossRestart: true, restartEveryRounds: 0 });
console.log('S3a 常驻回放（LRU 持久、无淘汰丢失路径）：in=' + a.accIn + '/' + truthInput + ' out=' + a.accOut + '/' + truthOut
  + (a.accIn === truthInput && a.accOut === truthOut ? ' ✅ 与真值一致' : ' ❌ 偏差'))
console.log('    轮数=' + a.rounds + ' 取行=' + a.fetched + ' 淘汰批次=' + a.evictions + ' staleMiss=' + a.staleMiss + ' 单轮最大行数=' + a.maxBacklog + '（分批+yield 依据）');
const b = replay({ lruPersistAcrossRestart: false, restartEveryRounds: 200 });   // ~3.3h 重启一次、LRU 丢弃
console.log('S3b 无持久化对照（每 200 轮重启丢 LRU）：in=' + b.accIn + '/' + truthInput + ' staleMiss=' + b.staleMiss
  + (b.accIn === truthInput ? '（本库恰好无跨重启二次更新）' : ' ❌ 偏差 +' + (b.accIn - truthInput) + '（tokens 多计）→ checkpoint 必须持久化 LRU）'));

// ---------- S4：增量 SQL 形状耗时（time_updated 无索引） ----------
const wmNow = Date.now() - 60_000;
for (const [label, sql] of [
  ['全量（现行 json_extract 过滤）', `SELECT COUNT(*) FROM message WHERE json_extract(data,'$.role')='assistant' AND json_extract(data,'$.tokens.input') IS NOT NULL`],
  ['增量（time_updated 过滤 + json_extract）', `SELECT COUNT(*) FROM message WHERE time_updated > ${wmNow} AND json_extract(data,'$.role')='assistant' AND json_extract(data,'$.tokens.input') IS NOT NULL`],
]) {
  const st = db.prepare(sql);
  const t = process.hrtime.bigint();
  st.get();
  console.log('S4 ' + label + '：' + (Number(process.hrtime.bigint() - t) / 1e6).toFixed(1) + 'ms');
}
db.close();
