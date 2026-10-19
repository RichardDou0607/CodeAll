#!/usr/bin/env node
/**
 * adapters/zcode-adapter.mjs — ZCode 观察适配器（docs/21 M-L，五源）
 *
 * 数据源（**只读**）：~/.zcode/cli/db/db.sqlite（WAL；node:sqlite readOnly 连接，与桌面 App 并发共存）
 *   session 表        ← 会话目录：id / title / path(=cwd) / parent_id / task_type(interactive|subagent_child|…)
 *                        / version / time_created / time_updated / time_archived
 *   message 表        ← 消息信封：role / finish(stop|completed|tool-calls|failed|interrupted|…) / modelId / tokens
 *   part 表           ← 消息内片段：step-start / step-finish(reason) / tool(callID,state.status) / text / reasoning…
 *   session_entry 表  ← runtime/model_selection（模型与思考档）
 *
 * 三个入口（与 claude/codex/kimi 适配器同构）：
 *   ① scanZcodeCatalog(opts)  → 会话目录（projects/sessions，子代理排除）
 *   ② followZcodeLogs(opts)   → sqlite 轮询增量（message/part 按 time_updated 水位）→ 规范事件
 *   ③ scanZcodeStatus(ctx)    → 四态面板数据（安装/运行由 local-agents 注入）
 *
 * 已实测（2026-10-07，本机 ZCode 0.16.9 / Node 24 node:sqlite）：
 *   94 session（37 interactive + 56 subagent_child + 1 side chat）；对正在运行的会话轮询可见
 *   tool running→completed 的行内更新（本次调研查询本身即出现在 part 流里）。
 *
 * 隐私红线：只输出状态级字段；message.assistant 文本截断 280 字符；tool 参数/输出、reasoning 原文不外传。
 *
 * 用法：
 *   node adapters/zcode-adapter.mjs [--json] [--bench N] [--follow] [--status]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { categoryOf } from '../demo/frame.mjs';

export const SOURCE = 'zcode';
export const AGENT_NAME = 'ZCode';
export const ZCODE_HOME = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode');
export const ZCODE_DB = process.env.ZCODE_DB || path.join(ZCODE_HOME, 'cli', 'db', 'db.sqlite');

export const DEFAULT_OPTS = Object.freeze({
  dbPath: ZCODE_DB,
  liveWindowMs: 60_000,
  staleProgressMs: 300_000,     // 与 kimi 适配器同款 5min 滞留修正
  maxSessions: 500,
  coarseRows: 14,               // 每会话参与粗状态判定的最近行数
  now: null,
});

const RISK_BY_CATEGORY = { exec: 2, write: 2, net: 1, read: 0, other: 1 };
function clip(s, n) { s = String(s ?? '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

/** 主会话判定：task_type='subagent_child' 为子代理；'selection_side_chat' 为划词问答（瞬态 UI 产物，
 *  ZCode 自身会话列表不视为对话——计入 stats.sideChats，不进列表，2026-10-07 修正计数口径）。 */
const SIDE_CHAT = 'selection_side_chat';
function kindOfTaskType(tt) { return tt === 'subagent_child' ? 'subagent' : tt === SIDE_CHAT ? 'sidechat' : 'main'; }

/**
 * 打开只读连接。WAL 库在 -shm/-wal 存在（App 在跑或曾写入）时可并发读；
 * 打不开（未安装/权限/异常关闭）返回 null，调用方按降级处理——绝不落任何写入。
 */
export function openZcodeDb(dbPath = ZCODE_DB) {
  try {
    if (!fs.existsSync(dbPath)) return null;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.prepare('SELECT 1').get();                       // 立即探活，坏库/锁死在此暴露
    return db;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// 1. 会话目录（scanZcodeCatalog）
// ---------------------------------------------------------------------------

/** 由「最近 N 行 message/part」推导粗粒度状态（口径对齐 claude/codex/kimi 适配器）。
 *  行序按 **time_updated 倒序**（真实完成序）：zcode 的 message.time_created 是生成开始时间，
 *  早于它自己的 part 行——若按 time_created 排，完成的回合最新行是 step-finish（→running）而非
 *  完成消息（→done），会把已完成会话误判成进行中（2026-10-07 实测：活跃数虚高、滞留不进隐藏档）。 */
export function coarseStateFromZcodeRows(rows, { now = Date.now(), staleProgressMs = DEFAULT_OPTS.staleProgressMs } = {}) {
  let state = 'idle', stateSource = 'no-signal';
  let lastTs = null;
  for (const r of rows) {                                 // rows 已按 time_updated 倒序
    if (lastTs === null && Number.isFinite(r.time_updated ?? r.time_created)) lastTs = r.time_updated ?? r.time_created;
    const d = r.data ?? {};
    if (stateSource !== 'no-signal') break;               // 已由最新显著行定性
    if (r.tbl === 'message') {
      if (d.role === 'user') {
        if (d.semantics?.origin === 'real_user' && !d.synthetic) { state = 'thinking'; stateSource = 'user_prompt'; }
        // 合成注入（todo_reminder / 系统提醒等）不算回合边界，继续看更早的行
      } else if (d.role === 'assistant') {
        const fin = String(d.finish ?? '');
        if (fin === 'stop' || fin === 'completed') { state = 'done'; stateSource = 'assistant:' + fin; }
        else if (fin === 'failed') { state = 'error'; stateSource = 'assistant:failed'; }
        else if (fin === 'interrupted') { state = 'idle'; stateSource = 'assistant:interrupted'; }
        else if (fin === 'tool-calls') { state = 'running'; stateSource = 'assistant:tool-calls'; }
        else { state = 'thinking'; stateSource = 'assistant:streaming'; }   // finish 未落 = 正在流式输出
      }
    } else {
      const t = d.type;
      if (t === 'tool') {
        const st = String(d.state?.status ?? '');
        if (st === 'running') { state = 'running'; stateSource = 'tool:running'; }
        else if (st === 'completed' || st === 'error') { state = 'running'; stateSource = 'tool:' + st; }
      } else if (t === 'step-start') { state = 'thinking'; stateSource = 'step-start'; }
      // step-finish 不认领：它落盘晚于消息终态（实测 dump：msg 完成 923043 → step-finish 929905），
      // 若认领 running 会把已完成回合顶回「进行中」。text/timeline/compaction/file：不单独定性
    }
  }
  // 时效修正：thinking/running 超 5min 无新行 → idle（进程被杀/会话被弃）
  if ((state === 'thinking' || state === 'running') && lastTs !== null && now - lastTs > staleProgressMs) {
    return { state: 'idle', stateSource: stateSource + ':stale>5min→idle' };
  }
  return { state, stateSource };
}

export function scanZcodeCatalog(opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const t0 = process.hrtime.bigint();
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const base = {
    root: o.dbPath, source: SOURCE, generatedAt: now, projects: [], sessions: [],
    sessionCount: 0, failed: 0, stats: { projects: 0, sessions: 0, subagentSessions: 0, archived: 0, live: 0, degraded: 0, readBytes: 0 },
  };
  const db = openZcodeDb(o.dbPath);
  if (!db) {
    return { ...base, elapsedMs: Number((Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2)), degraded: true, error: 'db-unavailable（未安装 ZCode 或库不可读）' };
  }
  try {
    const sessions = db.prepare(
      `SELECT id, parent_id, path, directory, title, version, task_type, title_source,
              time_created, time_updated, time_archived
       FROM session ORDER BY time_updated DESC LIMIT ?`
    ).all(o.maxSessions);
    // 每会话最近 N 行（message ∪ part）：窗口函数一次取齐，避免逐会话查询
    const recent = new Map();
    try {
      const rows = db.prepare(
        `SELECT session_id, tbl, id, time_created, time_updated, data FROM (
           SELECT m.session_id, 'message' AS tbl, m.id, m.time_created, m.time_updated, m.data,
                  ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.time_updated DESC, m.id DESC) AS rn
           FROM message m
           WHERE m.session_id IN (SELECT id FROM session WHERE time_archived IS NULL AND task_type NOT IN ('selection_side_chat'))
           UNION ALL
           SELECT p.session_id, 'part' AS tbl, p.id, p.time_created, p.time_updated, p.data,
                  ROW_NUMBER() OVER (PARTITION BY p.session_id ORDER BY p.time_updated DESC, p.id DESC) AS rn
           FROM part p
           WHERE p.session_id IN (SELECT id FROM session WHERE time_archived IS NULL AND task_type NOT IN ('selection_side_chat'))
         ) WHERE rn <= ? ORDER BY time_updated DESC, id DESC`
      ).all(o.coarseRows);
      for (const r of rows) {
        if (!recent.has(r.session_id)) recent.set(r.session_id, []);
        recent.get(r.session_id).push({ tbl: r.tbl, time_created: r.time_created, time_updated: r.time_updated, data: safeJson(r.data) });
      }
    } catch { /* 窗口函数不可用等：粗状态整体退回 unknown */ }
    // 模型/思考档：每会话取最新一条 runtime/model_selection
    const modelBySid = new Map();
    try {
      for (const e of db.prepare(`SELECT session_id, data FROM session_entry WHERE type = 'runtime/model_selection' ORDER BY time_created`).all()) {
        modelBySid.set(e.session_id, safeJson(e.data));     // 顺序遍历，后写覆盖 = 最新
      }
    } catch { /* 无 entry：model 留空 */ }

    const out = [];
    let archived = 0, subagents = 0, sideChats = 0, degraded = 0;
    for (const s of sessions) {
      const kind = kindOfTaskType(s.task_type);
      if (s.time_archived != null) { archived++; continue; }
      if (kind === 'subagent') subagents++;   // 子代理行保留进 sessions（快照据此给宿主挂活跃度），不进项目组/主会话计数
      if (kind === 'sidechat') { sideChats++; continue; }   // 划词问答：瞬态产物，不进会话列表
      const cwd = typeof s.path === 'string' && s.path ? s.path : (typeof s.directory === 'string' ? s.directory : null);
      const rows = recent.get(s.id) || [];
      const coarse = rows.length ? coarseStateFromZcodeRows(rows, { now, staleProgressMs: o.staleProgressMs }) : { state: 'unknown', stateSource: 'no-events' };
      if (!rows.length) degraded++;
      const ms = modelBySid.get(s.id);
      const sel = ms?.modelSelection ?? ms;
      const modelId = typeof ms?.modelId === 'string' ? ms.modelId : typeof sel?.modelId === 'string' ? sel.modelId : null;
      const providerId = typeof sel?.providerId === 'string' ? sel.providerId : (modelId && modelId.includes('/') ? modelId.split('/').slice(0, -1).join('/') : null);
      const effort = ms?.thoughtLevel ?? sel?.options?.reasoningLevel ?? null;
      out.push({
        sessionId: s.id, dirName: s.id, agentName: AGENT_NAME, source: SOURCE,
        dir: path.dirname(cwd ?? ''), projectDir: cwd, projectDirName: cwd ? path.basename(cwd) : null,
        title: s.title || (cwd ? path.basename(cwd) : s.id),
        titleRaw: s.title ?? null, titleKind: s.title_source ?? null, isCustomTitle: s.title_source === 'custom' ? true : null,
        provider: providerId,
        model: modelId ? modelId.split('/').pop() : null,
        reasoningEffort: typeof effort === 'string' ? effort : null,
        agentPreset: null, agentVersion: s.version ?? null,
        state: coarse.state, stateSource: coarse.stateSource, live: Number.isFinite(s.time_updated) ? now - s.time_updated < o.liveWindowMs : false,
        createdAt: s.time_created ?? null, updatedAt: s.time_updated ?? null,
        bytes: null, logFile: o.dbPath, logName: 'db.sqlite',
        origin: kind === 'subagent' ? 'subagent' : null, parentSession: s.parent_id ?? null, delegationDepth: null,
        kind, cwd, cwdSource: cwd ? 'session.path' : null, archived: false,
        variant: 'desktop',                                     // ZCode 为纯桌面软件（无独立 CLI 产品）：会话一律产自桌面 App，统一打桌面徽标
        degraded: !rows.length, error: null,
        metaSources: { cwd: 'session.path', title: 'session.title(' + (s.title_source ?? '?') + ')', model: modelId ? 'session_entry:runtime/model_selection' : null },
        metaComplete: true, metaApproximate: false,
        readBytes: 0, readMode: 'sqlite:ro',
      });
    }
    // 按 cwd 归并为项目（与 kimi 适配器同构）；子代理不进项目组（sessionCount/liveCount 口径不变）
    const byCwd = new Map();
    for (const s of out) {
      if (s.kind === 'subagent') continue;
      const key = s.cwd ?? '(未知目录)';
      if (!byCwd.has(key)) byCwd.set(key, []);
      byCwd.get(key).push(s);
    }
    const projects = [];
    for (const [cwd, list] of byCwd) {
      list.sort((a, b) => (Number(b.live) - Number(a.live)) || ((b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
      const name = path.basename(cwd);
      projects.push({
        projectId: 'zcode:' + cwd, projectDirName: name, cwd,
        cwdSource: 'session.path', title: name, name,
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
      // sessions 含子代理行（供快照挂宿主活跃度）；sessionCount 仅主会话（软件状态卡「会话总数」用）
      projects, sessions: out, sessionCount: mains.length, failed: degraded,
      stats: { projects: projects.length, sessions: mains.length, live: mains.filter((s) => s.live).length, degraded, archived, subagentSessions: subagents, sideChats, readBytes: 0 },
    };
  } catch (e) {
    return { ...base, elapsedMs: Number((Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2)), degraded: true, error: 'sqlite:' + String(e.message || e).slice(0, 120) };
  } finally { try { db.close(); } catch { /* ignore */ } }
}

function safeJson(text) { try { return JSON.parse(text); } catch { return {}; } }

// ---------------------------------------------------------------------------
// 2. message/part 行 → 规范事件（纯函数）
// ---------------------------------------------------------------------------

/**
 * 把一行 message/part 映射为零或多条规范事件（信封与 claude/codex/kimi 适配器同构）。
 * @param row {tbl:'message'|'part', data, time_created, time_updated?}
 *   ts 取 time_updated ?? time_created：message.time_created 是生成开始时间，finish=stop 等
 *   终态是行内 UPDATE——用完成时间才与 part 流的真实时序一致（见 coarseStateFromZcodeRows 注释）。
 * @param ctx {sessionId, seq}
 */
export function mapZcodeRow(row, ctx) {
  const d = row?.data;
  if (!d || typeof d !== 'object') return [];
  const seq = ++ctx.seq;
  const ts = Number.isFinite(row.time_updated) ? row.time_updated : (Number.isFinite(row.time_created) ? row.time_created : Date.now());
  const base = { v: 1, seq, ts, source: SOURCE, sessionId: ctx.sessionId };
  if (row.tbl === 'message') {
    if (d.role === 'user') {
      // 合成注入（todo 提醒 / 系统提醒 / 背景通知）不是用户回合：跳过，避免假 turn.start
      if (d.synthetic || d.semantics?.origin !== 'real_user') return [];
      return [{ ...base, type: 'turn.start', data: { turnId: d.anchor?.turnId ?? ('turn-' + seq), inputKind: 'user' } }];
    }
    if (d.role === 'assistant') {
      const fin = String(d.finish ?? '');
      if (fin === 'stop' || fin === 'completed') return [{ ...base, type: 'turn.end', data: { turnId: d.anchor?.turnId ?? ('turn-' + seq), status: 'ok' } }];
      if (fin === 'failed') return [{ ...base, type: 'turn.end', data: { turnId: d.anchor?.turnId ?? ('turn-' + seq), status: 'error' } }];
      if (fin === 'interrupted') return [{ ...base, type: 'turn.end', data: { turnId: d.anchor?.turnId ?? ('turn-' + seq), status: 'aborted' } }];
      return [];                        // tool-calls / 流式中：由 part 行表达
    }
    return [];
  }
  const t = d.type;
  if (t === 'tool') {
    const st = String(d.state?.status ?? '');
    const toolName = String(d.tool ?? 'unknown');
    const category = categoryOf(toolName);
    if (st === 'running') {
      return [{ ...base, type: 'tool.call', data: { callId: d.callID ?? ('call-' + seq), toolName, category, risk: RISK_BY_CATEGORY[category], summary: '' } }];
    }
    return [{ ...base, type: 'tool.result', data: { callId: d.callID ?? ('call-' + seq), status: st === 'completed' ? 'ok' : 'error' } }];
  }
  // step-start/step-finish 不映射（v1.1）：step 边界落盘晚于消息终态（finish=stop 是行内 UPDATE、
  // step-finish 随后 INSERT），迟到的 step.end 会把 turn.end 已置的 done 拉回 running——
  // 滞留「进行中」正是活跃数虚高、会话进不了完成/隐藏档的根因（与 Kimi 口径一致：step 边界不产事件）。
  if (t === 'text') {
    const text = typeof d.text === 'string' ? d.text : '';
    return text ? [{ ...base, type: 'message.assistant', data: { text: clip(text, 280), truncated: true } }] : [];
  }
  return [];                             // reasoning/timeline/compaction/file：状态级之外，不产事件
}

// ---------------------------------------------------------------------------
// 3. 增量跟随（sqlite 轮询；只跟主会话——task_type='subagent_child' 在 SQL 层排除，红线：不产行）
// ---------------------------------------------------------------------------

/**
 * 按 time_updated 水位轮询 message/part 的**新增与行内更新**（tool running→completed 是同行 UPDATE），
 * 以 (tbl,id)→data 文本指纹去重：新行与内容变化行各重放一次映射（状态机幂等，重复 tool.call 无害）。
 */
export function followZcodeLogs(opts = {}) {
  const intervalMs = opts.intervalMs ?? 2000;             // PERF-4：1.5s→2s 基准；无新增行时指数退避（≤10s）
  const lookbackMs = opts.lookbackMs ?? 60_000;          // 启动回看窗口：只关注「现在正在跑」的会话
  const maxRows = opts.maxRows ?? 400;
  const onEvent = opts.onEvent ?? (() => {});
  let db = openZcodeDb(opts.dbPath || ZCODE_DB);
  let watermark = Date.now() - lookbackMs;
  // PERF-6（docs/25）：指纹去重——seen 只存 sha256(data)（原全文本 data 在长会话下可占数十 MB RSS）；
  // 命中即 delete+set 重触刷新，配合容量上限构成 LRU（容量 6000 与原批淘汰口径不变）。
  const seen = new Map();                                // 'tbl:id' → sha256 hex
  // 鲁棒性：data 允许 NULL / 非字符串（v0.1.0 的 safeJson 对 NULL 宽容、该行被忽略；新码不能把历史坏行/
  // 半写行升级为 TypeError 崩服务）：NULL→空串指纹、Buffer/TypedArray 按字节、其它按 String()。
  const fp = (s) => {
    try { return createHash('sha256').update(s == null ? '' : s).digest('hex'); }
    catch { return createHash('sha256').update(String(s)).digest('hex'); }
  };
  const ctxBySid = new Map();                            // sessionId → {seq, hello}
  const metaBySid = new Map();                           // sessionId → {cwd, title}
  let stopped = false;
  // P4-b 断言用：lastGapMs/gaps 暴露实际轮询间隔（空闲应显著增长、取到新行后回基准），
  // currentBackoffMs 暴露当前退避值；无 DB / 查询异常也走退避（见 slowDown）。
  let lastPumpAt = 0;
  const stats = { polls: 0, rows: 0, events: 0, parseErrors: 0, subagentSkipped: 0, dbReopens: 0, lastGapMs: 0, gaps: [] };
  const noteGap = () => {
    const now = Date.now();
    const gap = lastPumpAt ? Math.max(0, now - lastPumpAt) : 0;
    lastPumpAt = now;
    if (gap) { stats.lastGapMs = gap; stats.gaps.push(gap); if (stats.gaps.length > 60) stats.gaps.shift(); }
  };
  /** 无 DB（未安装/打不开）或查询异常也算一轮空闲：退避同样推进，
   *  否则没有 ZCode 的机器会永久保持基准间隔每 2s 探测一次文件系统。 */
  function slowDown() { backoffMs = Math.min(backoffMs * 2, 10_000); }

  const STMT = `
    SELECT 'message' AS tbl, m.id AS id, m.session_id AS session_id, m.time_created AS time_created,
           m.time_updated AS time_updated, m.data AS data, s.path AS cwd, s.title AS title
    FROM message m JOIN session s ON s.id = m.session_id
    WHERE s.task_type NOT IN ('subagent_child', 'selection_side_chat') AND m.time_updated > ?
    UNION ALL
    SELECT 'part' AS tbl, p.id AS id, p.session_id AS session_id, p.time_created AS time_created,
           p.time_updated AS time_updated, p.data AS data, s.path AS cwd, s.title AS title
    FROM part p JOIN session s ON s.id = p.session_id
    WHERE s.task_type NOT IN ('subagent_child', 'selection_side_chat') AND p.time_updated > ?
    ORDER BY time_updated, id LIMIT ?`;

  function pump() {
    if (stopped) return;
    stats.polls++;
    noteGap();
    if (!db) { db = openZcodeDb(opts.dbPath || ZCODE_DB); if (db) stats.dbReopens++; }
    if (!db) { slowDown(); return; }                                // 无 ZCode：退避而非每 2s 探测
    let rows;
    try { rows = db.prepare(STMT).all(watermark - 2000, watermark - 2000, maxRows); }
    catch (e) { try { db.close(); } catch {} db = null; slowDown(); return; }   // 库被替换/锁死：下轮重开+退避
    const rowsBefore = stats.rows;
    let maxUpdated = watermark;
    for (const r of rows) {
      if (r.time_updated > maxUpdated) maxUpdated = r.time_updated;
      const key = r.tbl + ':' + r.id;
      const h = fp(r.data);
      const prev = seen.get(key);
      if (prev === h) {                                   // 未变化的旧行（LRU：重触刷新位置）
        seen.delete(key); seen.set(key, h); continue;
      }
      seen.set(key, h);
      if (seen.size > 6000) { const it = seen.keys(); for (let i = 0; i < 2000; i++) { const k = it.next().value; if (k === undefined) break; seen.delete(k); } }
      stats.rows++;
      let ctx = ctxBySid.get(r.session_id);
      if (!ctx) {
        ctx = { sessionId: r.session_id, seq: 0, hello: false };
        ctxBySid.set(r.session_id, ctx);
        metaBySid.set(r.session_id, { cwd: r.cwd, title: r.title });
      }
      const data = safeJson(r.data);
      if (!ctx.hello) {
        ctx.hello = true;
        onEvent({ v: 1, seq: ++ctx.seq, ts: r.time_created, source: SOURCE, sessionId: r.session_id,
          type: 'session.start', data: { workspace: r.cwd ?? undefined, title: r.title ?? undefined } });
      }
      for (const ev of mapZcodeRow({ tbl: r.tbl, data, time_created: r.time_created, time_updated: r.time_updated }, ctx)) { stats.events++; onEvent(ev); }
    }
    watermark = maxUpdated;
    // PERF-4：本轮有新增/变化行 → 回到基准间隔；空闲轮与无 DB/查询异常同走 slowDown（2× 指数退避，上限 10s）
    if (stats.rows > rowsBefore) backoffMs = intervalMs; else slowDown();
  }

  let backoffMs = intervalMs;
  let timer = null;
  const schedule = () => { if (!stopped) timer = setTimeout(() => { pump(); schedule(); }, backoffMs); };
  pump();
  schedule();
  return {
    stop() { stopped = true; clearTimeout(timer); try { db?.close(); } catch {} },
    // gaps 给数组快照（stats() 调用方可能跨轮持有）；currentBackoffMs 供 P4-b 断言"取到新行后回基准"
    stats: () => ({ ...stats, gaps: stats.gaps.slice(), currentBackoffMs: backoffMs, baseIntervalMs: intervalMs }),
  };
}

// ---------------------------------------------------------------------------
// 4. 状态快照（四态面板数据；安装/运行态由 local-agents 注入）
// ---------------------------------------------------------------------------

export function scanZcodeStatus(ctx = {}) {
  const dbFile = ZCODE_DB;
  const appBundle = '/Applications/ZCode.app';
  const installed = (() => { try { return fs.existsSync(appBundle) || fs.existsSync(ZCODE_HOME); } catch { return false; } })();
  let sessionCount = null, degraded = false;
  try {
    const db = openZcodeDb(dbFile);
    if (db) {
      try { sessionCount = db.prepare(`SELECT COUNT(*) AS c FROM session WHERE time_archived IS NULL AND task_type NOT IN ('subagent_child', 'selection_side_chat')`).get().c; }
      finally { db.close(); }
    } else degraded = true;
  } catch { degraded = true; }
  return {
    source: SOURCE, agentName: AGENT_NAME,
    installed, processRunning: !!ctx.processRunning,
    degraded, degradeReason: degraded ? 'sqlite-readonly-unavailable' : null,
    observes: !degraded
      ? ['session.start', 'turn.start', 'turn.end', 'step.start', 'step.end', 'tool.call', 'tool.result', 'message.assistant']
      : ['session.heartbeat'],                           // 库内无审批流（permission 表为项目配置）：审批族如实缺席
    sessionCount, sessionCountApproximate: false,
    dataLocation: path.dirname(dbFile),
    note: degraded ? 'ZCode 数据库不可只读访问（未安装或异常关闭）' : 'sqlite 只读：session/message/part（WAL 并发读，零侵入）',
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

export function formatZcodeTree(catalog) {
  const lines = [];
  lines.push('ZCode 会话目录 ' + catalog.root);
  if (catalog.degraded) { lines.push('⚠ ' + (catalog.error ?? '降级')); return lines.join('\n'); }
  lines.push(catalog.stats.projects + ' 个项目 / ' + catalog.stats.sessions + ' 个会话（子代理 ' + catalog.stats.subagentSessions + ' 不列出 · 划词问答 ' + (catalog.stats.sideChats || 0) + ' 不列出 · 归档 ' + catalog.stats.archived + ' · 活跃 ' + catalog.stats.live + ' · 降级 ' + catalog.stats.degraded + '）  扫描耗时 ' + catalog.tookMs.toFixed(1) + ' ms');
  for (const p of catalog.projects) {
    lines.push('');
    lines.push('📁 ' + p.title + '   (' + p.cwd + ')');
    for (const s of p.sessions) {
      const flags = [s.live ? '● 活跃' : '', s.degraded ? '⚠ 降级' : ''].filter(Boolean).join('  ');
      lines.push('   └─ ' + String(s.sessionId).replace(/^sess_/, '').slice(0, 12).padEnd(13) + fmtTime(s.updatedAt) + '  ' + String(s.model ?? '—').padEnd(12) + ' th:' + String(s.reasoningEffort ?? '—').padEnd(5) + String(s.state).padEnd(9) + flags);
      lines.push('      「' + String(s.title ?? '').slice(0, 46) + '」  v' + (s.agentVersion ?? '?'));
    }
  }
  return lines.join('\n');
}

async function main(argv) {
  if (argv.includes('--follow')) {
    console.log('跟随 ' + ZCODE_DB + '（Ctrl-C 退出）');
    followZcodeLogs({ onEvent: (ev) => console.log(JSON.stringify(ev)) });
    return;
  }
  if (argv.includes('--status')) { console.log(JSON.stringify(scanZcodeStatus(), null, 2)); return; }
  const runs = (() => { const i = argv.indexOf('--bench'); return i >= 0 ? Math.max(1, Number(argv[i + 1]) || 5) : 1; })();
  let catalog; const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    catalog = scanZcodeCatalog();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  if (argv.includes('--json')) console.log(JSON.stringify(catalog, null, 2));
  else {
    console.log(formatZcodeTree(catalog));
    if (runs > 1) console.log('\n扫描耗时 ' + runs + ' 轮：min ' + Math.min(...times).toFixed(1) + ' / 中位 ' + times.sort((a, b) => a - b)[Math.floor(times.length / 2)].toFixed(1) + ' / max ' + Math.max(...times).toFixed(1) + ' ms');
  }
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) await main(process.argv.slice(2));
