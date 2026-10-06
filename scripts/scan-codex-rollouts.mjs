#!/usr/bin/env node
/**
 * scan-codex-rollouts.mjs — 只读统计本机 Codex CLI 会话日志（~/.codex/sessions/<Y>/<M>/<D>/rollout-<ts>.jsonl）
 * 负责人：队友 C（adapter-recon）。
 * 隐私：只输出类型名/字段名与计数，绝不打印内容。**不读取 auth.json 等凭据文件。**
 * 用途：验证 docs/40-adapters.md §3.2 的实测数字。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(homedir(), '.codex', 'sessions');
const files = [];
(function walk(d) {
  let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) files.push(p); }
})(ROOT);

const topTypes = new Map(), payloadTypes = new Map(), itemTypes = new Map(), metaKeys = new Set(), turnKeys = new Set();
let lines = 0, maxLine = 0, parseErrors = 0;
const bump = (m, k) => { if (k !== undefined && k !== null) m.set(k, (m.get(k) || 0) + 1); };

for (const f of files) {
  for (const text of readFileSync(f, 'utf8').split('\n')) {
    if (!text.trim()) continue;
    lines++; maxLine = Math.max(maxLine, Buffer.byteLength(text));
    let o; try { o = JSON.parse(text); } catch { parseErrors++; continue; }
    bump(topTypes, o.type);
    const p = o.payload || {};
    bump(payloadTypes, o.type + '.' + p.type);
    if (o.type === 'session_meta') for (const k of Object.keys(p)) metaKeys.add(k);
    if (o.type === 'turn_context') for (const k of Object.keys(p)) turnKeys.add(k);
    if (o.type === 'event_msg' && p.type === 'item_completed' && p.item) bump(itemTypes, p.item.type);
  }
}
const fmt = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => k + '=' + v).join(', ');
console.log('目录:', ROOT.replace(homedir(), '~'));
console.log(`rollout 文件 ${files.length} | 行 ${lines} | 最大单行 ${maxLine}B | 解析失败 ${parseErrors}`);
console.log('顶层行类型: ' + fmt(topTypes, 12));
console.log('payload 类型: ' + fmt(payloadTypes, 16));
console.log('item_completed.item.type: ' + fmt(itemTypes, 12));
console.log('session_meta.payload 键: ' + [...metaKeys].join(', '));
console.log('turn_context.payload 键: ' + [...turnKeys].join(', '));
