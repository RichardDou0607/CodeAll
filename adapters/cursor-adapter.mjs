#!/usr/bin/env node
/**
 * adapters/cursor-adapter.mjs — Cursor 观察适配器（docs/22 W2 AGT-4；桌面 + CLI 双源）
 *
 * 数据源（**只读**）：
 *   桌面（Cursor.app 3.26.x，实测 2026-10-22）：
 *     ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb（SQLite WAL）
 *       composerHeaders 表   ← 会话目录：composerId / workspaceId / createdAt / lastUpdatedAt /
 *                              isArchived / isSubagent / value(JSON: name·unifiedMode…)
 *       cursorDiskKV 表      ← composerData:<id> 行：JSON{status: completed|aborted|running|none, name}
 *                              （bubbleId:* 消息泡与 agentKv blob 不读——含 prompt 原文/工具输出）
 *     ~/.cursor/ai-tracking/ai-code-tracking.db
 *       conversation_summaries 表 ← 跨源会话标题/模型摘要（best-effort 补模型字段）
 *   CLI（cursor-agent，~/.local/bin，实测 2026-10-22）：
 *     ~/.cursor/chats/<projectHash>/<sessionId>/meta.json
 *       {schemaVersion, createdAtMs, updatedAtMs, cwd, hasConversation}
 *       会话内消息文件格式本机未验证（仅 hasConversation=false 样本）→ CLI 会话只做目录级观察，
 *       回合级事件如实缺席；控制面经 cursor-agent -p --resume <id>。
 *
 * 隐私红线：composerHeaders.value 的 `subtitle` 是用户 prompt 原文——解析后**只输出**
 *   name/unifiedMode/isDraft 类字段，subtitle 一律不取；bubbleId/agentKv 消息泡完全不读。
 *
 * 三个入口（与 zcode/opencode/qoder 适配器同构）：
 *   ① scanCursorCatalog(opts)  → 会话目录（projects/sessions；子代理排除；桌面+CLI 双源合并）
 *   ② followCursorLogs(opts)   → sqlite/文件轮询 → 规范事件（桌面：agent.status 状态级；CLI：仅 session.start）
 *   ③ scanCursorStatus(ctx)    → 四态面板数据（安装/运行由 local-agents 注入）
 *
 * 用量：Cursor 的 per-request token 在云端（客户端不落盘）——如实降级，不虚估。
 *
 * 用法：
 *   node adapters/cursor-adapter.mjs [--json] [--bench N] [--follow] [--status]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const SOURCE = 'cursor';
export const AGENT_NAME = 'Cursor';
export const CURSOR_APP_SUPPORT = process.env.CURSOR_APP_SUPPORT
  || path.join(os.homedir(), 'Library', 'Application Support', 'Cursor');
export const CURSOR_GLOBAL_DB = process.env.CURSOR_GLOBAL_DB
  || path.join(CURSOR_APP_SUPPORT, 'User', 'globalStorage', 'state.vscdb');
export const CURSOR_HOME = process.env.CURSOR_HOME || path.join(os.homedir(), '.cursor');
export const CURSOR_CHATS = process.env.CURSOR_CHATS || path.join(CURSOR_HOME, 'chats');
export const CURSOR_TRACKING_DB = path.join(CURSOR_HOME, 'ai-tracking', 'ai-code-tracking.db');

export const DEFAULT_OPTS = Object.freeze({
  dbPath: CURSOR_GLOBAL_DB,
  chatsPath: CURSOR_CHATS,
  liveWindowMs: 60_000,
  staleProgressMs: 300_000,
  maxSessions: 500,
  now: null,
});

function safeJson(text) { try { return JSON.parse(text); } catch { return null; } }
function clip(s, n) { s = String(s ?? '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

/** 打开只读连接（WAL 并发读；打不开返回 null = 未安装/降级）。 */
export function openCursorDb(dbPath = CURSOR_GLOBAL_DB) {
  try {
    if (!fs.existsSync(dbPath)) return null;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.prepare('SELECT 1').get();
    return db;
  } catch { return null; }
}

/** composerData.status → 粗状态（2026-10-22 实测见值：completed/aborted/none；running 为流中推断）。 */
export function coarseStateFromCursorStatus(status, lastUpdatedAt, { now = Date.now(), staleProgressMs = DEFAULT_OPTS.staleProgressMs } = {}) {
  const s = String(status ?? 'none');
  let state, stateSource;
  if (s === 'completed') { state = 'done'; stateSource = 'composer:completed'; }
  else if (s === 'aborted') { state = 'aborted'; stateSource = 'composer:aborted'; }
  else if (s === 'error' || s === 'failed') { state = 'error'; stateSource = 'composer:' + s; }
  else if (s === 'running' || s === 'generating' || s === 'queued' || s === 'waiting') { state = 'running'; stateSource = 'composer:' + s; }
  else { state = 'idle'; stateSource = 'composer:' + (s || 'none'); }
  // 时效修正：running 状态超 5min 无更新 → idle（进程被杀/会话被弃）
  if (state === 'running' && Number.isFinite(lastUpdatedAt) && now - lastUpdatedAt > staleProgressMs) {
    return { state: 'idle', stateSource: stateSource + ':stale>5min→idle' };
  }
  return { state, stateSource };
}

/** ai-tracking 的 conversation_summaries → conversationId → {model, mode}（best-effort，无则空）。 */
function cursorSummaryIndex() {
  const out = new Map();
  try {
    const db = new DatabaseSync(CURSOR_TRACKING_DB, { readOnly: true });
    try { for (const r of db.prepare('SELECT conversationId, model, mode FROM conversation_summaries').all()) out.set(r.conversationId, { model: r.model ?? null, mode: r.mode ?? null }); }
    finally { db.close(); }
  } catch { /* 无库/未用 AI 追踪：模型留空 */ }
  return out;
}

/** CLI 会话目录枚举：chats/<projectHash>/<sessionId>/meta.json → [{sessionId, cwd, createdAtMs, updatedAtMs}]。 */
export function scanCursorCliChats(chatsPath = CURSOR_CHATS) {
  const out = [];
  try {
    for (const proj of fs.readdirSync(chatsPath, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const projDir = path.join(chatsPath, proj.name);
      let sids; try { sids = fs.readdirSync(projDir, { withFileTypes: true }); } catch { continue; }
      for (const sd of sids) {
        if (!sd.isDirectory()) continue;
        const meta = safeJson(fs.readFileSync(path.join(projDir, sd.name, 'meta.json'), 'utf8').toString());
        if (!meta || typeof meta !== 'object') continue;
        out.push({
          sessionId: sd.name, cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
          createdAt: Number.isFinite(meta.createdAtMs) ? meta.createdAtMs : null,
          updatedAt: Number.isFinite(meta.updatedAtMs) ? meta.updatedAtMs : null,
          hasConversation: !!meta.hasConversation,
        });
      }
    }
  } catch { /* 无 chats 目录 = CLI 未用 */ }
  return out;
}

// ---------------------------------------------------------------------------
// 1. 会话目录（scanCursorCatalog）
// ---------------------------------------------------------------------------

export function scanCursorCatalog(opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const t0 = process.hrtime.bigint();
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const base = {
    root: o.dbPath, source: SOURCE, generatedAt: now, projects: [], sessions: [],
    sessionCount: 0, failed: 0, stats: { projects: 0, sessions: 0, subagentSessions: 0, archived: 0, live: 0, degraded: 0, readBytes: 0 },
  };
  const out = [];
  let archived = 0, subagents = 0, degraded = 0;
  const summaries = cursorSummaryIndex();

  // ---- 桌面：composerHeaders + composerData.status ----
  const db = openCursorDb(o.dbPath);
  let desktopOk = false;
  if (db) {
    try {
      // 隐私：value JSON 只取 name/unifiedMode/isDraft/isWorktree；subtitle（prompt 原文）绝不外传
      const rows = db.prepare(
        `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, subagentTypeName, value
         FROM composerHeaders ORDER BY COALESCE(lastUpdatedAt, createdAt) DESC LIMIT ?`
      ).all(o.maxSessions);
      const statusStmt = db.prepare("SELECT json_extract(CAST(value AS TEXT), '$.status') AS st FROM cursorDiskKV WHERE key = 'composerData:' || ?");
      for (const r of rows) {
        const kind = r.isSubagent ? 'subagent' : 'main';
        if (r.isArchived) { archived++; continue; }
        if (kind === 'subagent') subagents++;
        if (r.composerId === 'empty-state-draft') continue;      // 起草占位：瞬态 UI 产物，不是会话
        const v = safeJson(r.value) || {};
        let status = null;
        try { status = statusStmt.get(r.composerId)?.st ?? null; } catch { /* 无行 */ }
        const lastAt = Number.isFinite(r.lastUpdatedAt) ? r.lastUpdatedAt : (Number.isFinite(r.createdAt) ? r.createdAt : null);
        const coarse = status !== null
          ? coarseStateFromCursorStatus(status, lastAt, { now, staleProgressMs: o.staleProgressMs })
          : { state: 'unknown', stateSource: 'no-composer-data' };
        if (status === null) degraded++;
        const sum = summaries.get(r.composerId) || {};
        // workspaceId 是内部 id（如 empty-window），不可逆推 cwd → cwd=null（未开文件夹的会话如实无目录）
        out.push({
          sessionId: r.composerId, dirName: r.composerId, agentName: AGENT_NAME, source: SOURCE,
          dir: '', projectDir: null, projectDirName: null,
          title: typeof v.name === 'string' && v.name ? clip(v.name, 80) : null,
          titleRaw: typeof v.name === 'string' ? v.name : null, titleKind: v.name ? 'composer.name' : null, isCustomTitle: null,
          provider: null, model: sum.model ?? null,
          reasoningEffort: null,
          agentPreset: typeof v.unifiedMode === 'string' ? v.unifiedMode : null, agentVersion: null,
          state: coarse.state, stateSource: coarse.stateSource,
          live: lastAt !== null ? now - lastAt < o.liveWindowMs : false,
          createdAt: Number.isFinite(r.createdAt) ? r.createdAt : null, updatedAt: lastAt,
          bytes: null, logFile: o.dbPath, logName: 'state.vscdb',
          origin: kind === 'subagent' ? 'subagent' : null, parentSession: null, delegationDepth: null,
          kind, cwd: null, cwdSource: null, archived: false,
          variant: 'desktop',
          degraded: status === null, error: null,
          subagentType: typeof r.subagentTypeName === 'string' ? r.subagentTypeName : null,
          metaSources: { cwd: null, title: v.name ? 'composerHeaders.value.name' : null, model: sum.model ? 'ai-tracking:conversation_summaries' : null },
          metaComplete: false, metaApproximate: false,   // cwd 不可得（workspaceId 不透明）→ 目录归属不完整，如实标注
          readBytes: 0, readMode: 'sqlite:ro',
        });
      }
      desktopOk = true;
    } catch { /* 表缺失（老版本 Cursor）：桌面侧降级 */ }
    finally { try { db.close(); } catch { /* ignore */ } }
  }

  // ---- CLI：~/.cursor/chats/<hash>/<sid>/meta.json ----
  const cliChats = scanCursorCliChats(o.chatsPath);
  for (const c of cliChats) {
    const coarse = c.hasConversation
      ? { state: 'unknown', stateSource: 'cli-meta-only' }        // 会话文件格式未验证（本机仅空样本）
      : { state: 'unknown', stateSource: 'cli-empty' };
    out.push({
      sessionId: c.sessionId, dirName: c.sessionId, agentName: AGENT_NAME, source: SOURCE,
      dir: c.cwd ? path.dirname(c.cwd) : '', projectDir: c.cwd, projectDirName: c.cwd ? path.basename(c.cwd) : null,
      title: null, titleRaw: null, titleKind: null, isCustomTitle: null,
      provider: null, model: null, reasoningEffort: null,
      agentPreset: null, agentVersion: null,
      state: coarse.state, stateSource: coarse.stateSource,
      live: c.updatedAt !== null ? now - c.updatedAt < o.liveWindowMs : false,
      createdAt: c.createdAt, updatedAt: c.updatedAt,
      bytes: null, logFile: o.chatsPath, logName: 'chats/',
      origin: null, parentSession: null, delegationDepth: null,
      kind: 'main', cwd: c.cwd, cwdSource: c.cwd ? 'chats.meta.cwd' : null, archived: false,
      variant: 'cli',
      degraded: true,             // CLI 会话文件格式未验证：回合级观察缺席，如实降级标注
      error: null,
      metaSources: { cwd: c.cwd ? 'chats.meta.cwd' : null, title: null, model: null },
      metaComplete: false, metaApproximate: false,
      readBytes: 0, readMode: 'file:meta-json',
    });
  }
  if (!desktopOk && !cliChats.length && !db) {
    return { ...base, elapsedMs: Number((Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2)), degraded: true, error: 'db-unavailable（未安装 Cursor 或库不可读）' };
  }

  // ---- 按 cwd 归并为项目（桌面无 cwd → 「（Cursor 无目录）」组；子代理不进项目组）----
  const byCwd = new Map();
  for (const s of out) {
    if (s.kind === 'subagent') continue;
    const key = s.cwd ?? '(Cursor 无目录)';
    if (!byCwd.has(key)) byCwd.set(key, []);
    byCwd.get(key).push(s);
  }
  const projects = [];
  for (const [cwd, list] of byCwd) {
    list.sort((a, b) => (Number(b.live) - Number(a.live)) || ((b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
    const real = cwd !== '(Cursor 无目录)';
    projects.push({
      projectId: 'cursor:' + cwd, projectDirName: real ? path.basename(cwd) : '（Cursor 无目录）', cwd: real ? cwd : null,
      cwdSource: real ? 'chats.meta.cwd' : null, title: real ? path.basename(cwd) : 'Cursor（未开文件夹）', name: real ? path.basename(cwd) : 'Cursor（未开文件夹）',
      workspaceId: null, workspaceSessionIds: [],
      sessionCount: list.length, registeredSessionCount: list.length,
      updatedAt: list.reduce((m, s) => Math.max(m, s.updatedAt ?? 0), 0),
      liveCount: list.filter((s) => s.live).length,
      sessions: list,
    });
  }
  projects.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const mains = out.filter(s => s.kind !== 'subagent');
  const tookMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    root: o.dbPath, source: SOURCE, generatedAt: now, tookMs, elapsedMs: Number(tookMs.toFixed(2)),
    projects, sessions: out, sessionCount: mains.length, failed: degraded,
    stats: { projects: projects.length, sessions: mains.length, live: mains.filter((s) => s.live).length, degraded, archived, subagentSessions: subagents, sideChats: 0, desktopSessions: mains.filter(s => s.variant === 'desktop').length, cliSessions: mains.filter(s => s.variant === 'cli').length, readBytes: 0 },
  };
}

// ---------------------------------------------------------------------------
// 2. 状态跟随（桌面 sqlite 轮询 → agent.status 状态级事件；CLI 目录仅 session.start）
// ---------------------------------------------------------------------------

/**
 * 桌面：按 composerHeaders.lastUpdatedAt 水位轮询——新 composer → session.start；
 * status 变化 → agent.status（状态级事件，回合级细节需读消息泡=红线，如实缺席）。
 * CLI：chats 目录出现新会话目录 → session.start（回合事件缺席：会话文件格式未验证）。
 */
export function followCursorLogs(opts = {}) {
  const intervalMs = opts.intervalMs ?? 2000;
  const lookbackMs = opts.lookbackMs ?? 60_000;
  const onEvent = opts.onEvent ?? (() => {});
  let stopped = false;
  let lastPumpAt = 0;
  const stats = { polls: 0, rows: 0, events: 0, cliSessions: 0, dbReopens: 0, lastGapMs: 0, gaps: [] };
  const noteGap = () => {
    const now = Date.now();
    const gap = lastPumpAt ? Math.max(0, now - lastPumpAt) : 0;
    lastPumpAt = now;
    if (gap) { stats.lastGapMs = gap; stats.gaps.push(gap); if (stats.gaps.length > 60) stats.gaps.shift(); }
  };
  function slowDown() { backoffMs = Math.min(backoffMs * 2, 10_000); }

  let db = openCursorDb(opts.dbPath || CURSOR_GLOBAL_DB);
  let watermark = Date.now() - lookbackMs;                // lastUpdatedAt 水位（新会话/更新的会话）
  const statusSeen = new Map();                           // composerId → 上次 status（变化才发 agent.status）
  const helloDone = new Set();
  const cliSeen = new Set();
  for (const c of scanCursorCliChats(opts.chatsPath || CURSOR_CHATS)) cliSeen.add(c.sessionId);   // 启动即有：不回放历史

  const STMT = `SELECT composerId, lastUpdatedAt FROM composerHeaders
                WHERE COALESCE(lastUpdatedAt, createdAt) > ? AND isArchived = 0 LIMIT 200`;

  function pump() {
    if (stopped) return;
    stats.polls++;
    noteGap();
    if (!db) { db = openCursorDb(opts.dbPath || CURSOR_GLOBAL_DB); if (db) stats.dbReopens++; }
    if (db) {
      let rows;
      try { rows = db.prepare(STMT).all(watermark - 2000); }
      catch (e) { try { db.close(); } catch {} db = null; }
      if (rows) {
        let rowsN = 0;
        let maxTu = watermark;
        for (const r of rows) {
          if (Number.isFinite(r.lastUpdatedAt) && r.lastUpdatedAt > maxTu) maxTu = r.lastUpdatedAt;
          if (r.composerId === 'empty-state-draft' || helloDone.has(r.composerId)) continue;
          helloDone.add(r.composerId);
          rowsN++;
          onEvent({ v: 1, seq: 1, ts: r.lastUpdatedAt ?? Date.now(), source: SOURCE, sessionId: r.composerId,
            type: 'session.start', data: { workspace: undefined, title: undefined, variant: 'desktop' } });
        }
        // status 变化 → agent.status（读 composerData.status，一条一条查；活跃会话少，开销可忽略）
        for (const id of helloDone) {
          let st = null;
          try { st = db.prepare("SELECT json_extract(CAST(value AS TEXT), '$.status') AS st FROM cursorDiskKV WHERE key = 'composerData:' || ?").get(id)?.st ?? null; } catch { continue; }
          if (st === null || statusSeen.get(id) === st) continue;
          statusSeen.set(id, st);
          const coarse = coarseStateFromCursorStatus(st, Date.now());
          onEvent({ v: 1, seq: 2, ts: Date.now(), source: SOURCE, sessionId: id,
            type: 'agent.status', data: { state: coarse.state } });
        }
        watermark = maxTu;
        if (rowsN) stats.rows += rowsN;
        if (rowsN) backoffMs = intervalMs; else slowDown();
      } else slowDown();
    } else slowDown();
    // CLI 新会话目录 → session.start
    for (const c of scanCursorCliChats(opts.chatsPath || CURSOR_CHATS)) {
      if (cliSeen.has(c.sessionId)) continue;
      cliSeen.add(c.sessionId);
      stats.cliSessions++;
      onEvent({ v: 1, seq: 1, ts: c.createdAt ?? Date.now(), source: SOURCE, sessionId: c.sessionId,
        type: 'session.start', data: { workspace: c.cwd ?? undefined, variant: 'cli' } });
      backoffMs = intervalMs;
    }
  }

  let backoffMs = intervalMs;
  let timer = null;
  const schedule = () => { if (!stopped) timer = setTimeout(() => { pump(); schedule(); }, backoffMs); };
  pump();
  schedule();
  return {
    stop() { stopped = true; clearTimeout(timer); try { db?.close(); } catch {} },
    stats: () => ({ ...stats, gaps: stats.gaps.slice(), currentBackoffMs: backoffMs, baseIntervalMs: intervalMs }),
  };
}

// ---------------------------------------------------------------------------
// 3. 状态快照（四态面板数据；安装/运行态由 local-agents 注入）
// ---------------------------------------------------------------------------

export function scanCursorStatus(ctx = {}) {
  const installed = (() => {
    try {
      return fs.existsSync('/Applications/Cursor.app')
        || fs.existsSync(CURSOR_APP_SUPPORT)
        || fs.existsSync(path.join(os.homedir(), '.local', 'bin', 'cursor-agent'))
        || fs.existsSync(CURSOR_HOME);
    } catch { return false; }
  })();
  let sessionCount = null, degraded = false;
  const db = openCursorDb(CURSOR_GLOBAL_DB);
  if (db) {
    try { sessionCount = db.prepare(`SELECT COUNT(*) AS c FROM composerHeaders WHERE isArchived = 0 AND isSubagent = 0 AND composerId != 'empty-state-draft'`).get().c; }
    finally { db.close(); }
  } else degraded = true;
  return {
    source: SOURCE, agentName: AGENT_NAME,
    installed, processRunning: !!ctx.processRunning,
    degraded, degradeReason: degraded ? 'sqlite-readonly-unavailable' : null,
    // 回合级/审批事件需读消息泡（含 prompt 原文，红线不读）→ 桌面只到会话/状态级；CLI 会话文件格式未验证
    observes: !degraded ? ['session.start', 'agent.status'] : ['session.heartbeat'],
    sessionCount, sessionCountApproximate: false,
    dataLocation: path.dirname(CURSOR_GLOBAL_DB),
    note: degraded ? 'Cursor 数据库不可只读访问（未安装或异常关闭）' : 'sqlite 只读：composerHeaders/composerData.status（不读消息泡原文；CLI 会话=meta.json 目录级）',
  };
}

// ---------------------------------------------------------------------------
// 4. CLI
// ---------------------------------------------------------------------------

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms); const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

export function formatCursorTree(catalog) {
  const lines = [];
  lines.push('Cursor 会话目录 ' + catalog.root + '（桌面）+ ' + CURSOR_CHATS + '（CLI）');
  if (catalog.degraded) { lines.push('⚠ ' + (catalog.error ?? '降级')); }
  lines.push((catalog.stats.projects || 0) + ' 个项目 / ' + (catalog.stats.sessions || 0) + ' 个会话（桌面 ' + (catalog.stats.desktopSessions ?? '?') + ' · CLI ' + (catalog.stats.cliSessions ?? '?') + ' · 子代理 ' + (catalog.stats.subagentSessions || 0) + ' 不列出 · 归档 ' + (catalog.stats.archived || 0) + ' · 活跃 ' + (catalog.stats.live || 0) + '）  扫描耗时 ' + (catalog.tookMs ?? 0).toFixed(1) + ' ms');
  for (const p of catalog.projects) {
    lines.push('');
    lines.push('📁 ' + p.title + (p.cwd ? '   (' + p.cwd + ')' : ''));
    for (const s of p.sessions) {
      const flags = [s.live ? '● 活跃' : '', s.degraded ? '⚠ 降级' : ''].filter(Boolean).join('  ');
      lines.push('   └─ ' + String(s.sessionId).slice(0, 8).padEnd(9) + fmtTime(s.updatedAt) + '  ' + (s.variant === 'cli' ? 'CLI ' : '桌面').padEnd(4) + String(s.state).padEnd(9) + flags);
      if (s.title) lines.push('      「' + String(s.title).slice(0, 46) + '」' + (s.model ? '  ' + s.model : ''));
    }
  }
  return lines.join('\n');
}

async function main(argv) {
  if (argv.includes('--follow')) {
    console.log('跟随 Cursor（桌面 sqlite + CLI 目录）（Ctrl-C 退出）');
    followCursorLogs({ onEvent: (ev) => console.log(JSON.stringify(ev)) });
    return;
  }
  if (argv.includes('--status')) { console.log(JSON.stringify(scanCursorStatus(), null, 2)); return; }
  const runs = (() => { const i = argv.indexOf('--bench'); return i >= 0 ? Math.max(1, Number(argv[i + 1]) || 5) : 1; })();
  let catalog; const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    catalog = scanCursorCatalog();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  if (argv.includes('--json')) console.log(JSON.stringify(catalog, null, 2));
  else {
    console.log(formatCursorTree(catalog));
    if (runs > 1) console.log('\n扫描耗时 ' + runs + ' 轮：min ' + Math.min(...times).toFixed(1) + ' / 中位 ' + times.sort((a, b) => a - b)[Math.floor(times.length / 2)].toFixed(1) + ' / max ' + Math.max(...times).toFixed(1) + ' ms');
  }
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) await main(process.argv.slice(2));
