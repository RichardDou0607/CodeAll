#!/usr/bin/env node
/**
 * demo/framed.mjs — 悬浮窗的本地服务（状态聚合 + SSE 实时推送 + 输入接口）
 *
 * 设计（契约 docs/00-interface-contract.md v1.2 的本地落地）：
 *   DSH 会话日志（只读，多帧 zstd 增量）
 *        └─→ 规范事件（15 种；只保留「状态级」信息，不落步骤明细）
 *              └─→ Hub 状态机（§4：优先级 / 瞬态-持久错误 / 审批配对 / 多会话聚合）
 *                    └─→ SSE /api/stream  →  悬浮窗 demo/window.html
 *   悬浮窗输入 ──POST /api/input──→ Hub 输入队列
 *        ├─ 若配置了 DSH 输入通道（环境变量 PET_INPUT_CMD）→ 交给该命令投递
 *        └─ 否则标记为 pending，返回「需要手动投递」，UI 显示可复制的命令
 *
 * 用法：node demo/framed.mjs [--port 7799] [--session <id>]
 * 注意：只读 DSH 会话日志；不接触任何凭证，不写入 ~/.dsh。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { createHub, makeMapper, findSessionLog } from './frame.mjs';
import { scanCatalog, readWorkspaceIndex } from '../adapters/session-catalog.mjs';
import { scanLocalAgents } from '../adapters/local-agents.mjs';
import { scanClaudeCatalog, followClaudeLogs, SOURCE as CC_SOURCE } from '../adapters/claude-code-adapter.mjs';
import { scanCodexCatalog, followCodexLogs, SOURCE as CX_SOURCE } from '../adapters/codex-adapter.mjs';
import { scanKimiCatalog, followKimiLogs, SOURCE as KM_SOURCE } from '../adapters/kimi-code-adapter.mjs';
import { CLI_TARGETS, availableCliChannels, deliverControl, newCliSession, openCliSession } from '../adapters/cli-control.mjs';
import net from 'node:net';
import crypto from 'node:crypto';

/** 多源会话目录（M-C）：DSH（workspace 注册表）+ Claude Code（目录即项目）+ Codex（session_meta.cwd 归并）。 */
const SOURCE_LABEL = { dsh: 'DSH', 'claude-code': 'Claude Code', codex: 'Codex', 'kimi-code': 'Kimi Code', agentos: 'AgentOS', opencode: 'OpenCode' };

// ---------- DSH 插件通道（优先）：存在则用进程内事件 + 输入投递；不存在则退回日志 tail + 本地队列 ----------
const PLUGIN_SOCK = process.env.PET_PLUGIN_SOCK || path.join(process.env.TMPDIR || '/tmp', 'agent-pet', 'dsh-plugin.sock');
const plugin = { available: false, socket: PLUGIN_SOCK, lastProbe: 0, info: null, events: 0 };
/** 极简 HTTP-over-UnixSocket 客户端（零依赖） */
function pluginRequest(method, urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PLUGIN_SOCK);
    let done = false;
    const finish = (err, val) => { if (done) return; done = true; try { sock.destroy(); } catch {} err ? reject(err) : resolve(val); };
    sock.setTimeout(timeoutMs || 1500);
    sock.on('timeout', () => finish(new Error('timeout')));
    sock.on('error', (e) => finish(e));
    sock.on('connect', () => {
      const payload = body ? JSON.stringify(body) : '';
      const head = method + ' ' + urlPath + ' HTTP/1.1\r\nHost: dsh-pet\r\n' +
        (payload ? 'Content-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(payload) + '\r\n' : '') +
        'Connection: close\r\n\r\n';
      sock.write(head + payload);
    });
    let raw = '';
    sock.on('data', (c) => { raw += c.toString('utf8'); });
    sock.on('end', () => {
      const idx = raw.indexOf('\r\n\r\n');
      if (idx < 0) return finish(new Error('bad response'));
      const head = raw.slice(0, idx), rest = raw.slice(idx + 4);
      const status = Number((head.match(/^HTTP\/1\.1 (\d+)/) || [])[1] || 0);
      let json = null; try { json = JSON.parse(rest); } catch {}
      finish(null, { status, json, text: rest });
    });
  });
}
async function probePlugin() {
  plugin.lastProbe = Date.now();
  try {
    // 探测端点必须是插件真实存在的 GET /health（曾误用 /state：插件只回 404，
    // 导致插件永远「不可用」，新建/打开/直投能力位永远 false）
    const r = await pluginRequest('GET', '/health', null, 1200);
    if (r.status === 200 && r.json) {
      // /health 把能力位放在 capabilities 子对象里；归一化到顶层，快照读取不用区分形状
      const caps = r.json.capabilities || {};
      plugin.info = { ...r.json, canOpen: r.json.canOpen ?? caps.canOpen, canCreate: r.json.canCreate ?? caps.canCreate };
      plugin.available = true; return true;
    }
    plugin.available = false; plugin.info = r.json;
  } catch (e) { plugin.available = false; plugin.info = { error: String(e.message || e) }; }
  return plugin.available;
}
/** 订阅插件事件流（NDJSON 长连），把契约帧喂给同一个状态机 */
function subscribePlugin() {
  const sock = net.connect(PLUGIN_SOCK);
  let buf = '';
  sock.on('connect', () => sock.write('GET /events HTTP/1.1\r\nHost: dsh-pet\r\nConnection: keep-alive\r\n\r\n'));
  sock.on('data', (c) => {
    buf += c.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      let frame = null; try { frame = JSON.parse(line); } catch { continue; }
      if (frame.ctl) { if (frame.ctl === 'hello' || frame.ctl === 'ack') plugin.info = Object.assign({}, plugin.info, frame); continue; }
      plugin.available = true; plugin.events++;
      try { applyEvent(frame); } catch {}
    }
  });
  sock.on('error', () => { plugin.available = false; setTimeout(connectPlugin, 3000); });
  sock.on('close', () => setTimeout(connectPlugin, 3000));
}
async function connectPlugin() {
  if (!(await probePlugin())) { setTimeout(connectPlugin, 5000); return; }
  console.log('DSH 插件已连接： ' + PLUGIN_SOCK + '（进程内事件 + 输入投递可用）');
  subscribePlugin();
  broadcast();
}

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(getArg('--port', process.env.PET_PORT || 7799));
const SESSION = getArg('--session', null);
const INPUT_CMD = process.env.PET_INPUT_CMD || null;
const PET_DIR = path.join(process.env.HOME || '.', '.agent-pet');
const INPUT_LOG = path.join(PET_DIR, 'input-queue.jsonl');
const INPUT_MAX_ITEMS = 200;      // 队列条目上限：超出丢弃最旧（补上架构文档 §4 缺失的轮转规格）
const INPUT_MAX_BYTES = 1 << 20;  // 1MB 硬上限（单条 ≤2000 字符，正常远达不到）

// ---------- 本地服务鉴权（qa A-1批 E-1：TCP 失去了 Unix socket 的同用户隐含鉴权，必须显式补回） ----------
// token 落盘 0600：同用户进程可读（与 ADR-3 的 Unix socket 同一信任级别）；
// 页面由本服务产出并注入 token，跨站页面与 DNS rebinding 都拿不到。
function loadOrCreateToken() {
  const tokenFile = path.join(PET_DIR, 'token');
  try {
    const t = fs.readFileSync(tokenFile, 'utf8').trim();
    if (/^[0-9a-f]{32,64}$/.test(t)) return t;
  } catch { /* 首次运行 */ }
  const t = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(PET_DIR, { recursive: true });
    fs.writeFileSync(tokenFile, t + '\n', { mode: 0o600 });
  } catch { /* HOME 只读时退化为仅 Host 校验 */ }
  return t;
}
const TOKEN = loadOrCreateToken();

/** DNS rebinding 防线：Host 必须是回环地址（rebinding 时浏览器发 Host: 攻击域名 → 拒绝）。 */
function hostOk(req) {
  const h = String(req.headers.host || '');
  return h === '127.0.0.1:' + PORT || h === 'localhost:' + PORT;
}
/** 写操作鉴权：token 走 header x-pet-token 或查询参数 ?t=（供 EventSource 类无法设头的客户端）。 */
function tokenOk(req, url) {
  const given = String(req.headers['x-pet-token'] || '') || String(url.searchParams.get('t') || '');
  return given.length > 0 && given === TOKEN;
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function decodeFrames(buf) {
  const offsets = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i >= 0) { offsets.push(i); i = buf.indexOf(MAGIC, i + 1); }
  const events = []; let cursor = 0;
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k]; if (start < cursor) continue;
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    let text = null;
    try { text = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'); }
    catch { if (k + 1 === offsets.length) break; continue; }
    cursor = end;
    for (const line of text.split('\n')) { const t = line.trim(); if (t) { try { events.push(JSON.parse(t)); } catch {} } }
  }
  return { events, nextOffset: cursor };
}

const hub = createHub();
// ---------- 输入队列持久化（qa A-1/A-3/A-4：可删除、有轮转、0600、原子写） ----------
function readInputFile() {
  try {
    if (!fs.existsSync(INPUT_LOG)) return [];
    const out = [];
    for (const l of fs.readFileSync(INPUT_LOG, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { const o = JSON.parse(l); out.push({ id: o.id, text: o.text, at: o.at, status: o.status, detail: o.detail, sessionId: o.sessionId ?? null }); } catch { /* 坏行跳过 */ }
    }
    return out;
  } catch { return []; }
}
function writeInputFile(items) {
  fs.mkdirSync(PET_DIR, { recursive: true });
  const data = items.map(i => JSON.stringify(i)).join('\n') + (items.length ? '\n' : '');
  const tmp = INPUT_LOG + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o600 });  // 0600：队列是用户原文，按架构 §5.3 与录制文件同级
  fs.renameSync(tmp, INPUT_LOG);                 // 原子替换：磁盘上不会出现半写的队列
}
const state = {
  sessions: new Map(),      // sessionId -> { source, label, state, since, pending, lastToolCategory, note }
  order: [],
  counters: { events: 0, thinking: 0, running: 0, errors: 0, done: 0, offline: 0 },
  inputs: readInputFile(), // 启动时从 ~/.agent-pet/input-queue.jsonl 全量恢复（轮转后 ≤200 条）
  lastEvent: null,
  lastEventAt: Date.now(),
};
try { fs.chmodSync(INPUT_LOG, 0o600); } catch { /* 文件尚不存在，首次写入时即为 0600 */ }
const clients = new Set();
// 目录缓存（项目 → 会话）；每 5s 或按需刷新，扫描实测 ~20ms/16 会话
let catalogCache = { at: 0, data: null };
function catalog(force) {
  if (force || !catalogCache.data || Date.now() - catalogCache.at > 5000) {
    try { catalogCache = { at: Date.now(), data: scanCatalog({}) }; }
    catch (e) { catalogCache = { at: Date.now(), data: { projects: [], error: String(e.message).slice(0, 120) } }; }
  }
  return catalogCache.data;
}
// DSH 左侧会话列表的注册表（workspace.json，只读）：列表成员与顺序以它为准
let wsCache = { at: 0, data: null };
function workspaceIndex(force) {
  if (force || !wsCache.data || Date.now() - wsCache.at > 5000) {
    wsCache = { at: Date.now(), data: readWorkspaceIndex() };   // 内部已兜底，绝不抛
  }
  return wsCache.data;
}
// 多源目录缓存：DSH + Claude Code + Codex + Kimi Code 四路扫描合并（各 ~20ms，5s 复用）
let multiCache = { at: 0, data: null };
function multiCatalog(force) {
  if (force || !multiCache.data || Date.now() - multiCache.at > 5000) {
    const dsh = catalog(force);
    let cc = { projects: [], sessions: [], elapsedMs: 0 };
    let cx = { projects: [], sessions: [], elapsedMs: 0 };
    let km = { projects: [], sessions: [], elapsedMs: 0 };
    try { cc = scanClaudeCatalog(); } catch (e) { cc = { projects: [], sessions: [], elapsedMs: 0, error: String(e.message).slice(0, 120) }; }
    try { cx = scanCodexCatalog(); } catch (e) { cx = { projects: [], sessions: [], elapsedMs: 0, error: String(e.message).slice(0, 120) }; }
    try { km = scanKimiCatalog(); } catch (e) { km = { projects: [], sessions: [], elapsedMs: 0, error: String(e.message).slice(0, 120) }; }
    multiCache = { at: Date.now(), data: { dsh, cc, cx, km, elapsedMs: (dsh.elapsedMs || 0) + (cc.elapsedMs || 0) + (cx.elapsedMs || 0) + (km.elapsedMs || 0) } };
  }
  return multiCache.data;
}
const sessionStates = new Map(); // sessionId -> 来自目录的粗粒度状态（无实时事件时用）

// CLI 控制通道缓存（PATH 探测 60s 缓存，避免每 2s 快照都查）
let cliChannelsCacheData = { at: 0, data: null };
function cliChannelsCache() {
  if (!cliChannelsCacheData.data || Date.now() - cliChannelsCacheData.at > 60_000) {
    try { cliChannelsCacheData = { at: Date.now(), data: availableCliChannels() }; }
    catch { cliChannelsCacheData = { at: Date.now(), data: [] }; }
  }
  return cliChannelsCacheData.data;
}

// ---------- 本地域 agent 软件四态（adapters/local-agents.mjs）：3s 轮询，DSH 连接态由此处注入 ----------
let agentStatus = { agents: [], counts: {}, scannedAt: 0, tookMs: 0 };
async function refreshAgentStatus() {
  try {
    agentStatus = await scanLocalAgents({ dsh: { plugin: plugin.available, lastEventAt: state.lastEventAt } });
  } catch { /* 探测失败保持上次结果 */ }
}

// 状态级摘要：只保留「思考 / 运行命令 / 连接错误 / 已完成 / 等待你」，不展示步骤明细
const CATEGORY_TEXT = { exec: '运行命令', read: '读取文件', write: '修改文件', net: '联网检索', other: '调用工具' };
function touchSession(sessionId, ev) {
  const id = sessionId ?? 'backend';
  let s = state.sessions.get(id);
  if (!s) {
    s = { id, source: ev.source, label: labelOf(ev), state: 'idle', since: ev.ts, pending: 0, activity: '', note: '', events: 0, cwd: null, origin: null };
    state.sessions.set(id, s); state.order.push(id);
  }
  s.events++;
  s.since = s.since ?? ev.ts;
  if (ev.data?.workspace) { s.label = String(ev.data.workspace).split('/').pop(); s.cwd = ev.data.workspace; }
  if (ev.data?.origin) s.origin = ev.data.origin;   // 插件 session.start 带上 origin：子代理零延迟识别（不等 5s 目录刷新）
  if (ev.data?.title) s.label = ev.data.title;
  return s;
}
function labelOf(ev) {
  const ws = ev.data?.workspace ?? ev.workspace;
  if (ws) return String(ws).split('/').pop();
  return String(ev.sessionId ?? 'backend').replace(/^session-/, '').slice(0, 10);
}
function setState(s, next, activity) {
  if (s.state !== next) { s.since = Date.now(); s.state = next; }
  if (activity !== undefined) s.activity = activity;
}
function applyEvent(ev) {
  const id = ev.sessionId ?? 'backend';
  state.lastEvent = { type: ev.type, ts: ev.ts, sessionId: id };
  state.lastEventAt = Date.now();
  // 来源级帧（pet.heartbeat / sessionId='backend'）：维持存活判定，但**不**建会话行
  //（曾把心跳画成名为 backend 的幽灵「会话」，2026-10-05 实测踩坑）
  if (id === 'backend' || ev.type === 'pet.heartbeat') { hub.apply(ev); broadcast(); return; }
  const s = touchSession(id, ev);
  const d = ev.data ?? {};
  switch (ev.type) {
    // 会话创建 ≠ 开始思考：新会话是空闲的（曾把 session.start 当 thinking，
    // 新建的空闲会话永远显示「思考中」，2026-10-05 实测踩坑）
    case 'session.start': setState(s, 'idle', '空闲'); break;
    case 'turn.start': setState(s, 'thinking', '思考中'); state.counters.thinking++; break;
    case 'turn.end': setState(s, d.status === 'ok' ? 'done' : d.status === 'error' ? 'error' : 'idle', d.status === 'ok' ? '已完成' : d.status === 'error' ? '本轮出错' : '空闲'); if (d.status === 'ok') state.counters.done++; break;
    case 'session.end': setState(s, d.reason === 'error' ? 'error' : d.reason === 'done' ? 'done' : 'idle', d.reason === 'error' ? '会话出错' : d.reason === 'done' ? '已完成' : '空闲'); break;
    case 'step.start': case 'step.end': setState(s, d.status === 'error' ? 'transient-error' : 'running', d.status === 'error' ? '步骤出错（自动恢复）' : '运行中'); break;
    case 'tool.call': setState(s, 'running', CATEGORY_TEXT[d.category] || '调用工具'); state.counters.running++; break;
    case 'tool.result': if (d.status === 'error') { setState(s, 'transient-error', '命令出错'); state.counters.errors++; } else if (d.status === 'denied') { setState(s, 'running', '命令被拒绝'); } break;
    case 'approval.request': case 'user.question': { s.pending++; setState(s, 'waiting', ev.type === 'approval.request' ? '等待你批准' : '等你回答'); break; }
    case 'approval.resolved': case 'user.answer': { s.pending = Math.max(0, s.pending - 1); if (d.decision === 'timeout') setState(s, 'transient-error', '审批超时'); else setState(s, 'running', '继续运行'); break; }
    case 'agent.status': setState(s, d.state, '后端上报'); break;
    case 'error.raised': if (d.fatal) { setState(s, 'error', d.message || '连接错误'); state.counters.errors++; } break;
    case 'message.assistant': s.note = '刚有回复'; break;
    default: break;
  }
  hub.apply(ev);
  broadcast();
}
function snapshot() {
  const agg = hub.agg();
  const multi = multiCatalog(false);
  const cat = multi.dsh;
  const ws = workspaceIndex(false);
  // 跨源元信息表：sessionId → 目录记录（claude/codex/kimi 记录自带 source / agentName / model）
  const metaById = new Map();
  for (const p of cat.projects || []) for (const s of p.sessions || []) metaById.set(s.sessionId, s);
  for (const p of multi.cc.projects || []) for (const s of p.sessions || []) metaById.set(s.sessionId, s);
  for (const p of multi.cx.projects || []) for (const s of p.sessions || []) metaById.set(s.sessionId, s);
  for (const p of multi.km.projects || []) for (const s of p.sessions || []) metaById.set(s.sessionId, s);
  // 子代理判定：插件 session.start 的 origin 立即可判（零延迟）；目录 kind 兜底（≤5s 滞后）
  const isSubagent = (id, s) => s?.origin === 'subagent' || (metaById.get(id)?.kind || 'main') === 'subagent';
  // projectKey：DSH 注册表优先；claude/codex 按 cwd 归并进同目录 workspace；都不中 → 'path:<cwd>'（M-C）
  const keyOfSession = (id, row) => {
    const wid = ws.sessionOwner.get(id);
    if (wid) return wid;
    const cwd = metaById.get(id)?.cwd ?? row?.cwd ?? null;
    if (cwd) { const w = ws.byPath.get(cwd); if (w) return w; }
    return cwd ? 'path:' + cwd : '__none__';
  };
  const live = state.order.map(id => state.sessions.get(id)).filter(Boolean).filter(s => !isSubagent(s.id, s)).map(s => {
    const meta = metaById.get(s.id) || {};
    return {
      id: s.id, source: s.source, label: meta.title || s.label, state: s.state,
      cwd: meta.cwd || s.cwd || null, projectKey: keyOfSession(s.id, s),
      since: s.since, pending: s.pending, activity: s.activity,
      elapsedMs: Date.now() - s.since,
      agentName: meta.agentName || SOURCE_LABEL[s.source] || 'DSH', model: meta.model || null, reasoningEffort: meta.reasoningEffort || null,
      agentPreset: meta.agentPreset || null, title: meta.title || null, kind: 'main', live: true,
    };
  });
  const liveIds = new Set(live.map(s => s.id));

  // ---- 会话列表（多源合并，docs/21 M-C「按 cwd 归一」）----
  //   DSH = workspace 注册表（唯一真相源，原行为保留）；
  //   Claude Code / Codex 会话按 cwd 挂靠：① 命中 workspace.path → 并进该项目；② 未命中 → 'path:<cwd>' 自立组。
  //   子代理一律不出现（注册表本就不含；codex 目录扫描已按 parent_thread_id 过滤）。
  const extraByWorkspace = new Map();   // workspaceId → 非 DSH 会话行
  const orphanByCwd = new Map();        // 'path:<cwd>' → { cwd, rows }
  const collectExtra = (s) => {
    if (s.kind === 'subagent') return;
    const wid = s.cwd ? ws.byPath.get(s.cwd) : undefined;
    if (wid && ws.byId.has(wid)) {
      if (!extraByWorkspace.has(wid)) extraByWorkspace.set(wid, []);
      extraByWorkspace.get(wid).push(s);
    } else {
      const key = 'path:' + (s.cwd ?? '(未知目录)');
      if (!orphanByCwd.has(key)) orphanByCwd.set(key, { cwd: s.cwd, rows: [] });
      orphanByCwd.get(key).rows.push(s);
    }
  };
  for (const s of multi.cc.sessions || []) collectExtra(s);
  for (const s of multi.cx.sessions || []) collectExtra(s);
  for (const s of multi.km.sessions || []) collectExtra(s);

  const sidebarProjects = [];
  const listed = new Set();
  for (const wid of ws.order) {
    const w = ws.byId.get(wid);
    if (!w) continue;
    const rows = [];
    for (const sid of w.sessionIds) {
      if (ws.archived.has(sid)) continue;
      const meta = metaById.get(sid);
      if (!meta || meta.kind === 'subagent') continue;
      listed.add(sid);
      rows.push(meta);
    }
    const extras = (extraByWorkspace.get(wid) || []).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    for (const e of extras) listed.add(e.sessionId);
    const all = [...rows, ...extras];
    sidebarProjects.push({
      key: wid, projectId: wid, workspaceId: wid, name: w.title, title: w.title, cwd: w.path,
      sessionCount: all.length, mainCount: all.length, subagentCount: 0,
      liveCount: all.filter(r => r.live || liveIds.has(r.sessionId)).length,
      sources: [...new Set(['dsh', ...extras.map(e => e.source).filter(Boolean)])],
      sessions: all,
    });
  }
  // 未挂靠任何 workspace 的 claude/codex/kimi 项目组（cwd 自立；同 cwd 的多源会话进同一组）
  for (const [key, g] of orphanByCwd) {
    const rows = g.rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    for (const r of rows) listed.add(r.sessionId);
    const name = g.cwd ? path.basename(g.cwd) : '（未知目录）';
    sidebarProjects.push({
      key, projectId: key, workspaceId: null, name, title: name, cwd: g.cwd,
      sessionCount: rows.length, mainCount: rows.length, subagentCount: 0,
      liveCount: rows.filter(r => r.live || liveIds.has(r.sessionId)).length,
      sources: [...new Set(rows.map(r => r.source).filter(Boolean))],
      sessions: rows, unregistered: false,
    });
  }
  // DSH 未注册进任何 workspace 的主会话（如旧版 cwd-only 创建的）归入末尾「未归入项目」组
  const unregistered = (cat.sessions || [])
    .filter(s => s.kind !== 'subagent' && !ws.archived.has(s.sessionId) && !ws.sessionOwner.has(s.sessionId) && !listed.has(s.sessionId))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  if (unregistered.length) {
    sidebarProjects.push({
      key: '__none__', projectId: '__none__', workspaceId: null, name: '未归入项目', title: '未归入项目', cwd: null,
      sessionCount: Math.min(unregistered.length, 12), mainCount: Math.min(unregistered.length, 12), subagentCount: 0,
      liveCount: unregistered.filter(r => r.live || liveIds.has(r.sessionId)).length,
      sources: ['dsh'],
      sessions: unregistered.slice(0, 12),
      unregistered: true,
    });
  }
  // 历史行（非实时）：跨源合并，按更新时间排，总量截 40
  const history = sidebarProjects.flatMap(p => p.sessions)
    .filter(s => !liveIds.has(s.sessionId) && !s.live)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, 40)
    .map(s => ({ ...s, source: s.source || 'dsh', projectKey: keyOfSession(s.sessionId, s) }));
  return {
    v: 1, ts: Date.now(), agg,
    sessions: live,
    agents: agentStatus.agents,
    agentCounts: agentStatus.counts || {},
    counters: state.counters,
    inputs: state.inputs.slice(-8).reverse(),
    lastEvent: state.lastEvent,
    inputChannel: (() => {
      const cli = cliChannelsCache();
      if (INPUT_CMD) return { mode: 'cmd', detail: INPUT_CMD };
      if (cli.length) return { mode: 'cli', detail: 'DSH 经本地队列（挂插件可直投）；Claude Code / Codex / Kimi Code 会话直接经各自 CLI 投递' };
      return { mode: 'manual', detail: '未配置输入通道：输入会进本地队列，点击可复制手动投递命令' };
    })(),
    catalog: {
      projects: sidebarProjects.map(p => ({
        key: p.key, projectId: p.projectId, name: p.name, cwd: p.cwd,
        sessionCount: p.sessionCount, mainCount: p.mainCount, subagentCount: p.subagentCount,
        liveCount: p.liveCount, unregistered: p.unregistered || false,
        sources: p.sources || ['dsh'],
      })),
      history,
      elapsedMs: multi.elapsedMs, scannedAt: cat.scannedAt,
      source: 'multi:workspace-registry+disk(claude-code,codex,kimi-code)',
    },
    capabilities: (() => {
      const cli = cliChannelsCache();
      const pluginCanInput = !!(plugin.info && ((plugin.info.capabilities || {}).canInput ?? plugin.info.canInput));
      return {
        canCatalog: true,
        canInput: pluginCanInput || cli.length > 0,
        canOpen: !!(plugin.info && plugin.info.canOpen) || cli.length > 0,
        canCreate: !!(plugin.info && plugin.info.canCreate) || cli.length > 0,
        cliChannels: cli.map(c => ({ source: c.source, name: c.name })),
        source: plugin.available ? 'plugin' : 'log-tail',
        plugin: { available: plugin.available, socket: plugin.socket, events: plugin.events, info: plugin.info || null },
        note: plugin.available
          ? 'DSH 插件已连接：进程内事件 + 输入投递 + 新建/打开可用'
          : (cli.length ? '控制通道：' + cli.map(c => c.name).join(' / ') + '（CLI 投递/新建/打开）；DSH 仍为只读观察' : '未挂载 DSH 插件且无 CLI 通道：只读观察 + 本地队列（挂载方式见 docs/54-dsh-plugin.md）'),
      };
    })(),
  };
}
function broadcast() { const payload = 'data: ' + JSON.stringify(snapshot()) + '\n\n'; for (const res of clients) { try { res.write(payload); } catch { clients.delete(res); } } }

// ---------- DSH 会话日志跟随 ----------
let offset = 0, mapper = null, target = null;
/** 默认跟随目标：目录里最新的**主**会话（findSessionLog 按 mtime 全局挑最新，会挑中子代理日志）。 */
function newestMainLog() {
  try {
    const cat = scanCatalog({});
    const mains = (cat.sessions || []).filter(s => s.kind !== 'subagent' && s.logFile)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return mains[0] ? { file: mains[0].logFile, session: mains[0].sessionId } : null;
  } catch { return null; }
}
function startFollower() {
  target = SESSION ? findSessionLog(SESSION) : (newestMainLog() || findSessionLog(null));
  if (!target) { console.error('未找到 DSH 会话日志；悬浮窗将只显示空状态。可用 --session 指定。'); return; }
  const read = () => {
    let buf; try { buf = fs.readFileSync(target.file); } catch { return; }
    if (offset > buf.length) offset = 0;
    const { events, nextOffset } = decodeFrames(buf.subarray(offset));
    offset += nextOffset;
    for (const native of events) {
      if (native.type === 'session') { mapper = makeMapper(native); continue; }
      if (!mapper) mapper = makeMapper({ id: 'unknown', cwd: null, createdAt: Date.now() });
      for (const ev of mapper(native)) applyEvent(ev);
    }
    const offline = Date.now() - state.lastEventAt > 45000;
    if (offline && !state.counters.offline) { state.counters.offline = 1; broadcast(); }
    else if (!offline && state.counters.offline) { state.counters.offline = 0; broadcast(); }
  };
  read();
  try { fs.watch(target.file, () => read()); } catch {}
  setInterval(read, 800);
  setInterval(broadcast, 2000);   // 心跳 + 计时刷新
}

// ---------- 输入投递 ----------
/** 跨源定位会话（支持前缀）：DSH / Claude Code / Codex / Kimi Code 目录各查一遍，返回时附带所属项目。 */
function resolveSessionAny(sessionId) {
  const multi = multiCatalog(false);
  for (const cat of [multi.dsh, multi.cc, multi.cx, multi.km]) {
    for (const p of cat.projects || []) {
      const s = (p.sessions || []).find(x => x.sessionId === sessionId || String(x.sessionId).indexOf(sessionId) === 0);
      if (s) return { ...s, project: { projectId: p.projectId, cwd: p.cwd, name: p.name, title: p.title } };
    }
  }
  return null;
}
/** 校验并归一化用户指定的投递目标：必须是已知**主**会话（支持 sessionId 前缀）。
 *  返回 {id,label,source} 或 {error}——source 供 deliverInput 路由（DSH=插件/队列；CLI 后端=cli-control）。 */
function resolveTarget(sessionId) {
  if (!sessionId) return { id: null };
  const liveHit = state.order.map(id => state.sessions.get(id)).filter(Boolean).find(s => s.id === sessionId || s.id.startsWith(sessionId));
  if (liveHit) return { id: liveHit.id, label: liveHit.label, source: liveHit.source ?? 'dsh' };
  const found = resolveSessionAny(String(sessionId));
  if (!found) return { error: '未找到会话 ' + String(sessionId).slice(0, 24) };
  if (found.kind === 'subagent') return { error: '「' + (found.title || found.sessionId.slice(0, 12)) + '」是子代理会话，不能作为投递目标' };
  return { id: found.sessionId, label: found.title, source: found.source || 'dsh' };
}
async function deliverInput(text, targetId, targetSource) {
  // id 必须唯一：同毫秒两次发送若共用 id，删除/重发会误伤另一条
  const item = { id: 'in-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'), text, at: Date.now(), status: 'pending', detail: '', sessionId: targetId || null };
  // ⓪ CLI 后端（M-D/M-E/M-H 控制层）：tmux 优先 → 无头续会话兜底；回合写入会话文件后观察跟随器自动看到
  if (targetSource && CLI_TARGETS[targetSource]) {
    const sess = (() => {
      const live = state.sessions.get(targetId);
      if (live) return { sessionId: targetId, cwd: live.cwd };
      const found = resolveSessionAny(String(targetId));
      return found ? { sessionId: found.sessionId, cwd: found.cwd ?? found.project?.cwd } : { sessionId: targetId };
    })();
    const r = await deliverControl(targetSource, sess, text);
    if (r.ok) { item.status = 'delivered'; item.detail = 'via ' + r.via; }
    else { item.status = 'failed'; item.detail = 'CLI 投递失败：' + (r.detail || r.error); }
    state.inputs.push(item); persistInput(item); broadcast(); return item;
  }
  // ① 首选：DSH 插件（进程内投递；显式指定的目标优先，否则自动挑活跃主会话）
  if (plugin.available) {
    const targetSession = targetId || pluginTargetSession();
    try {
      const r = await pluginRequest('POST', '/input', { sessionId: targetSession, text }, 4000);
      if (r.json && r.json.sessionId) item.sessionId = r.json.sessionId;  // 审计字段记实际投递目标，而非日志跟随目标
      if (r.status === 200 && r.json && r.json.ok) {
        item.status = 'delivered';
        item.detail = 'via plugin:' + (r.json.via || '?') + (r.json.sessionId ? ' → ' + String(r.json.sessionId).slice(0, 12) : '');
        state.inputs.push(item); persistInput(item); broadcast(); return item;
      }
      item.status = 'failed';
      item.detail = 'plugin 拒绝：' + ((r.json && (r.json.detail || r.json.code)) || r.status);
    } catch (e) { item.status = 'failed'; item.detail = 'plugin 调用失败：' + String(e.message || e).slice(0, 80); }
    state.inputs.push(item); persistInput(item); broadcast(); return item;
  }
  // ② 次选：外部命令
  if (INPUT_CMD) {
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync('/bin/sh', ['-c', INPUT_CMD], { input: text, timeout: 5000 });
      item.status = 'delivered'; item.detail = '已通过 PET_INPUT_CMD 投递';
    } catch (e) { item.status = 'failed'; item.detail = String(e.message).slice(0, 120); }
  } else {
    item.status = 'queued'; item.detail = '已记录到本地队列（未配置自动投递通道）';
  }
  state.inputs.push(item);
  persistInput(item);
  broadcast();
  return item;
}
/** 自动挑投递目标：优先实时活跃的**DSH 主**会话（claude/codex 无投递通道，子代理不算），否则 null（插件会挑最新磁盘主会话）。 */
function pluginTargetSession() {
  const cat = catalog(false);
  const metaById = new Map();
  for (const p of cat.projects || []) for (const s of p.sessions || []) metaById.set(s.sessionId, s);
  const live = state.order.map(id => state.sessions.get(id)).filter(Boolean)
    .filter(s => (s.source ?? 'dsh') === 'dsh')
    .filter(s => (metaById.get(s.id)?.kind || 'main') !== 'subagent');
  const running = live.find(s => ['running', 'thinking', 'waiting'].includes(s.state)) || live[0];
  return running ? running.id : null;
}
function persistInput(item) {
  const items = readInputFile();
  items.push({ ...item, sessionId: item.sessionId ?? null });
  let out = items.length > INPUT_MAX_ITEMS ? items.slice(-INPUT_MAX_ITEMS) : items;
  while (Buffer.byteLength(JSON.stringify(out)) > INPUT_MAX_BYTES && out.length > 1) out = out.slice(1);
  try { writeInputFile(out); } catch { /* 磁盘不可写时仍保留内存态 */ }
}
/** 从文件与内存同步删除队列项（qa A-1）；返回删除条数。 */
function removeInputs(pred) {
  const before = readInputFile();
  const keep = before.filter(i => !pred(i));
  if (keep.length !== before.length) { try { writeInputFile(keep); } catch { /* ignore */ } }
  state.inputs = keep;
  return before.length - keep.length;
}

// ---------- HTTP ----------
const HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'window.html');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (!hostOk(req)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'bad-host', detail: '仅接受 127.0.0.1/localhost 的 Host（DNS rebinding 防线）' }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && !tokenOk(req, url)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized', howto: '写接口需带 header x-pet-token 或 ?t=；token 在 ~/.agent-pet/token（0600）' }));
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/window.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    // 只替换字符串字面量 '__PET_TOKEN_VALUE__'（页面中唯一出现）。
    // 不得用 '__PET_TOKEN__'：它在页面里的首次出现是 window.__PET_TOKEN__ 的属性名，
    // 会被一并替换成 window.<hex>——数字开头的非法标识符，整个内联脚本 SyntaxError（2026-10-05 实测踩坑）。
    res.end(fs.readFileSync(HTML, 'utf8').replace("'__PET_TOKEN_VALUE__'", JSON.stringify(TOKEN)));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/catalog') {
    // 对外只暴露「主会话」：子代理（kind==='subagent'）不是用户意义上的会话，
    // 既不该出现在列表里，也不该被选为投递目标（服务端 resolveTarget 也会再拦一次）。
    // M-C：三源合并（DSH / Claude Code / Codex），projects[].sources 标注每个项目的来源构成。
    const multi = multiCatalog(url.searchParams.get('refresh') === '1');
    const projects = [];
    for (const cat of [multi.dsh, multi.cc, multi.cx, multi.km]) {
      for (const p of cat.projects || []) {
        const mains = (p.sessions || []).filter(s => s.kind !== 'subagent');
        projects.push(Object.assign({}, p, {
          sessions: mains,
          sessionCount: mains.length,
          mainCount: mains.length,
          subagentCount: (p.sessions || []).length - mains.length,
          liveCount: mains.filter(s => s.live).length,
          sources: [...new Set(mains.map(s => s.source).filter(Boolean))],
        }));
      }
    }
    const visible = projects.filter(p => p.sessionCount > 0);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(Object.assign({}, multi.dsh, {
      source: 'multi:workspace-registry+disk(claude-code,codex,kimi-code)',
      projects: visible,
      mainSessions: visible.reduce((a, p) => a + p.sessionCount, 0),
      subagentSessions: visible.reduce((a, p) => a + p.subagentCount, 0),
      perSource: {
        dsh: { projects: (multi.dsh.projects || []).length, sessions: (multi.dsh.sessions || []).filter(s => s.kind !== 'subagent').length },
        'claude-code': { projects: (multi.cc.projects || []).length, sessions: (multi.cc.sessions || []).length },
        codex: { projects: (multi.cx.projects || []).length, sessions: (multi.cx.sessions || []).filter(s => s.kind !== 'subagent').length },
        'kimi-code': { projects: (multi.km.projects || []).length, sessions: (multi.km.sessions || []).length },
      },
    })));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/open') {
    if (plugin.available) {
      let body0 = '';
      req.on('data', c => { body0 += c; });
      req.on('end', async () => {
        let sessionId0 = ''; try { sessionId0 = String(JSON.parse(body0).sessionId || ''); } catch {}
        const r = await pluginRequest('POST', '/open', { sessionId: sessionId0 }, 6000).catch(e => ({ status: 0, json: { ok: false, detail: String(e.message || e) } }));
        res.writeHead(r.status || 502, { 'content-type': 'application/json' });
        res.end(JSON.stringify(Object.assign({ via: 'plugin' }, r.json)));
      });
      return;
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      let sessionId = '';
      try { sessionId = String(JSON.parse(body).sessionId || ''); } catch {}
      // 跨源定位（M-C）+ 控制分发：CLI 后端直接在 Terminal 续接（M-D/M-E/M-H）；DSH 维持原口径
      const found = sessionId ? resolveSessionAny(sessionId) : null;
      if (found && CLI_TARGETS[found.source]) {
        const r = await openCliSession(found.source, found);
        res.writeHead(r.ok ? 200 : 502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: r.ok, via: 'terminal',
          session: { sessionId: found.sessionId, title: found.title, source: found.source, cwd: found.cwd },
          opened: !!r.opened,
          reason: r.ok ? undefined : 'Terminal 打开失败',
          detail: r.detail || r.via,
        }));
        return;
      }
      const reason = !found ? '未找到该会话'
        : '目录中已定位该会话；切换实时跟随需要 DSH 插件授权（canOpen 能力位）';
      res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: !!found, session: found,
        opened: false,
        reason,
        howto: '见 demo/README.md「打开已存在会话 / 新建会话」',
      }));
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/new') {
    let body0 = '';
    req.on('data', c => { body0 += c; });
    req.on('end', async () => {
      let payload0 = {};
      try { payload0 = JSON.parse(body0); } catch {}
      const cwd = String(payload0.cwd || '');
      // ⓪ CLI 后端（M-D/M-E/M-H 控制层）：tmux 在跑开 window，否则 Terminal 新窗口（可见、可交互）
      if (payload0.source && CLI_TARGETS[payload0.source]) {
        const r = await newCliSession(payload0.source, cwd);
        res.writeHead(r.ok ? 200 : 502, { 'content-type': 'application/json' });
        res.end(JSON.stringify(Object.assign({ ok: r.ok, via: r.ok ? r.via : undefined, error: r.error, detail: r.detail }, r.ok ? { note: '已在终端打开新会话；目录将在几秒内出现' } : {})));
        return;
      }
      // ① DSH：插件进程内创建（需授权挂载）
      if (plugin.available) {
        // workspaceRegistry.create 对不存在的目录会失败（→ 会话落不进项目）→ 这里先把目录建出来
        if (cwd && !fs.existsSync(cwd)) {
          try { fs.mkdirSync(cwd, { recursive: true }); } catch { /* 无权限等：交给插件报错 */ }
        }
        const r = await pluginRequest('POST', '/new', { cwd, model: payload0.model, reasoningEffort: payload0.reasoningEffort }, 8000).catch(e => ({ status: 0, json: { ok: false, detail: String(e.message || e) } }));
        res.writeHead(r.status || 502, { 'content-type': 'application/json' });
        res.end(JSON.stringify(Object.assign({ via: 'plugin' }, r.json)));
        return;
      }
      res.writeHead(501, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: false, error: 'not-authorized',
        reason: '新建 DSH 会话需要在 DSH 进程内完成（Cordis 插件），当前未授权挂载；不得使用 DSH 凭证绕过。Claude Code / Codex / Kimi Code 的新建可用（请求带 source 字段即走终端通道）',
        requested: { cwd, agentName: payload0.agentName || 'DSH', model: payload0.model || null, reasoningEffort: payload0.reasoningEffort || null },
        howto: '见 demo/README.md「打开已存在会话 / 新建会话」与 docs/52-session-catalog.md 的能力矩阵',
      }));
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/agents') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(agentStatus));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(snapshot()));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('data: ' + JSON.stringify(snapshot()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/input') {
    let body = '';
    let oversized = false;
    req.on('data', c => {
      body += c;
      if (!oversized && Buffer.byteLength(body) > 8192) {   // 契约 §2.3 口径=8192 UTF-8 字节；回 413 而不是裸断连
        oversized = true;
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'oversized', detail: '输入超过 8192 字节上限' }));
        setTimeout(() => { try { req.destroy(); } catch {} }, 50);
      }
    });
    req.on('end', async () => {
      if (oversized) return;
      let text = '', askedTarget = '';
      try { const b = JSON.parse(body); text = String(b.text || ''); askedTarget = String(b.sessionId || '').trim(); } catch { text = String(body).trim(); }
      text = text.trim();
      if (!text) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'empty' })); return; }
      const t = resolveTarget(askedTarget || null);
      if (t.error) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'unknown-session', detail: t.error })); return; }
      const item = await deliverInput(text.slice(0, 2000), t.id, t.source);
      // ok=真正送达；queued(202)=已入队无通道；failed(502)=投递失败。不再一律 ok:true（qa A-6）
      const code = item.status === 'delivered' ? 200 : item.status === 'queued' ? 202 : 502;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: item.status === 'delivered', item }));
    });
    return;
  }
  // ---------- 队列生命周期（qa A-1：删除单条 / 清空 / 重发） ----------
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/input/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/input/'.length));
    const n = id ? removeInputs(i => i.id === id) : 0;
    broadcast();
    res.writeHead(n ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(n ? { ok: true, removed: n } : { ok: false, error: 'not-found' }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/queue/clear') {
    const n = removeInputs(() => true);
    broadcast();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cleared: n }));
    return;
  }
  const mResend = url.pathname.match(/^\/api\/input\/([^/]+)\/resend$/);
  if (req.method === 'POST' && mResend) {
    const id = decodeURIComponent(mResend[1]);
    const orig = readInputFile().find(i => i.id === id);
    if (!orig) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'not-found' })); return; }
    const fresh = await deliverInput(orig.text, orig.sessionId || null);
    const removedOriginal = fresh.status === 'delivered' ? removeInputs(i => i.id === id) > 0 : false;
    broadcast();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: fresh.status === 'delivered', item: fresh, removedOriginal }));
    return;
  }
  res.writeHead(404); res.end('not found');
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('悬浮窗服务已启动： http://127.0.0.1:' + PORT + '/');
  console.log('  会话日志： ' + (findSessionLog(SESSION)?.file ?? '（未找到）'));
  console.log('  输入通道： ' + (INPUT_CMD ? 'PET_INPUT_CMD（自动投递）' : '手动队列（未配置 PET_INPUT_CMD）'));
  startFollower();
  connectPlugin();   // 若 DSH 插件已挂载：进程内事件 + 直接投递
  // M-A/M-B/M-H：Claude Code / Codex / Kimi Code 的多文件观察跟随（增量 tail → 同一个状态机）
  const ccFollow = followClaudeLogs({ onEvent: applyEvent });
  const cxFollow = followCodexLogs({ onEvent: applyEvent });
  const kmFollow = followKimiLogs({ onEvent: applyEvent });
  console.log('  观察通道： DSH=日志tail/插件 · Claude Code=转录tail · Codex=rollout tail · Kimi Code=wire.jsonl tail（M-H A 路径）');
  console.log('  控制通道： ' + (cliChannelsCache().map((c) => c.name + '(' + c.bin + ')').join(' · ') || '无（CLI 不在 PATH）') + '；投递=tmux/无头续会话，新建/打开=Terminal 窗口');
  refreshAgentStatus();
  setInterval(refreshAgentStatus, 3000);   // 软件四态（ps + mtime 探测，实测 ~40ms）
});
export { snapshot, deliverInput };
