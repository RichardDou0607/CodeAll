#!/usr/bin/env node
/**
 * adapters/kimi-code-adapter.mjs — Kimi Code 观察适配器（docs/21 M-H，A 路径）
 *
 * 数据源（全部**只读**）：~/.kimi-code/（CLI-first 架构，agent 核心写文件级数据）
 *   sessions/wd_<hash>/session_<uuid>/state.json   ← 会话状态（id/cwd/createdAt/updatedAt/title/archived/lastTurnReason）
 *   sessions/.../agents/main/wire.jsonl             ← **事件流**（protocol 1.5）：turn 边界、tool.call/result、
 *                                                       interaction.request/resolved（原生审批对，id 天然配对）、
 *                                                       usage/token、file_history、mcp.* 等（本机 5557 行实测）
 *   workspaces.json                                 ← 工作区注册表（wd_<hash> → 路径/标题，可选增强）
 *   session_index.jsonl                             ← 会话索引（sessionId/sessionDir/workDir）
 *
 * 勘误（2026-10-06）：上一版 spike 结论「会话仅在 Electron LevelDB、无文件级数据」**有误**——
 * 探测命令 `ls -d ~/.kimi* ~/kimi*` 因后者无匹配被 zsh 整体中止，~/.kimi-code 从未被列出。
 * LevelDB 是 Electron 前端层缓存；本适配器改走 A 路径（state.json 目录 + wire.jsonl 事件 tail），
 * LevelDB 计数降级为第三层兜底（scanKimiLegacyCount）。
 *
 * 三个入口：
 *   ① scanKimiCatalog(opts)   → 会话目录（与 claude/codex 适配器同构）
 *   ② followKimiLogs(opts)    → 多文件 wire.jsonl 增量 tail → 规范事件
 *   ③ scanKimiLegacyCount()   → LevelDB 近似计数（兜底；无 ~/.kimi-code 时用）
 *
 * 隐私红线：只输出状态级字段；agent.message.appended 文本截断 280 字符；tool 参数/输出不外传；
 *   state.json 的 lastPrompt（用户原文）**不读取、不外传**。
 *
 * 用法：
 *   node adapters/kimi-code-adapter.mjs [--json] [--bench N] [--follow]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { categoryOf } from '../demo/frame.mjs';

export const SOURCE = 'kimi-code';
export const AGENT_NAME = 'Kimi Code';
export const KIMI_HOME = process.env.KIMI_HOME || path.join(os.homedir(), '.kimi-code');
export const SESSIONS_ROOT = path.join(KIMI_HOME, 'sessions');
export const WORKSPACES_STORE = path.join(KIMI_HOME, 'workspaces.json');
/** Electron 前端层缓存（第三层兜底，见文件头勘误）。 */
export const KIMI_LEVELDB = process.env.KIMI_APP_SUPPORT || path.join(os.homedir(), 'Library', 'Application Support', 'kimi-code-app', 'Local Storage', 'leveldb');

export const DEFAULT_OPTS = Object.freeze({
  root: SESSIONS_ROOT,
  wireHeadBytes: 64 * 1024,        // profile.bind（模型/思考档）在头部
  wireTailBytes: 128 * 1024,       // 粗状态看尾部
  maxLineBytes: 512 * 1024,        // 本机 wire 最大单行 2.5MB（大 content.part）：超限跳过
  liveWindowMs: 60_000,
  maxSessions: 500,
  now: null,
});

const RISK_BY_CATEGORY = { exec: 2, write: 2, net: 1, read: 0, other: 1 };
function clip(s, n) { s = String(s ?? '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ---------------------------------------------------------------------------
// 1. 窗口读取（wire.jsonl 是纯 JSONL；与 claude/codex 适配器同款窗口策略）
// ---------------------------------------------------------------------------

function readWindowLines(file, start, length, maxLineBytes = DEFAULT_OPTS.maxLineBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, length));
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.subarray(0, n).toString('utf8').split('\n');
    if (start > 0) lines.shift();                    // 窗口首行大概率是被劈开的半行
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

export function readWireWindows(file, { size = null, headBytes = DEFAULT_OPTS.wireHeadBytes, tailBytes = DEFAULT_OPTS.wireTailBytes } = {}) {
  const fileSize = size ?? fs.statSync(file).size;
  if (fileSize === 0) return { head: [], tail: [], bytesRead: 0 };
  const headLen = Math.min(headBytes, fileSize);
  const tailLen = Math.min(tailBytes, Math.max(0, fileSize - headLen));
  const head = readWindowLines(file, 0, headLen);
  const tail = tailLen > 0 ? readWindowLines(file, fileSize - tailLen, tailLen) : [];
  return { head, tail, bytesRead: headLen + tailLen };
}

/** workspaces.json（可选增强）：wd_<hash> → {path,title}。失败静默返回空表。 */
export function readKimiWorkspaces(storePath = WORKSPACES_STORE) {
  const out = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    for (const [id, w] of Object.entries(j?.workspaces ?? {})) {
      if (w?.path) out.set(id, { id, path: w.path, title: w.title ?? w.name ?? path.basename(w.path) });
    }
  } catch { /* 无注册表/坏文件：按 cwd 兜底分组 */ }
  return out;
}

// ---------------------------------------------------------------------------
// 2. 会话记录与粗粒度状态
// ---------------------------------------------------------------------------

/** 从 wire 尾部窗口推导粗粒度状态（口径对齐 claude/codex 适配器）。 */
export function coarseStateFromWireLines(lines) {
  let state = 'idle', stateSource = 'no-signal';
  for (const o of lines) {
    const t = o?.type;
    if (t === 'turn.prompt' || t === 'agent.turn.started') { state = 'thinking'; stateSource = t; }
    else if (t === 'context.append_loop_event' && o.event?.type === 'tool.call') { state = 'running'; stateSource = 'loop:tool.call'; }
    else if (t === 'context.append_loop_event' && o.event?.type === 'step.begin') { if (state === 'idle') { state = 'thinking'; stateSource = 'loop:step.begin'; } }
    else if (t === 'turn.ended') { state = o.reason === 'completed' ? 'done' : o.reason === 'cancelled' || o.reason === 'aborted' ? 'idle' : 'error'; stateSource = 'turn.ended:' + o.reason; }
    else if (t === 'turn.step.retrying') { state = 'error'; stateSource = 'turn.step.retrying'; }
    else if (t === 'interaction.request' && o.kind === 'approval') { state = 'waiting'; stateSource = 'interaction.request'; }
  }
  return { state, stateSource };
}

/** 解析单个会话目录 → 会话记录。state.json 很小（~500B）整读；wire.jsonl 只读头/尾窗口。 */
export function parseKimiSession(sessionDir, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const stateFile = path.join(sessionDir, 'state.json');
  const wireFile = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const base = {
    sessionId: path.basename(sessionDir), dirName: path.basename(sessionDir), agentName: AGENT_NAME, source: SOURCE,
    dir: sessionDir, projectDir: path.dirname(sessionDir), projectDirName: path.basename(path.dirname(sessionDir)),
    title: null, titleRaw: null, titleKind: null, provider: null, model: null, reasoningEffort: null, agentPreset: null,
    agentVersion: null, state: 'unknown', stateSource: null, live: false,
    createdAt: null, updatedAt: null, bytes: 0, logFile: null, logName: null,
    origin: null, parentSession: null, delegationDepth: null, isSeeded: null, kind: 'main', label: null,
    cwd: null, cwdSource: null, archived: false, isCustomTitle: null,
    degraded: false, error: null, metaSources: {},
    metaComplete: true, metaApproximate: false, readBytes: 0, readMode: 'state+wire-window',
  };
  let st;
  try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch (e) { return { ...base, degraded: true, error: 'state.json:' + (e?.code ?? e?.message) }; }
  const rec = {
    ...base,
    sessionId: typeof st.id === 'string' ? st.id : base.sessionId,
    title: typeof st.title === 'string' && st.title ? st.title : path.basename(String(st.cwd ?? base.sessionId)),
    titleRaw: st.title ?? null, titleKind: st.titleKind ?? null, isCustomTitle: st.isCustomTitle ?? null,
    cwd: typeof st.cwd === 'string' ? st.cwd : null, cwdSource: st.cwd ? 'state.json.cwd' : null,
    createdAt: Number.isFinite(st.createdAt) ? st.createdAt : null,
    archived: st.archived === true,
    bytes: (() => { try { return fs.statSync(stateFile).size; } catch { return 0; } })(),
  };
  // wire.jsonl：头窗口取模型/思考档（profile.bind / config.update），尾窗口取粗状态
  let wireSt = null;
  try { wireSt = fs.statSync(wireFile); } catch { /* 无 wire（仅 CLI 建过目录） */ }
  const metaSources = { cwd: 'state.json.cwd', title: st.titleKind === 'custom' || st.isCustomTitle ? 'state.json.title(custom)' : 'state.json.title(generated)' };
  let variant = null;   // wire: turn.prompt.origin.clientMetadata 含 kimi_code_composer = 桌面版；无 = CLI
  if (wireSt) {
    rec.logFile = wireFile; rec.logName = 'wire.jsonl'; rec.bytes = wireSt.size;
    try {
      const { head, tail, bytesRead } = readWireWindows(wireFile, { size: wireSt.size, headBytes: o.wireHeadBytes, tailBytes: o.wireTailBytes });
      let model = null, provider = null, effort = null;
      for (const l of [...head, ...tail]) {
        if (l.type === 'turn.prompt') {
          const meta = JSON.stringify(l.origin?.clientMetadata ?? '');
          variant = meta ? (/composer/i.test(meta) ? 'desktop' : 'cli') : 'cli';
        }
      }
      for (const l of head) {
        if (l.type === 'profile.bind') {
          if (typeof l.modelAlias === 'string') { model = l.modelAlias.split('/').pop(); provider = l.modelAlias.includes('/') ? l.modelAlias.split('/').slice(0, -1).join('/') : null; metaSources.model = 'wire:profile.bind'; }
          if (typeof l.thinkingEffort === 'string') effort = l.thinkingEffort;
        } else if (l.type === 'config.update' && typeof l.thinkingEffort === 'string') effort = l.thinkingEffort;
      }
      // 尾窗口可能也带 config.update（思考档被中途调高）
      for (const l of tail) if (l.type === 'config.update' && typeof l.thinkingEffort === 'string') effort = l.thinkingEffort;
      let coarse = coarseStateFromWireLines(tail.length ? tail : head);
      // 时效修正：turn.prompt 后中断的会话超 5 分钟降级 idle
      {
        const win = tail.length ? tail : head;
        let lastTs = null;
        for (let i = win.length - 1; i >= 0; i--) { if (Number.isFinite(win[i]?.time)) { lastTs = win[i].time; break } }
        if ((coarse.state === 'thinking' || coarse.state === 'running') && lastTs !== null && now - lastTs > 300_000) {
          coarse = { state: 'idle', stateSource: coarse.stateSource + ':stale>5min→idle' };
        }
      }
      rec.model = model; rec.provider = provider; rec.reasoningEffort = effort;
      rec.state = coarse.state; rec.stateSource = coarse.stateSource;
      rec.updatedAt = Math.round(Math.max(st.updatedAt ?? 0, wireSt.mtimeMs));
      rec.live = now - wireSt.mtimeMs < o.liveWindowMs;
      rec.readBytes = bytesRead;
    } catch (e) {
      rec.degraded = true; rec.error = 'wire:' + (e?.code ?? e?.message);
      rec.updatedAt = Math.round(st.updatedAt ?? wireSt.mtimeMs);
    }
  } else {
    rec.updatedAt = Number.isFinite(st.updatedAt) ? Math.round(st.updatedAt) : null;
    rec.state = 'idle'; rec.stateSource = 'no-wire';
  }
  rec.metaSources = metaSources;
  rec.variant = variant;
  return rec;
}

export function scanKimiCatalog(opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const t0 = process.hrtime.bigint();
  const sessionDirs = [];
  try {
    for (const wd of fs.readdirSync(o.root, { withFileTypes: true })) {
      if (!wd.isDirectory() || wd.name.startsWith('.')) continue;
      const wdPath = path.join(o.root, wd.name);
      let es; try { es = fs.readdirSync(wdPath, { withFileTypes: true }); } catch { continue; }
      for (const e of es) if (e.isDirectory() && e.name.startsWith('session_')) sessionDirs.push(path.join(wdPath, e.name));
    }
  } catch { /* root 不存在：未安装/未用过 CLI */ }
  const sessions = [];
  let degraded = 0, readBytes = 0, archived = 0, subagents = 0;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  for (const d of sessionDirs.slice(0, o.maxSessions)) {
    const s = parseKimiSession(d, o);
    if (s.archived) { archived++; continue; }               // 归档会话不进列表
    if (s.degraded) degraded++;
    readBytes += s.readBytes ?? 0;
    sessions.push(s);
    // 子代理流：agents/<非 main>/wire.jsonl（宿主委派后 main 停写、子代理写自己的流）。
    // 产出 kind='subagent' 行供快照给宿主挂活跃度；不进项目组/主会话计数（与 zcode 口径一致）。
    try {
      const agentsDir = path.join(d, 'agents');
      let ags; try { ags = fs.readdirSync(agentsDir, { withFileTypes: true }); } catch { ags = []; }
      for (const a of ags) {
        if (!a.isDirectory() || a.name === 'main') continue;
        const wf = path.join(agentsDir, a.name, 'wire.jsonl');
        let wst; try { wst = fs.statSync(wf); } catch { continue; }
        let coarse = { state: 'unknown', stateSource: 'no-signal' };
        try {
          const { head, tail, bytesRead } = readWireWindows(wf, { size: wst.size, headBytes: o.wireHeadBytes, tailBytes: o.wireTailBytes });
          const win = tail.length ? tail : head;
          coarse = coarseStateFromWireLines(win);
          let lastTs = null;                                // 时效修正同 main：thinking/running 超 5min 无新行 → idle
          for (let i = win.length - 1; i >= 0; i--) { if (Number.isFinite(win[i]?.time)) { lastTs = win[i].time; break } }
          if ((coarse.state === 'thinking' || coarse.state === 'running') && lastTs !== null && now - lastTs > 300_000) {
            coarse = { state: 'idle', stateSource: coarse.stateSource + ':stale>5min→idle' };
          }
          readBytes += bytesRead;
        } catch { /* 子代理 wire 读不了按 unknown */ }
        subagents++;
        sessions.push({
          sessionId: s.sessionId + '::' + a.name, dirName: a.name, agentName: AGENT_NAME, source: SOURCE,
          dir: d, projectDir: path.dirname(d), projectDirName: path.basename(path.dirname(d)),
          title: '子代理 ' + a.name, titleRaw: null, provider: null, model: null, reasoningEffort: null, agentPreset: null,
          agentVersion: null, state: coarse.state, stateSource: 'subagent-wire:' + coarse.stateSource, live: now - wst.mtimeMs < o.liveWindowMs,
          createdAt: null, updatedAt: Math.round(wst.mtimeMs), bytes: wst.size, logFile: wf, logName: 'wire.jsonl',
          origin: 'subagent', parentSession: s.sessionId, delegationDepth: null, isSeeded: null, kind: 'subagent', label: null,
          cwd: s.cwd, cwdSource: s.cwdSource, archived: false, isCustomTitle: null,
          degraded: false, error: null, metaSources: {},
          metaComplete: true, metaApproximate: false, readBytes: 0, readMode: 'state+wire-window',
          variant: null,
        });
      }
    } catch { /* agents 目录缺失：普通会话 */ }
  }
  const ws = readKimiWorkspaces();
  const byCwd = new Map();
  for (const s of sessions) {
    if (s.kind === 'subagent') continue;   // 子代理不进项目组（sessionCount/liveCount 口径不变）
    const key = s.cwd ?? '(未知目录)';
    if (!byCwd.has(key)) byCwd.set(key, []);
    byCwd.get(key).push(s);
  }
  const projects = [];
  for (const [cwd, list] of byCwd) {
    list.sort((a, b) => (Number(b.live) - Number(a.live)) || ((b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
    const wsHit = [...ws.values()].find((w) => w.path === cwd);
    const name = wsHit?.title ?? path.basename(cwd);
    projects.push({
      projectId: 'kimi:' + (wsHit?.id ?? cwd),
      projectDirName: cwd, cwd,
      cwdSource: 'state.json.cwd',
      title: name, name,
      workspaceId: wsHit?.id ?? null, workspaceSessionIds: [],
      sessionCount: list.length, registeredSessionCount: list.length,
      updatedAt: list.reduce((m, s) => Math.max(m, s.updatedAt ?? 0), 0),
      liveCount: list.filter((s) => s.live).length,
      sessions: list,
    });
  }
  projects.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const tookMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const mains = sessions.filter((s) => s.kind !== 'subagent');
  return {
    root: o.root, source: SOURCE, generatedAt: Date.now(), tookMs, elapsedMs: Number(tookMs.toFixed(2)),
    // sessions 含子代理行（供快照挂宿主活跃度）；sessionCount 仅主会话（软件状态卡「会话总数」用）
    projects, sessions, sessionCount: mains.length, failed: degraded,
    stats: { projects: projects.length, sessions: mains.length, live: mains.filter((s) => s.live).length, degraded, archived, readBytes, subagentSessions: subagents },
  };
}

// ---------------------------------------------------------------------------
// 3. wire 行 → 规范事件（纯函数）
// ---------------------------------------------------------------------------

/**
 * 把一行 wire 事件映射为零或多条规范事件（信封与 claude/codex 适配器同构）。
 * @param line wire 行对象
 * @param ctx {sessionId, seq}
 */
export function mapKimiLine(line, ctx) {
  if (!line || typeof line.type !== 'string') return [];
  const seq = ++ctx.seq;
  const ts = Number.isFinite(line.time) ? line.time : Date.now();
  const base = { v: 1, seq, ts, source: SOURCE, sessionId: ctx.sessionId };
  switch (line.type) {
    case 'turn.prompt':
      return [{ ...base, type: 'turn.start', data: { turnId: 'turn-' + (line.turnId ?? seq), inputKind: 'user' } }];
    case 'turn.ended': {
      const r = String(line.reason ?? '');
      return [{ ...base, type: 'turn.end', data: { turnId: 'turn-' + (line.turnId ?? seq), status: r === 'completed' ? 'ok' : (r === 'cancelled' || r === 'aborted') ? 'aborted' : 'error', durationMs: Number.isFinite(line.durationMs) ? line.durationMs : undefined } }];
    }
    case 'context.append_loop_event': {
      const ev = line.event ?? {};
      if (ev.type === 'tool.call') {
        const toolName = String(ev.name ?? ev.toolName ?? ev.tool_name ?? 'unknown');
        const category = categoryOf(toolName);
        return [{ ...base, type: 'tool.call', data: { callId: ev.uuid ?? ev.toolCallId ?? ev.callId ?? ('call-' + seq), toolName, category, risk: RISK_BY_CATEGORY[category], summary: '' } }];
      }
      if (ev.type === 'tool.result') {
        return [{ ...base, type: 'tool.result', data: { callId: ev.uuid ?? ev.toolCallId ?? ev.callId ?? ('call-' + seq), status: ev.error || ev.isError ? 'error' : 'ok' } }];
      }
      return [];      // step.begin/end、content.part：v1 不映射
    }
    case 'agent.message.appended': {
      const msg = line.message?.message ?? line.message ?? {};
      if (msg.role !== 'assistant') return [];
      const c = msg.content;
      const text = Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join(' ') : (typeof c === 'string' ? c : '');
      return text ? [{ ...base, type: 'message.assistant', data: { text: clip(text, 280), truncated: true } }] : [];
    }
    case 'interaction.request': {
      if (line.kind !== 'approval') return [];             // 其他 interaction（提问等）v1 不映射
      const toolName = String(line.request?.toolName ?? line.toolName ?? 'unknown');
      return [{ ...base, type: 'approval.request', data: { requestId: String(line.id ?? ('req-' + seq)), kind: 'permission', summary: clip('等待批准：' + toolName, 120), risk: RISK_BY_CATEGORY[categoryOf(toolName)] } }];
    }
    case 'interaction.resolved': {
      const d = String(line.response?.decision ?? '');
      return [{ ...base, type: 'approval.resolved', data: { requestId: String(line.id ?? ('req-' + seq)), decision: /allow|approve|accept|yes/i.test(d) ? 'allow' : /deny|reject|block|no/i.test(d) ? 'deny' : 'timeout', nativeOutcome: d || undefined } }];
    }
    case 'turn.step.retrying':
      return [{ ...base, type: 'error.raised', data: { scope: 'llm', message: '第 ' + (line.step ?? '?') + ' 步重试（' + (line.failedAttempt ?? '?') + '/' + (line.maxAttempts ?? '?') + '）', fatal: false } }];
    default:
      return [];      // metadata/profile.bind/llm.*/usage.*/token_*/file_history/mcp.*/permission.*/plan_mode/task.*：不产事件
  }
}

// ---------------------------------------------------------------------------
// 4. 多文件增量跟随（wire.jsonl；只跟 main agent 的流——非 main = 子代理，红线：不产行）
// ---------------------------------------------------------------------------

export function followKimiLogs(opts = {}) {
  const root = opts.root || SESSIONS_ROOT;
  const intervalMs = opts.intervalMs ?? 1200;
  const maxFiles = opts.maxFiles ?? 80;
  const onEvent = opts.onEvent ?? (() => {});
  const files = new Map();          // wireFile -> {offset, ctx, sessionId, cwd, mtimeMs}
  const evictedOffsets = new Map(); // 被淘汰文件的 offset（再准入时续读）
  let stopped = false;
  const stats = { files: 0, lines: 0, events: 0, parseErrors: 0, resamples: 0, subagentSkipped: 0, evictions: 0 };

  function listWires() {
    const out = [];
    try {
      for (const wd of fs.readdirSync(root, { withFileTypes: true })) {
        if (!wd.isDirectory() || wd.name.startsWith('.')) continue;
        const wdPath = path.join(root, wd.name);
        let ses; try { ses = fs.readdirSync(wdPath, { withFileTypes: true }); } catch { continue; }
        for (const s of ses) {
          if (!s.isDirectory() || !s.name.startsWith('session_')) continue;
          const agentsDir = path.join(wdPath, s.name, 'agents');
          let ags; try { ags = fs.readdirSync(agentsDir, { withFileTypes: true }); } catch { continue; }
          for (const a of ags) if (a.isDirectory()) out.push({ file: path.join(agentsDir, a.name, 'wire.jsonl'), agentId: a.name, sessionDir: path.join(wdPath, s.name) });
        }
      }
    } catch { /* 未安装：静默 */ }
    return out;
  }

  /** 首遇文件：读同目录上级的 state.json 拿 sessionId/cwd；非 main agent = 子代理流，跳过。 */
  function describe(entry) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(entry.sessionDir, 'state.json'), 'utf8'));
      return { sessionId: typeof st.id === 'string' ? st.id : path.basename(entry.sessionDir), cwd: typeof st.cwd === 'string' ? st.cwd : undefined };
    } catch { return { sessionId: path.basename(entry.sessionDir), cwd: undefined }; }
  }

  /** 预算准入（maxFiles）：触顶淘汰最久未修改的跟随项；被淘汰者再活跃时从淘汰点续读（防抖 + 不漏增量）。 */
  function admit(entry, st) {
    const existing = files.get(entry.file);
    if (existing) return existing;
    if (files.size >= maxFiles) {
      let victimFile = null, victim = null;
      for (const [key, item] of files) {
        if (!victim || (item.mtimeMs ?? 0) < (victim.mtimeMs ?? 0)) { victim = item; victimFile = key; }
      }
      if (!victim || (victim.mtimeMs ?? 0) >= st.mtimeMs) return null;
      files.delete(victimFile);
      evictedOffsets.set(victimFile, victim.offset);
      if (evictedOffsets.size > maxFiles * 2) evictedOffsets.delete(evictedOffsets.keys().next().value);
      stats.evictions++;
    }
    if (entry.agentId !== 'main') { files.set(entry.file, { offset: st.size, subagent: true, mtimeMs: st.mtimeMs }); stats.subagentSkipped++; return null; }
    const d = describe(entry);
    const resume = evictedOffsets.get(entry.file);
    evictedOffsets.delete(entry.file);
    const offset = opts.fromStart ? 0 : (resume !== undefined && st.size >= resume ? resume : st.size);
    const fresh = { offset, ctx: { sessionId: d.sessionId, seq: 0 }, cwd: d.cwd, hello: false, mtimeMs: st.mtimeMs };
    files.set(entry.file, fresh);
    return fresh;
  }

  function pump() {
    if (stopped) return;
    // 先统一 stat 并按 mtime 倒序：最近写入的会话优先占预算
    const entries = [];
    for (const entry of listWires()) {
      let st; try { st = fs.statSync(entry.file); } catch { continue; }
      entries.push({ entry, st });
    }
    entries.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    for (const { entry, st } of entries) {
      const f = admit(entry, st);
      if (!f) continue;
      f.mtimeMs = st.mtimeMs;
      if (f.subagent) continue;
      if (st.size < f.offset) { f.offset = 0; stats.resamples++; }
      if (st.size <= f.offset) continue;
      let chunk;
      try {
        const fd = fs.openSync(entry.file, 'r');
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
        if (Buffer.byteLength(t) > DEFAULT_OPTS.maxLineBytes) continue;    // 超大行（大 content.part）不值得映射
        if (!f.hello) {
          f.hello = true;
          onEvent({ v: 1, seq: ++f.ctx.seq, ts: Number.isFinite(o.time) ? o.time : Date.now(), source: SOURCE, sessionId: f.ctx.sessionId, type: 'session.start', data: { workspace: f.cwd } });
        }
        for (const ev of mapKimiLine(o, f.ctx)) { stats.events++; onEvent(ev); }
      }
    }
    stats.files = files.size;
  }

  const timer = setInterval(pump, intervalMs);
  pump();
  return { stop() { stopped = true; clearInterval(timer); }, stats: () => ({ ...stats }) };
}

// ---------------------------------------------------------------------------
// 5. 第三层兜底：LevelDB 近似计数（原降级通道，保留）
// ---------------------------------------------------------------------------

const SESSION_KEY_RE = /session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

/** Electron 前端层 Local Storage 键名去重计数（压缩块可能漏计 → approximate）。 */
export function scanKimiLegacyCount(dir = KIMI_LEVELDB, { budgetBytes = 2 * 1024 * 1024 } = {}) {
  const ids = new Set();
  let files = 0, readBytes = 0, lastActivityMs = null;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { count: 0, approximate: true, files: 0, readBytes: 0, lastActivityMs: null, available: false }; }
  for (const e of ents) {
    if (!e.isFile() || !/\.(log|ldb)$/.test(e.name)) continue;
    const p = path.join(dir, e.name);
    let st; try { st = fs.statSync(p); } catch { continue; }
    lastActivityMs = Math.max(lastActivityMs ?? 0, st.mtimeMs);
    files++;
    if (readBytes >= budgetBytes) continue;
    try {
      const fd = fs.openSync(p, 'r');
      try {
        const len = Math.min(st.size, budgetBytes - readBytes);
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, 0);
        readBytes += n;
        const text = buf.subarray(0, n).toString('latin1');
        SESSION_KEY_RE.lastIndex = 0;
        let m;
        while ((m = SESSION_KEY_RE.exec(text))) ids.add(m[1]);
      } finally { fs.closeSync(fd); }
    } catch { /* 并发写入/权限：跳过 */ }
  }
  return { count: ids.size, approximate: true, files, readBytes, lastActivityMs, available: files > 0 };
}

/**
 * Kimi 状态快照（四态面板数据）：优先 ~/.kimi-code（精确），缺失时退回 LevelDB（近似）。
 * @param {{processRunning?:boolean}} ctx 进程态由 local-agents 的 ps 轮询注入
 */
export function scanKimiStatus(ctx = {}) {
  let sessionCount = null, approximate = false, dataLocation = SESSIONS_ROOT, degraded = false, degradeReason = null;
  try {
    const cat = scanKimiCatalog();
    if (cat.sessionCount > 0 || fs.existsSync(SESSIONS_ROOT)) {
      sessionCount = cat.sessionCount; dataLocation = SESSIONS_ROOT;
    }
  } catch { /* 走兜底 */ }
  if (sessionCount === null) {
    const legacy = scanKimiLegacyCount();
    sessionCount = legacy.available ? legacy.count : null;
    approximate = true;
    dataLocation = KIMI_LEVELDB;
    degraded = true; degradeReason = 'no-kimi-home-fallback-leveldb';
  }
  return {
    source: SOURCE, agentName: AGENT_NAME,
    installed: (() => { try { return fs.existsSync(path.join('/Applications', 'Kimi Code.app')) || fs.existsSync(KIMI_HOME); } catch { return false; } })(),
    processRunning: !!ctx.processRunning,
    degraded, degradeReason,
    observes: sessionCount !== null && !degraded ? ['session.start', 'turn.start', 'turn.end', 'tool.call', 'tool.result', 'approval.request', 'approval.resolved', 'message.assistant'] : ['session.heartbeat'],
    sessionCount, sessionCountApproximate: approximate,
    dataLocation,
    note: degraded ? '未找到 ~/.kimi-code（CLI 未使用过）：LevelDB 近似计数兜底' : 'A 路径：state.json 目录 + wire.jsonl 事件 tail（LevelDB 仅兜底）',
  };
}

// ---------------------------------------------------------------------------
// 6. CLI
// ---------------------------------------------------------------------------

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms); const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

export function formatKimiTree(catalog) {
  const lines = [];
  lines.push('Kimi Code 会话目录 ' + catalog.root);
  lines.push(catalog.stats.projects + ' 个项目 / ' + catalog.stats.sessions + ' 个会话（归档 ' + catalog.stats.archived + ' 不列出 · 活跃 ' + catalog.stats.live + ' · 降级 ' + catalog.stats.degraded + '）  扫描耗时 ' + catalog.tookMs.toFixed(1) + ' ms');
  for (const p of catalog.projects) {
    lines.push('');
    lines.push('📁 ' + p.title + '   (' + p.cwd + ')');
    for (const s of p.sessions) {
      const flags = [s.live ? '● 活跃' : '', s.degraded ? '⚠ 降级' : ''].filter(Boolean).join('  ');
      lines.push('   └─ ' + String(s.sessionId).replace(/^session_/, '').slice(0, 12).padEnd(13) + fmtTime(s.updatedAt) + '  ' + String(s.model ?? '—').padEnd(10) + ' th:' + String(s.reasoningEffort ?? '—').padEnd(5) + String(s.state).padEnd(9) + flags);
      lines.push('      「' + String(s.title ?? '').slice(0, 46) + '」  titleKind=' + (s.titleKind ?? '—'));
    }
  }
  return lines.join('\n');
}

async function main(argv) {
  if (argv.includes('--follow')) {
    console.log('跟随 ' + SESSIONS_ROOT + '（Ctrl-C 退出）');
    followKimiLogs({ onEvent: (ev) => console.log(JSON.stringify(ev)) });
    return;
  }
  if (argv.includes('--status')) {
    console.log(JSON.stringify(scanKimiStatus(), null, 2));
    return;
  }
  const runs = (() => { const i = argv.indexOf('--bench'); return i >= 0 ? Math.max(1, Number(argv[i + 1]) || 5) : 1; })();
  let catalog; const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    catalog = scanKimiCatalog();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  if (argv.includes('--json')) console.log(JSON.stringify(catalog, null, 2));
  else {
    console.log(formatKimiTree(catalog));
    if (runs > 1) console.log('\n扫描耗时 ' + runs + ' 轮：min ' + Math.min(...times).toFixed(1) + ' / 中位 ' + times.sort((a, b) => a - b)[Math.floor(times.length / 2)].toFixed(1) + ' / max ' + Math.max(...times).toFixed(1) + ' ms');
  }
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) await main(process.argv.slice(2));
