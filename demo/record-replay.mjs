#!/usr/bin/env node
/**
 * demo/record-replay.mjs — 把真实 DSH 会话日志转成「回放用规范事件 JSONL」
 *
 * 用法：node demo/record-replay.mjs [--session <id>] [--limit 2000] [--out fixtures/session-replay.pet.jsonl]
 * 输出：契约 v1.2 规范事件（每行一个 JSON），可直接喂给 demo/frame.mjs --replay 或 demo/frame.html
 */
import fs from 'node:fs';
import { createHub, makeMapper, findSessionLog } from './frame.mjs';

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const limit = Number(getArg('--limit', 2000));
const outPath = getArg('--out', 'fixtures/session-replay.pet.jsonl');
const forceSession = getArg('--session', null);
const fileArg = getArg('--file', null);

const target = fileArg ? { file: fileArg, session: 'local' } : findSessionLog(forceSession);
if (!target) { console.error('未找到会话日志（可用 --session 指定）'); process.exit(2); }

// 复用 demo/frame.mjs 的多帧 zstd 解码（通过一次 decodeFrames 导出不便，这里直接内联同规则）
import zlib from 'node:zlib';
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function decodeFrames(buf) {
  const offsets = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i >= 0) { offsets.push(i); i = buf.indexOf(MAGIC, i + 1); }
  const events = [];
  let cursor = 0;
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k];
    if (start < cursor) continue;
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    let text = null;
    try { text = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'); }
    catch { if (k + 1 === offsets.length) break; continue; }
    cursor = end;
    for (const line of text.split('\n')) { const t = line.trim(); if (t) { try { events.push(JSON.parse(t)); } catch {} } }
  }
  return { events, frames: offsets.length };
}

const { events: native, frames } = decodeFrames(fs.readFileSync(target.file));
const header = native.find(e => e.type === 'session') ?? { id: 'unknown', cwd: null, createdAt: Date.now(), version: 4 };
const map = makeMapper(header);
const canonical = [];
for (const n of native) {
  if (n.type === 'session') continue;
  for (const ev of map(n)) canonical.push(ev);
}
const sliced = canonical.slice(-limit);
fs.writeFileSync(outPath, sliced.map(e => JSON.stringify(e)).join('\n') + '\n');

// 自检：用同一份事件喂 Hub，确认能跑出状态
const hub = createHub();
for (const ev of sliced) hub.apply(ev);
const byType = new Map();
for (const e of sliced) byType.set(e.type, (byType.get(e.type) || 0) + 1);
console.log(JSON.stringify({
  session: header.id, cwd: header.cwd, frames,
  nativeEvents: native.length, canonicalEvents: canonical.length, written: sliced.length,
  out: outPath, agg: hub.agg(),
  types: Object.fromEntries([...byType.entries()].sort((a, b) => b[1] - a[1])),
  counters: hub.counters,
}, null, 1));
const first = sliced[0], last = sliced.at(-1);
console.log('时间跨度：' + new Date(first.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + ' → ' + new Date(last.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + '（' + Math.round((last.ts - first.ts) / 1000) + 's）');
