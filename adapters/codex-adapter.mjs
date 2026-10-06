#!/usr/bin/env node
/**
 * adapters/codex-adapter.mjs — Codex 观察适配器（docs/21 M-B）
 *
 * 事件源（全部**只读**）：~/.codex/sessions/<Y>/<M>/<D>/rollout-<ts>-<threadId>.jsonl
 *   - 首行恒为 session_meta（本机 32/32 实测）：session_id / cwd / cli_version / parent_thread_id
 *     （parent_thread_id 非空 = 子代理线程，**不进会话列表**——docs/21 §0.2 的真相源规则）
 *   - ordinal 提供全序；turn 边界 = event_msg.task_started / task_complete / turn_aborted；
 *     工具 = response_item.function_call / custom_tool_call（+ item_completion 的同类信息，取其一即可）
 *   - 模型：turn_context.model（每回合）+ thread_settings_applied.thread_settings.model（会话级）
 *
 * 两个入口（与 claude-code-adapter 同构）：
 *   ① scanCodexCatalog(opts)  → 会话目录
 *   ② followCodexLogs(opts)   → 多文件增量 tail → 规范事件
 *
 * 隐私红线：同 docs/21 §0.5 —— 只输出状态级字段；task_complete.last_agent_message 截断 280 字符；
 *   工具参数/输出（arguments / input / output）一律不外传。
 *
 * 用法：
 *   node adapters/codex-adapter.mjs [--json] [--bench N] [--follow]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { categoryOf } from '../demo/frame.mjs';

export const SOURCE = 'codex';
export const AGENT_NAME = 'Codex';
export const SESSIONS_ROOT = process.env.CODEX_SESSIONS || path.join(os.homedir(), '.codex', 'sessions');

export const DEFAULT_OPTS = Object.freeze({
  root: SESSIONS_ROOT,
  headBytes: 96 * 1024,           // session_meta 首行实测 20~51KB（内嵌 base_instructions），96KB 稳妥
  tailBytes: 160 * 1024,
  maxLineBytes: 512 * 1024,       // 本机最大行 5MB（工具输出）：超限跳过，只影响状态近似
  liveWindowMs: 60_000,
  maxSessions: 500,
  now: null,
});

const RISK_BY_CATEGORY = { exec: 2, write: 2, net: 1, read: 0, other: 1 };
const ts = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
function clip(s, n) { s = String(s ?? '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ---------------------------------------------------------------------------
// 1. 窗口读取（与 claude-code-adapter 同款：只解析能完整 JSON.parse 的行）
// ---------------------------------------------------------------------------

function readWindowLines(file, start, length, maxLineBytes = DEFAULT_OPTS.maxLineBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, length));
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.subarray(0, n).toString('utf8').split('\n');
    if (start > 0) lines.shift();                     // 窗口首行大概率是被劈开的半行
    const out = [];
    for (const l of lines) {
      const t = l.trim();
      if (!t) continue;
      if (Buffer.byteLength(t) > maxLineBytes) continue;
      try { out.push(JSON.parse(t)); } catch { /* 半行/坏行 */ }
    }
    return out;
  } finally { fs.closeSync(fd); }
}

export function readRolloutWindows(file, { size = null, headBytes = DEFAULT_OPTS.headBytes, tailBytes = DEFAULT_OPTS.tailBytes } = {}) {
  const fileSize = size ?? fs.statSync(file).size;
  if (fileSize === 0) return { head: [], tail: [], bytesRead: 0 };
  const headLen = Math.min(headBytes, fileSize);
  const tailLen = Math.min(tailBytes, Math.max(0, fileSize - headLen));
  const head = readWindowLines(file, 0, headLen);
  const tail = tailLen > 0 ? readWindowLines(file, fileSize - tailLen, tailLen) : [];
  return { head, tail, bytesRead: headLen + tailLen };
}

// ---------------------------------------------------------------------------
// 2. 会话记录与粗粒度状态
// ---------------------------------------------------------------------------

/** rollout 文件名里的线程 id：rollout-2026-09-24T23-29-50-01a0d409-8bc7-….jsonl */
export function threadIdOf(file) {
  const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return m ? m[1] : path.basename(file).replace(/^rollout-/, '').replace(/\.jsonl$/, '');
}

export function coarseStateFromLines(lines) {
  let state = 'idle', stateSource = 'no-signal';
  for (const o of lines) {
    const p = o?.payload ?? {};
    if (o?.type === 'event_msg') {
      if (p.type === 'task_started') { state = 'thinking'; stateSource = 'task_started'; }
      else if (p.type === 'item_completed' && p.item?.type === 'UserMessage') { state = 'thinking'; stateSource = 'item:UserMessage'; }
      else if (p.type === 'task_complete') { state = 'done'; stateSource = 'task_complete'; }
      else if (p.type === 'turn_aborted') { state = 'idle'; stateSource = 'turn_aborted'; }
    } else if (o?.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call') { state = 'running'; stateSource = 'response_item:' + p.type; }
      else if (p.type === 'reasoning') { if (state === 'idle') { state = 'thinking'; stateSource = 'reasoning'; } }
    }
  }
  return { state, stateSource };
}

export function parseCodexSession(file, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const st = (() => { try { return fs.statSync(file); } catch { return null; } })();
  const sessionId = threadIdOf(file);
  const base = {
    sessionId, dirName: path.basename(file), agentName: AGENT_NAME, source: SOURCE,
    dir: path.dirname(file), projectDir: path.dirname(file), projectDirName: '',
    title: null, titleRaw: null, provider: null, model: null, reasoningEffort: null, agentPreset: null,
    agentVersion: null, state: 'unknown', stateSource: null, live: false,
    createdAt: null, updatedAt: null, bytes: st?.size ?? 0, logFile: file, logName: path.basename(file),
    origin: null, parentSession: null, delegationDepth: null, isSeeded: null, kind: 'main', label: null,
    cwd: null, cwdSource: null, originator: null,
    degraded: false, error: null, metaSources: {},
    metaComplete: false, metaApproximate: true, readBytes: 0, readMode: 'window',
  };
  if (!st) return { ...base, degraded: true, error: 'stat' };
  let head, tail, bytesRead;
  try { ({ head, tail, bytesRead } = readRolloutWindows(file, { size: st.size, headBytes: o.headBytes, tailBytes: o.tailBytes })); }
  catch (e) { return { ...base, degraded: true, error: 'read:' + (e?.code ?? e?.message) }; }
  const lines = [...head, ...tail];
  const metaSources = {};
  let meta = null, cwd = null, version = null, originator = null, parent = null, nickname = null, createdAt = null, lastTs = null, model = null, effort = null;
  for (const l of lines) {
    const t = ts(l.timestamp); if (t && (!lastTs || t > lastTs)) lastTs = t;
    if (l.type === 'session_meta') {
      meta = l.payload ?? {};
      if (!createdAt) createdAt = ts(l.timestamp) ?? (meta.session_id ? null : null);
      cwd = typeof meta.cwd === 'string' ? meta.cwd : cwd;
      version = typeof meta.cli_version === 'string' ? meta.cli_version : version;
      originator = typeof meta.originator === 'string' ? meta.originator : originator;
      parent = meta.parent_thread_id ?? parent;
      nickname = typeof meta.agent_nickname === 'string' ? meta.agent_nickname : nickname;
      if (cwd) metaSources.cwd = 'session_meta.cwd';
    } else if (l.type === 'turn_context') {
      if (typeof l.payload?.model === 'string') { model = l.payload.model; metaSources.model = 'turn_context.model'; }
      if (typeof l.payload?.effort === 'string') effort = l.payload.effort;
    } else if (l.type === 'event_msg' && l.payload?.type === 'thread_settings_applied') {
      const m = l.payload.thread_settings?.model;
      if (typeof m === 'string') { model = m; metaSources.model = 'thread_settings_applied.model'; }
    }
  }
  let coarse = coarseStateFromLines(tail.length ? tail : lines);
  // 时效修正：task_started 后中断的会话不该永远 thinking/running（超 5 分钟降级 idle）
  {
    const win = tail.length ? tail : lines;
    let lastTs = null;
    for (let i = win.length - 1; i >= 0; i--) { const t = Date.parse(win[i]?.timestamp); if (Number.isFinite(t)) { lastTs = t; break } }
    if ((coarse.state === 'thinking' || coarse.state === 'running') && lastTs !== null && ((Number.isFinite(o.now) ? o.now : Date.now()) - lastTs) > 300_000) {
      coarse = { state: 'idle', stateSource: coarse.stateSource + ':stale>5min→idle' };
    }
  }
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const isSub = parent != null && parent !== '';
  // 会话形态：originator 本机实测 "Codex Desktop"（Codex++ 壳）；CLI 发起的会话为 codex/codex-cli 等
  const variant = originator == null ? null : /desktop/i.test(originator) ? 'desktop' : 'cli';
  return {
    ...base,
    title: nickname ?? (cwd ? path.basename(cwd) : sessionId.slice(0, 8)),
    titleRaw: nickname, metaSources,
    cwd, cwdSource: cwd ? 'session_meta.cwd' : null,
    createdAt: createdAt ?? ts(meta?.timestamp) ?? null,
    updatedAt: Math.round(Math.max(st.mtimeMs, lastTs ?? 0)),
    model, reasoningEffort: effort,
    agentVersion: version, originator,
    origin: isSub ? 'subagent' : 'main',
    parentSession: isSub ? parent : null,
    kind: isSub ? 'subagent' : 'main',
    variant,
    label: nickname,
    state: isSub ? coarse.state : coarse.state, stateSource: coarse.stateSource,
    live: now - st.mtimeMs < o.liveWindowMs,
    metaComplete: false, metaApproximate: true,
    readBytes: bytesRead, readMode: 'window',
    degraded: !meta, error: meta ? null : 'no-session-meta',
  };
}

export function scanCodexCatalog(opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const t0 = process.hrtime.bigint();
  const files = [];
  try {
    (function walk(d) {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) files.push(p); }
    })(o.root);
  } catch { /* root 不存在：未安装 Codex */ }
  const sessions = [];
  let degraded = 0, readBytes = 0;
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const f of files.slice(0, o.maxSessions)) {
    const s = parseCodexSession(f, o);
    if (s.degraded) degraded++;
    readBytes += s.readBytes ?? 0;
    sessions.push(s);
  }
  // 项目分组：按 cwd 归并（真相源 = session_meta.cwd；目录结构 Y/M/D 只是日期归档，不是项目）
  const byCwd = new Map();
  for (const s of sessions) {
    const key = s.cwd ?? '(未知目录)';
    if (!byCwd.has(key)) byCwd.set(key, []);
    byCwd.get(key).push(s);
  }
  const projects = [];
  for (const [cwd, list] of byCwd) {
    const mains = list.filter((s) => s.kind !== 'subagent');
    if (!mains.length) continue;                        // 只剩子代理的项目不立项（子代理不进列表）
    mains.sort((a, b) => (Number(b.live) - Number(a.live)) || ((b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
    projects.push({
      projectId: 'codex:' + cwd,
      projectDirName: cwd, cwd,
      cwdSource: 'session_meta.cwd',
      title: path.basename(cwd), name: path.basename(cwd),
      workspaceId: null, workspaceSessionIds: [],
      sessionCount: mains.length, registeredSessionCount: mains.length,
      updatedAt: mains.reduce((m, s) => Math.max(m, s.updatedAt ?? 0), 0),
      liveCount: mains.filter((s) => s.live).length,
      sessions: mains,
    });
  }
  projects.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const tookMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    root: o.root, source: SOURCE, generatedAt: Date.now(), tookMs, elapsedMs: Number(tookMs.toFixed(2)),
    projects, sessions, sessionCount: sessions.length, failed: degraded,
    stats: {
      projects: projects.length, sessions: sessions.length,
      mainSessions: sessions.filter((s) => s.kind === 'main').length,
      subagentSessions: sessions.filter((s) => s.kind === 'subagent').length,
      live: sessions.filter((s) => s.live).length, degraded, readBytes,
    },
  };
}

// ---------------------------------------------------------------------------
// 3. 行 → 规范事件（纯函数）
// ---------------------------------------------------------------------------

/**
 * 把一行 rollout 映射为零或多条规范事件。
 * @param line rollout 行对象
 * @param ctx {sessionId, seq, subagent}
 */
export function mapCodexLine(line, ctx) {
  if (!line || typeof line.type !== 'string') return [];
  const t = ts(line.timestamp) ?? Date.now();
  const seq = ++ctx.seq;
  const base = { v: 1, seq, ts: t, source: SOURCE, sessionId: ctx.sessionId };
  const p = line.payload ?? {};
  if (line.type === 'event_msg') {
    switch (p.type) {
      case 'task_started':
        return [{ ...base, type: 'turn.start', data: { turnId: p.turn_id ?? ('turn-' + seq), inputKind: 'user' } }];
      case 'task_complete':
        return [
          { ...base, type: 'message.assistant', data: { text: clip(p.last_agent_message, 280), truncated: true } },
          { ...base, type: 'turn.end', data: { turnId: p.turn_id ?? ('turn-' + seq), status: 'ok', durationMs: Number.isFinite(p.duration_ms) ? p.duration_ms : undefined } },
        ];
      case 'turn_aborted':
        return [{ ...base, type: 'turn.end', data: { turnId: p.turn_id ?? ('turn-' + seq), status: 'aborted' } }];
      default:
        return [];
    }
  }
  if (line.type === 'response_item') {
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      const toolName = String(p.name ?? 'unknown');
      const category = categoryOf(toolName);
      return [{ ...base, type: 'tool.call', data: { callId: p.call_id ?? ('call-' + seq), toolName, category, risk: RISK_BY_CATEGORY[category], summary: '' } }];
    }
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      // 输出内容不外传；custom_tool_call_output 前一行同 call 的 status 已由 custom_tool_call.status 表达
      return [{ ...base, type: 'tool.result', data: { callId: p.call_id ?? ('call-' + seq), status: p.status === 'failed' ? 'error' : 'ok' } }];
    }
    if (p.type === 'agent_message' || (p.type === 'message' && p.role === 'assistant')) {
      const text = Array.isArray(p.content) ? p.content.filter((c) => typeof c?.text === 'string').map((c) => c.text).join(' ') : '';
      return text ? [{ ...base, type: 'message.assistant', data: { text: clip(text, 280), truncated: true } }] : [];
    }
    return [];
  }
  if (line.type === 'session_meta') {
    return [{ ...base, type: 'session.start', data: { workspace: typeof p.cwd === 'string' ? p.cwd : undefined, agentVersion: typeof p.cli_version === 'string' ? p.cli_version : undefined, nativeSessionId: p.session_id ?? ctx.sessionId } }];
  }
  return [];      // world_state / token_* / compacted / …：v1 不映射
}

// ---------------------------------------------------------------------------
// 4. 多文件增量跟随
// ---------------------------------------------------------------------------

export function followCodexLogs(opts = {}) {
  const root = opts.root || SESSIONS_ROOT;
  const intervalMs = opts.intervalMs ?? 1200;
  const maxFiles = opts.maxFiles ?? 80;
  const onEvent = opts.onEvent ?? (() => {});
  const files = new Map();
  let stopped = false;
  const stats = { files: 0, lines: 0, events: 0, parseErrors: 0, resamples: 0 };

  function listFiles() {
    const out = [];
    try {
      (function walk(d) {
        let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p); }
      })(root);
    } catch { /* 未安装：静默 */ }
    return out;
  }

  /** 首次遇到文件时读首行 session_meta：取权威 sessionId / cwd，并识别子代理线程（整文件跳过）。 */
  function readMeta(file) {
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(256 * 1024);   // session_meta 实测 20~51KB；给 4 倍余量
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        const nl = buf.subarray(0, n).indexOf(10);
        const line = nl >= 0 ? buf.subarray(0, nl).toString('utf8') : buf.subarray(0, n).toString('utf8');
        const o = JSON.parse(line);
        if (o?.type !== 'session_meta') return {};
        const p = o.payload ?? {};
        return { sessionId: p.session_id ?? p.id, cwd: typeof p.cwd === 'string' ? p.cwd : undefined, subagent: p.parent_thread_id != null && p.parent_thread_id !== '' };
      } finally { fs.closeSync(fd); }
    } catch { return {}; }
  }

  function pump() {
    if (stopped) return;
    const now = Date.now();
    for (const file of listFiles()) {
      let st; try { st = fs.statSync(file); } catch { continue; }
      let f = files.get(file);
      if (!f) {
        if (files.size >= maxFiles) continue;
        const meta = readMeta(file);
        if (meta.subagent) { files.set(file, { offset: st.size, ctx: null, subagent: true }); continue; }   // 子代理线程：不产事件
        f = { offset: opts.fromStart ? 0 : st.size, ctx: { sessionId: meta.sessionId ?? threadIdOf(file), seq: 0 } };
        files.set(file, f);
      }
      if (f.subagent || !f.ctx) continue;
      if (st.size < f.offset) { f.offset = 0; stats.resamples++; }
      if (st.size <= f.offset) continue;
      let chunk;
      try {
        const fd = fs.openSync(file, 'r');
        try {
          const len = Math.min(st.size - f.offset, 8 * 1024 * 1024);
          const buf = Buffer.alloc(len);
          const n = fs.readSync(fd, buf, 0, len, f.offset);
          chunk = buf.subarray(0, n).toString('utf8');
        } finally { fs.closeSync(fd); }
      } catch { continue; }
      const nl = chunk.lastIndexOf('\n');
      if (nl < 0) continue;
      const complete = chunk.slice(0, nl);
      f.offset += Buffer.byteLength(complete, 'utf8') + 1;
      for (const l of complete.split('\n')) {
        const t = l.trim();
        if (!t) continue;
        stats.lines++;
        let o; try { o = JSON.parse(t); } catch { stats.parseErrors++; continue; }
        for (const ev of mapCodexLine(o, f.ctx)) { stats.events++; onEvent(ev); }
      }
    }
    stats.files = files.size;
  }

  const timer = setInterval(pump, intervalMs);
  pump();
  return { stop() { stopped = true; clearInterval(timer); }, stats: () => ({ ...stats }) };
}

// ---------------------------------------------------------------------------
// 5. CLI
// ---------------------------------------------------------------------------

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms); const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

export function formatCodexTree(catalog) {
  const lines = [];
  lines.push('Codex 会话目录 ' + catalog.root);
  lines.push(catalog.stats.projects + ' 个项目 / ' + catalog.stats.mainSessions + ' 个主会话（子代理 ' + catalog.stats.subagentSessions + ' 不列出 · 活跃 ' + catalog.stats.live + ' · 降级 ' + catalog.stats.degraded + '）  扫描耗时 ' + catalog.tookMs.toFixed(1) + ' ms');
  for (const p of catalog.projects) {
    lines.push('');
    lines.push('📁 ' + p.title + '   (' + p.cwd + ')');
    for (const s of p.sessions) {
      const flags = [s.live ? '● 活跃' : '', s.degraded ? '⚠ 降级' : ''].filter(Boolean).join('  ');
      lines.push('   └─ ' + String(s.sessionId).slice(0, 12).padEnd(13) + fmtTime(s.updatedAt) + '  ' + String(s.model ?? '—').padEnd(18) + ' v' + String(s.agentVersion ?? '—').padEnd(16) + String(s.state).padEnd(9) + flags);
      lines.push('      「' + String(s.title ?? '').slice(0, 46) + '」  originator=' + (s.originator ?? '—'));
    }
  }
  return lines.join('\n');
}

async function main(argv) {
  if (argv.includes('--follow')) {
    console.log('跟随 ' + SESSIONS_ROOT + '（Ctrl-C 退出）');
    followCodexLogs({ onEvent: (ev) => console.log(JSON.stringify(ev)) });
    return;
  }
  const runs = (() => { const i = argv.indexOf('--bench'); return i >= 0 ? Math.max(1, Number(argv[i + 1]) || 5) : 1; })();
  let catalog; const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    catalog = scanCodexCatalog();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  if (argv.includes('--json')) console.log(JSON.stringify(catalog, null, 2));
  else {
    console.log(formatCodexTree(catalog));
    if (runs > 1) console.log('\n扫描耗时 ' + runs + ' 轮：min ' + Math.min(...times).toFixed(1) + ' / 中位 ' + times.sort((a, b) => a - b)[Math.floor(times.length / 2)].toFixed(1) + ' / max ' + Math.max(...times).toFixed(1) + ' ms');
  }
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) await main(process.argv.slice(2));
