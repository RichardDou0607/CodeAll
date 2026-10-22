#!/usr/bin/env node
/**
 * adapters/qoder-adapter.mjs — Qoder（阿里 AI IDE，本机为 Qoder CN 0.4.8）观察适配器
 * （docs/22 W2 AGT-3 spike 结论落地：无 CLI / 无公开 hook / 无 ACP——**观察走文件级**）
 *
 * 数据源（**只读**）：~/Library/Application Support/com.qodercn.app.stable/main.sqlite
 * （Electron 主库，WAL；node:sqlite readOnly 与 App 并发共存，2026-10-22 本机实测）
 *   chat_sessions 表          ← 会话目录：session_id / session_kind(standard|sideChat|automationExecution)
 *                                / title / cwd / workspace_id / model(qfmodel|auto 服务端路由) / created_at / updated_at(ms)
 *   chat_session_messages 表  ← 回合边界：role(user|assistant|system|'') / status(completed|interrupted|…)
 *                                / sequence / turn_id（**只用结构化列**；消息原文列列级排除，从不 SELECT）
 *   workspaces 表             ← 工作区名与根路径
 *
 * 隐私红线（最高档）：消息原文/工具参数列**列级排除**，任何查询都不 SELECT——
 * （比 Kimi lastPrompt 口径更严：Qoder 的 payload 与原文同列，列级排除）。
 *
 * 三个入口（与 zcode/opencode 适配器同构）：
 *   ① scanQoderCatalog(opts)  → 会话目录（projects/sessions；sideChat/automation 不进列表）
 *   ② followQoderLogs(opts)   → sqlite 轮询增量（chat_session_messages 按 updated_at 水位）→ 规范事件
 *   ③ scanQoderStatus(ctx)    → 四态面板数据（安装/运行由 local-agents 注入）
 *
 * 本机实测（2026-10-22）：11 会话（standard）+ 86 消息行；interrupted 终态可见（手动停止映射 aborted）。
 * 事件流（2026-10-22 三次侦察发现）：~/.qoder-cn/logs/sessions/<编码cwd>/<sessionId>/segments/*.jsonl
 *   ——桌面与 CLI **共用**的结构化事件流（turn.started/turn.finished，文件名带时间戳与 pid）。
 *   CLI 的回合**只写 segments、不回写 main.sqlite**（实测 -r 续接桌面会话后 chat_sessions.updated_at
 *   不动）→ 目录的 updatedAt/状态以 segments 为准（sqlite 供标题/cwd/会话清单）。
 *   turn.finished.reason 实测分布：end_turn(124)/max_turns(14)/abort(6)。
 *   红线：input.prompt.* 事件含 text_preview（prompt 原文）——一律不读不解析；
 *   segments 的 token 字段实测恒 0（1123 个 model.response.completed 全零）→ 用量仍如实降级。
 *
 * 控制面（2026-10-22 二次侦察更新）：Qoder CLI（qoderclicn，~/.qoder-cn/bin/qoderclicn/<版本>/，
 * 版本化命名、~/.local/bin 有符号链接）与桌面**共用 chat_sessions 库**（--list-sessions 列出的就是
 * 本库 UUID，可互相续接）——控制走 `qoderclicn -p -r <id>`（CLI 会话与桌面会话都可续接）。
 *
 * 用法：
 *   node adapters/qoder-adapter.mjs [--json] [--bench N] [--follow] [--status]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const SOURCE = 'qoder';
export const AGENT_NAME = 'Qoder';
export const QODER_APP_SUPPORT = process.env.QODER_APP_SUPPORT
  || path.join(os.homedir(), 'Library', 'Application Support', 'com.qodercn.app.stable');
export const QODER_DB = process.env.QODER_DB || path.join(QODER_APP_SUPPORT, 'main.sqlite');

/**
 * 解析 Qoder CLI 二进制：~/.qoder-cn/bin/qoderclicn/qoderclicn-<版本>（版本化命名、无符号链接、
 * 不在 PATH——取目录内最新版本；cli-control extraPaths 与 model-registry 共用）。
 */
export function resolveQoderCliBin() {
  const dir = path.join(os.homedir(), '.qoder-cn', 'bin', 'qoderclicn');
  try {
    const cands = fs.readdirSync(dir)
      .filter((n) => /^qoderclicn-[\d.]+$/.test(n))
      .sort((a, b) => {
        const va = a.split('.').map(Number), vb = b.split('.').map(Number);
        for (let i = 0; i < Math.max(va.length, vb.length); i++) { const d = (vb[i] || 0) - (va[i] || 0); if (d) return d; }
        return b.localeCompare(a);
      });
    if (!cands.length) return null;
    const p = path.join(dir, cands[0]);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 下一个 */ }
    return null;
  } catch { return null; }
}

export const DEFAULT_OPTS = Object.freeze({
  dbPath: QODER_DB,
  liveWindowMs: 60_000,
  staleProgressMs: 300_000,     // 与 zcode/opencode 适配器同款 5min 滞留修正
  maxSessions: 500,
  coarseRows: 10,               // 每会话参与粗状态判定的最近消息行数
  now: null,
});

/**
 * 打开只读连接。WAL 库在 -shm/-wal 存在（App 在跑或曾写入）时可并发读；
 * 打不开（未安装/权限/异常关闭）返回 null，调用方按降级处理——绝不落任何写入。
 */
export function openQoderDb(dbPath = QODER_DB) {
  try {
    if (!fs.existsSync(dbPath)) return null;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.prepare('SELECT 1').get();                       // 立即探活，坏库/锁死在此暴露
    return db;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// 0. segments 事件流（桌面与 CLI 共用；CLI 回合的唯一落点）
// ---------------------------------------------------------------------------

export const QODER_SEGMENTS = path.join(os.homedir(), '.qoder-cn', 'logs', 'sessions');

/** turn.finished.reason → 粗状态（实测分布：end_turn/max_turns/abort）。 */
function stateFromTurnReason(reason) {
  const r = String(reason ?? '');
  if (r === 'end_turn' || r === 'max_turns') return 'done';
  if (r === 'abort' || /abort|cancel|interrupt/i.test(r)) return 'aborted';
  if (r === 'error' || r === 'failed') return 'error';
  return r ? 'done' : 'unknown';
}

/** 枚举全部 segment 文件：[{file, sessionId}]。 */
export function listSegmentFiles(rootDir = QODER_SEGMENTS) {
  const out = [];
  try {
    for (const proj of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const projDir = path.join(rootDir, proj.name);
      let sids; try { sids = fs.readdirSync(projDir, { withFileTypes: true }); } catch { continue; }
      for (const sd of sids) {
        if (!sd.isDirectory()) continue;
        const segDir = path.join(projDir, sd.name, 'segments');
        let files; try { files = fs.readdirSync(segDir); } catch { continue; }
        for (const f of files) if (f.endsWith('.jsonl')) out.push({ file: path.join(segDir, f), sessionId: sd.name });
      }
    }
  } catch { /* 无目录 = 未使用 */ }
  return out;
}

/**
 * 单个 segment 文件 → 用量记录（请求级，token 真值在云端不虚估；usage-collect 调用）。
 * **计数基元 = model.response.completed（一次事件 = 一次模型请求）**，不是回合：
 *   实测（2026-10-22 用户报障后复核）159 回合 vs 1190 次模型响应——Qoder 一回合含
 *   多次 agentic 模型请求；且 fork 后台代理（Explore/plan，~900 次）不写 turn.started/
 *   finished，按「turn 配对」计数既压低量级（14×）又会把 fork 请求错记/漏记。
 *   事件自带 model（dfmodel/qfmodel…服务端路由名，如实展示）——无需配对。
 *   子代理/fork 消耗一并计入（Kimi「子代理归入父会话」口径；segment 在父会话目录下自动归父）。
 *   tool.execution.finished → 1 次工具调用。只输出计数级字段，不解析 text_preview。
 */
export function parseQoderSegmentUsage(file) {
  const out = [];
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const sessionId = path.basename(path.dirname(path.dirname(file)));
    for (const l of lines) {
      let j; try { j = JSON.parse(l); } catch { continue; }
      const ts = Date.parse(j.ts || '');
      if (j.type === 'model.response.completed') {
        out.push({ ts: Number.isFinite(ts) ? ts : Date.now(), sessionId, model: typeof j.data?.model === 'string' ? j.data.model : null, requests: 1, toolCalls: 0 });
      } else if (j.type === 'tool.execution.finished') {
        out.push({ ts: Number.isFinite(ts) ? ts : Date.now(), sessionId, model: null, requests: 0, toolCalls: 1 });
      }
    }
  } catch { /* 读失败：整文件跳过（下轮 mtime 变化会重读） */ }
  return out;
}

/**
 * 每会话取**最新 segment 文件**解析最后的 turn 事件 → {lastTs, state, stateSource}。
 * （CLI 回合只写 segments；这是 CLI 会话状态的唯一真值，也是桌面会话的实时补充。）
 */
export function scanQoderSegmentStates(rootDir = QODER_SEGMENTS) {
  const bySid = new Map();                                // sessionId → 最新文件（文件名时间戳字典序）
  for (const { file, sessionId } of listSegmentFiles(rootDir)) {
    const prev = bySid.get(sessionId);
    if (!prev || path.basename(file) > path.basename(prev)) bySid.set(sessionId, file);
  }
  const out = new Map();
  for (const [sessionId, file] of bySid) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      let lastTs = 0, state = null, stateSource = null, inFlight = false;
      for (const l of lines) {
        let j; try { j = JSON.parse(l); } catch { continue; }
        const ts = Date.parse(j.ts || '');
        if (Number.isFinite(ts) && ts > lastTs) lastTs = ts;
        if (j.type === 'turn.started') { inFlight = true; if (state === null) { state = 'running'; stateSource = 'segment:turn.started'; } }
        else if (j.type === 'turn.finished') { inFlight = false; state = stateFromTurnReason(j.data?.reason); stateSource = 'segment:turn.finished:' + String(j.data?.reason ?? '?'); }
      }
      if (lastTs && state !== null) out.set(sessionId, { lastTs, state, stateSource, inFlight });
    } catch { /* 并发写入/读失败：跳过该会话本轮 */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. 会话目录（scanQoderCatalog）
// ---------------------------------------------------------------------------

/**
 * 由「最近 N 行消息（role/status 结构化列，不读 payload）」推导粗粒度状态。
 * 行序按 sequence 倒序（会话内真实发生序）：
 *   status=interrupted            → aborted（Qoder 的手动停止终态）
 *   role=assistant & completed    → done（回合收尾）
 *   role=assistant & 其它 status  → error（failed 等异常终态；未知值按 error 从严）
 *   role=user & completed         → thinking（回合已开、响应未落）
 *   role=''（工具/内部行）         → running（回合中；无 payload 不可再细分——如实）
 *   role=system                   → 不认领（压缩/系统事件不是回合边界，继续看更早行）
 * 时效修正：thinking/running 超 5min 无新行 → idle。
 */
export function coarseStateFromQoderRows(rows, { now = Date.now(), staleProgressMs = DEFAULT_OPTS.staleProgressMs } = {}) {
  let state = 'idle', stateSource = 'no-signal';
  let lastTs = null;
  for (const r of rows) {                                 // rows 已按 sequence 倒序
    if (lastTs === null && Number.isFinite(r.updated_at ?? r.created_at)) lastTs = r.updated_at ?? r.created_at;
    if (stateSource !== 'no-signal') break;               // 已由最新显著行定性
    const status = String(r.status ?? '');
    const role = String(r.role ?? '');
    if (status === 'interrupted') { state = 'aborted'; stateSource = 'status:interrupted'; continue; }
    if (role === 'assistant') {
      if (status === 'completed') { state = 'done'; stateSource = 'assistant:completed'; }
      else { state = 'error'; stateSource = 'assistant:' + (status || '?'); }
    } else if (role === 'user') {
      state = 'thinking'; stateSource = 'user_prompt';
    } else if (role === '') {
      state = 'running'; stateSource = 'internal-row';
    }
    // role=system：不认领，继续看更早的行
  }
  if ((state === 'thinking' || state === 'running') && lastTs !== null && now - lastTs > staleProgressMs) {
    return { state: 'idle', stateSource: stateSource + ':stale>5min→idle' };
  }
  return { state, stateSource };
}

export function scanQoderCatalog(opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const t0 = process.hrtime.bigint();
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const base = {
    root: o.dbPath, source: SOURCE, generatedAt: now, projects: [], sessions: [],
    sessionCount: 0, failed: 0, stats: { projects: 0, sessions: 0, subagentSessions: 0, archived: 0, live: 0, degraded: 0, readBytes: 0 },
  };
  const db = openQoderDb(o.dbPath);
  if (!db) {
    return { ...base, elapsedMs: Number((Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2)), degraded: true, error: 'db-unavailable（未安装 Qoder 或库不可读）' };
  }
  // segments 真值（CLI 回合不回写 sqlite——updatedAt/状态以 segments 优先）
  const segStates = scanQoderSegmentStates();
  try {
    const sessions = db.prepare(
      `SELECT session_id, session_kind, title, cwd, workspace_id, model, permission_mode,
              created_at, updated_at, archived, deleted_at
       FROM chat_sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`
    ).all(o.maxSessions);
    // 每会话最近 N 行消息（结构化列；红线：消息原文列列级排除，从不 SELECT）
    const recent = new Map();
    try {
      const rows = db.prepare(
        `SELECT session_id, role, status, sequence, created_at, updated_at FROM (
           SELECT session_id, role, status, sequence, created_at, updated_at,
                  ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY sequence DESC) AS rn
           FROM chat_session_messages
           WHERE session_id IN (SELECT session_id FROM chat_sessions WHERE deleted_at IS NULL AND archived = 0)
         ) WHERE rn <= ? ORDER BY sequence DESC`
      ).all(o.coarseRows);
      for (const r of rows) {
        if (!recent.has(r.session_id)) recent.set(r.session_id, []);
        recent.get(r.session_id).push(r);
      }
    } catch { /* 窗口函数不可用等：粗状态整体退回 unknown */ }
    // 工作区名（侧栏展示用；cwd 才是归并键）
    const wsName = new Map();
    try { for (const w of db.prepare('SELECT workspace_id, name FROM workspaces').all()) wsName.set(w.workspace_id, w.name); } catch { /* 无表 */ }

    const out = [];
    let archived = 0, sideChats = 0, automations = 0, degraded = 0;
    for (const s of sessions) {
      if (s.archived) { archived++; continue; }
      if (s.session_kind === 'sideChat') { sideChats++; continue; }          // 划词问答：瞬态产物，不进会话列表
      if (s.session_kind === 'automationExecution') { automations++; continue; } // 定时任务执行：不是用户对话
      const cwd = typeof s.cwd === 'string' && s.cwd ? s.cwd : null;
      const rows = recent.get(s.session_id) || [];
      const coarse = rows.length ? coarseStateFromQoderRows(rows, { now, staleProgressMs: o.staleProgressMs }) : { state: 'unknown', stateSource: 'no-events' };
      if (!rows.length) degraded++;
      // segment 事件比 sqlite 更新 → 以 segments 为准（CLI 回合的唯一落点；实时性也更好）
      const seg = segStates.get(s.session_id);
      const effUpdatedAt = seg && seg.lastTs > (s.updated_at ?? 0) ? seg.lastTs : (s.updated_at ?? null);
      const effCoarse = seg && seg.lastTs > (s.updated_at ?? 0)
        ? (seg.state === 'running' && now - seg.lastTs > o.staleProgressMs ? { state: 'idle', stateSource: 'segment:running:stale>5min→idle' } : { state: seg.state, stateSource: seg.stateSource })
        : coarse;
      out.push({
        sessionId: s.session_id, dirName: s.session_id, agentName: AGENT_NAME, source: SOURCE,
        dir: cwd ? path.dirname(cwd) : '', projectDir: cwd, projectDirName: cwd ? path.basename(cwd) : null,
        title: s.title || (cwd ? path.basename(cwd) : s.session_id),
        titleRaw: s.title ?? null, titleKind: null, isCustomTitle: null,
        provider: null,
        model: typeof s.model === 'string' && s.model ? s.model : null,   // qfmodel/auto：Qoder 服务端路由名（非具体模型，如实展示）
        reasoningEffort: null,
        agentPreset: null, agentVersion: null,
        state: effCoarse.state, stateSource: effCoarse.stateSource, live: effUpdatedAt !== null && now - effUpdatedAt < o.liveWindowMs,
        createdAt: s.created_at ?? null, updatedAt: effUpdatedAt,
        bytes: null, logFile: o.dbPath, logName: 'main.sqlite',
        origin: null, parentSession: null, delegationDepth: null,
        kind: 'main', cwd, cwdSource: cwd ? 'chat_sessions.cwd' : null, archived: false,
        variant: null,                                 // CLI（qoderclicn）与桌面共用本库且无来源标记（extra_json.source=workspace / 消息 source=引擎投影）——形态不可分，不冒充
        degraded: !rows.length, error: null,
        metaSources: { cwd: cwd ? 'chat_sessions.cwd' : null, title: 'chat_sessions.title', model: 'chat_sessions.model' },
        metaComplete: true, metaApproximate: false,
        readBytes: 0, readMode: 'sqlite:ro',
        workspaceName: wsName.get(s.workspace_id) ?? null,
      });
    }
    // 按 cwd 归并为项目（与 zcode/opencode 适配器同构）
    const byCwd = new Map();
    for (const s of out) {
      const key = s.cwd ?? '(未知目录)';
      if (!byCwd.has(key)) byCwd.set(key, []);
      byCwd.get(key).push(s);
    }
    const projects = [];
    for (const [cwd, list] of byCwd) {
      list.sort((a, b) => (Number(b.live) - Number(a.live)) || ((b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
      const name = cwd ? path.basename(cwd) : '（未知目录）';
      projects.push({
        projectId: 'qoder:' + cwd, projectDirName: name, cwd,
        cwdSource: 'chat_sessions.cwd', title: name, name,
        workspaceId: null, workspaceSessionIds: [],
        sessionCount: list.length, registeredSessionCount: list.length,
        updatedAt: list.reduce((m, s) => Math.max(m, s.updatedAt ?? 0), 0),
        liveCount: list.filter((s) => s.live).length,
        sessions: list,
      });
    }
    projects.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const tookMs = Number(process.hrtime.bigint() - t0) / 1e6;
    return {
      root: o.dbPath, source: SOURCE, generatedAt: now, tookMs, elapsedMs: Number(tookMs.toFixed(2)),
      projects, sessions: out, sessionCount: out.length, failed: degraded,
      stats: { projects: projects.length, sessions: out.length, live: out.filter((s) => s.live).length, degraded, archived, subagentSessions: 0, sideChats, automations, readBytes: 0 },
    };
  } catch (e) {
    return { ...base, elapsedMs: Number((Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2)), degraded: true, error: 'sqlite:' + String(e.message || e).slice(0, 120) };
  } finally { try { db.close(); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------------------
// 2. 消息行 → 规范事件（纯函数；输入只有 role/status 结构化列）
// ---------------------------------------------------------------------------

/**
 * 把一行 chat_session_messages（结构化列）映射为零或一条规范事件。
 * 工具级事件（tool.call/tool.result）**没有**对应结构化列——不读 payload 就没有工具名，
 * 如实缺席（observes 能力表与 UI 自动降级）。
 * @param row {role, status, created_at, updated_at, sequence}
 * @param ctx {sessionId, seq}
 */
export function mapQoderRow(row, ctx) {
  const role = String(row?.role ?? '');
  const status = String(row?.status ?? '');
  if (!role || role === 'system') return [];            // 内部行/system：不产事件（无状态语义可映射）
  const seq = ++ctx.seq;
  const ts = Number.isFinite(row.updated_at) ? row.updated_at : (Number.isFinite(row.created_at) ? row.created_at : Date.now());
  const base = { v: 1, seq, ts, source: SOURCE, sessionId: ctx.sessionId };
  if (status === 'interrupted') return [{ ...base, type: 'turn.end', data: { turnId: row.turn_id ?? ('turn-' + seq), status: 'aborted' } }];
  if (role === 'user') {
    if (status === 'completed') return [{ ...base, type: 'turn.start', data: { turnId: row.turn_id ?? ('turn-' + seq), inputKind: 'user' } }];
    return [];
  }
  if (role === 'assistant') {
    if (status === 'completed') return [{ ...base, type: 'turn.end', data: { turnId: row.turn_id ?? ('turn-' + seq), status: 'ok' } }];
    if (status === 'failed') return [{ ...base, type: 'turn.end', data: { turnId: row.turn_id ?? ('turn-' + seq), status: 'error' } }];
    return [];                                          // 流式等中间态：等终态行
  }
  return [];
}

// ---------------------------------------------------------------------------
// 3. 增量跟随（tail segments 事件流——桌面与 CLI 共用、CLI 回合的唯一落点）
// ---------------------------------------------------------------------------

/**
 * 按「文件偏移」尾读 segments/*.jsonl（mtime/大小变化 → 续读增量；新文件从 0 读）：
 *   turn.started → turn.start（子代理回合 is_subagent=true 在此跳过——红线：不产行）
 *   turn.finished → turn.end{ok|aborted|error}（reason: end_turn/max_turns→ok、abort→aborted、error/failed→error）
 *   input.prompt.* 含 text_preview（prompt 原文）——**不读不解析**（红线，比 Kimi lastPrompt 更严）。
 * 会话标题/cwd 由目录扫描（≤15s）补齐，session.start 只做行建立。
 */
export function followQoderLogs(opts = {}) {
  const intervalMs = opts.intervalMs ?? 2000;
  const lookbackMs = opts.lookbackMs ?? 60_000;          // 启动回看窗口：只关注「现在正在跑」的回合
  const onEvent = opts.onEvent ?? (() => {});
  const rootDir = opts.segmentsPath || QODER_SEGMENTS;
  let stopped = false;
  let lastPumpAt = 0;
  const stats = { polls: 0, rows: 0, events: 0, subagentSkipped: 0, lastGapMs: 0, gaps: [] };
  const noteGap = () => {
    const now = Date.now();
    const gap = lastPumpAt ? Math.max(0, now - lastPumpAt) : 0;
    lastPumpAt = now;
    if (gap) { stats.lastGapMs = gap; stats.gaps.push(gap); if (stats.gaps.length > 60) stats.gaps.shift(); }
  };
  function slowDown() { backoffMs = Math.min(backoffMs * 2, 10_000); }

  const offsets = new Map();                             // file → 已读字节（LRU 上限 2000）
  const helloDone = new Set();                           // 已发 session.start 的会话
  const subagentTurn = new Set();                        // 本回合 is_subagent 的会话（turn.finished 同跳）
  const bootCutoff = Date.now() - lookbackMs;

  function pump() {
    if (stopped) return;
    stats.polls++;
    noteGap();
    let rowsN = 0;
    for (const { file, sessionId } of listSegmentFiles(rootDir)) {
      let st; try { st = fs.statSync(file); } catch { continue; }
      const seen0 = offsets.get(file);
      const start0 = seen0 === undefined ? Math.max(0, st.size - 64 * 1024) : seen0;   // 新文件：回看 64KB（只追当前回合）
      if (seen0 !== undefined && st.size < seen0) { offsets.set(file, 0); continue; }   // 截断/轮转：下轮整读
      if (st.size <= start0) { if (seen0 === undefined) offsets.set(file, st.size); continue; }
      let text = '';
      try { const fh = fs.openSync(file, 'r'); try { const buf = Buffer.alloc(st.size - start0); fs.readSync(fh, buf, 0, buf.length, start0); text = buf.toString('utf8'); } finally { fs.closeSync(fh); } }
      catch { continue; }
      offsets.set(file, st.size);
      if (offsets.size > 2000) { const it = offsets.keys(); for (let i = 0; i < 500; i++) { const k = it.next().value; if (k === undefined) break; offsets.delete(k); } }
      let newLines = 0;
      for (const line of text.split('\n')) {
        if (!line) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }       // 半写行：下轮续读时重新拼上
        const ts = Number.isFinite(Date.parse(j.ts || '')) ? Date.parse(j.ts) : Date.now();
        if (ts < bootCutoff && seen0 === undefined) continue;          // 启动回看只关当前窗口
        newLines++;
        if (j.type === 'turn.started') {
          if (j.data?.is_subagent) { stats.subagentSkipped++; subagentTurn.add(sessionId); continue; }
          subagentTurn.delete(sessionId);
          if (!helloDone.has(sessionId)) { helloDone.add(sessionId); onEvent({ v: 1, seq: 1, ts, source: SOURCE, sessionId, type: 'session.start', data: {} }); }
          onEvent({ v: 1, seq: 2, ts, source: SOURCE, sessionId, type: 'turn.start', data: { turnId: 'turn-' + ts, inputKind: 'user' } });
          stats.events++;
        } else if (j.type === 'turn.finished') {
          if (subagentTurn.has(sessionId)) { stats.subagentSkipped++; subagentTurn.delete(sessionId); continue; }
          if (!helloDone.has(sessionId)) { helloDone.add(sessionId); onEvent({ v: 1, seq: 1, ts, source: SOURCE, sessionId, type: 'session.start', data: {} }); }
          const r = String(j.data?.reason ?? '');
          const status = r === 'abort' || /abort|cancel|interrupt/i.test(r) ? 'aborted' : (r === 'error' || r === 'failed') ? 'error' : 'ok';
          onEvent({ v: 1, seq: 3, ts, source: SOURCE, sessionId, type: 'turn.end', data: { turnId: 'turn-' + ts, status } });
          stats.events++;
        }
        // 其余事件（session.phase/hook/model.*/input.prompt.* 等）：状态级之外不产事件；prompt 原文不读
      }
      if (newLines) rowsN += newLines;
    }
    if (rowsN) backoffMs = intervalMs; else slowDown();
  }

  let backoffMs = intervalMs;
  let timer = null;
  const schedule = () => { if (!stopped) timer = setTimeout(() => { pump(); schedule(); }, backoffMs); };
  pump();
  schedule();
  return {
    stop() { stopped = true; clearTimeout(timer); },
    stats: () => ({ ...stats, gaps: stats.gaps.slice(), currentBackoffMs: backoffMs, baseIntervalMs: intervalMs }),
  };
}

// ---------------------------------------------------------------------------
// 4. 状态快照（四态面板数据；安装/运行态由 local-agents 注入）
// ---------------------------------------------------------------------------

export function scanQoderStatus(ctx = {}) {
  const appBundle = '/Applications/Qoder CN.app';
  const installed = (() => {
    try { return fs.existsSync(appBundle) || fs.existsSync(QODER_APP_SUPPORT); } catch { return false; }
  })();
  let sessionCount = null, degraded = false;
  try {
    const db = openQoderDb(QODER_DB);
    if (db) {
      try { sessionCount = db.prepare(`SELECT COUNT(*) AS c FROM chat_sessions WHERE deleted_at IS NULL AND archived = 0 AND session_kind = 'standard'`).get().c; }
      finally { db.close(); }
    } else degraded = true;
  } catch { degraded = true; }
  return {
    source: SOURCE, agentName: AGENT_NAME,
    installed, processRunning: !!ctx.processRunning,
    degraded, degradeReason: degraded ? 'sqlite-readonly-unavailable' : null,
    // 工具级/审批事件需要 payload 原文（红线不读）；回合级经 segments 事件流可观察（桌面+CLI 共用）
    observes: !degraded ? ['session.start', 'turn.start', 'turn.end'] : ['session.heartbeat'],
    sessionCount, sessionCountApproximate: false,
    dataLocation: QODER_APP_SUPPORT,
    note: degraded ? 'Qoder 数据库不可只读访问（未安装或异常关闭）' : 'sqlite 只读（标题/目录）+ segments 事件流（回合级，桌面/CLI 共用，不读 prompt 原文）；控制经 qoderclicn -p -r',
  };
}

// ---------------------------------------------------------------------------
// 5. CLI
// ---------------------------------------------------------------------------

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms); const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

export function formatQoderTree(catalog) {
  const lines = [];
  lines.push('Qoder 会话目录 ' + catalog.root);
  if (catalog.degraded) { lines.push('⚠ ' + (catalog.error ?? '降级')); return lines.join('\n'); }
  lines.push(catalog.stats.projects + ' 个项目 / ' + catalog.stats.sessions + ' 个会话（划词问答 ' + (catalog.stats.sideChats || 0) + ' 不列出 · 自动化执行 ' + (catalog.stats.automations || 0) + ' 不列出 · 归档 ' + catalog.stats.archived + ' · 活跃 ' + catalog.stats.live + ' · 降级 ' + catalog.stats.degraded + '）  扫描耗时 ' + catalog.tookMs.toFixed(1) + ' ms');
  for (const p of catalog.projects) {
    lines.push('');
    lines.push('📁 ' + p.title + '   (' + p.cwd + ')');
    for (const s of p.sessions) {
      const flags = [s.live ? '● 活跃' : '', s.degraded ? '⚠ 降级' : ''].filter(Boolean).join('  ');
      lines.push('   └─ ' + String(s.sessionId).slice(0, 8).padEnd(9) + fmtTime(s.updatedAt) + '  ' + String(s.model ?? '—').padEnd(8) + String(s.state).padEnd(9) + flags);
      lines.push('      「' + String(s.title ?? '').slice(0, 46) + '」');
    }
  }
  return lines.join('\n');
}

async function main(argv) {
  if (argv.includes('--follow')) {
    console.log('跟随 ' + QODER_DB + '（Ctrl-C 退出）');
    followQoderLogs({ onEvent: (ev) => console.log(JSON.stringify(ev)) });
    return;
  }
  if (argv.includes('--status')) { console.log(JSON.stringify(scanQoderStatus(), null, 2)); return; }
  const runs = (() => { const i = argv.indexOf('--bench'); return i >= 0 ? Math.max(1, Number(argv[i + 1]) || 5) : 1; })();
  let catalog; const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    catalog = scanQoderCatalog();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  if (argv.includes('--json')) console.log(JSON.stringify(catalog, null, 2));
  else {
    console.log(formatQoderTree(catalog));
    if (runs > 1) console.log('\n扫描耗时 ' + runs + ' 轮：min ' + Math.min(...times).toFixed(1) + ' / 中位 ' + times.sort((a, b) => a - b)[Math.floor(times.length / 2)].toFixed(1) + ' / max ' + Math.max(...times).toFixed(1) + ' ms');
  }
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) await main(process.argv.slice(2));
