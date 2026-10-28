#!/usr/bin/env node
/**
 * adapters/session-catalog.mjs — DSH 会话目录（项目 → 会话树 + 元信息）
 *
 * 数据来源（全部**只读**）：
 *   ~/.dsh/sessions/<projectKey>/<sessionId>/session.vN.jsonl.zstd   ← 会话日志（唯一真相源）
 *   ~/.dsh/storages/workspace.json                                   ← 项目标题/workspaceId（可选增强）
 *   绝不读取 ~/.dsh/.credentials.yaml，不写入 ~/.dsh 任何文件。
 *
 * 性能策略：**只解前 headFrames 帧 + 末尾 tailFrames 帧**（默认 8 + 2），且只读文件头/尾窗口
 *   （64 KB 起步按需翻倍），不整文件读入。zstd 是多帧追加日志，必须按魔数 0x28B52FFD 分帧。
 *   本机最大会话 2.6 MB / 1144 帧 → 实际只读约 20 KB + 20 KB。
 *
 * 用法：
 *   node adapters/session-catalog.mjs                 # 人类可读目录树
 *   node adapters/session-catalog.mjs --json          # 机器可读完整数据
 *   node adapters/session-catalog.mjs --json --frame  # 契约 §2.2 ctl:catalog 帧载荷
 *   node adapters/session-catalog.mjs --bench 10      # 性能实测（10 轮）
 *   node adapters/session-catalog.mjs --locks         # 附带 flock 占用探测
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { decodeZstdFrames, forEachZstdFrameText, extractMeta, coarseState as coarseStateOf, findFrameOffsets, firstUserTitleFromEvents, AGENT_NAME, AGENT_VERSION } from './dsh-meta.mjs';
import { PLATFORM_ID, IS_MAC, desktopAppDirSync } from './platform.mjs';

export const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
export const SESSIONS_ROOT = process.env.DSH_SESSIONS || path.join(DSH_HOME, 'sessions');
export const WORKSPACE_STORE = process.env.DSH_WORKSPACES || path.join(DSH_HOME, 'storages', 'workspace.json');
/** 可扩展的 agent 目录表：新增后端只需追加一行（root 指向该后端的会话根目录）。 */
export const KNOWN_AGENTS = Object.freeze([
  { id: 'dsh', name: AGENT_NAME, version: AGENT_VERSION, sessionsRoot: SESSIONS_ROOT, layout: 'dsh-jsonl-zstd' },
]);

export const DEFAULT_OPTS = Object.freeze({
  root: SESSIONS_ROOT,
  headFrames: 24,   // 8→24：session/title 常落在首轮对话后（实测第 ~31 条记录、8 帧只盖 23 条），窗口漏采会把真实标题错降为项目名
  tailFrames: 2,
  chunkBytes: 64 * 1024,
  maxHeadBytes: 1024 * 1024,
  maxTailBytes: 512 * 1024,
  liveWindowMs: 60_000,
  maxSessions: 500,
  deep: false,            // false = 快扫（前 8 帧 + 末 2 帧，近似）；true = 整文件全解（精确，见 docs/52 性能表）
  locks: false,
  withWorkspaces: true,
  workspaceStore: WORKSPACE_STORE,
});

// ---------------------------------------------------------------------------
// 1. 目录名 ↔ 项目路径
//    规则来自 shipped 源码 dsh-session-persistence-jsonl/lib/index.js（projectKey/encodeSegment）。
//    **编码有意有损**：连续分隔符折叠为一个 '-'，超长截断到 251 字符。
//    因此解码只用于「会话 header 不可读」时兜底；权威 cwd 一律取日志 header.cwd。
// ---------------------------------------------------------------------------

const isSafeChar = (ch) => ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch);
const escapeCodeUnit = (code) => '~' + code.toString(16).toUpperCase().padStart(4, '0');

/** 解码项目目录名：--Users-demo-Desktop-agent~684C~5BA0-- → /Users/demo/Desktop/agent桌宠（有损） */
export function decodeProjectDirName(name) {
  if (typeof name !== 'string' || !name.startsWith('--') || !name.endsWith('--') || name.length < 4) return null;
  const body = name.slice(2, -2);
  if (body === '' || body === '_no-cwd') return null;
  const decoded = body.replace(/~([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return '/' + decoded.replace(/^-+/, '').replace(/-/g, '/');
}

/** 按 DSH 规则编码项目路径（与 projectKey 等价，用于自检对照）。 */
export function encodeProjectDirName(cwd) {
  const s = String(cwd);
  if (s.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '', separatorRun = false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const ch = s[i];
    if (ch === '/' || ch === '\\' || ch === ':') { if (!separatorRun) readable += '-'; separatorRun = true; }
    else if (isSafeChar(ch)) { readable += ch; separatorRun = false; }
    else { readable += escapeCodeUnit(code); separatorRun = false; }
  }
  return '--' + ((readable.replace(/^-+/, '') || 'root').slice(0, 251)) + '--';
}

// ---------------------------------------------------------------------------
// 2. 快速帧读取（头/尾窗口，只解需要的帧；不整文件读入）
// ---------------------------------------------------------------------------

function readWindow(fd, start, length) {
  const buf = Buffer.alloc(Math.max(0, length));
  const n = fs.readSync(fd, buf, 0, buf.length, start);
  return buf.subarray(0, n);
}

/** 只解码文件**开头**的 n 个完整帧；窗口不够则按 chunkBytes 翻倍。 */
export function readHeadFrames(file, { frames = 8, chunkBytes = 64 * 1024, maxBytes = 1024 * 1024, size = null } = {}) {
  const fileSize = size ?? fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    if (fileSize === 0) return { records: [], frames: 0, bytesRead: 0, headBytes: 0, badFrames: 0, emptyTail: false };
    let window = Math.min(Math.max(chunkBytes, 1), fileSize);
    let buf = Buffer.alloc(0), offs = [];
    for (;;) {
      buf = readWindow(fd, 0, window);
      offs = findFrameOffsets(buf);
      const atEof = buf.length >= fileSize;
      const complete = offs.length - (atEof ? 0 : 1); // 末尾帧可能只写了一半
      if (complete >= frames || atEof || buf.length >= maxBytes) break;
      if (window >= maxBytes || window >= fileSize) break;
      window = Math.min(window * 2, maxBytes, fileSize);
    }
    const atEof = buf.length >= fileSize;
    const have = Math.max(0, Math.min(frames, offs.length - (atEof ? 0 : 1)));
    const end = have > 0 && offs[have] !== undefined ? offs[have] : buf.length;
    const dec = decodeZstdFrames(buf.subarray(0, end), { maxFrames: frames });
    return { records: dec.records, frames: dec.frames, bytesRead: buf.length, headBytes: end, badFrames: dec.badFrames, emptyTail: dec.emptyTail, atEof };
  } finally { fs.closeSync(fd); }
}

/** 只解码文件**末尾**的 n 个完整帧（窗口首帧常被截断：Node 对截断帧返回空串，直接跳过）。 */
export function readTailFrames(file, { frames = 2, chunkBytes = 64 * 1024, maxBytes = 512 * 1024, size = null } = {}) {
  const fileSize = size ?? fs.statSync(file).size;
  if (fileSize === 0) return { records: [], frames: 0, bytesRead: 0 };
  const fd = fs.openSync(file, 'r');
  try {
    let window = Math.min(Math.max(chunkBytes, 1), fileSize), chunks = [];
    for (;;) {
      const buf = readWindow(fd, fileSize - window, window);
      const offs = findFrameOffsets(buf);
      chunks = [];
      for (let k = 0; k < offs.length; k++) {
        const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
        let text;
        try { text = zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8'); } catch { continue; }
        if (!text.length) continue;
        const recs = [];
        for (const line of text.split('\n')) { const t = line.trim(); if (t) { try { recs.push(JSON.parse(t)); } catch { /* 半行 */ } } }
        if (recs.length) chunks.push(recs);
      }
      if (chunks.length >= frames || window >= fileSize || window >= maxBytes) break;
      window = Math.min(window * 2, maxBytes, fileSize);
    }
    const tail = chunks.slice(-frames);
    return { records: tail.flat(), frames: tail.length, bytesRead: Math.min(window, fileSize) };
  } finally { fs.closeSync(fd); }
}

// ---------------------------------------------------------------------------
// 3. flock 占用探测（可选）：'held' = 有活进程持有写租约；'free' = 空闲；'unknown' = 无原生插件
// ---------------------------------------------------------------------------

let flockBinding;
function loadFlock() {
  if (flockBinding !== undefined) return flockBinding;
  const require = createRequire(import.meta.url);
  const platformPkg = '@deepseek-ai/node-addon-system-' + PLATFORM_ID + '-' + process.arch + '/bin/system.node';
  const appDir = IS_MAC ? null : desktopAppDirSync('dsh');
  const unpacked = IS_MAC
    ? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/' + platformPkg
    : appDir ? path.join(appDir, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', platformPkg) : null;
  const candidates = [process.env.DSH_FLOCK_ADDON, unpacked].filter(Boolean);
  for (const c of candidates) { try { if (fs.existsSync(c)) { flockBinding = require(c); return flockBinding; } } catch { /* 继续 */ } }
  try { flockBinding = require(platformPkg); return flockBinding; } catch { /* 本机无插件 */ }
  flockBinding = null;
  return null;
}

/** 非阻塞 flock 探测：只在「无人持有」时瞬时取得并立即 close 释放，绝不写入文件。 */
export function probeLock(lockPath) {
  const binding = loadFlock();
  if (!binding) return Promise.resolve('unknown');
  return new Promise((resolve) => {
    let fd;
    try { fd = fs.openSync(lockPath, 'r'); } catch { resolve('unknown'); return; }
    try {
      binding.tryLock(fd, (errno) => { try { fs.closeSync(fd); } catch { /* ignore */ } resolve(errno === 0 ? 'free' : (errno === 35 || errno === 11) ? 'held' : 'unknown'); });
    } catch { try { fs.closeSync(fd); } catch { /* ignore */ } resolve('unknown'); }
  });
}

// ---------------------------------------------------------------------------
// 4. 扫描
// ---------------------------------------------------------------------------

/** 选出会话目录里「数值最高」的日志代（DSH 运行时同样选最高代）。 */
export function pickLogFile(sessionDir) {
  let best = null;
  for (const f of fs.readdirSync(sessionDir)) {
    const m = f.match(/^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/);
    if (!m) continue;
    const version = m[1] === undefined ? 0 : Number(m[1]);
    const compressed = !!m[2];
    const full = path.join(sessionDir, f);
    const st = fs.statSync(full);
    if (!best || version > best.version || (version === best.version && compressed && !best.compressed)) best = { file: full, name: f, version, compressed, size: st.size, mtimeMs: st.mtimeMs };
  }
  return best;
}

const CATALOG_DEEP_TYPES = new Set([
  'session', 'request/header', 'model/selection', 'subagent/descriptor', 'agent-preset/selected', 'session/title',
  'turn/start', 'turn/end', 'session/end-seed', 'session/end', 'llm/retry',
]);
const CATALOG_TYPE_RE = /"type"\s*:\s*"([^"]+)"/;

/** 目录深扫只保留影响最终字段的事件；最后一个 assistant 保留相对位置，用户消息只保留首个有效标题。 */
function decodeCatalogDeep(buf, { maxRecords = 200000 } = {}) {
  const records = [];
  let assistantRaw = null, assistantIndex = 0, userFound = false;
  const { frames, tornFrames, badFrames, emptyTail, bytesConsumed } = forEachZstdFrameText(buf, (text) => {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const match = t.match(CATALOG_TYPE_RE);
      if (!match) continue;
      const type = match[1];
      if (type === 'assistant/message') {
        if (records.length < maxRecords) { assistantRaw = t; assistantIndex = records.length; }
        continue;
      }
      if (type === 'user/message') {
        if (userFound || records.length >= maxRecords) continue;
        try {
          const event = JSON.parse(t);
          if (firstUserTitleFromEvents([event])) { records.push(event); userFound = true; }
        } catch { /* 半行 */ }
        continue;
      }
      if (!CATALOG_DEEP_TYPES.has(type) || records.length >= maxRecords) continue;
      try { records.push(JSON.parse(t)); } catch { /* 半行 */ }
    }
  });
  if (assistantRaw) {
    try {
      const event = JSON.parse(assistantRaw);
      records.splice(Math.min(assistantIndex, records.length), 0, event);
      if (records.length > maxRecords) records.length = maxRecords;
    } catch { /* 半行 */ }
  }
  return { records, frames, tornFrames, badFrames, emptyTail, bytesConsumed };
}

/**
 * DSH 会话形态：DSH 无独立 CLI 产品（desktop profile 被 Electron 应用独占，docs/52 §5.3），
 * 会话一律产自桌面端 → 恒为 'desktop'。
 */

/** 解析单个会话目录 → 会话记录；任何失败都降级为 sessionId + 时间 + 大小。 */
export function parseSession(sessionRoot, projectDirName, sessionDirName, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const dir = path.join(sessionRoot, projectDirName, sessionDirName);
  const base = {
    sessionId: sessionDirName, dirName: sessionDirName, agentName: AGENT_NAME, source: 'dsh',
    projectDirName, dir, projectDir: dir,
    title: null, titleRaw: null, provider: null, model: null, reasoningEffort: null, agentPreset: null,
    agentVersion: AGENT_VERSION, state: 'unknown', stateSource: null, live: false,
    createdAt: null, updatedAt: null, bytes: 0, logFile: null, logFormatVersion: null,
    origin: null, parentSession: null, delegationDepth: null, isSeeded: null, kind: 'main', label: null,
    variant: null,
    degraded: false, error: null, metaSources: {}, conflicts: [], selection: null, lock: 'unknown',
    metaComplete: false, metaApproximate: true, framesScanned: 0, readBytes: 0, readMode: 'window',
  };
  let log;
  try { log = pickLogFile(dir); } catch (e) { return { ...base, degraded: true, error: 'readdir:' + e.code }; }
  if (!log) return { ...base, degraded: true, error: 'no-session-log' };
  const rec = { ...base, bytes: log.size, logFile: log.file, logName: log.name };
  try {
    // 两种读取策略：快扫（默认，窗口近似）与深扫（整文件，精确）
    let events, framesScanned, readBytes, metaComplete;
    if (o.deep) {
      const buf = fs.readFileSync(log.file);
      const dec = decodeCatalogDeep(buf, { maxRecords: 200000 });
      events = dec.records; framesScanned = dec.frames; readBytes = buf.length; metaComplete = true;
    } else {
      const head = readHeadFrames(log.file, { frames: o.headFrames, chunkBytes: o.chunkBytes, maxBytes: o.maxHeadBytes, size: log.size });
      const tail = readTailFrames(log.file, { frames: o.tailFrames, chunkBytes: o.chunkBytes, maxBytes: o.maxTailBytes, size: log.size });
      events = [...head.records, ...tail.records];
      framesScanned = head.frames + tail.frames;
      readBytes = head.bytesRead + tail.bytesRead;
      metaComplete = head.atEof === true; // 整个文件都在头窗口内 → 窗口即全量
    }
    const header = events.find((r) => r?.type === 'session') ?? null;
    const meta = extractMeta(events, { header });
    const st = coarseStateOf(events); // events 已按时间序（head 在前、tail 在后），取「最后一次出现」即为最新状态
    const lastTs = [...events].reverse().find((r) => Number.isFinite(r?.time))?.time ?? null;
    const updatedAt = Math.round(Math.max(log.mtimeMs, Number.isFinite(lastTs) ? lastTs : 0));
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    // 找不到 header 帧（坏帧/空文件/未写完）= 解析不完整：**仍然**给出 sessionId + 时间 + 大小，但显式标降级
    if (!header) return { ...rec, updatedAt, cwd: decodeProjectDirName(projectDirName), cwdSource: 'dir-name(lossy)', metaComplete: false, metaApproximate: true, framesScanned, readBytes, readMode: o.deep ? 'deep' : 'window', degraded: true, error: 'no-header-frame' };
    // 标题回退链：session/title → 首条用户消息 → null（前端显示「（未命名）」；不再拿项目名冒充标题）
    const firstUserTitle = firstUserTitleFromEvents(events);
    const metaSources = { ...meta.sources };
    if (!metaSources.title) metaSources.title = firstUserTitle ? 'derived:first-user-message' : 'derived:none';
    return {
      ...rec,
      sessionId: header?.id ?? sessionDirName,
      title: meta.title ?? firstUserTitle ?? null,
      titleRaw: meta.titleRaw,
      provider: meta.provider, model: meta.model, reasoningEffort: meta.reasoningEffort,
      agentPreset: meta.agentPreset, agentVersion: meta.agentVersion,
      logFormatVersion: meta.logFormatVersion,
      cwd: header?.cwd ?? decodeProjectDirName(projectDirName),
      cwdSource: header?.cwd ? 'log-header' : 'dir-name(lossy)',
      createdAt: Number.isFinite(header?.createdAt) ? header.createdAt : null,
      updatedAt,
      origin: header?.origin ?? null,
      parentSession: header?.parentSession ?? null,
      delegationDepth: header?.delegationDepth ?? null,
      isSeeded: header?.isSeeded ?? null,
      kind: header?.origin === 'subagent' ? 'subagent' : 'main',
      variant: 'desktop',   // DSH 无 CLI 产品：恒为桌面形态（降级记录除外，保持 null 不猜）
      label: events.find((r) => r?.type === 'subagent/descriptor')?.data?.label ?? null,
      state: st.state, stateSource: st.stateSource,
      live: (now - log.mtimeMs) < o.liveWindowMs,
      metaSources, conflicts: meta.conflicts, selection: meta.selection,
      metaComplete, metaApproximate: !metaComplete, framesScanned, readBytes,
      readMode: o.deep ? 'deep' : 'window',
      degraded: false, error: null,
    };
  } catch (e) {
    return { ...rec, degraded: true, error: 'parse:' + (e?.code ?? e?.message ?? String(e)), cwd: decodeProjectDirName(projectDirName) };
  }
}

/** 读 workspace.json（可选增强）。失败静默返回 {}，绝不抛。 */
export function readWorkspaces(storePath = WORKSPACE_STORE) {
  try {
    const j = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const out = {};
    for (const [id, w] of Object.entries(j?.tables?.workspaces ?? {})) if (w?.path) out[w.path] = { workspaceId: id, title: w.title ?? path.basename(w.path), sessionIds: w.sessionIds ?? [], updatedAt: w.updatedAt ?? null };
    return out;
  } catch { return {}; }
}

/**
 * DSH 左侧会话列表的「注册表视图」（唯一真相源 = storages/workspace.json，只读）：
 *   order     workspace 顺序（global.workspaceIds，= DSH 侧栏顺序）
 *   byId      workspaceId -> { id, title, path, sessionIds }
 *   byPath    path -> workspaceId
 *   sessionOwner sessionId -> workspaceId（含未排序注册项）
 *   archived / pinned  会话 id 集合
 * 与 readWorkspaces 并存：后者按 path 键控、被 scanCatalog 用于标题增强。
 */
export function readWorkspaceIndex(storePath = WORKSPACE_STORE) {
  const empty = { order: [], byId: new Map(), byPath: new Map(), sessionOwner: new Map(), archived: new Set(), pinned: new Set() };
  try {
    const j = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const g = j?.global ?? {};
    const tables = j?.tables?.workspaces ?? {};
    for (const [id, w] of Object.entries(tables)) {
      if (!w?.path) continue;
      const entry = { id, title: w.title ?? path.basename(w.path), path: w.path, sessionIds: [...(w.sessionIds ?? [])] };
      empty.byId.set(id, entry);
      empty.byPath.set(w.path, id);
      for (const sid of entry.sessionIds) empty.sessionOwner.set(sid, id);
    }
    for (const wid of g.workspaceIds ?? []) if (empty.byId.has(wid)) empty.order.push(wid);
    for (const id of empty.byId.keys()) if (!empty.order.includes(id)) empty.order.push(id);  // 注册表新增但顺序表滞后的兜底
    for (const sid of g.archivedSessionIds ?? []) empty.archived.add(sid);
    for (const sid of g.pinnedSessionIds ?? []) empty.pinned.add(sid);
    return empty;
  } catch { return empty; }
}

/** 全量扫描：项目 → 会话树 + 统计。 */
export function scanCatalog(opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const t0 = process.hrtime.bigint();
  const workspaces = o.withWorkspaces === false ? {} : readWorkspaces(o.workspaceStore);
  const projects = [], sessions = [];
  let degraded = 0, readBytes = 0, total = 0;
  let dirs = [];
  try {
    dirs = fs.readdirSync(o.root).filter((d) => { try { return fs.statSync(path.join(o.root, d)).isDirectory(); } catch { return false; } });
  } catch {
    return { root: o.root, generatedAt: Date.now(), scannedAt: Date.now(), tookMs: 0, elapsedMs: 0, projects: [], sessions: [], sessionCount: 0, failed: 0, stats: { projects: 0, sessions: 0, degraded: 0, readBytes: 0 }, error: 'root-unreadable' };
  }
  for (const projectDirName of dirs.sort()) {
    const projectPath = path.join(o.root, projectDirName);
    let sessionDirs = [];
    try { sessionDirs = fs.readdirSync(projectPath).filter((d) => { try { return fs.statSync(path.join(projectPath, d)).isDirectory(); } catch { return false; } }); } catch { continue; }
    const list = [];
    for (const d of sessionDirs.sort()) {
      if (total >= o.maxSessions) break;
      const s = parseSession(o.root, projectDirName, d, o);
      total++;
      if (s.degraded) degraded++;
      readBytes += s.readBytes ?? 0;
      list.push(s);
    }
    if (!list.length) continue;
    sessions.push(...list);
    list.sort((a, b) => (Number(b.live) - Number(a.live)) || ((b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
    const cwd = list.find((s) => s.cwdSource === 'log-header')?.cwd ?? decodeProjectDirName(projectDirName) ?? projectDirName;
    const ws = workspaces[cwd];
    projects.push({
      projectId: ws?.workspaceId ?? projectDirName,
      projectDirName,
      cwd,
      cwdSource: list.some((s) => s.cwdSource === 'log-header') ? 'log-header' : 'dir-name(lossy)',
      title: ws?.title ?? path.basename(cwd),
      name: ws?.title ?? path.basename(cwd),
      workspaceId: ws?.workspaceId ?? null,
      workspaceSessionIds: ws?.sessionIds ?? [],
      sessionCount: list.length,
      registeredSessionCount: (ws?.sessionIds ?? []).filter((id) => list.some((s) => s.sessionId === id)).length,
      updatedAt: list.reduce((m, s) => Math.max(m, s.updatedAt ?? 0), 0),
      liveCount: list.filter((s) => s.live).length,
      sessions: list,
    });
  }
  projects.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const tookMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const stats = {
    projects: projects.length, sessions: sessions.length,
    mainSessions: sessions.filter((s) => s.kind === 'main').length,
    subagentSessions: sessions.filter((s) => s.kind === 'subagent').length,
    live: sessions.filter((s) => s.live).length, degraded, readBytes,
    headFrames: o.headFrames, tailFrames: o.tailFrames,
  };
  return { root: o.root, generatedAt: Date.now(), scannedAt: Date.now(), tookMs, elapsedMs: Number(tookMs.toFixed(2)), projects, sessions, sessionCount: sessions.length, failed: degraded, stats };
}

/** 契约 §2.2 ctl:catalog 载荷（只带 UI 需要的字段；不含 readBytes/logFile 等本地细节）。 */
export function toCatalogFrame(catalog) {
  return {
    ctl: 'catalog',
    generatedAt: catalog.generatedAt,
    tookMs: Number((catalog.tookMs ?? 0).toFixed(2)),
    projects: catalog.projects.map((p) => ({
      projectId: p.projectId, cwd: p.cwd, title: p.title, sessionCount: p.sessionCount, updatedAt: p.updatedAt,
      sessions: p.sessions.map((s) => ({
        sessionId: s.sessionId, title: s.title, agentName: s.agentName, provider: s.provider, model: s.model,
        reasoningEffort: s.reasoningEffort, agentPreset: s.agentPreset, state: s.state, kind: s.kind,
        variant: s.variant ?? null,
        createdAt: s.createdAt, updatedAt: s.updatedAt, live: s.live,
      })),
    })),
  };
}

/** 按 sessionId（支持前缀）定位会话，返回时附带所属项目。 */
export function resolveSession(sessionId, opts = {}) {
  const cat = scanCatalog(opts);
  for (const p of cat.projects) {
    const s = p.sessions.find((x) => x.sessionId === sessionId || String(x.sessionId).indexOf(sessionId) === 0);
    if (s) return { ...s, project: { projectId: p.projectId, cwd: p.cwd, name: p.name, title: p.title } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 5. 兼容别名（早期版本曾导出这些名字，保留以免调用方断裂）
// ---------------------------------------------------------------------------

/** @deprecated 用 scanCatalog + readHeadFrames/readTailFrames；此处保留：整文件读取并解析（仅诊断用）。 */
export function readSessionEvents(file) {
  const buf = fs.readFileSync(file);
  const dec = decodeZstdFrames(buf, { maxFrames: Infinity });
  return { events: dec.records, frames: dec.frames, bytes: buf.length };
}
/** @deprecated 用 dsh-meta.extractMeta（带来源追溯）；此处保留旧签名。 */
export function metaFromEvents(events, fallback = {}) {
  const header = events.find((e) => e?.type === 'session') ?? null;
  const meta = extractMeta(events, { header });
  return {
    sessionId: header?.id ?? fallback.sessionId ?? null,
    cwd: header?.cwd ?? fallback.cwd ?? null,
    createdAt: header?.createdAt ?? fallback.createdAt ?? null,
    title: meta.title ?? '(未命名会话)',
    agentName: AGENT_NAME,
    agentVersion: AGENT_VERSION,
    provider: meta.provider, model: meta.model, reasoningEffort: meta.reasoningEffort, agentPreset: meta.agentPreset,
  };
}
/** @deprecated 用 extractMeta().title；旧版会剥掉 <...> 噪声，这里保留同样行为。 */
export function cleanTitle(raw, fallbackTitle) {
  if (typeof raw === 'string') {
    const t = raw.replace(/<[^>]{0,120}>/g, ' ').replace(/\s+/g, ' ').trim();
    const noise = /^(You are|系统|system-reminder|teammate|DeepSeek Harness|Agent Teams|协作)/i.test(t);
    if (t.length >= 4 && !noise) return t.slice(0, 42);
  }
  return fallbackTitle || '(未命名会话)';
}
/** @deprecated 旧签名返回字符串；**推荐** dsh-meta.coarseState()，它同时给出 stateSource。 */
export function coarseState(events) { return coarseStateOf(events).state; }

// ---------------------------------------------------------------------------
// 6. CLI
// ---------------------------------------------------------------------------

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms); const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function fmtBytes(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : n >= 1024 ? (n / 1024).toFixed(0) + 'KB' : n + 'B'; }

export function formatTree(catalog) {
  const lines = [];
  lines.push('会话目录 ' + catalog.root);
  lines.push(catalog.stats.projects + ' 个项目 / ' + catalog.stats.sessions + ' 个会话（主 ' + catalog.stats.mainSessions + ' · 子代理 ' + catalog.stats.subagentSessions + ' · 活跃 ' + catalog.stats.live + ' · 降级 ' + catalog.stats.degraded + '）  扫描耗时 ' + catalog.tookMs.toFixed(1) + ' ms');
  for (const p of catalog.projects) {
    lines.push('');
    lines.push('📁 ' + p.title + '   (' + p.cwd + ')');
    lines.push('   projectId=' + p.projectId + ' · 会话 ' + p.sessionCount + ' 个 · 活跃 ' + p.liveCount + ' · 最后更新 ' + fmtTime(p.updatedAt) + (p.workspaceId ? ' · workspace 已登记 ' + p.registeredSessionCount + '/' + p.sessionCount : ''));
    for (const s of p.sessions) {
      const flags = [s.kind === 'subagent' ? '子代理' : '主会话', s.live ? '● 活跃' : '', s.degraded ? '⚠ 降级' : '', s.lock === 'held' ? '🔒 占用' : s.lock === 'free' ? '🔓 空闲' : ''].filter(Boolean).join('  ');
      lines.push('   └─ ' + String(s.sessionId).slice(0, 40).padEnd(41) + fmtTime(s.updatedAt) + '  ' + fmtBytes(s.bytes).padStart(6) +
        '  ' + String(s.model ?? '—').padEnd(16) + String(s.reasoningEffort ?? '—').padEnd(6) + String(s.state).padEnd(8) + ' ' + flags);
      lines.push('      「' + String(s.title ?? '').slice(0, 46) + '」  ' + (s.provider ?? '—') + ' · preset=' + (s.agentPreset ?? '—') + (s.label ? ' · label=' + s.label : ''));
    }
  }
  return lines.join('\n');
}

async function main(argv) {
  const o = { ...DEFAULT_OPTS };
  const benchIdx = argv.indexOf('--bench');
  const runs = benchIdx >= 0 ? Math.max(1, Number(argv[benchIdx + 1]) || 5) : 1;
  if (argv.includes('--locks')) o.locks = true;
  if (argv.includes('--deep')) o.deep = true;
  const rootIdx = argv.indexOf('--root');
  if (rootIdx >= 0) o.root = argv[rootIdx + 1];
  const times = [];
  let catalog;
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    catalog = scanCatalog(o);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  if (o.locks) for (const s of catalog.sessions) s.lock = await probeLock(path.join(s.dir, 'session.lock'));
  if (argv.includes('--json')) {
    console.log(JSON.stringify(argv.includes('--frame') ? toCatalogFrame(catalog) : catalog, null, 2));
  } else {
    console.log(formatTree(catalog));
    if (runs > 1) {
      const sorted = [...times].sort((a, b) => a - b);
      const sum = times.reduce((a, b) => a + b, 0);
      console.log('');
      console.log('扫描耗时 ' + runs + ' 轮：min ' + sorted[0].toFixed(1) + ' ms / 中位 ' + sorted[Math.floor(runs / 2)].toFixed(1) + ' ms / max ' + sorted.at(-1).toFixed(1) + ' ms / 平均 ' + (sum / runs).toFixed(1) + ' ms');
    }
    console.log('');
    console.log('统计：' + JSON.stringify(catalog.stats));
  }
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) await main(process.argv.slice(2));
