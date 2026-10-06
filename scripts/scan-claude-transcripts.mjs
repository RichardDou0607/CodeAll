#!/usr/bin/env node
/**
 * scan-claude-transcripts.mjs — 只读统计本机 Claude Code 转录文件（~/.claude/projects/<cwd 转义>/<session>.jsonl）
 * 负责人：队友 C（adapter-recon）。
 * 隐私：**只输出类型名、字段名与计数**，绝不打印消息内容、路径中的用户名会被替换为 ~。
 * 用途：验证 docs/40-adapters.md §3.1 的实测数字。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(homedir(), '.claude', 'projects');
const files = [];
(function walk(d) {
  let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) files.push(p); }
})(ROOT);

const lineTypes = new Map(), subtypes = new Map(), blocks = new Map(), tools = new Map();
let lines = 0, maxLine = 0, parseErrors = 0;
const bump = (m, k) => { if (k !== undefined && k !== null) m.set(k, (m.get(k) || 0) + 1); };

for (const f of files) {
  for (const text of readFileSync(f, 'utf8').split('\n')) {
    if (!text.trim()) continue;
    lines++; maxLine = Math.max(maxLine, Buffer.byteLength(text));
    let o; try { o = JSON.parse(text); } catch { parseErrors++; continue; }
    bump(lineTypes, o.type); bump(subtypes, o.subtype);
    const c = o.message && o.message.content;
    if (Array.isArray(c)) for (const b of c) { bump(blocks, b.type); if (b.type === 'tool_use') bump(tools, b.name); }
    if (o.toolUseResult !== undefined) bump(blocks, 'line.toolUseResult');
  }
}
const fmt = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => k + '=' + v).join(', ');
console.log('目录:', ROOT.replace(homedir(), '~'));
console.log(`转录文件 ${files.length} | 行 ${lines} | 最大单行 ${maxLine}B | 解析失败 ${parseErrors}`);
console.log('行类型: ' + fmt(lineTypes, 20));
console.log('system 子类型: ' + fmt(subtypes, 12));
console.log('内容块: ' + fmt(blocks, 10));
console.log('工具名 Top: ' + fmt(tools, 20));
