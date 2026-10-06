#!/usr/bin/env node
/**
 * dsh-session-to-pet.mjs — 离线把 DSH 会话日志映射为规范事件 v1（契约 §2/§3）
 *
 * 负责人：队友 C（adapter-recon）。只读输入文件；不修改任何 DSH 数据。
 * 用途：Phase 1 适配器原型 + 回放素材生成 + 验证「会话日志 → 规范事件」的可行性。
 *
 * 关键实现点（已在本机 DSH 0.2.0-rc.2 实测）：
 *   - session.v4.jsonl.zstd 是**多帧 zstd**：每帧 1 条 JSONL 事件，
 *     Node 的 zlib.zstdDecompressSync / createZstdDecompress 只解第一帧（实测：366,642B → 209B）。
 *   - 因此按 zstd 帧魔数 28 B5 2F FD 扫描候选帧边界，逐帧解压并校验「解出的文本以 \n 结尾」，
 *     失败则把边界外推（把压缩数据里偶然出现的魔数当成了帧边界）。
 *     实测本机 11 个会话日志：171/171 帧解出、1,670 行、0 解析错误。
 *
 * 用法：node scripts/dsh-session-to-pet.mjs <session.v4.jsonl.zstd> [--summary-max 120] [--agent-version 0.2.0-rc.2]
 * 输出：规范事件 JSONL 到 stdout（可直接喂给桌宠 --replay，或重定向为 *.pet.jsonl）
 */
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const MAX_EVENT_BYTES = 8192;

/** 多帧 zstd 解压 → JSONL 文本行。返回 { lines, frames, errors }。 */
export function decodeZstdJsonlFrames(buf) {
  const offsets = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) offsets.push(i);
  }
  const lines = [];
  let frames = 0, errors = 0, i = 0;
  while (i < offsets.length) {
    let advanced = false;
    for (let j = i + 1; j <= offsets.length; j++) {
      const end = j < offsets.length ? offsets[j] : buf.length;
      let out;
      try { out = zstdDecompressSync(buf.subarray(offsets[i], end)); } catch { continue; } // 截断帧：外推边界重试
      const text = out.toString('utf8');
      if (!text.endsWith('\n') && j !== offsets.length) continue;                        // 未解到帧尾：继续外推
      frames++;
      for (const line of text.split('\n')) if (line.trim()) lines.push(line);
      i = j; advanced = true;
      break;
    }
    if (!advanced) { errors++; break; }
  }
  return { lines, frames, errors, candidates: offsets.length };
}

const TOOL_CATEGORY = [
  [/^(read|read_file|view|grep|glob|search|list)/i, 'read'],
  [/^(write|edit|apply_patch|create|str_replace)/i, 'write'],
  [/^(bash|shell|exec|run|command|terminal|npm|pnpm|node)/i, 'exec'],
  [/^(web|fetch|http|curl|browser|search)/i, 'net'],
];
function categoryOf(name = '') { for (const [re, c] of TOOL_CATEGORY) if (re.test(name)) return c; return 'other'; }
function riskOf(name = '', args = '') {
  if (/^(bash|shell|exec|run)/i.test(name) && /(rm |sudo|chmod|curl|\|\||>s*\/)/.test(args)) return 3;
  if (/^(write|edit)/i.test(name)) return 1;
  if (/^(bash|shell|exec)/i.test(name)) return 2;
  if (/^(web|fetch|http)/i.test(name)) return 1;
  return 0;
}
const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);
function textOf(message, kinds = ['text']) {
  const parts = (message && Array.isArray(message.content) ? message.content : [])
    .filter(b => kinds.includes(b.type) && typeof b.text === 'string' && b.text.trim());
  return parts.map(b => b.text).join('\n');
}
const TURN_STATUS = { completed: 'ok', 'max-tokens': 'ok', blocked: 'aborted', interrupted: 'aborted', aborted: 'aborted' };
const APPROVAL = { 'allowed-once': 'allow', rejected: 'deny', cancelled: 'deny', unavailable: 'timeout' };

/** 原生事件数组 → 规范事件数组（同一会话）。 */
export function mapEvents(nativeEvents, { summaryMax = 120, agentVersion = 'unknown' } = {}) {
  const out = [];
  const openCalls = new Map();   // callId -> { ts, name, category, risk }
  const approvals = new Map();   // approval id -> { ts, callId }
  let seq = 0;
  const emit = (type, data, extra = {}) => {
    const ev = { v: 1, seq: seq++, ts: 0, source: 'dsh', sessionId: null, workspace: null, agent: null, type, data, ...extra };
    out.push(ev);
    return ev;
  };
  let meta = null, sessionId = null, workspace = null;
  for (const e of nativeEvents) {
    const t = e.type, d = e.data || {}, ts = e.time ?? e.createdAt ?? 0;
    if (t === 'session') {
      // 注意：会话头里的 version 是**会话格式版本**（本机为 4），不是 DSH 应用版本；
      // 应用版本请用 --agent-version 显式传入（例：--agent-version 0.2.0-rc.2）。
      meta = { name: 'DSH', version: agentVersion };
      sessionId = e.id; workspace = e.cwd ?? null;
      // v1.2 §3.1：session.start 必填 startedAt（Unix ms）→ 用会话头 createdAt；endedAt 在合成 session.end 时补。
      // 注意：会话头本身没有 seq/time，若忘记给 ev.ts 赋值就会产出 ts=0 的非法事件（本任务实测踩过）。
      const startedAt = Number(e.createdAt ?? ts) || Date.now();
      const startEv = emit('session.start', { nativeSessionId: sessionId, startedAt, workspace, agentName: 'DSH', agentVersion }, {});
      startEv.ts = startedAt;
      continue;
    }
    if (t === 'turn/start') { const ev = emit('turn.start', { nativeSessionId: sessionId, turnId: 'turn-' + d.turn, inputKind: 'user' }); ev.ts = ts; continue; }
    if (t === 'turn/end') { const ev = emit('turn.end', { nativeSessionId: sessionId, turnId: 'turn-' + d.turn, status: TURN_STATUS[d.reason?.kind] || 'error', summary: d.reason?.kind }); ev.ts = ts; continue; }
    if (t === 'step/start') { const ev = emit('step.start', { turnId: 'turn-' + d.turn, stepId: `turn-${d.turn}/step-${d.step}`, index: d.step }); ev.ts = ts; continue; }
    if (t === 'step/end') { const ev = emit('step.end', { turnId: 'turn-' + d.turn, stepId: `turn-${d.turn}/step-${d.step}`, index: d.step, status: 'ok' }); ev.ts = ts; continue; }
    if (t === 'tool/call') {
      const args = typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? '');
      openCalls.set(d.callId, { ts, name: d.name, category: categoryOf(d.name), risk: riskOf(d.name, args) });
      const ev = emit('tool.call', { toolName: d.name, callId: d.callId, summary: clip(args.replace(/\s+/g, ' '), summaryMax), category: categoryOf(d.name), risk: riskOf(d.name, args) });
      ev.ts = ts; continue;
    }
    if (t === 'tool/result') {
      const callId = d.message?.toolCallId || d.message?.source?.callId || 'unknown';
      const info = openCalls.get(callId);
      const failed = Boolean(d.error) || d.message?.isError === true;
      const ev = emit('tool.result', { callId, status: failed ? 'error' : 'ok', durationMs: info ? Math.max(0, ts - info.ts) : 0, summary: clip(textOf(d.message).replace(/\s+/g, ' '), summaryMax) });
      ev.ts = ts; continue;
    }
    if (t === 'approval/asked') {
      approvals.set(d.id, { ts, callId: d.callId });
      const info = d.callId ? openCalls.get(d.callId) : null;
      const ev = emit('approval.request', { callId: d.callId, kind: d.toolName || 'approval', risk: info?.risk ?? 2, summary: clip(d.reason || `工具 ${d.toolName} 需要批准`, summaryMax * 2) });
      ev.ts = ts; continue;
    }
    if (t === 'approval/decided') {
      const info = approvals.get(d.id);
      const ev = emit('approval.resolved', { callId: info?.callId, decision: APPROVAL[d.outcome] || 'deny', latencyMs: info ? Math.max(0, ts - info.ts) : 0 });
      ev.ts = ts; continue;
    }
    if (t === 'assistant/message') {
      const text = clip(textOf(d.message).replace(/\s+/g, ' ').trim(), 280);
      if (!text) continue;
      const ev = emit('message.assistant', { turnId: 'turn-' + d.turn, text, truncated: textOf(d.message).length > 280 ? true : false });
      ev.privacy = { redacted: true, fields: ['text'] };  // 契约 §2/§3：截断即标注
      ev.ts = ts; continue;
    }
    if (t === 'llm/retry') {
      const ev = emit('error.raised', { scope: 'llm', code: d.failure?.code || d.failure?.name || 'RETRY', message: clip(`${d.provider || 'llm'} 重试 #${d.retry}`, summaryMax), fatal: false });
      ev.ts = ts; continue;
    }
    // 其余原生 type（agent/inbox/spliced、todo/write、team/* 等）暂不映射：契约 §7.3 要求未知事件被忽略并计数
  }
  for (const ev of out) {                 // 统一补齐信封 + 会话元数据 + 8KB 上限
    if (!ev.ts) ev.ts = 0;
    ev.sessionId = sessionId; ev.workspace = workspace; ev.agent = meta;
    const size = Buffer.byteLength(JSON.stringify(ev));
    if (size > MAX_EVENT_BYTES) {
      if (ev.data.summary) ev.data.summary = clip(ev.data.summary, 200);
      if (ev.data.text) ev.data.text = clip(ev.data.text, 200);
      ev.privacy = { redacted: true, fields: [...new Set([...(ev.privacy?.fields || []), 'summary', 'text'])] };
    }
  }
  return out;
}

function main() {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) { console.error('用法: node scripts/dsh-session-to-pet.mjs <session.v4.jsonl.zstd>'); process.exit(2); }
  const argValue = (name, dflt) => { const i = rest.indexOf(name); return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : dflt; };
  const summaryMax = Number(argValue('--summary-max', '120')) || 120;   // 注意：先取字符串再 Number，否则 NaN 会让截断静默失效
  const agentVersion = argValue('--agent-version', 'unknown');
  const buf = readFileSync(file);
  const dec = decodeZstdJsonlFrames(buf);
  const native = dec.lines.map(l => JSON.parse(l));
  const pet = mapEvents(native, { summaryMax, agentVersion });
  process.stdout.write(pet.map(o => JSON.stringify(o)).join('\n') + '\n');
  console.error(`[dsh-session-to-pet] 压缩 ${buf.length}B → 帧 ${dec.frames}/${dec.candidates} 候选 → 原生事件 ${native.length} → 规范事件 ${pet.length}（解帧失败 ${dec.errors}）`);
  console.error('[type 分布] ' + [...pet.reduce((m, e) => m.set(e.type, (m.get(e.type) || 0) + 1), new Map())].map(([k, v]) => k + '=' + v).join(', '));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
