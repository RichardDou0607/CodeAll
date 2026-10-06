#!/usr/bin/env node
/**
 * adapters/claude-code-adapter.mjs — Claude Code 观察适配器（docs/21 M-A）
 *
 * 事件源（全部**只读**）：~/.claude/projects/<cwd 转义>/<sessionId>.jsonl（纯 JSONL，无压缩）
 *   - 目录即项目（无注册表）：项目真相源 = ~/.claude/projects 本身（docs/21 §0.2）
 *   - 转录行结构与字段均本机实测（scripts/scan-claude-transcripts.mjs + docs/40 §3.1）：
 *     user / assistant / attachment / system(turn_duration|api_error|…) / custom-title /
 *     ai-title / agent-name / queue-operation / last-prompt / mode / permission-mode / …
 *   - 子代理（sidechain）消息写在**同一个会话文件**内（isSidechain=true），文件级无需拆分；
 *     事件级一律忽略 isSidechain=true 的行。
 *
 * 两个入口：
 *   ① scanClaudeCatalog(opts)  → 会话目录（与 adapters/session-catalog.mjs 的 DSH 目录同构）
 *   ② followClaudeLogs(opts)   → 多文件增量 tail → 规范事件（喂给 framed.mjs 的 applyEvent）
 *
 * 隐私红线（docs/21 §0.5）：只输出状态级字段；message.assistant 文本截断 280 字符；
 *   工具参数只留 category + 工具名；绝不携带工具输出/文件内容/思维链。
 *
 * 用法：
 *   node adapters/claude-code-adapter.mjs                # 人类可读目录
 *   node adapters/claude-code-adapter.mjs --json         # 机器可读
 *   node adapters/claude-code-adapter.mjs --follow       # 实时 tail（打印规范事件，诊断用）
 *   node adapters/claude-code-adapter.mjs --bench 10     # 性能实测
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { categoryOf } from '../demo/frame.mjs';

/** 与 demo/frame.mjs 的 RISK_BY_CATEGORY 同表（那边未导出；保持一致，勿分叉） */
const RISK_BY_CATEGORY = { exec: 2, write: 2, net: 1, read: 0, other: 1 };

export const SOURCE = 'claude-code';
export const AGENT_NAME = 'Claude Code';
export const PROJECTS_ROOT = process.env.CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');

export const DEFAULT_OPTS = Object.freeze({
  root: PROJECTS_ROOT,
  headBytes: 24 * 1024,          // 头窗口：cwd/version/title(ai-title 常在头部)
  tailBytes: 160 * 1024,         // 尾窗口：最近状态/模型/custom-title
  maxLineBytes: 512 * 1024,      // 单行超限直接跳过（本机实测最大 1.8MB，都是工具输出行）
  liveWindowMs: 60_000,
  maxSessions: 500,
  now: null,
});

// ---------------------------------------------------------------------------
// 1. 目录名 ↔ 项目路径（Claude Code 的转义是有损的：非安全字符一律折叠成 '-'，
//    因此目录名只做兜底展示；权威 cwd 一律取行内 cwd 字段）
// ---------------------------------------------------------------------------

export function decodeClaudeProjectDir(name) {
  if (typeof name !== 'string' || !name.startsWith('-') || name.length < 2) return null;
  return name.replace(/^-+/, '').replace(/-+/g, '/').replace(/^\//, '/') || null;
}

// ---------------------------------------------------------------------------
// 2. 窗口读取（头/尾各一段；只解析能完整 JSON.parse 的行，窗口边缘半行自然丢弃）
// ---------------------------------------------------------------------------

function readWindowLines(file, start, length, maxLineBytes = DEFAULT_OPTS.maxLineBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, length));
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.subarray(0, n).toString('utf8');
    const lines = text.split('\n');
    // 首行只有从头读（start===0）时才完整；尾窗口的首行大概率是被劈开的半行
    if (start > 0) lines.shift();
    const out = [];
    for (const l of lines) {
      const t = l.trim();
      if (!t) continue;
      if (Buffer.byteLength(t) > maxLineBytes) continue;   // 超大行（工具输出）不值得解析
      try { out.push(JSON.parse(t)); } catch { /* 半行/坏行：跳过 */ }
    }
    return out;
  } finally { fs.closeSync(fd); }
}

/** 窗口化读取一个转录文件：head + tail 两段行集合（按文件序）。 */
export function readTranscriptWindows(file, { size = null, headBytes = DEFAULT_OPTS.headBytes, tailBytes = DEFAULT_OPTS.tailBytes } = {}) {
  const fileSize = size ?? fs.statSync(file).size;
  if (fileSize === 0) return { head: [], tail: [], bytesRead: 0 };
  const headLen = Math.min(headBytes, fileSize);
  const tailLen = Math.min(tailBytes, Math.max(0, fileSize - headLen));
  const head = readWindowLines(file, 0, headLen);
  const tail = tailLen > 0 ? readWindowLines(file, fileSize - tailLen, tailLen) : [];
  return { head, tail, bytesRead: headLen + tailLen };
}

// ---------------------------------------------------------------------------
// 3. 会话记录（目录行）与粗粒度状态
// ---------------------------------------------------------------------------

const ts = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** 从窗口行集合推导粗粒度状态（只看最后一条有效信号；口径对齐 DSH 的 coarseState）。 */
export function coarseStateFromLines(lines) {
  let state = 'idle', stateSource = 'no-signal';
  for (const o of lines) {
    if (o?.type === 'user' && o.isSidechain === false) { state = 'thinking'; stateSource = 'user'; }
    else if (o?.type === 'assistant' && Array.isArray(o.message?.content)) {
      const hasTool = o.message.content.some((b) => b?.type === 'tool_use');
      state = hasTool ? 'running' : o.message.stop_reason === 'end_turn' ? 'done' : 'thinking';
      stateSource = 'assistant:' + (hasTool ? 'tool_use' : o.message.stop_reason || 'message');
    }
    else if (o?.type === 'system' && o.subtype === 'turn_duration') { state = 'done'; stateSource = 'system/turn_duration'; }
    else if (o?.type === 'system' && o.subtype === 'api_error') { state = 'error'; stateSource = 'system/api_error'; }
  }
  return { state, stateSource };
}

/** 解析单个转录文件 → 会话记录；任何失败都降级为 sessionId + 时间 + 大小（与 DSH parseSession 同策略）。 */
export function parseClaudeSession(file, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const name = path.basename(file);
  const sessionId = name.replace(/\.jsonl$/, '');
  const st = (() => { try { return fs.statSync(file); } catch { return null; } })();
  const base = {
    sessionId, dirName: name, agentName: AGENT_NAME, source: SOURCE,
    dir: path.dirname(file), projectDir: path.dirname(file), projectDirName: path.basename(path.dirname(file)),
    title: null, titleRaw: null, provider: null, model: null, reasoningEffort: null, agentPreset: null,
    agentVersion: null, state: 'unknown', stateSource: null, live: false,
    createdAt: null, updatedAt: null, bytes: st?.size ?? 0, logFile: file, logName: name,
    origin: null, parentSession: null, delegationDepth: null, isSeeded: null, kind: 'main', label: null,
    cwd: null, cwdSource: null, gitBranch: null, entrypoint: null,
    degraded: false, error: null,
    metaSources: {}, metaComplete: false, metaApproximate: true, readBytes: 0, readMode: 'window',
  };
  if (!st) return { ...base, degraded: true, error: 'stat' };
  let head, tail, bytesRead;
  try { ({ head, tail, bytesRead } = readTranscriptWindows(file, { size: st.size, headBytes: o.headBytes, tailBytes: o.tailBytes })); }
  catch (e) { return { ...base, degraded: true, error: 'read:' + (e?.code ?? e?.message) }; }
  const lines = [...head, ...tail];
  const metaSources = {};
  let cwd = null, version = null, gitBranch = null, entrypoint = null, createdAt = null, lastTs = null;
  let customTitle = null, aiTitle = null, agentNameTitle = null, model = null;
  for (const l of head) {
    if (!cwd && typeof l.cwd === 'string') { cwd = l.cwd; metaSources.cwd = 'line:cwd(head)'; }
    if (!createdAt) { const t = ts(l.timestamp); if (t) { createdAt = t; } }
    if (l.type === 'ai-title' && !aiTitle && typeof l.aiTitle === 'string') { aiTitle = l.aiTitle; metaSources.title = 'ai-title'; }
  }
  // 尾窗口按序覆盖：custom-title > ai-title > agent-name；model 取最后一个 assistant
  for (const l of lines) {
    if (typeof l.cwd === 'string' && cwd !== l.cwd) cwd = cwd ?? l.cwd;
    const t = ts(l.timestamp); if (t && (!lastTs || t > lastTs)) lastTs = t;
    if (typeof l.version === 'string') version = l.version;
    if (typeof l.gitBranch === 'string') gitBranch = l.gitBranch;
    if (typeof l.entrypoint === 'string') entrypoint = l.entrypoint;
    if (l.type === 'custom-title' && typeof l.customTitle === 'string') { customTitle = l.customTitle; metaSources.title = 'custom-title'; }
    else if (l.type === 'ai-title' && typeof l.aiTitle === 'string' && !customTitle && !aiTitle) { aiTitle = l.aiTitle; metaSources.title = metaSources.title ?? 'ai-title'; }
    else if (l.type === 'agent-name' && typeof l.agentName === 'string') agentNameTitle = l.agentName;
    if (l.type === 'assistant' && typeof l.message?.model === 'string') { model = l.message.model; metaSources.model = 'assistant.message.model'; }
  }
  const coarse = coarseStateFromLines(tail.length ? tail : lines);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const title = customTitle ?? aiTitle ?? agentNameTitle ?? null;
  const updatedAt = Math.round(Math.max(st.mtimeMs, lastTs ?? 0));
  // 会话形态（命令行版 vs 桌面版）：entrypoint 实测 ∈ cli / sdk-cli / claude-desktop-3p / claude-vscode
  const variant = entrypoint == null ? null
    : /desktop/i.test(entrypoint) ? 'desktop'
    : /vscode/i.test(entrypoint) ? 'ide'
    : 'cli';                                   // cli / sdk-cli 及其他 CLI 形态
  return {
    ...base,
    title: title ?? path.basename(cwd ?? decodeClaudeProjectDir(base.projectDirName) ?? sessionId),
    titleRaw: title, metaSources,
    cwd: cwd ?? decodeClaudeProjectDir(base.projectDirName),
    cwdSource: cwd ? 'line:cwd' : 'dir-name(lossy)',
    createdAt, updatedAt, model,
    agentVersion: version,
    gitBranch, entrypoint, variant,
    state: coarse.state, stateSource: coarse.stateSource,
    live: now - st.mtimeMs < o.liveWindowMs,
    metaComplete: false, metaApproximate: true,      // 窗口近似：与 DSH 快扫同口径
    readBytes: bytesRead, readMode: 'window',
    degraded: false, error: null,
  };
}

/** 全量扫描：项目（= 目录）→ 会话列表。输出结构与 scanCatalog 同构，便于 framed.mjs 合并。 */
export function scanClaudeCatalog(opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const t0 = process.hrtime.bigint();
  const projects = [], sessions = [];
  let degraded = 0, readBytes = 0, total = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(o.root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); }
  catch {
    return { root: o.root, source: SOURCE, generatedAt: Date.now(), tookMs: 0, elapsedMs: 0, projects: [], sessions: [], sessionCount: 0, failed: 0, stats: { projects: 0, sessions: 0, degraded: 0 }, error: 'root-unreadable' };
  }
  for (const projectDirName of dirs) {
    const projectPath = path.join(o.root, projectDirName);
    let files = [];
    try { files = fs.readdirSync(projectPath, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name).sort(); } catch { continue; }
    const list = [];
    for (const f of files) {
      if (total >= o.maxSessions) break;
      const s = parseClaudeSession(path.join(projectPath, f), o);
      total++;
      if (s.degraded) degraded++;
      readBytes += s.readBytes ?? 0;
      list.push(s);
    }
    if (!list.length) continue;
    sessions.push(...list);
    list.sort((a, b) => (Number(b.live) - Number(a.live)) || ((b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
    const cwd = list.find((s) => s.cwdSource === 'line:cwd')?.cwd ?? decodeClaudeProjectDir(projectDirName) ?? projectDirName;
    projects.push({
      projectId: 'claude:' + projectDirName,
      projectDirName, cwd,
      cwdSource: list.some((s) => s.cwdSource === 'line:cwd') ? 'line:cwd' : 'dir-name(lossy)',
      title: path.basename(cwd), name: path.basename(cwd),
      workspaceId: null, workspaceSessionIds: [],
      sessionCount: list.length, registeredSessionCount: list.length,
      updatedAt: list.reduce((m, s) => Math.max(m, s.updatedAt ?? 0), 0),
      liveCount: list.filter((s) => s.live).length,
      sessions: list,
    });
  }
  projects.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const tookMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    root: o.root, source: SOURCE, generatedAt: Date.now(), tookMs, elapsedMs: Number(tookMs.toFixed(2)),
    projects, sessions, sessionCount: sessions.length, failed: degraded,
    stats: { projects: projects.length, sessions: sessions.length, live: sessions.filter((s) => s.live).length, degraded, readBytes, subagentSessions: 0 },
  };
}

// ---------------------------------------------------------------------------
// 4. 行 → 规范事件（纯函数；事件信封与 demo/frame.mjs 的 DSH 映射同构）
// ---------------------------------------------------------------------------

function clip(s, n) { s = String(s ?? '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

/**
 * 把一行转录映射为零或多条规范事件。
 * @param line 转录行对象
 * @param ctx {sessionId, seq} —— sessionId 必传（跟随器维护），seq 由本函数自增
 */
export function mapClaudeLine(line, ctx) {
  if (!line || typeof line.type !== 'string') return [];
  const sessionId = ctx.sessionId ?? line.sessionId ?? 'unknown';
  const t = ts(line.timestamp) ?? Date.now();
  const seq = ++ctx.seq;
  const base = { v: 1, seq, ts: t, source: SOURCE, sessionId };
  switch (line.type) {
    case 'user': {
      if (line.isSidechain === true) return [];                    // 子代理内部回合：忽略
      const c = line.message?.content;
      const blocks = Array.isArray(c) ? c : null;
      if (blocks) {
        // role=user 且 content 是数组：多半是上一轮工具结果回填（tool_result 块）
        const out = [];
        for (const b of blocks) {
          if (b?.type === 'tool_result') {
            out.push({ ...base, type: 'tool.result', data: { callId: b.tool_use_id ?? ('call-' + seq), status: b.is_error ? 'error' : 'ok' } });
          } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            out.push({ ...base, type: 'turn.start', data: { inputKind: 'user', turnId: line.promptId ?? ('turn-' + seq) } });
            break;                                                  // 一轮只有一个 turn.start
          }
        }
        return out;
      }
      if (typeof c === 'string' && c.trim()) return [{ ...base, type: 'turn.start', data: { inputKind: 'user', turnId: line.promptId ?? ('turn-' + seq) } }];
      return [];
    }
    case 'assistant': {
      if (line.isSidechain === true) return [];
      const msg = line.message ?? {};
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const out = [];
      for (const b of blocks) {
        if (b?.type === 'tool_use') {
          const category = categoryOf(String(b.name ?? ''));
          out.push({ ...base, type: 'tool.call', data: { callId: b.id ?? ('call-' + seq), toolName: String(b.name ?? 'unknown'), category, risk: RISK_BY_CATEGORY[category], summary: clip(typeof b.input === 'object' ? JSON.stringify(Object.keys(b.input ?? {})).slice(0, 120) : b.input, 120) } });
        }
      }
      if (msg.stop_reason === 'end_turn') {
        out.push({ ...base, type: 'message.assistant', data: { text: clip(blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(' '), 280), truncated: true } });
        out.push({ ...base, type: 'turn.end', data: { status: 'ok', turnId: line.promptId ?? ('turn-' + seq) } });
      }
      return out;
    }
    case 'system': {
      if (line.subtype === 'turn_duration') return [{ ...base, type: 'turn.end', data: { status: 'ok', durationMs: Number.isFinite(line.durationMs) ? line.durationMs : undefined, turnId: line.promptId ?? ('turn-' + seq) } }];
      if (line.subtype === 'api_error') return [{ ...base, type: 'error.raised', data: { scope: 'llm', message: clip(line.error?.message ?? 'api error', 80), fatal: false } }];
      return [];
    }
    case 'custom-title': case 'ai-title': case 'agent-name': {
      // 标题行不改状态，但让会话行立刻拿到标题（touchSession 会带出）
      const title = line.customTitle ?? line.aiTitle ?? line.agentName;
      return typeof title === 'string' && title ? [{ ...base, type: 'session.meta', data: { title } }] : [];
    }
    default: return [];      // queue-operation / mode / …：v1 不映射（契约 §1.5 未知忽略）
  }
}

// ---------------------------------------------------------------------------
// 5. 多文件增量跟随（纯 JSONL：按字节 offset 增量读；轮询 + 新文件发现）
// ---------------------------------------------------------------------------

/**
 * 跟随 ~/.claude/projects 下全部转录文件的新增行，产出规范事件。
 * 启动时从各文件**末尾**开始（不回放历史，避免 7.5 万行灌进状态机）；--fromStart 可选回放。
 * @param {{root?:string, intervalMs?:number, onEvent:(ev)=>void, fromStart?:boolean, maxFiles?:number}} opts
 * @returns {{stop:()=>void, stats:()=>object}}
 */
export function followClaudeLogs(opts = {}) {
  const root = opts.root || PROJECTS_ROOT;
  const intervalMs = opts.intervalMs ?? 1200;
  const maxFiles = opts.maxFiles ?? 80;
  const onEvent = opts.onEvent ?? (() => {});
  const files = new Map();          // file -> {offset, ctx, sessionId, sessionStarted}
  let stopped = false;
  const stats = { files: 0, lines: 0, events: 0, parseErrors: 0, resamples: 0 };

  function listFiles() {
    const out = [];
    try {
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const p = path.join(root, d.name);
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
          if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path.join(p, e.name));
        }
      }
    } catch { /* root 不存在：静默（未安装 Claude Code） */ }
    return out;
  }

  function ensure(file, size) {
    let f = files.get(file);
    if (!f) {
      if (files.size >= maxFiles) return null;                     // 预算封顶：最老的文件不再跟随
      f = { offset: opts.fromStart ? 0 : size, ctx: { sessionId: path.basename(file).replace(/\.jsonl$/, ''), seq: 0 }, sessionStarted: false };
      files.set(file, f);
    }
    return f;
  }

  function pump() {
    if (stopped) return;
    const now = Date.now();
    for (const file of listFiles()) {
      let st; try { st = fs.statSync(file); } catch { continue; }
      const f = ensure(file, st.size);
      if (!f) continue;
      if (st.size < f.offset) { f.offset = 0; stats.resamples++; }  // 文件被截断/重建：从头重读
      if (st.size <= f.offset) continue;
      // 按字节增量读（offset 是字节偏移；绝不能整文件转字符串再切片——字符/字节偏移在
      // 多字节内容上会错位，且 1.8MB 文件每 1.2s 全读一遍不可接受）
      let chunk;
      try {
        const fd = fs.openSync(file, 'r');
        try {
          const len = Math.min(st.size - f.offset, 8 * 1024 * 1024);   // 单轮最多追 8MB，防失控
          const buf = Buffer.alloc(len);
          const n = fs.readSync(fd, buf, 0, len, f.offset);
          chunk = buf.subarray(0, n).toString('utf8');
        } finally { fs.closeSync(fd); }
      } catch { continue; }
      const nl = chunk.lastIndexOf('\n');
      if (nl < 0) continue;                                          // 还没有完整行
      const complete = chunk.slice(0, nl);
      f.offset += Buffer.byteLength(complete, 'utf8') + 1;
      for (const l of complete.split('\n')) {
        const t = l.trim();
        if (!t) continue;
        stats.lines++;
        let o; try { o = JSON.parse(t); } catch { stats.parseErrors++; continue; }
        if (!f.sessionStarted && o.type === 'user') {
          f.sessionStarted = true;
          onEvent({ v: 1, seq: ++f.ctx.seq, ts: Date.parse(o.timestamp) || now, source: SOURCE, sessionId: f.ctx.sessionId, type: 'session.start', data: { workspace: typeof o.cwd === 'string' ? o.cwd : undefined, agentVersion: typeof o.version === 'string' ? o.version : undefined } });
        }
        for (const ev of mapClaudeLine(o, f.ctx)) { stats.events++; onEvent(ev); }
      }
    }
    stats.files = files.size;
  }

  const timer = setInterval(pump, intervalMs);
  pump();
  return { stop() { stopped = true; clearInterval(timer); }, stats: () => ({ ...stats }) };
}

// ---------------------------------------------------------------------------
// 6. CLI
// ---------------------------------------------------------------------------

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms); const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function fmtBytes(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : n >= 1024 ? (n / 1024).toFixed(0) + 'KB' : n + 'B'; }

export function formatClaudeTree(catalog) {
  const lines = [];
  lines.push('Claude Code 会话目录 ' + catalog.root);
  lines.push(catalog.stats.projects + ' 个项目 / ' + catalog.stats.sessions + ' 个会话（活跃 ' + catalog.stats.live + ' · 降级 ' + catalog.stats.degraded + '）  扫描耗时 ' + catalog.tookMs.toFixed(1) + ' ms');
  for (const p of catalog.projects) {
    lines.push('');
    lines.push('📁 ' + p.title + '   (' + p.cwd + ')');
    for (const s of p.sessions) {
      const flags = [s.live ? '● 活跃' : '', s.degraded ? '⚠ 降级' : ''].filter(Boolean).join('  ');
      lines.push('   └─ ' + String(s.sessionId).slice(0, 12).padEnd(13) + fmtTime(s.updatedAt) + '  ' + fmtBytes(s.bytes).padStart(6) +
        '  ' + String(s.model ?? '—').padEnd(20) + '  v' + String(s.agentVersion ?? '—').padEnd(10) + String(s.state).padEnd(9) + flags);
      lines.push('      「' + String(s.title ?? '').slice(0, 46) + '」  ' + (s.cwdSource === 'line:cwd' ? '' : '⚠ cwd 来自目录名(有损)'));
    }
  }
  return lines.join('\n');
}

async function main(argv) {
  if (argv.includes('--follow')) {
    console.log('跟随 ' + PROJECTS_ROOT + '（Ctrl-C 退出）');
    followClaudeLogs({ onEvent: (ev) => console.log(JSON.stringify(ev)) });
    return;
  }
  const runs = (() => { const i = argv.indexOf('--bench'); return i >= 0 ? Math.max(1, Number(argv[i + 1]) || 5) : 1; })();
  let catalog;
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    catalog = scanClaudeCatalog();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  if (argv.includes('--json')) console.log(JSON.stringify(catalog, null, 2));
  else {
    console.log(formatClaudeTree(catalog));
    if (runs > 1) console.log('\n扫描耗时 ' + runs + ' 轮：min ' + Math.min(...times).toFixed(1) + ' / 中位 ' + times.sort((a, b) => a - b)[Math.floor(times.length / 2)].toFixed(1) + ' / max ' + Math.max(...times).toFixed(1) + ' ms');
  }
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) await main(process.argv.slice(2));
