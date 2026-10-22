#!/usr/bin/env node
/**
 * adapters/opencode-adapter.mjs — OpenCode 观察适配器（docs/22 W2 AGT-2 / docs/21 M-I）
 *
 * 数据源（**只读**）：~/.local/share/opencode/opencode.db（WAL；node:sqlite readOnly 并发读，
 * 桌面 App 的 `opencode-cli serve --service` 与独立 CLI 共用同一库与后台服务，2026-10-22 本机实测）
 * **双消息存储**（2026-10-22 实测，同一 session_v2 里按创建版本二选一）：
 *   ≤1.18 旧路径：message 表（data{role,agent,model}）+ part 表（step-start/step-finish{reason,tokens}/
 *              tool{tool,callID,state}/text/reasoning，与 ZCode 同构）
 *   ≥2.x v2 服务路径：session_message 表（type=user/assistant/idle/system，内容内联：
 *              assistant.data{model,finish,content[{type:tool|text|reasoning}],tokens,cost}；
 *              idle.data{outcome:succeeded|failed}=回合终态）
 *   session_v2 表  ← 会话目录：id(ses_*) / title / directory / parent_id(子代理) / agent /
 *                    model(JSON{providerID,modelID,variant}) / tokens_*(会话累计) / time_*(ms)
 *
 * 三个入口（与 zcode/kimi 适配器同构）：
 *   ① scanOpencodeCatalog(opts)  → 会话目录（projects/sessions，子代理排除）
 *   ② followOpencodeLogs(opts)   → sqlite 轮询增量（message/part 按 time_updated 水位）→ 规范事件
 *   ③ scanOpencodeStatus(ctx)    → 四态面板数据（安装/运行由 local-agents 注入）
 *
 * 本机实测（2026-10-22，OpenCode CLI/桌面 2.1.2）：82 会话（含子代理）/ 2457 message / 10015 part；
 *   模型 JSON 带 providerID（zhipuai / moonshotai-cn / zhipuai-coding-plan / opencode…）。
 *
 * 形态口径（诚实降级）：CLI 与桌面端共用同一后台服务与库，库内**无形态标记** →
 *   会话 variant=null（不冒充 cli/desktop），软件状态页仍按 CLI/桌面拆行（进程路径可分家）。
 *
 * 隐私红线：只输出状态级字段；text 截断 280 字符；tool 参数(input)/reasoning 原文不外传。
 *
 * 用法：
 *   node adapters/opencode-adapter.mjs [--json] [--bench N] [--follow] [--status]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { categoryOf } from '../demo/frame.mjs';

export const SOURCE = 'opencode';
export const AGENT_NAME = 'OpenCode';
export const OPENCODE_HOME = process.env.OPENCODE_HOME || path.join(os.homedir(), '.local', 'share', 'opencode');
export const OPENCODE_DB = process.env.OPENCODE_DB || path.join(OPENCODE_HOME, 'opencode.db');

export const DEFAULT_OPTS = Object.freeze({
  dbPath: OPENCODE_DB,
  liveWindowMs: 60_000,
  staleProgressMs: 300_000,     // 与 zcode/kimi 适配器同款 5min 滞留修正
  maxSessions: 500,
  coarseRows: 14,               // 每会话参与粗状态判定的最近行数
  now: null,
});

const RISK_BY_CATEGORY = { exec: 2, write: 2, net: 1, read: 0, other: 1 };
function clip(s, n) { s = String(s ?? '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

/** 手动停止签名（与 zcode 同款）：工具被取消的 error 文本带 cancelled/interrupted。 */
const CANCELLED_TOOL_RE = /cancell?ed|interrupted/i;
export function isCancelledToolError(errValue) {
  const text = typeof errValue === 'string' ? errValue : String(errValue?.message ?? '');
  return !!text && CANCELLED_TOOL_RE.test(text);
}

/**
 * 打开只读连接。WAL 库在 -shm/-wal 存在（服务在跑或曾写入）时可并发读；
 * 打不开（未安装/权限/异常关闭）返回 null，调用方按降级处理——绝不落任何写入。
 */
export function openOpencodeDb(dbPath = OPENCODE_DB) {
  try {
    if (!fs.existsSync(dbPath)) return null;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.prepare('SELECT 1').get();                       // 立即探活，坏库/锁死在此暴露
    return db;
  } catch { return null; }
}

function safeJson(text) { try { return JSON.parse(text); } catch { return {}; } }

// ---------------------------------------------------------------------------
// 1. 会话目录（scanOpencodeCatalog）
// ---------------------------------------------------------------------------

/**
 * 由「最近 N 行 message/part（旧路径）或 session_message（v2 路径）」推导粗粒度状态
 * （口径对齐 zcode 适配器；行序 time_updated 倒序）：
 *   【v2】 idle outcome=failed → error；其余（succeeded…）→ done（回合已 settle）
 *   【v2】 assistant 无 time.completed → thinking（流式中）；已 completed → running（等 idle 收尾）
 *   【v2】 user → thinking（回合已开、响应未落）；system/agent-switched 不认领
 *   【旧】 part step-finish reason=stop   → done（OpenCode 的**回合终态**：最后一个 step 以 stop 收尾）
 *   【旧】 part step-finish reason=其它   → running（tool-calls 等步间态，回合未完）
 *   【旧】 part tool running/completed    → running
 *   【旧】 part tool error                → error（被取消文本 → aborted）
 *   【旧】 part text/step-start/reasoning → thinking（流式中）
 *   【旧】 message role=user              → thinking（回合已开、响应未落）
 * 时效修正：thinking/running 超 5min 无新行 → idle。
 */
export function coarseStateFromOpencodeRows(rows, { now = Date.now(), staleProgressMs = DEFAULT_OPTS.staleProgressMs } = {}) {
  let state = 'idle', stateSource = 'no-signal';
  let lastTs = null;
  for (const r of rows) {                                 // rows 已按 time_updated 倒序
    if (lastTs === null && Number.isFinite(r.time_updated ?? r.time_created)) lastTs = r.time_updated ?? r.time_created;
    if (stateSource !== 'no-signal') break;               // 已由最新显著行定性
    if (r.tbl === 'smsg') {                               // v2 session_message 行
      const t = r.data?.type;
      if (t === 'idle') {
        state = String(r.data?.outcome ?? '') === 'failed' ? 'error' : 'done';
        stateSource = 'v2:idle:' + String(r.data?.outcome ?? '?');
      } else if (t === 'assistant') {
        if (r.data?.time && !Number.isFinite(r.data.time.completed)) { state = 'thinking'; stateSource = 'v2:assistant:streaming'; }
        else { state = 'running'; stateSource = 'v2:assistant:awaiting-idle'; }
      } else if (t === 'user') {
        state = 'thinking'; stateSource = 'v2:user_prompt';
      }
      // system / agent-switched：不认领，继续看更早的行
    } else if (r.tbl === 'message') {
      if (r.data?.role === 'user') { state = 'thinking'; stateSource = 'user_prompt'; }
      // assistant 行不带终态（finish 在 part 流）：不认领，继续看更早的行
    } else {
      const t = r.data?.type;
      if (t === 'step-finish') {
        const reason = String(r.data?.reason ?? '');
        if (reason === 'stop') { state = 'done'; stateSource = 'step-finish:stop'; }
        else { state = 'running'; stateSource = 'step-finish:' + (reason || '?'); }
      } else if (t === 'tool') {
        const st = String(r.data?.state?.status ?? '');
        if (st === 'running') { state = 'running'; stateSource = 'tool:running'; }
        else if (st === 'completed' || st === 'error') { state = 'running'; stateSource = 'tool:' + st; }
        if (st === 'error' && isCancelledToolError(r.data?.state?.error)) { state = 'aborted'; stateSource = 'tool:cancelled'; }
      } else if (t === 'text' || t === 'step-start' || t === 'reasoning') {
        state = 'thinking'; stateSource = t;
      }
    }
  }
  if ((state === 'thinking' || state === 'running') && lastTs !== null && now - lastTs > staleProgressMs) {
    const lastTool = rows.find(r => r.data?.type === 'tool');   // rows 按 time_updated 倒序：首个 tool 行即最新
    if (lastTool && String(lastTool.data.state?.status ?? '') === 'error' && isCancelledToolError(lastTool.data.state?.error))
      return { state: 'aborted', stateSource: stateSource + ':stale>5min→aborted(tool-cancelled)' };
    return { state: 'idle', stateSource: stateSource + ':stale>5min→idle' };
  }
  return { state, stateSource };
}

/** 模型选择 → {provider, model, effort}：会话行为嵌套 JSON{providerID,modelID,variant}；
 *  message 行为顶层字段 providerID/modelID（2026-10-22 实测两种形状并存）。 */
function parseModelSel(raw) {
  const m = raw && typeof raw === 'object' ? raw : (typeof raw === 'string' ? safeJson(raw) : null);
  if (!m || typeof m !== 'object') return {};
  const modelId = typeof m.modelID === 'string' ? m.modelID : typeof m.modelId === 'string' ? m.modelId : typeof m.id === 'string' ? m.id : null;
  const providerId = typeof m.providerID === 'string' ? m.providerID : typeof m.providerId === 'string' ? m.providerId : null;
  const effort = typeof m.variant === 'string' && m.variant && m.variant !== 'default' ? m.variant : null;
  return { provider: providerId, model: modelId, effort };
}

export function scanOpencodeCatalog(opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const t0 = process.hrtime.bigint();
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const base = {
    root: o.dbPath, source: SOURCE, generatedAt: now, projects: [], sessions: [],
    sessionCount: 0, failed: 0, stats: { projects: 0, sessions: 0, subagentSessions: 0, archived: 0, live: 0, degraded: 0, readBytes: 0 },
  };
  const db = openOpencodeDb(o.dbPath);
  if (!db) {
    return { ...base, elapsedMs: Number((Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2)), degraded: true, error: 'db-unavailable（未安装 OpenCode 或库不可读）' };
  }
  try {
    // v2 迁移完成后 session 与 session_v2 同源（本机 82/82）；优先 v2，无表则回退 v1
    const hasV2 = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_v2'").get();
    const table = hasV2 ? 'session_v2' : 'session';
    const sessions = db.prepare(
      `SELECT id, parent_id, directory, path, title, version, agent, model,
              time_created, time_updated, time_archived
       FROM ${table} ORDER BY time_updated DESC LIMIT ?`
    ).all(o.maxSessions);
    // 每会话最近 N 行（message ∪ part）：两段式取数——窗口排序只走 id/时间戳（不搬 data 大字段；
    // 本机 part 均值 ~50KB——tool 输入内嵌原文，668MB 库单段式窗口查询实测 ~600ms，两段式 <80ms），
    // 命中的行再按主键逐条取 data。
    const recent = new Map();
    try {
      const ranked = db.prepare(
        `SELECT session_id, tbl, id, time_created, time_updated FROM (
           SELECT m.session_id, 'message' AS tbl, m.id, m.time_created, m.time_updated,
                  ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.time_updated DESC, m.id DESC) AS rn
           FROM message m
           WHERE m.session_id IN (SELECT id FROM ${table} WHERE time_archived IS NULL)
           UNION ALL
           SELECT p.session_id, 'part' AS tbl, p.id, p.time_created, p.time_updated,
                  ROW_NUMBER() OVER (PARTITION BY p.session_id ORDER BY p.time_updated DESC, p.id DESC) AS rn
           FROM part p
           WHERE p.session_id IN (SELECT id FROM ${table} WHERE time_archived IS NULL)
         ) WHERE rn <= ? ORDER BY time_updated DESC, id DESC`
      ).all(o.coarseRows);
      const msgData = db.prepare('SELECT data FROM message WHERE id = ?');
      const partData = db.prepare('SELECT data FROM part WHERE id = ?');
      for (const r of ranked) {
        let data = null;
        try { data = (r.tbl === 'message' ? msgData : partData).get(r.id)?.data ?? null; } catch { /* 行被并发删除 */ }
        if (!recent.has(r.session_id)) recent.set(r.session_id, []);
        recent.get(r.session_id).push({ tbl: r.tbl, time_created: r.time_created, time_updated: r.time_updated, data: safeJson(data) });
      }
    } catch { /* 窗口函数不可用等：粗状态整体退回 unknown */ }
    // v2 路径：session_message（≥2.x 服务端写入；同样两段式——先排 id 再按主键取 data）
    try {
      const ranked2 = db.prepare(
        `SELECT session_id, id, type, time_created, time_updated FROM (
           SELECT session_id, id, type, time_created, time_updated,
                  ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY time_updated DESC, id DESC) AS rn
           FROM session_message
           WHERE session_id IN (SELECT id FROM ${table} WHERE time_archived IS NULL)
         ) WHERE rn <= ? ORDER BY time_updated DESC, id DESC`
      ).all(o.coarseRows);
      const smsgData = db.prepare('SELECT data FROM session_message WHERE id = ?');
      for (const r of ranked2) {
        let data = null;
        try { data = smsgData.get(r.id)?.data ?? null; } catch { /* 行被并发删除 */ }
        // v2 的 type 是表列（data JSON 内无 type 字段）——注入后与旧路径的 data.type 同构
        if (!recent.has(r.session_id)) recent.set(r.session_id, []);
        recent.get(r.session_id).push({ tbl: 'smsg', time_created: r.time_created, time_updated: r.time_updated, data: { ...safeJson(data), type: r.type } });
      }
    } catch { /* 无 v2 表等：旧路径会话不受影响 */ }
    // 每会话合并后按 time_updated 倒序；v1→v2 迁移双写的会话只认 v2 行（旧 message/part 行弃用，
    // 否则同批旧行重复参与定性——与 usage 采集的同一条去重规则）
    for (const list of recent.values()) {
      list.sort((a, b) => (b.time_updated ?? b.time_created ?? 0) - (a.time_updated ?? a.time_created ?? 0));
      if (list.some((r) => r.tbl === 'smsg')) {
        for (let i = list.length - 1; i >= 0; i--) if (list[i].tbl !== 'smsg') list.splice(i, 1);
      }
    }

    const out = [];
    let archived = 0, subagents = 0, degraded = 0;
    for (const s of sessions) {
      const kind = s.parent_id ? 'subagent' : 'main';
      if (s.time_archived != null) { archived++; continue; }
      if (kind === 'subagent') subagents++;   // 子代理行保留进 sessions（快照据此给宿主挂活跃度），不进项目组/主会话计数
      const cwd = typeof s.directory === 'string' && s.directory ? s.directory : (typeof s.path === 'string' ? s.path : null);
      const rows = recent.get(s.id) || [];
      const coarse = rows.length ? coarseStateFromOpencodeRows(rows, { now, staleProgressMs: o.staleProgressMs }) : { state: 'unknown', stateSource: 'no-events' };
      if (!rows.length) degraded++;
      // 模型：会话行保存的 model JSON；没有则回退该会话最新 message 的顶层 providerID/modelID
      let sel = parseModelSel(s.model);
      let modelVia = sel.model ? table + '.model' : null;
      if (!sel.model && rows.length) {
        const mrow = rows.find(r => r.tbl === 'message' && (r.data?.modelID || r.data?.model));
        if (mrow) { sel = parseModelSel(mrow.data.model ?? { providerID: mrow.data.providerID, modelID: mrow.data.modelID }); modelVia = 'message.data(providerID/modelID)'; }
      }
      out.push({
        sessionId: s.id, dirName: s.id, agentName: AGENT_NAME, source: SOURCE,
        dir: cwd ? path.dirname(cwd) : '', projectDir: cwd, projectDirName: cwd ? path.basename(cwd) : null,
        title: s.title || (cwd ? path.basename(cwd) : s.id),
        titleRaw: s.title ?? null, titleKind: null, isCustomTitle: null,
        provider: sel.provider ?? null,
        model: sel.model ?? null,
        reasoningEffort: sel.effort ?? null,
        agentPreset: typeof s.agent === 'string' ? s.agent : null, agentVersion: s.version ?? null,
        state: coarse.state, stateSource: coarse.stateSource, live: Number.isFinite(s.time_updated) ? now - s.time_updated < o.liveWindowMs : false,
        createdAt: s.time_created ?? null, updatedAt: s.time_updated ?? null,
        bytes: null, logFile: o.dbPath, logName: 'opencode.db',
        origin: kind === 'subagent' ? 'subagent' : null, parentSession: s.parent_id ?? null, delegationDepth: null,
        kind, cwd, cwdSource: cwd ? table + '.directory' : null, archived: false,
        variant: null,                              // CLI 与桌面共用库，库内无形态标记（诚实：不冒充）
        degraded: !rows.length, error: null,
        metaSources: { cwd: cwd ? table + '.directory' : null, title: 'session.title', model: modelVia },
        metaComplete: true, metaApproximate: false,
        readBytes: 0, readMode: 'sqlite:ro',
      });
    }
    // 按 cwd 归并为项目（与 zcode/kimi 适配器同构）；子代理不进项目组
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
        projectId: 'opencode:' + cwd, projectDirName: name, cwd,
        cwdSource: 'session.directory', title: name, name,
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
      stats: { projects: projects.length, sessions: mains.length, live: mains.filter((s) => s.live).length, degraded, archived, subagentSessions: subagents, sideChats: 0, readBytes: 0 },
    };
  } catch (e) {
    return { ...base, elapsedMs: Number((Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2)), degraded: true, error: 'sqlite:' + String(e.message || e).slice(0, 120) };
  } finally { try { db.close(); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------------------
// 2. message/part 行 → 规范事件（纯函数）
// ---------------------------------------------------------------------------

/**
 * 把一行 message/part（旧路径）或 session_message（v2 路径）映射为零或多条规范事件。
 * @param row {tbl:'message'|'part'|'smsg', data, time_created, time_updated?}
 * @param ctx {sessionId, seq}
 */
export function mapOpencodeRow(row, ctx) {
  const d = row?.data;
  if (!d || typeof d !== 'object') return [];
  const seq = ++ctx.seq;
  const ts = Number.isFinite(row.time_updated) ? row.time_updated : (Number.isFinite(row.time_created) ? row.time_created : Date.now());
  const base = { v: 1, seq, ts, source: SOURCE, sessionId: ctx.sessionId };
  if (row.tbl === 'smsg') {                              // v2 session_message
    const t = d.type;
    if (t === 'user') return [{ ...base, type: 'turn.start', data: { turnId: d.id ?? ('turn-' + seq), inputKind: 'user' } }];
    if (t === 'idle') {
      const outcome = String(d.outcome ?? '');
      return [{ ...base, type: 'turn.end', data: { turnId: 'turn-' + seq, status: outcome === 'failed' ? 'error' : outcome === 'aborted' || outcome === 'cancelled' ? 'aborted' : 'ok' } }];
    }
    if (t === 'assistant' && Array.isArray(d.content)) {
      const out = [];
      for (const c of d.content) {
        if (c?.type === 'tool') {
          const st = String(c.state?.status ?? '');
          const toolName = String(c.name ?? 'unknown');
          const category = categoryOf(toolName);
          if (st === 'running') out.push({ ...base, type: 'tool.call', data: { callId: c.id ?? ('call-' + seq), toolName, category, risk: RISK_BY_CATEGORY[category], summary: '' } });
          else out.push({ ...base, type: 'tool.result', data: { callId: c.id ?? ('call-' + seq), status: st === 'completed' ? 'ok' : isCancelledToolError(c.state?.error) ? 'aborted' : 'error' } });
        } else if (c?.type === 'text' && typeof c.text === 'string' && c.text) {
          out.push({ ...base, type: 'message.assistant', data: { text: clip(c.text, 280), truncated: true } });
        }
      }
      return out;
    }
    return [];                                           // system / agent-switched：不产事件
  }
  if (row.tbl === 'message') {
    if (d.role === 'user') return [{ ...base, type: 'turn.start', data: { turnId: d.id ?? ('turn-' + seq), inputKind: 'user' } }];
    return [];                              // assistant 信封不带终态（finish 在 part 的 step-finish）
  }
  const t = d.type;
  if (t === 'step-finish') {
    // 回合/步骤终态：stop=回合收尾；tool-calls 等只算步骤边界（与 Kimi/ZCode 口径一致：不产 step 事件）
    if (String(d.reason ?? '') === 'stop') return [{ ...base, type: 'turn.end', data: { turnId: 'turn-' + seq, status: 'ok' } }];
    return [];
  }
  if (t === 'tool') {
    const st = String(d.state?.status ?? '');
    const toolName = String(d.tool ?? 'unknown');
    const category = categoryOf(toolName);
    if (st === 'running') {
      return [{ ...base, type: 'tool.call', data: { callId: d.callID ?? ('call-' + seq), toolName, category, risk: RISK_BY_CATEGORY[category], summary: '' } }];
    }
    return [{ ...base, type: 'tool.result', data: { callId: d.callID ?? ('call-' + seq), status: st === 'completed' ? 'ok' : isCancelledToolError(d.state?.error) ? 'aborted' : 'error' } }];
  }
  if (t === 'text') {
    const text = typeof d.text === 'string' ? d.text : '';
    return text ? [{ ...base, type: 'message.assistant', data: { text: clip(text, 280), truncated: true } }] : [];
  }
  return [];                             // reasoning/step-start 等：状态级之外，不产事件
}

// ---------------------------------------------------------------------------
// 3. 增量跟随（sqlite 轮询；只跟主会话——parent_id 非空为子代理，红线：不产行）
// ---------------------------------------------------------------------------

/**
 * 按 time_updated 水位轮询 message/part 的**新增与行内更新**（tool running→completed 是同行 UPDATE），
 * 以 (tbl,id)→data 文本指纹去重（与 zcode 跟随器同构：LRU + 指数退避 + 无库退避）。
 */
export function followOpencodeLogs(opts = {}) {
  const intervalMs = opts.intervalMs ?? 2000;
  const lookbackMs = opts.lookbackMs ?? 60_000;          // 启动回看窗口：只关注「现在正在跑」的会话
  const maxRows = opts.maxRows ?? 400;
  const onEvent = opts.onEvent ?? (() => {});
  let db = openOpencodeDb(opts.dbPath || OPENCODE_DB);
  let watermark = Date.now() - lookbackMs;
  const seen = new Map();                                // 'tbl:id' → sha256 hex
  const fp = (s) => {
    try { return createHash('sha256').update(s == null ? '' : s).digest('hex'); }
    catch { return createHash('sha256').update(String(s)).digest('hex'); }
  };
  const ctxBySid = new Map();                            // sessionId → {seq, hello}
  // v1→v2 迁移双写去重：有 v2 行的会话只跟 v2（连接期加载一次，随看到的 smsg 行增补）
  let v2Sids = null;
  const loadV2Sids = (db) => { try { return new Set(db.prepare('SELECT DISTINCT session_id AS s FROM session_message').all().map((r) => r.s)); } catch { return new Set(); } };
  let stopped = false;
  let lastPumpAt = 0;
  const stats = { polls: 0, rows: 0, events: 0, parseErrors: 0, subagentSkipped: 0, dbReopens: 0, lastGapMs: 0, gaps: [] };
  const noteGap = () => {
    const now = Date.now();
    const gap = lastPumpAt ? Math.max(0, now - lastPumpAt) : 0;
    lastPumpAt = now;
    if (gap) { stats.lastGapMs = gap; stats.gaps.push(gap); if (stats.gaps.length > 60) stats.gaps.shift(); }
  };
  function slowDown() { backoffMs = Math.min(backoffMs * 2, 10_000); }

  const STMT = `
    SELECT 'message' AS tbl, m.id AS id, m.session_id AS session_id, m.time_created AS time_created,
           m.time_updated AS time_updated, m.data AS data, s.directory AS cwd, s.title AS title
    FROM message m JOIN session_v2 s ON s.id = m.session_id
    WHERE s.parent_id IS NULL AND m.time_updated > ?
    UNION ALL
    SELECT 'part' AS tbl, p.id AS id, p.session_id AS session_id, p.time_created AS time_created,
           p.time_updated AS time_updated, p.data AS data, s.directory AS cwd, s.title AS title
    FROM part p JOIN session_v2 s ON s.id = p.session_id
    WHERE s.parent_id IS NULL AND p.time_updated > ?
    UNION ALL
    SELECT 'smsg' AS tbl, q.id AS id, q.session_id AS session_id, q.time_created AS time_created,
           q.time_updated AS time_updated, q.data AS data, s.directory AS cwd, s.title AS title,
           q.type AS smsg_type
    FROM session_message q JOIN session_v2 s ON s.id = q.session_id
    WHERE s.parent_id IS NULL AND q.time_updated > ?
    ORDER BY time_updated, id LIMIT ?`;

  function pump() {
    if (stopped) return;
    stats.polls++;
    noteGap();
    if (!db) { db = openOpencodeDb(opts.dbPath || OPENCODE_DB); if (db) stats.dbReopens++; }
    if (!db) { slowDown(); return; }                                // 无 OpenCode：退避而非每 2s 探测
    let rows;
    try { rows = db.prepare(STMT).all(watermark - 2000, watermark - 2000, watermark - 2000, maxRows); }
    catch (e) { try { db.close(); } catch {} db = null; slowDown(); return; }   // 库被替换/锁死：下轮重开+退避
    const rowsBefore = stats.rows;
    let maxUpdated = watermark;
    for (const r of rows) {
      if (r.time_updated > maxUpdated) maxUpdated = r.time_updated;
      const key = r.tbl + ':' + r.id;
      const h = fp(r.data);
      const prev = seen.get(key);
      if (prev === h) {
        seen.delete(key); seen.set(key, h); continue;
      }
      seen.set(key, h);
      if (seen.size > 6000) { const it = seen.keys(); for (let i = 0; i < 2000; i++) { const k = it.next().value; if (k === undefined) break; seen.delete(k); } }
      if (r.tbl === 'smsg') { if (!v2Sids) v2Sids = loadV2Sids(db); v2Sids.add(r.session_id); }
      else if (v2Sids === null) v2Sids = loadV2Sids(db);
      if (r.tbl !== 'smsg' && v2Sids.has(r.session_id)) { stats.subagentSkipped++; continue; }   // 迁移双写：旧路径行跳过（计数借用 subagentSkipped 字段名，含义=被去重跳过）
      stats.rows++;
      let ctx = ctxBySid.get(r.session_id);
      if (!ctx) {
        ctx = { sessionId: r.session_id, seq: 0, hello: false };
        ctxBySid.set(r.session_id, ctx);
      }
      const data = safeJson(r.data);
      if (r.tbl === 'smsg' && r.smsg_type) data.type = r.smsg_type;   // v2：type 在表列
      if (!ctx.hello) {
        ctx.hello = true;
        onEvent({ v: 1, seq: ++ctx.seq, ts: r.time_created, source: SOURCE, sessionId: r.session_id,
          type: 'session.start', data: { workspace: r.cwd ?? undefined, title: r.title ?? undefined } });
      }
      for (const ev of mapOpencodeRow({ tbl: r.tbl, data, time_created: r.time_created, time_updated: r.time_updated }, ctx)) { stats.events++; onEvent(ev); }
    }
    watermark = maxUpdated;
    if (stats.rows > rowsBefore) backoffMs = intervalMs; else slowDown();
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
// 4. 状态快照（四态面板数据；安装/运行态由 local-agents 注入）
// ---------------------------------------------------------------------------

export function scanOpencodeStatus(ctx = {}) {
  const installed = (() => {
    try {
      return fs.existsSync(path.join(os.homedir(), '.opencode', 'bin', 'opencode'))
        || fs.existsSync(OPENCODE_HOME)
        || fs.existsSync('/Applications/OpenCode.app');
    } catch { return false; }
  })();
  let sessionCount = null, degraded = false;
  try {
    const db = openOpencodeDb(OPENCODE_DB);
    if (db) {
      try { sessionCount = db.prepare(`SELECT COUNT(*) AS c FROM session_v2 WHERE time_archived IS NULL AND parent_id IS NULL`).get().c; }
      finally { db.close(); }
    } else degraded = true;
  } catch { degraded = true; }
  return {
    source: SOURCE, agentName: AGENT_NAME,
    installed, processRunning: !!ctx.processRunning,
    degraded, degradeReason: degraded ? 'sqlite-readonly-unavailable' : null,
    observes: !degraded
      ? ['session.start', 'turn.start', 'turn.end', 'tool.call', 'tool.result', 'message.assistant']
      : ['session.heartbeat'],                           // 库内 permission 表为请求级审批（桌面内交互），观察通道如实缺席审批族
    sessionCount, sessionCountApproximate: false,
    dataLocation: path.dirname(OPENCODE_DB),
    note: degraded ? 'OpenCode 数据库不可只读访问（未安装或异常关闭）' : 'sqlite 只读：session_v2/message/part（WAL 并发读，零侵入；CLI 与桌面共用）',
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

export function formatOpencodeTree(catalog) {
  const lines = [];
  lines.push('OpenCode 会话目录 ' + catalog.root);
  if (catalog.degraded) { lines.push('⚠ ' + (catalog.error ?? '降级')); return lines.join('\n'); }
  lines.push(catalog.stats.projects + ' 个项目 / ' + catalog.stats.sessions + ' 个会话（子代理 ' + catalog.stats.subagentSessions + ' 不列出 · 归档 ' + catalog.stats.archived + ' · 活跃 ' + catalog.stats.live + ' · 降级 ' + catalog.stats.degraded + '）  扫描耗时 ' + catalog.tookMs.toFixed(1) + ' ms');
  for (const p of catalog.projects) {
    lines.push('');
    lines.push('📁 ' + p.title + '   (' + p.cwd + ')');
    for (const s of p.sessions) {
      const flags = [s.live ? '● 活跃' : '', s.degraded ? '⚠ 降级' : ''].filter(Boolean).join('  ');
      lines.push('   └─ ' + String(s.sessionId).replace(/^ses_/, '').slice(0, 12).padEnd(13) + fmtTime(s.updatedAt) + '  ' + String((s.provider ? s.provider + '/' : '') + (s.model ?? '—')).padEnd(28) + ' ' + String(s.state).padEnd(9) + flags);
      lines.push('      「' + String(s.title ?? '').slice(0, 46) + '」  agent:' + (s.agentPreset ?? '?') + ' v' + (s.agentVersion ?? '?'));
    }
  }
  return lines.join('\n');
}

async function main(argv) {
  if (argv.includes('--follow')) {
    console.log('跟随 ' + OPENCODE_DB + '（Ctrl-C 退出）');
    followOpencodeLogs({ onEvent: (ev) => console.log(JSON.stringify(ev)) });
    return;
  }
  if (argv.includes('--status')) { console.log(JSON.stringify(scanOpencodeStatus(), null, 2)); return; }
  const runs = (() => { const i = argv.indexOf('--bench'); return i >= 0 ? Math.max(1, Number(argv[i + 1]) || 5) : 1; })();
  let catalog; const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    catalog = scanOpencodeCatalog();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  if (argv.includes('--json')) console.log(JSON.stringify(catalog, null, 2));
  else {
    console.log(formatOpencodeTree(catalog));
    if (runs > 1) console.log('\n扫描耗时 ' + runs + ' 轮：min ' + Math.min(...times).toFixed(1) + ' / 中位 ' + times.sort((a, b) => a - b)[Math.floor(times.length / 2)].toFixed(1) + ' / max ' + Math.max(...times).toFixed(1) + ' ms');
  }
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) await main(process.argv.slice(2));
