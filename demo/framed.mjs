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
 *        ├─ DSH 插件不可用时留在本地队列，不通过外部命令猜测目标
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
import { scanCatalog, readWorkspaceIndex, DSH_HOME } from '../adapters/session-catalog.mjs';
import { scanLocalAgents } from '../adapters/local-agents.mjs';
import { scanClaudeCatalog, followClaudeLogs, SOURCE as CC_SOURCE } from '../adapters/claude-code-adapter.mjs';
import { scanCodexCatalog, followCodexLogs, SOURCE as CX_SOURCE } from '../adapters/codex-adapter.mjs';
import { scanKimiCatalog, followKimiLogs, SOURCE as KM_SOURCE } from '../adapters/kimi-code-adapter.mjs';
import { scanZcodeCatalog, followZcodeLogs, SOURCE as ZC_SOURCE } from '../adapters/zcode-adapter.mjs';
import { scanAllUsage, serializeUsageScan, usageCalendar } from '../adapters/usage-collect.mjs';
import { CLI_TARGETS, availableCliChannels, deliverControl, deliverCreateViaCli, deliverCreateViaZcodePipe, openCliSession, resolveCliBin, recoverZcodePendingRollbacks } from '../adapters/cli-control.mjs';
import { loadModelRegistry, validateModelSelection } from '../adapters/model-registry.mjs';
import net from 'node:net';
import crypto from 'node:crypto';

/** 多源会话目录（M-C）：DSH（workspace 注册表）+ Claude Code（目录即项目）+ Codex（session_meta.cwd 归并）+ ZCode（sqlite session.path）。 */
const SOURCE_LABEL = { dsh: 'DSH', 'claude-code': 'Claude Code', codex: 'Codex', 'kimi-code': 'Kimi Code', zcode: 'ZCode' };

// Codex 桌面端任务工作目录（~/Documents/Codex/<日期>/<任务名>，每任务一个一次性目录）：
// 按 cwd 归并会让侧栏出现大量单会话「项目」（he / qi / jian / xia …）——统一折叠为一个「Codex 任务目录」组
const CODEX_TASKS_ROOT = process.env.CODEX_TASKS_ROOT || path.join(process.env.HOME || '.', 'Documents', 'Codex');
export const CODEX_TASKS_KEY = 'codex:tasks';
/** 仅 codex 来源、且 cwd 落在任务目录约定下才算（claude/kimi 在同目录开的会话仍是自己的项目） */
export function isCodexTaskCwd(source, cwd) {
  if (source !== 'codex' || typeof cwd !== 'string' || !cwd) return false;
  return cwd === CODEX_TASKS_ROOT || cwd.startsWith(CODEX_TASKS_ROOT + path.sep);
}

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
      plugin.info = {
        ...r.json,
        canOpen: r.json.canOpen ?? caps.canOpen,
        canCreate: r.json.canCreate ?? caps.canCreate,
        modelSelection: r.json.modelSelection || r.json.defaultModel || null,
      };
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
const PET_DIR = path.join(process.env.HOME || '.', '.agent-pet');
const INPUT_LOG = path.join(PET_DIR, 'input-queue.jsonl');
const INPUT_MAX_ITEMS = 200;      // 队列条目上限：超出丢弃最旧（补上架构文档 §4 缺失的轮转规格）
const INPUT_MAX_BYTES = 1 << 20;  // 1MB 硬上限（单条 ≤2000 字符，正常远达不到）
const HTML_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.join(HTML_DIR, 'assets');
// Keep the user's CLI priority; append bundled Node for shebangs if absent.
const runtimeDir = path.dirname(process.execPath);
if (!(process.env.PATH || '').split(path.delimiter).includes(runtimeDir))
  process.env.PATH = (process.env.PATH ? process.env.PATH + path.delimiter : '') + runtimeDir;
const BOOT_TS = Date.now();
/** 页面构建号 = max(服务启动时间, 页面文件 mtime)：服务重启或 HTML 更新后，旧页面自行刷新（页面响应 no-store）。 */
function pageBuild(file) { try { return Math.max(BOOT_TS, fs.statSync(file).mtimeMs); } catch { return BOOT_TS; } }

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
      // targetKey = 按会话分队列的组键：sess:<id>（既有会话）| new:<source>:<cwd>（待新建）。
      // 旧条目（2026-10-08 之前无 targetKey/source 字段）在此迁移，老队列文件无需手工处理。
      try {
        const o = JSON.parse(l);
        out.push({
          id: o.id, text: o.text, at: o.at, status: o.status, detail: o.detail,
          sessionId: o.sessionId ?? null,
          source: o.source ?? null, model: o.model ?? '', reasoningEffort: o.reasoningEffort ?? '', accepted: !!o.accepted,
          targetKey: o.targetKey ?? (o.sessionId ? 'sess:' + o.sessionId : 'new:dsh:-'),
        });
      } catch { /* 坏行跳过 */ }
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
if (state.inputs.some(i => i.status === 'pending')) {
  state.inputs = state.inputs.map(i => i.status === 'pending'
    ? { ...i, status: 'failed', accepted: !!i.accepted,
      detail: '服务在投递期间重启，结果未确认；请先查看目标会话，再决定是否重发' }
    : i);
  try { writeInputFile(state.inputs); } catch { /* 内存状态仍可供用户检查 */ }
}
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
// 多源目录缓存：DSH + Claude Code + Codex + Kimi Code + ZCode 五路扫描合并（各 ~20ms / zcode ~90ms，5s 复用）
let multiCache = { at: 0, data: null };
function multiCatalog(force) {
  if (force || !multiCache.data || Date.now() - multiCache.at > 5000) {
    const dsh = catalog(force);
    let cc = { projects: [], sessions: [], elapsedMs: 0 };
    let cx = { projects: [], sessions: [], elapsedMs: 0 };
    let km = { projects: [], sessions: [], elapsedMs: 0 };
    let zc = { projects: [], sessions: [], elapsedMs: 0 };
    try { cc = scanClaudeCatalog(); } catch (e) { cc = { projects: [], sessions: [], elapsedMs: 0, error: String(e.message).slice(0, 120) }; }
    try { cx = scanCodexCatalog(); } catch (e) { cx = { projects: [], sessions: [], elapsedMs: 0, error: String(e.message).slice(0, 120) }; }
    try { km = scanKimiCatalog(); } catch (e) { km = { projects: [], sessions: [], elapsedMs: 0, error: String(e.message).slice(0, 120) }; }
    try { zc = scanZcodeCatalog(); } catch (e) { zc = { projects: [], sessions: [], elapsedMs: 0, error: String(e.message).slice(0, 120) }; }
    multiCache = { at: Date.now(), data: { dsh, cc, cx, km, zc, elapsedMs: Math.round(((dsh.elapsedMs || 0) + (cc.elapsedMs || 0) + (cx.elapsedMs || 0) + (km.elapsedMs || 0) + (zc.elapsedMs || 0)) * 100) / 100 } };
  }
  return multiCache.data;
}
const sessionStates = new Map(); // sessionId -> 来自目录的粗粒度状态（无实时事件时用）

// ---------- Token 用量慢缓存（60s；与 5s 目录缓存分离——usage 需全文件精确累计） ----------
// 首轮全量 ~2s（本机 1.1GB 转录）；文件级增量（size+mtime）让后续轮次只重读有增长的文件。
let usageCache = { at: 0, busy: false, data: null };
async function refreshUsage() {
  if (usageCache.busy) return;
  usageCache.busy = true;
  try {
    usageCache.data = await scanAllUsage();
    usageCache.at = Date.now();
  } catch (e) {
    usageCache.data = usageCache.data ?? { overview: null, cc: null, cx: null, km: null, zc: null, error: String(e?.message || e).slice(0, 120) };
  } finally { usageCache.busy = false; }
  broadcast();                                          // 扫描完成立刻推新快照（不等 2s 心跳）
}

// ---------- 进行中口径（修复「N 进行」误报，2026-10-06）----------
// 实时会话表只增不减：进程被杀/会话结束后，running/thinking 会永远滞留（曾导致已完成会话被计入「进行」）。
// 目录扫描 ≤5s 刷新且各适配器自带 5min 滞留修正 → 进行中状态需要近期事件佐证，否则信目录结论。
// waiting / transient-error 不受时间限制（对齐前端规则①：等审批的会话一直在进行中）。
const STALE_MS = 300_000;
const TIMED_PROGRESS = new Set(['thinking', 'running', 'working']);
const PINNED_PROGRESS = new Set(['waiting', 'transient-error', 'delegated']);   // delegated=等待子代理（宿主停、子代理跑）
const isProgressState = (st) => TIMED_PROGRESS.has(st) || PINNED_PROGRESS.has(st);
/** 实时行的有效状态：滞留的进行中状态按目录结论修正（目录无结论则降 idle；ended 归入 UI 的 done 词汇）。 */
function effectiveState(s, meta, nowMs) {
  if (TIMED_PROGRESS.has(s.state) && nowMs - (s.lastAt || 0) > STALE_MS) {
    const m = meta?.state;
    if (m && m !== 'unknown' && !TIMED_PROGRESS.has(m)) return m === 'ended' ? 'done' : m;
    return 'idle';
  }
  return s.state;
}

// CLI 控制通道缓存（PATH 探测 60s 缓存，避免每 2s 快照都查）
let cliChannelsCacheData = { at: 0, data: null };
function cliChannelsCache() {
  if (!cliChannelsCacheData.data || Date.now() - cliChannelsCacheData.at > 60_000) {
    try { cliChannelsCacheData = { at: Date.now(), data: availableCliChannels() }; }
    catch { cliChannelsCacheData = { at: Date.now(), data: [] }; }
  }
  return cliChannelsCacheData.data;
}

function modelRegistrySnapshot(force = false) {
  const selection = plugin.info?.modelSelection || null;
  const canCreate = plugin.available && !!(plugin.info && ((plugin.info.capabilities || {}).canCreate ?? plugin.info.canCreate));
  const catalog = Array.isArray(plugin.info?.modelCatalog) ? plugin.info.modelCatalog : null;
  return loadModelRegistry({ dshSelection: selection, dshCanCreate: canCreate, dshCatalog: catalog, force });
}

/**
 * 新建会话的工作目录约束（用户定向 2026-10-09）：只允许该 Agent 软件自己有主会话的项目文件夹，
 * 与 UI 对话框的选项集合同源（snapshot().catalog.projects 中 sources 含该来源且目录仍存在的项目）。
 * /api/new、/api/input 的 new: 兼容入口与队列重试在执行前统一经过这里——不再接受任意路径、
 * 也不再为不存在的目录 mkdir。
 */
function validateCreateCwd(source, cwd) {
  const value = String(cwd || '').trim();
  if (!value) return { ok: false, error: 'cwd-required', detail: '新建会话必须选择该 Agent 的项目文件夹作为工作目录' };
  const allowed = ((snapshot().catalog || {}).projects || [])
    .filter(p => p.cwd && !p.dead && (p.sources || []).includes(source))
    .map(p => p.cwd);
  if (!allowed.includes(value)) {
    return {
      ok: false, error: 'cwd-not-registered',
      detail: '工作目录只能选该 Agent 项目列表中的文件夹'
        + (allowed.length ? '（可选：' + allowed.slice(0, 3).join('、') + (allowed.length > 3 ? ' 等 ' + allowed.length + ' 个' : '') + '）' : '（该 Agent 暂无项目文件夹）'),
    };
  }
  return { ok: true };
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
  s.lastAt = Date.now();          // 最后一次收到该会话事件的时间（活跃窗口判定用）
  s.since = s.since ?? ev.ts;
  if (ev.data?.workspace) { s.label = String(ev.data.workspace).split('/').pop(); s.cwd = ev.data.workspace; }
  if (ev.data?.origin) s.origin = ev.data.origin;   // 插件 session.start 带上 origin：子代理零延迟识别（不等 5s 目录刷新）
  if (ev.data?.parentSessionId) s.parentSessionId = String(ev.data.parentSessionId);   // 子代理 → 宿主关联（插件可选携带；缺失时按项目兜底）
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
  const nowMs = Date.now();
  const multi = multiCatalog(false);
  const cat = multi.dsh;
  const ws = workspaceIndex(false);
  // ---- Token 用量：慢缓存 → 会话行附带 + 全局 usage 块（首轮未完成时 {pending:true}）----
  const usage = usageCache.data;
  const usageBySid = new Map();                          // 'source:sessionId' → 扁平 usage（源内会话 id 不重复）
  if (usage) for (const sc of [usage.dsh, usage.cc, usage.cx, usage.km, usage.zc]) {
    if (sc?.bySession) for (const [sid, r] of sc.bySession) usageBySid.set((sc.source ?? '') + ':' + sid, r);
  }
  const usageOf = (source, sid) => {
    const r = usageBySid.get((source ?? '') + ':' + sid);
    return r && (r.input || r.output || r.cacheRead || r.cacheWrite || r.requests)
      ? { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, requests: r.requests }
      : undefined;
  };
  // 跨源元信息表：sessionId → 目录记录（claude/codex/kimi 记录自带 source / agentName / model）
  const metaById = new Map();
  for (const p of cat.projects || []) for (const s of p.sessions || []) metaById.set(s.sessionId, s);
  for (const p of multi.cc.projects || []) for (const s of p.sessions || []) metaById.set(s.sessionId, s);
  for (const p of multi.cx.projects || []) for (const s of p.sessions || []) metaById.set(s.sessionId, s);
  for (const p of multi.km.projects || []) for (const s of p.sessions || []) metaById.set(s.sessionId, s);
  for (const p of multi.zc.projects || []) for (const s of p.sessions || []) metaById.set(s.sessionId, s);
  // 子代理判定：插件 session.start 的 origin 立即可判（零延迟）；目录 kind 兜底（≤5s 滞后）
  const isSubagent = (id, s) => s?.origin === 'subagent' || (metaById.get(id)?.kind || 'main') === 'subagent';
  // projectKey：DSH 注册表优先；claude/codex 按 cwd 归并进同目录 workspace；Codex 任务目录折叠为一组；都不中 → 'path:<cwd>'（M-C）
  const keyOfSession = (id, row) => {
    const wid = ws.sessionOwner.get(id);
    if (wid) return wid;
    const meta = metaById.get(id);
    const cwd = meta?.cwd ?? row?.cwd ?? null;
    if (cwd) { const w = ws.byPath.get(cwd); if (w) return w; }
    if (isCodexTaskCwd(row?.source ?? meta?.source ?? '', cwd)) return CODEX_TASKS_KEY;
    return cwd ? 'path:' + cwd : '__none__';
  };
  // 实时区 TTL：非进行中且 24h 无事件的会话从实时区退役（目录历史区仍在；防常驻内存无限增长）
  const RETIRE_MS = 24 * 3600_000;
  for (const [id, s] of state.sessions) {
    if (isProgressState(effectiveState(s, metaById.get(id), nowMs))) continue;
    if (nowMs - (s.lastAt || 0) > RETIRE_MS) {
      state.sessions.delete(id);
      const i = state.order.indexOf(id); if (i >= 0) state.order.splice(i, 1);
    }
  }
  // 实时区保留进行中的全部会话——隐藏由 UI 手动触发（用户反馈：要手动隐藏，不要自动退场）
  // ---- 子代理活跃度：宿主暂时停住（idle/done）但子代理仍在跑 → 宿主必须保持活跃 ----
  // 关联两级：① parentSessionId 精确匹配（codex parent_thread_id / zcode parent_id；DSH 插件可选携带）；
  //          ② 同 projectKey 兜底（DSH 插件未带 parent：子代理与宿主共享同一 workspace/cwd）。
  // 滞留宽容：各适配器的 5min 滞留修正会把「正在跑长任务但安静」的子代理打成 idle（如 zcode 子代理
  // 执行超过 5 分钟的命令期间不写库）——归因一旦丢失，宿主立刻翻回 已完成（用户可见的误判）。
  // 宽容窗口（15min）内仍视为运行；超过则信目录结论（真死了）。
  const SUB_STALE_TOLERANCE_MS = 15 * 60_000;
  const subRunningLive = (s, meta, nowMs) => {
    if (isProgressState(s.state) || isProgressState(effectiveState(s, meta, nowMs))) return true;
    return TIMED_PROGRESS.has(s.state) && nowMs - (s.lastAt || 0) <= SUB_STALE_TOLERANCE_MS;
  };
  const subRunningCatalog = (s, nowMs) => {
    if (isProgressState(s.state)) return true;
    return s.state === 'idle' && String(s.stateSource || '').includes('stale>5min') && nowMs - (s.updatedAt ?? 0) <= SUB_STALE_TOLERANCE_MS;
  };
  const subActiveByParent = new Map();
  const subActiveByProject = new Map();
  const noteSubagent = (parent, projectKey, running, lastMs) => {
    if (!running) return;
    if (parent) { const e = subActiveByParent.get(parent) || { running: 0, lastMs: 0 }; e.running++; e.lastMs = Math.max(e.lastMs, lastMs || 0); subActiveByParent.set(parent, e); }
    if (projectKey) { const e = subActiveByProject.get(projectKey) || { running: 0, lastMs: 0 }; e.running++; e.lastMs = Math.max(e.lastMs, lastMs || 0); subActiveByProject.set(projectKey, e); }
  };
  for (const [id, s] of state.sessions) {   // ① DSH 插件事件区：子代理行原本在 live 组装时被直接丢弃
    if (!isSubagent(id, s)) continue;
    noteSubagent(s.parentSessionId ?? metaById.get(id)?.parentSession ?? null, keyOfSession(id, s), subRunningLive(s, metaById.get(id), nowMs), s.lastAt ?? s.since ?? 0);
  }
  for (const sc of [multi.dsh, multi.cc, multi.cx, multi.km, multi.zc]) {   // ② 目录扫描：五源子代理行自带 parentSession + 粗粒度状态（DSH 曾漏扫——插件未挂载时宿主归因完全丢失）
    for (const s of (sc?.sessions || [])) {
      if (s.kind !== 'subagent') continue;
      noteSubagent(s.parentSession ?? null, keyOfSession(s.sessionId, s), subRunningCatalog(s, nowMs), s.updatedAt ?? 0);
    }
  }
  const live = state.order.map(id => state.sessions.get(id)).filter(Boolean).filter(s => !isSubagent(s.id, s)).map(s => {
    const meta = metaById.get(s.id) || {};
    const projectKey = keyOfSession(s.id, s);
    const sub = subActiveByParent.get(s.id) || subActiveByProject.get(projectKey) || null;
    const st0 = effectiveState(s, meta, nowMs);
    // 宿主停住但子代理在跑 → 状态显示「等待子代理」（不再是 空闲/已完成）
    const delegated = sub && (st0 === 'idle' || st0 === 'done');
    // 标签：真实标题 → 事件标签；事件标签若就是 cwd 目录名（= 项目名）则视为无标题，不冒充
    const label0 = meta.title || s.label;
    const label = label0 && label0 === path.basename(String(meta.cwd || s.cwd || '')) ? '（未命名）' : label0;
    return {
      id: s.id, source: s.source, label, state: delegated ? 'delegated' : st0,
      cwd: meta.cwd || s.cwd || null, projectKey,
      since: s.since, pending: s.pending, activity: delegated ? '等待子代理完成' : s.activity,
      elapsedMs: nowMs - s.since,
      lastActiveMs: s.lastAt ?? s.since,
      agentName: meta.agentName || SOURCE_LABEL[s.source] || 'DSH', model: meta.model || null, reasoningEffort: meta.reasoningEffort || null,
      variant: meta.variant || null,
      agentPreset: meta.agentPreset || null, title: meta.title || null, kind: 'main', live: true,
      subagentRunning: sub ? sub.running : 0, subagentLastMs: sub ? sub.lastMs : null,
      usage: usageOf(s.source ?? 'dsh', s.id),
    };
  });
  const liveIds = new Set(live.map(s => s.id));
  const liveRowById = new Map(live.map(s => [s.id, s]));
  // 进行中判定：实时行用修正后的有效状态；未被实时跟随的会话用目录粗粒度（各适配器自带 5min 滞留修正）
  // 宿主暂时停止（idle/done）但子代理仍在跑 → delegated（等待子代理）：计进行中；聚合并入「运行中」
  const hostStateOf = (s) => (Number(s.subagentRunning) > 0 && (s.state === 'idle' || s.state === 'done')) ? 'delegated' : s.state;
  // 非实时宿主同样要吃 delegated 修正：目录粗状态 done/idle/ended + 子代理在跑 = 进行中
  //（曾只修正实时行 → 侧栏 liveCount 漏计「等待子代理」的历史区宿主，与行内徽标自相矛盾）
  const inProgressOf = (sid, meta) => {
    const r = liveRowById.get(sid);
    if (r) return isProgressState(hostStateOf(r));
    const st = (meta || {}).state;
    if (st === 'idle' || st === 'done' || st === 'ended') return !!subActiveByParent.get(sid);
    return isProgressState(st);
  };
  // 聚合状态改用修正后的实时行计算（hub.agg() 是另一套状态机，曾出现「新建空闲会话 agg=思考中」的不一致）
  const AGG_PRIORITY = { waiting: 5, 'transient-error': 4, error: 3, working: 2, running: 2, delegated: 2, thinking: 1, done: 0, idle: -1 };
  let agg = 'idle';
  for (const s of live) { const st = hostStateOf(s); const aggSt = st === 'delegated' ? 'running' : st; if ((AGG_PRIORITY[aggSt] ?? -1) > (AGG_PRIORITY[agg] ?? -1)) agg = aggSt; }
  // 当前状态计数（顶部 chips 用；counters 是累计事件数，只作诊断，不能再当“当前 N 个在跑”展示）
  const stateCounts = { thinking: 0, running: 0, delegated: 0, waiting: 0, errors: 0, done: 0 };
  for (const s of live) {
    const st = hostStateOf(s);
    if (st === 'thinking') stateCounts.thinking++;
    else if (st === 'running' || st === 'working') stateCounts.running++;
    else if (st === 'delegated') stateCounts.delegated++;
    else if (st === 'waiting') stateCounts.waiting++;
    else if (st === 'error' || st === 'transient-error') stateCounts.errors++;
    else if (st === 'done' && nowMs - (s.since || 0) <= 600_000) stateCounts.done++;
  }

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
      const isTask = isCodexTaskCwd(s.source, s.cwd);
      const key = isTask ? CODEX_TASKS_KEY : 'path:' + (s.cwd ?? '(未知目录)');
      if (!orphanByCwd.has(key)) orphanByCwd.set(key, isTask ? { cwd: CODEX_TASKS_ROOT, rows: [], name: 'Codex 任务目录' } : { cwd: s.cwd, rows: [] });
      orphanByCwd.get(key).rows.push(s);
    }
  };
  for (const s of multi.cc.sessions || []) collectExtra(s);
  for (const s of multi.cx.sessions || []) collectExtra(s);
  for (const s of multi.km.sessions || []) collectExtra(s);
  for (const s of multi.zc.sessions || []) collectExtra(s);

  const sidebarProjects = [];
  const listed = new Set();
  // DSH 磁盘扫描：会话成员的唯一真相源是磁盘（docs/52 §1.2：workspace.json 的 sessionIds
  // 只登记「GUI 里打开过」的子集——本机 21 个磁盘会话只登记 3 个——不能当成员口径）。
  /** 取磁盘项目中尚未列出的主会话（按更新时间倒序），并标记为已列出。 */
  const takeDiskMains = (p) => !p ? [] : (p.sessions || [])
    .filter(s => s.kind !== 'subagent' && !ws.archived.has(s.sessionId) && !listed.has(s.sessionId))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map(s => { listed.add(s.sessionId); return s; });
  /** 组装侧栏项目组：计数与会话行同源；liveCount = 有效状态为「进行中」的会话数（不是 mtime 近 60s）。 */
  const projByKey = new Map();
  const mkProject = (base, rows) => {
    const proj = {
      ...base,
      sessionCount: rows.length, mainCount: rows.length, subagentCount: 0,
      liveCount: rows.filter(r => inProgressOf(r.sessionId, r)).length,
      sources: [...new Set(rows.map(r => r.source || 'dsh'))],
      sessions: rows,
    };
    sidebarProjects.push(proj);
    projByKey.set(proj.key, proj);
    return proj;
  };
  for (const wid of ws.order) {
    const w = ws.byId.get(wid);
    if (!w) continue;
    const rows = [];
    for (const sid of w.sessionIds) {            // 已登记会话保持注册表顺序（= DSH GUI 侧栏顺序）
      if (ws.archived.has(sid) || listed.has(sid)) continue;
      const meta = metaById.get(sid);
      if (!meta || meta.kind === 'subagent') continue;
      listed.add(sid);
      rows.push(meta);
    }
    // 合并磁盘扫描中属于本项目、但未登记进 workspace.json 的会话（展示 agent 软件内的全部会话）；
    // 按 workspaceId 或 cwd 匹配，且遍历全部磁盘项目（目录名解码有损，理论上可能多项目同 cwd）
    for (const p of cat.projects || []) {
      if (p.workspaceId === wid || (p.cwd && p.cwd === w.path)) rows.push(...takeDiskMains(p));
    }
    const extras = (extraByWorkspace.get(wid) || []).filter(e => !listed.has(e.sessionId))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    for (const e of extras) { listed.add(e.sessionId); rows.push(e); }
    mkProject({ key: wid, projectId: wid, workspaceId: wid, name: w.title, title: w.title, cwd: w.path }, rows);
  }
  // DSH 磁盘上未注册为 workspace 的项目：各自成组（与 claude/codex 的 cwd 自立组同口径），
  // 不再混进末尾「未归入项目」（曾把 desktop / selftest 等独立项目的 19 个会话揉成一团）
  for (const p of [...(cat.projects || [])].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))) {
    if ((p.workspaceId && ws.byId.has(p.workspaceId)) || (p.cwd && ws.byPath.has(p.cwd))) continue;
    const rows = takeDiskMains(p);
    if (!rows.length) continue;
    mkProject({
      key: p.cwd ? 'path:' + p.cwd : 'dshproj:' + p.projectDirName,   // 与 keyOfSession 的 path:<cwd> 口径一致
      projectId: p.projectId, workspaceId: null, name: p.title, title: p.title, cwd: p.cwd ?? null, diskOnly: true,
    }, rows);
  }
  // 未挂靠任何 workspace / DSH 项目的 claude/codex/kimi 会话组（cwd 自立；与已有 DSH 磁盘组同 key 时合并）
  for (const [key, g] of orphanByCwd) {
    const rows = g.rows.filter(r => !listed.has(r.sessionId)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    if (!rows.length) continue;
    for (const r of rows) listed.add(r.sessionId);
    const existing = projByKey.get(key);
    if (existing) {
      existing.sessions.push(...rows);
      existing.sessionCount = existing.sessions.length;
      existing.mainCount = existing.sessions.length;
      existing.liveCount = existing.sessions.filter(r => inProgressOf(r.sessionId, r)).length;
      existing.sources = [...new Set(existing.sessions.map(r => r.source || 'dsh'))];
      continue;
    }
    const name = g.name || (g.cwd ? path.basename(g.cwd) : '（未知目录）');
    mkProject({ key, projectId: key, workspaceId: null, name, title: name, cwd: g.cwd, unregistered: false }, rows);
  }
  // 兜底：理论上磁盘会话都已被上面的项目组收编；收不完的（如无 cwd 的降级记录）进「未归入项目」
  const unregistered = (cat.sessions || [])
    .filter(s => s.kind !== 'subagent' && !ws.archived.has(s.sessionId) && !ws.sessionOwner.has(s.sessionId) && !listed.has(s.sessionId))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  if (unregistered.length) {
    mkProject({
      key: '__none__', projectId: '__none__', workspaceId: null, name: '未归入项目', title: '未归入项目', cwd: null, unregistered: true,
    }, unregistered.slice(0, 100));
  }

  // ---- 项目列表后处理（冗余治理，2026-10-06）----
  // ① 同名消歧：撞名时追加父目录名（Codex 的 ~/Documents/Codex/<date>/<name> 目录会产出多个同名项目，如两个 jian）
  // ② 临时/已删目录标记：/tmp、/var/folders、~/.dsh/profiles 下的项目属临时痕迹；cwd 已不存在 = 死目录
  // ③ 排序：workspace 组保持注册表顺序；其余正常组按更新时间倒序；临时/已删/兜底组沉底
  const profRoot = path.join(DSH_HOME, 'profiles');
  for (const p of sidebarProjects) {
    p.updatedAt = (p.sessions || []).reduce((m, s) => Math.max(m, s.updatedAt ?? 0), 0);
    p.cwdExists = p.cwd ? fs.existsSync(p.cwd) : true;
    p.scratch = !!(p.cwd && (/^\/(private\/)?tmp(\/|$)/.test(p.cwd) || p.cwd.startsWith('/var/folders/') || p.cwd === profRoot || p.cwd.startsWith(profRoot + path.sep) || p.cwd === CODEX_TASKS_ROOT));
  }
  const nameCount = new Map();
  for (const p of sidebarProjects) nameCount.set(p.name, (nameCount.get(p.name) || 0) + 1);
  for (const p of sidebarProjects) {
    if ((nameCount.get(p.name) || 0) > 1 && p.cwd) p.name = p.name + '（…/' + path.basename(path.dirname(p.cwd)) + '）';
    if (p.scratch) p.name = p.name + '（临时）';
  }
  sidebarProjects.sort((a, b) => {
    const rankOf = (p) => p.workspaceId ? 0 : (p.scratch || !p.cwdExists || p.key === '__none__') ? 2 : 1;
    const r = rankOf(a) - rankOf(b);
    if (r) return r;
    if (!a.workspaceId || !b.workspaceId) return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    return 0;   // workspace 组之间保持注册表顺序（V8 sort 稳定）
  });
  // 历史行（非实时）：跨源合并，按更新时间排，不截断（用户要求展示 agent 软件内的全部会话）
  // 注意：不再按 s.live（mtime<60s）排除——未被实时跟随的进行中会话否则会有 60 秒盲区，哪都不显示
  const history = sidebarProjects.flatMap(p => p.sessions)
    .filter(s => !liveIds.has(s.sessionId))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    // 历史行只按 parentSessionId 精确挂子代理（项目兜底会误伤同项目其它历史行；宿主若被实时跟随则本就在 live 区）
    .map(s => {
      const sub = subActiveByParent.get(s.sessionId) || null;
      const delegated = sub && (s.state === 'idle' || s.state === 'done' || s.state === 'ended');   // 宿主停、子代理跑 → 等待子代理
      return { ...s, source: s.source || 'dsh', state: delegated ? 'delegated' : s.state, projectKey: keyOfSession(s.sessionId, s), subagentRunning: sub ? sub.running : 0, subagentLastMs: sub ? sub.lastMs : null, usage: usageOf(s.source || 'dsh', s.sessionId) };
    });
  // 目录源宿主不被实时跟随 → 「等待子代理」出现在历史区：chips 与聚合同样计入（否则顶部显示 0、迷你条显示空闲）
  {
    const histDelegated = history.filter(h => h.state === 'delegated').length;
    if (histDelegated) {
      stateCounts.delegated += histDelegated;
      if ((AGG_PRIORITY.running ?? -1) > (AGG_PRIORITY[agg] ?? -1)) agg = 'running';
    }
  }
  return {
    v: 1, ts: Date.now(), agg,
    build: { window: pageBuild(path.join(HTML_DIR, 'window.html')), mini: pageBuild(path.join(HTML_DIR, 'mini.html')) },
    sessions: live,
    agents: (() => {
      const counts = {};
      const bump = (src, v) => { if (!v) return; counts[src] = counts[src] || {}; counts[src][v] = (counts[src][v] || 0) + 1; };
      for (const s of cat.sessions || []) { if (s.kind !== 'subagent' && s.variant) bump('dsh', s.variant); }   // 纯桌面软件：恒为 desktop 计数
      for (const s of multi.cc.sessions || []) bump('claude-code', s.variant);
      for (const s of multi.cx.sessions || []) bump('codex', s.variant);
      for (const s of multi.km.sessions || []) bump('kimi-code', s.variant);
      for (const s of multi.zc.sessions || []) { if (s.kind !== 'subagent') bump('zcode', s.variant); }   // 纯桌面软件：恒为 desktop 计数（子代理行不计）
      // CLI/桌面端拆行后（base+variantTag）：每行只带自己形态的会话计数
      // （claude 桌面行含 桌面+IDE；CLI 行只含 CLI；无拆行的软件——ZCode 纯桌面——整卡给全部形态计数）
      return (agentStatus.agents || []).map((a) => {
        const cnt = counts[a.base || a.source];
        let v = null;
        if (cnt) {
          if (a.variantTag === 'cli') v = cnt.cli ? { cli: cnt.cli } : null;
          else if (a.variantTag === 'desktop') v = { ...(cnt.desktop ? { desktop: cnt.desktop } : {}), ...(cnt.ide ? { ide: cnt.ide } : {}) };
          else v = cnt;
        }
        return { ...a, variants: v && Object.keys(v).length ? v : null };
      });
    })(),
    agentCounts: agentStatus.counts || {},
    counters: state.counters,
    stateCounts,
    usage: usage
      ? { generatedAt: usageCache.at, refreshing: usageCache.busy, ...usage.overview }
      : { pending: true },
    inputs: state.inputs.filter(i => i.status && i.status !== 'delivered').reverse(),
    lastEvent: state.lastEvent,
    inputChannel: (() => {
      const cli = cliChannelsCache();
      if (cli.length) return { mode: 'cli', detail: 'DSH 经本地队列（挂插件可直投）；Claude Code / Codex / Kimi Code 会话经各自 CLI 投递；ZCode 经桌面 App 内置引擎投递' };
      return { mode: 'manual', detail: '未配置输入通道：输入会进本地队列，点击可复制手动投递命令' };
    })(),
    catalog: {
      projects: sidebarProjects.map(p => ({
        key: p.key, projectId: p.projectId, name: p.name, cwd: p.cwd,
        sessionCount: p.sessionCount, mainCount: p.mainCount, subagentCount: p.subagentCount,
        liveCount: p.liveCount, unregistered: p.unregistered || false, diskOnly: p.diskOnly || false,
        dead: p.cwdExists === false, scratch: !!p.scratch, updatedAt: p.updatedAt || 0,
        sources: p.sources || ['dsh'],
      })),
      history,
      elapsedMs: multi.elapsedMs, scannedAt: cat.scannedAt,
      source: 'multi:disk-full+workspace-order+disk(claude-code,codex,kimi-code,zcode)',
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
    modelRegistry: modelRegistrySnapshot(),
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
  // 心跳广播不在这里：无 DSH 会话日志的机器上本函数会提前返回，2s 刷新（计时/相对时间）
  // 必须照常推送——见 listen 回调里的 setInterval(broadcast, 2000)（qa M4）。
}

// ---------- 输入投递 ----------
/** 跨源定位会话（支持前缀）：DSH / Claude Code / Codex / Kimi Code / ZCode 目录各查一遍，返回时附带所属项目。 */
function resolveSessionAny(sessionId, refresh = false) {
  const multi = multiCatalog(refresh);
  const hits = [multi.dsh, multi.cc, multi.cx, multi.km, multi.zc].flatMap(cat =>
    (cat.projects || []).flatMap(p => (p.sessions || [])
      .filter(s => s.sessionId === sessionId || String(s.sessionId).startsWith(sessionId))
      .map(s => ({ ...s, project: { projectId: p.projectId, cwd: p.cwd, name: p.name, title: p.title } }))));
  const exact = hits.filter(s => s.sessionId === sessionId);
  return (exact.length === 1 ? exact[0] : exact.length ? null : hits.length === 1 ? hits[0] : null);
}
/** 校验并归一化用户指定的投递目标：必须是已知**主**会话（支持 sessionId 前缀）。
 *  返回 {id,label,source} 或 {error}——source 供 deliverInput 路由（DSH=插件/队列；CLI 后端=cli-control）。 */
function resolveTarget(sessionId, refresh = false) {
  if (!sessionId) return { error: '请先选择明确的主会话，不能自动猜测投递目标' };
  const found = resolveSessionAny(sessionId, refresh);
  if (!found) return { error: '未找到会话 ' + String(sessionId).slice(0, 24) };
  if (found.kind === 'subagent') return { error: '「' + (found.title || found.sessionId.slice(0, 12)) + '」是子代理会话，不能作为投递目标' };
  return { id: found.sessionId, label: found.title, source: found.source || 'dsh' };
}
// ZCode 的模型覆盖直到回合终态才回滚，下一条需等 settle，不能只等 send accepted。
let zcodeDeliveryChain = Promise.resolve();
function settleZcodeInput(id, result) {
  const items = readInputFile();
  const index = items.findIndex(i => i.id === id && i.status === 'pending');
  if (index < 0) return;
  if (result.idle) items.splice(index, 1);
  else items[index] = { ...items[index], status: 'failed', accepted: true,
    detail: 'ZCode 回合未完成：' + (result.error || '未知错误') + '；请先核对目标会话中的消息' };
  try { writeInputFile(items); } catch { /* 磁盘不可写：内存态照常更新，服务不因落盘失败中断（qa M2） */ }
  state.inputs = items;
  broadcast();
}
async function deliverInput(text, targetId, targetSource, targetKey = null, model = '', opts = {}) {
  const isZcode = targetSource === 'zcode' || (typeof targetId === 'string' && targetId.startsWith('new:zcode:'));
  if (isZcode) {
    const run = () => deliverInputInner(text, targetId, targetSource, targetKey, model, opts);
    const next = zcodeDeliveryChain.then(run, run);
    zcodeDeliveryChain = next.then(async item => {
      if (!item.settle) return;
      const result = await item.settle;
      if (opts.record !== false) settleZcodeInput(item.id, result);
    }, () => {});
    return next;
  }
  return deliverInputInner(text, targetId, targetSource, targetKey, model, opts);
}
async function deliverInputInner(text, targetId, targetSource, targetKey = null, model = '', opts = {}) {
  // id 必须唯一：同毫秒两次发送若共用 id，删除/重发会误伤另一条
  // opts.record=false：重试/冲刷模式——只执行投递不落新队列条目（调用方按结果处理原条目），
  // 否则每次自动重试都会新建一条 queued，队列被自我复制刷满（2026-10-08 实测增殖到 200 上限）
  const record = opts.record !== false;
  const item = {
    id: 'in-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'),
    text, model, reasoningEffort: opts.reasoningEffort || '', at: Date.now(), status: 'pending', detail: '', accepted: false,
    sessionId: targetId || null,
    source: targetSource || null,
    targetKey: targetKey || (targetId && !String(targetId).startsWith('new:') ? 'sess:' + targetId : String(targetId || 'new:dsh:-')),
  };
  if (!targetId) {
    item.status = 'failed';
    item.detail = '未指定目标会话，消息未发送；请选择主会话后重试';
    if (record) upsertInput(item); broadcast(); return item;
  }
  // ⓪' 投递即新建：目标 new:<source>:<cwd>；ZCode 走精确 app-server 管道，其余 CLI 无头新建。
  if (typeof targetId === 'string' && targetId.startsWith('new:')) {
    const parts = targetId.split(':');
    const nSource = parts[1] || '';
    const nCwd = parts.slice(2).join(':') || '';
    item.targetKey = targetId;
    item.sessionId = null;
    item.source = nSource || null;
    if (CLI_TARGETS[nSource]) {
      // Revalidate at execution, including queued retries after the registry changes.
      const selection = validateModelSelection(modelRegistrySnapshot(), nSource, model, opts.reasoningEffort);
      if (selection.ok) item.model = selection.model.value;
      const cwdCheck = selection.ok ? validateCreateCwd(nSource, nCwd) : null;
      let r;
      if (!selection.ok) r = selection;
      else if (!cwdCheck.ok) r = cwdCheck;
      else {
        // V05 执行前落盘：新建+首条投递执行中被 kill -9/断电时，队列保留「结果未确认」记录
        if (record) { item.detail = '正在新建会话并投递首条消息…'; upsertInput(item); broadcast(); }
        r = nSource === 'zcode'
          ? await deliverCreateViaZcodePipe(nCwd, text, selection.model, { reasoningLevel: selection.reasoningEffort })
          : await deliverCreateViaCli(nSource, nCwd, text, selection.model, selection.reasoningEffort);
      }
      if (r.sessionId) { item.sessionId = r.sessionId; item.targetKey = 'sess:' + r.sessionId; }
      if (r.settle) Object.defineProperty(item, 'settle', { value: r.settle });
      if (r.ok) { item.status = r.settle ? 'pending' : 'delivered'; item.accepted = true; item.detail = 'via ' + r.via; }
      else if (r.error === 'cli-not-found') { item.status = 'queued'; item.detail = '已入队（' + r.detail + '）：CLI 可用后自动重试投递即新建'; }
      else { item.status = 'failed'; item.accepted = !!r.accepted; item.detail = '新建/首条消息失败：' + (r.detail || r.error) + (r.sessionId ? '；会话已存在，请向该会话重发' : ''); }
    } else {
      item.status = 'queued'; item.detail = '新建目标暂无 CLI 通道，已入队';
    }
    if (record) upsertInput(item); broadcast(); return item;
  }
  // ⓪ CLI 后端（M-D/M-E/M-H 控制层）：tmux 优先 → 无头续会话兜底；回合写入会话文件后观察跟随器自动看到
  if (targetSource && CLI_TARGETS[targetSource]) {
    const sess = (() => {
      const live = state.sessions.get(targetId);
      // catalog 元数据补齐工作目录；ZCode 模型由目标会话保存的选择或显式管道候选确定。
      const found = resolveSessionAny(String(targetId));
      if (live) return { sessionId: targetId, cwd: live.cwd, provider: found?.provider ?? null };
      return found ? { sessionId: found.sessionId, cwd: found.cwd ?? found.project?.cwd, provider: found.provider ?? null } : { sessionId: targetId };
    })();
    // V05 执行前落盘：CLI 无头投递（2.5s 快速失败窗口内）被 kill 时队列保留「结果未确认」记录
    if (record) { item.detail = '正在向 CLI 会话投递…'; upsertInput(item); broadcast(); }
    const r = await deliverControl(targetSource, sess, text);
    if (r.settle) Object.defineProperty(item, 'settle', { value: r.settle });
    if (r.ok) { item.status = r.settle ? 'pending' : 'delivered'; item.accepted = true; item.detail = 'via ' + r.via; }
    else { item.status = 'failed'; item.accepted = !!r.accepted; item.detail = '投递失败：' + (r.detail || r.error); }
    if (record) upsertInput(item); broadcast(); return item;
  }
  // ① DSH 插件：只向经过 resolveTarget 校验的明确主会话投递。
  if (plugin.available) {
    const targetSession = targetId;
    // V05 执行前落盘：插件请求最长挂 4s，期间被 kill 则消息可能已送达而队列此前无痕
    if (record) { item.detail = '正在通过 DSH 插件投递…'; upsertInput(item); broadcast(); }
    try {
      const r = await pluginRequest('POST', '/input', { sessionId: targetSession, text }, 4000);
      if (r.json && r.json.sessionId) item.sessionId = r.json.sessionId;  // 审计字段记实际投递目标，而非日志跟随目标
      if (r.status === 200 && r.json && r.json.ok) {
        item.status = 'delivered';
        item.detail = 'via plugin:' + (r.json.via || '?') + (r.json.sessionId ? ' → ' + String(r.json.sessionId).slice(0, 12) : '');
        if (record) upsertInput(item); broadcast(); return item;
      }
      item.status = 'failed';
      item.detail = 'plugin 拒绝：' + ((r.json && (r.json.detail || r.json.code)) || r.status);
    } catch (e) { item.status = 'failed'; item.detail = 'plugin 调用失败：' + String(e.message || e).slice(0, 80); }
    if (record) upsertInput(item); broadcast(); return item;
  }
  // ② 插件不可用时只入队：外部命令无法证明/携带选中的 DSH 会话 ID。
  item.status = 'queued';
  item.detail = 'DSH 插件未连接，已保存在本地队列；请连接插件后核对目标并重发';
  if (record) upsertInput(item);
  broadcast();
  return item;
}
/** 按 id 落盘（存在则原位替换，否则追加）：投递前先记 pending、终态再原位更新，
 *  同一消息不产生第二条队列记录；重启时残留 pending 由启动迁移标「结果未确认」（V05）。 */
function upsertInput(item) {
  const record = { ...item, sessionId: item.sessionId ?? null };
  const items = readInputFile();
  const index = items.findIndex(i => i.id === item.id);
  if (index === -1) items.push(record); else items[index] = record;
  let out = items.length > INPUT_MAX_ITEMS ? items.slice(-INPUT_MAX_ITEMS) : items;
  while (Buffer.byteLength(JSON.stringify(out)) > INPUT_MAX_BYTES && out.length > 1) out = out.slice(1);
  // 内存态先原位同步：磁盘不可写时界面仍可见（qa M2 口径）；可写时以文件内容为准
  const memIndex = state.inputs.findIndex(i => i.id === item.id);
  if (memIndex === -1) state.inputs.push(record); else state.inputs[memIndex] = record;
  try { writeInputFile(out); state.inputs = out; } catch { /* 磁盘不可写：内存态已原位更新，服务不中断（qa M2） */ }
}
const retryingInputs = new Set();
async function retryInput(id) {
  if (retryingInputs.has(id)) return { busy: true };
  const orig = readInputFile().find(i => i.id === id);
  if (!orig || orig.status === 'delivered') return { missing: true };
  if (orig.status === 'pending') return { busy: true };
  retryingInputs.add(id);
  try {
    const isNew = String(orig.targetKey || '').startsWith('new:');
    const resolved = isNew ? null : resolveTarget(orig.sessionId || null, true);
    const targetChanged = resolved && !resolved.error && orig.source && resolved.source !== orig.source;
    let fresh;
    if (resolved?.error || targetChanged) {
      fresh = { ...orig, status: 'failed', accepted: !!orig.accepted,
        detail: targetChanged ? '原目标来源发生变化，消息未重发；请核对后新建投递'
          : '原目标不可用，消息未重发：' + resolved.error };
    } else {
      // V05：重发执行前把原条目原位置为 pending——执行中被 kill，重启后同样标「结果未确认」
      const pre = readInputFile();
      const preIndex = pre.findIndex(i => i.id === id);
      if (preIndex !== -1) {
        pre[preIndex] = { ...pre[preIndex], status: 'pending', detail: '重发执行中…' };
        try { writeInputFile(pre); state.inputs = pre; } catch { /* 落盘失败不阻塞重发（qa M2） */ }
      }
      fresh = await deliverInput(orig.text, isNew ? orig.targetKey : resolved.id, isNew ? orig.source : resolved.source,
        orig.targetKey, orig.model || '', { record: false, reasoningEffort: orig.reasoningEffort || '' });
    }
    const items = readInputFile();
    const index = items.findIndex(i => i.id === id);
    if (index !== -1) {
      if (fresh.status === 'delivered') items.splice(index, 1);
      else items[index] = { ...items[index], status: fresh.status, detail: fresh.detail,
        accepted: fresh.accepted, sessionId: fresh.sessionId || items[index].sessionId,
        targetKey: fresh.targetKey || items[index].targetKey };
      writeInputFile(items);
      state.inputs = items;
      broadcast();
      if (fresh.status === 'pending' && fresh.settle)
        fresh.settle.then(result => settleZcodeInput(id, result)).catch(() => {});
    }
    return { item: fresh, removedOriginal: index !== -1 && fresh.status === 'delivered' };
  } finally { retryingInputs.delete(id); }
}
/** 从文件与内存同步删除队列项（qa A-1）；返回删除条数。 */
function removeInputs(pred) {
  const before = readInputFile();
  const keep = before.filter(i => !pred(i));
  if (keep.length !== before.length) { try { writeInputFile(keep); } catch { /* ignore */ } }
  state.inputs = keep;
  return before.length - keep.length;
}

/** 自动冲刷「投递即新建」排队项：CLI 不在 PATH 时入队的 new:<source>:<cwd> 条目，
 *  每 20s 重试一次；送达即从队列移除（与手动重发同语义）。 */
async function flushNewQueues() {
  // 只重试「投递即新建」可自动化的目标：new:<CLI 源>（CLI 已安装）。
  // new:dsh 一类依赖插件/人工的目标不自动重试——此前未区分，每 20s 把不可投递项复制成新
  // queued 条目，队列自我增殖到 200 上限（2026-10-08 实测）。record:false 保证重试不落新条目。
  const pending = readInputFile().filter(i => i.status === 'queued' && typeof i.targetKey === 'string' && i.targetKey.startsWith('new:'))
    .filter(i => { const s = i.targetKey.split(':')[1] || ''; return !!CLI_TARGETS[s] && !!resolveCliBin(s); });
  if (!pending.length) return;
  for (const orig of pending) {
    await retryInput(orig.id);
  }
}

// ---------- 进程级兜底（qa M2）----------
// 本地服务无自愈：外壳只在启动时 ensure_server，运行中崩溃 = 全源中断、必须重启 App。
// 已知崩溃路径（管道日志目录不可写、队列落盘失败）已在源头包住；这里是最后一道防线——
// 未知异常记 stderr（进外壳的 framed-server.log）后**保持存活**，宁可带一次异常日志继续服务。
process.on('unhandledRejection', (e) => { try { console.error('[framed] unhandledRejection（已兜住，不退出）：' + (e?.stack || String(e))); } catch { /* ignore */ } });
process.on('uncaughtException', (e) => { try { console.error('[framed] uncaughtException（已兜住，不退出）：' + (e?.stack || String(e))); } catch { /* ignore */ } });

// ---------- HTTP ----------
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
  // 页面路由：/ = 迷你悬浮条（外壳默认入口，单行进度 + 三级切换）；/window.html = App 界面
  //（顶部切 agent / 左侧切项目 / 底部控会话）。token 只替换带引号的 '__PET_TOKEN_VALUE__'（唯一出现，
  // 不得动 window.__PET_TOKEN__ 属性名——2026-10-05 实测踩坑：整页 SyntaxError →「未连接」）。
  // no-store：页面永不被缓存，配合 snapshot.build 让旧页面在服务重启/HTML 更新后自动刷新。
  const PAGE_BY_ROUTE = {
    '/': path.join(HTML_DIR, 'mini.html'),
    '/mini.html': path.join(HTML_DIR, 'mini.html'),
    '/window.html': path.join(HTML_DIR, 'window.html'),
    '/app': path.join(HTML_DIR, 'window.html'),
  };
  if (req.method === 'GET' && PAGE_BY_ROUTE[url.pathname]) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(PAGE_BY_ROUTE[url.pathname], 'utf8').replace("'__PET_TOKEN_VALUE__'", JSON.stringify(TOKEN)));
    return;
  }
  // 页面品牌图标与 Agent 原始图标：只允许访问 demo/assets 下的静态文件。
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/assets/')) {
    let rel = '';
    try { rel = decodeURIComponent(url.pathname.slice('/assets/'.length)); } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); res.end('bad asset path'); return;
    }
    const root = path.resolve(ASSET_DIR);
    const file = path.resolve(root, rel);
    const relative = path.relative(root, file);
    if (!rel || rel.includes('\0') || (relative && (relative === '..' || relative.startsWith('..' + path.sep)))) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); res.end('forbidden'); return;
    }
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) throw new Error('not-file');
      const type = {
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.ico': 'image/x-icon',
      }[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable' });
      if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('asset not found');
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/catalog') {
    // 对外只暴露「主会话」：子代理（kind==='subagent'）不是用户意义上的会话，
    // 既不该出现在列表里，也不该被选为投递目标（服务端 resolveTarget 也会再拦一次）。
    // M-C：三源合并（DSH / Claude Code / Codex），projects[].sources 标注每个项目的来源构成。
    const refresh = url.searchParams.get('refresh') === '1';
    if (refresh) {
      if (plugin.available) await probePlugin();
      modelRegistrySnapshot(true);
    }
    const multi = multiCatalog(refresh);
    const projects = [];
    for (const cat of [multi.dsh, multi.cc, multi.cx, multi.km, multi.zc]) {
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
      source: 'multi:workspace-registry+disk(claude-code,codex,kimi-code,zcode)',
      projects: visible,
      mainSessions: visible.reduce((a, p) => a + p.sessionCount, 0),
      subagentSessions: visible.reduce((a, p) => a + p.subagentCount, 0),
      perSource: {
        dsh: { projects: (multi.dsh.projects || []).length, sessions: (multi.dsh.sessions || []).filter(s => s.kind !== 'subagent').length },
        'claude-code': { projects: (multi.cc.projects || []).length, sessions: (multi.cc.sessions || []).length },
        codex: { projects: (multi.cx.projects || []).length, sessions: (multi.cx.sessions || []).filter(s => s.kind !== 'subagent').length },
        'kimi-code': { projects: (multi.km.projects || []).length, sessions: (multi.km.sessions || []).length },
        zcode: { projects: (multi.zc.projects || []).length, sessions: (multi.zc.sessions || []).filter(s => s.kind !== 'subagent').length },
      },
    })));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/open') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      let sessionId = '';
      try { sessionId = String(JSON.parse(body).sessionId || ''); } catch {}
      // 路由按会话来源分流，**先**定位再决定通道：CLI 后端固定走 Terminal 续接，
      // 插件在线不得截走（qa H1：此前插件优先导致 Claude/Codex/Kimi/ZCode 的「打开」全被
      // 送进 DSH 插件、必然 open-rejected，界面表现为点击无反应）。插件只承接 DSH 会话与
      // 目录里查不到的 ID（DSH 进程内可能有磁盘目录尚未登记的活会话）。
      const found = sessionId ? resolveSessionAny(sessionId) : null;
      if (found && CLI_TARGETS[found.source]) {
        const r = await openCliSession(found.source, found);
        res.writeHead(r.ok ? 200 : 502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: r.ok, via: 'terminal',
          session: { sessionId: found.sessionId, title: found.title, source: found.source, cwd: found.cwd, variant: found.variant ?? null },
          opened: !!r.opened,
          reason: r.ok ? undefined : 'Terminal 打开失败',
          detail: (r.detail || r.via) + (found.source === 'zcode' ? '（ZCode 桌面会话 · App 内置引擎续接）' : found.variant === 'desktop' ? '（桌面端会话经 CLI 续接）' : ''),
        }));
        return;
      }
      // DSH 会话 / 目录未收录的 ID：插件在线时交给插件（进程内 resolveAgent/resume）
      if (plugin.available) {
        const r = await pluginRequest('POST', '/open', { sessionId }, 6000).catch(e => ({ status: 0, json: { ok: false, detail: String(e.message || e) } }));
        res.writeHead(r.status || 502, { 'content-type': 'application/json' });
        res.end(JSON.stringify(Object.assign({ via: 'plugin' }, r.json)));
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
      const cwd = String(payload0.cwd || '').trim();
      const source = String(payload0.source || 'dsh');
      const text = String(payload0.text || '').trim();
      const model = String(payload0.model || '').trim();
      const reasoningEffort = String(payload0.reasoningEffort || '').trim();
      const reply = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (!text || text.length > 2000) { reply(400, { ok: false, error: 'message-required', detail: '新建会话必须填写首条消息（最多 2000 字）' }); return; }
      if (source !== 'dsh' && !CLI_TARGETS[source]) { reply(400, { ok: false, error: 'bad-source' }); return; }
      const registry = modelRegistrySnapshot();
      const selected = validateModelSelection(registry, source, model, reasoningEffort);
      if (!selected.ok) { reply(400, selected); return; }
      const cwdCheck = validateCreateCwd(source, cwd);
      if (!cwdCheck.ok) { reply(400, cwdCheck); return; }
      if (CLI_TARGETS[source]) {
        const item = await deliverInput(text, 'new:' + source + ':' + cwd, source, null, selected.model.value, { reasoningEffort: selected.reasoningEffort });
        reply(item.status === 'delivered' ? 200 : item.status === 'pending' || item.status === 'queued' ? 202 : 502,
          { ok: item.status === 'delivered' || item.status === 'pending', item, sessionId: item.sessionId, detail: item.detail });
        return;
      }
      // ① DSH：插件进程内创建（需授权挂载）。cwd 已经过 validateCreateCwd：必为已存在项目目录
      if (plugin.available) {
        const r = await pluginRequest('POST', '/new', {
          cwd,
          provider: selected.model.providerId,
          model: selected.model.modelId,
          reasoningEffort: selected.reasoningEffort,
        }, 8000).catch(e => ({ status: 0, json: { ok: false, detail: String(e.message || e) } }));
        if (!r.json?.ok || !r.json.sessionId) { reply(502, { ok: false, detail: r.json?.detail || '插件未返回新会话 ID，首条消息未发送' }); return; }
        const item = await deliverInput(text, r.json.sessionId, 'dsh', 'sess:' + r.json.sessionId);
        reply(item.status === 'delivered' ? 200 : 502, { ok: item.status === 'delivered', sessionId: r.json.sessionId, item, detail: item.detail });
        return;
      }
      res.writeHead(501, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: false, error: 'not-authorized',
        reason: '新建 DSH 会话需要在 DSH 进程内完成（Cordis 插件），当前未授权挂载；不得使用 DSH 凭证绕过。Claude Code / Codex / Kimi Code / ZCode 的新建可用（请求带 source 字段即走终端通道）',
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
  if (req.method === 'GET' && url.pathname === '/api/usage/calendar') {
    const u = usageCache.data;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(u ? {
      generatedAt: usageCache.at, refreshing: usageCache.busy, ...usageCalendar(u),
    } : { pending: true }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/usage') {
    // 全量用量明细（overview + 每源 byModel/bySession）；?refresh=1 异步触发重扫（响应仍返回当前缓存）
    if (url.searchParams.get('refresh') === '1') refreshUsage();
    const u = usageCache.data;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(u ? {
      generatedAt: usageCache.at, refreshing: usageCache.busy,
      overview: u.overview,
      perSource: {
        dsh: serializeUsageScan(u.dsh),
        'claude-code': serializeUsageScan(u.cc),
        codex: serializeUsageScan(u.cx),
        'kimi-code': serializeUsageScan(u.km),
        zcode: serializeUsageScan(u.zc),
      },
    } : { pending: true }));
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
      let text = '', askedTarget = '', askedModel = '', askedReasoning = '';
      try { const b = JSON.parse(body); text = String(b.text || ''); askedTarget = String(b.sessionId || '').trim(); askedModel = String(b.model || '').trim(); askedReasoning = String(b.reasoningEffort || '').trim(); } catch { text = String(body).trim(); }
      text = text.trim();
      if (!text) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'empty' })); return; }
      // 兼容旧客户端的 new:<source>:<cwd>，同样强制模型与来源，不允许绕开新建约束。
      if (askedTarget.startsWith('new:')) {
        const source = askedTarget.split(':')[1];
        const cwd = askedTarget.slice(('new:' + source + ':').length);
        const selected = validateModelSelection(modelRegistrySnapshot(), source, askedModel, askedReasoning);
        const badSource = !CLI_TARGETS[source];
        const cwdCheck = !badSource && selected.ok ? validateCreateCwd(source, cwd) : null;
        const fail = badSource
          ? { error: 'invalid-create', detail: '新建必须指定有效来源（claude-code / codex / kimi-code / zcode）' }
          : !selected.ok ? selected : cwdCheck.ok ? null : cwdCheck;
        if (fail) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: fail.error, detail: fail.detail }));
          return;
        }
        askedModel = selected.model.value;
        askedReasoning = selected.reasoningEffort;
      }
      const t = askedTarget.startsWith('new:') ? { id: askedTarget } : resolveTarget(askedTarget || null);
      if (t.error) { res.writeHead(askedTarget ? 404 : 400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: askedTarget ? 'unknown-session' : 'target-required', detail: t.error })); return; }
      const item = await deliverInput(text.slice(0, 2000), t.id, t.source, null, askedModel, { reasoningEffort: askedReasoning });
      // ok=真正送达；queued(202)=已入队无通道；failed(502)=投递失败。不再一律 ok:true（qa A-6）
      const code = item.status === 'delivered' ? 200 : item.status === 'queued' || item.status === 'pending' ? 202 : 502;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: item.status === 'delivered' || item.status === 'pending', item }));
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
  // 按会话/目标组清空：服务端按 targetKey 全量删除（快照窗口外的条目也要删得到，
  // 此前 UI 从 8 条快照里挑 id 逐个 DELETE，200 条队列清一次剩 192 条）
  if (req.method === 'POST' && url.pathname === '/api/queue/group/clear') {
    let body0 = '';
    req.on('data', c => { body0 += c; });
    req.on('end', () => {
      let key = '';
      try { key = String((JSON.parse(body0) || {}).key || ''); } catch { /* ignore */ }
      if (!key) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'missing-key' })); return; }
      const keyOf = i => i.targetKey ?? (i.sessionId ? 'sess:' + i.sessionId : 'new:dsh:-');
      const n = removeInputs(i => keyOf(i) === key);
      broadcast();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, cleared: n, key }));
    });
    return;
  }
  const mResend = url.pathname.match(/^\/api\/input\/([^/]+)\/resend$/);
  if (req.method === 'POST' && mResend) {
    const id = decodeURIComponent(mResend[1]);
    const original = readInputFile().find(i => i.id === id);
    if (original?.accepted) {
      let confirmed = false;
      try { confirmed = JSON.parse(await new Promise(resolve => {
        let raw = ''; req.on('data', c => { raw += c; }); req.on('end', () => resolve(raw));
      }))?.confirm === true; } catch { /* reject below */ }
      if (!confirmed) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'confirm-required', detail: '消息可能已被目标接收，请核对会话后确认重发' }));
        return;
      }
    }
    const result = await retryInput(id);
    res.writeHead(result.missing ? 404 : result.busy ? 409 : result.item.status === 'delivered' ? 200 : result.item.status === 'pending' ? 202 : 502, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.missing ? { ok: false, error: 'not-found' } : result.busy ? { ok: false, error: 'retry-in-progress' }
      : { ok: result.item.status === 'delivered' || result.item.status === 'pending', item: result.item, removedOriginal: result.removedOriginal }));
    return;
  }
  res.writeHead(404); res.end('not found');
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('悬浮窗服务已启动： http://127.0.0.1:' + PORT + '/');
  console.log('  会话日志： ' + (findSessionLog(SESSION)?.file ?? '（未找到）'));
  console.log('  DSH 输入： 插件直投；未连接时仅入本地队列');
  startFollower();
  connectPlugin();   // 若 DSH 插件已挂载：进程内事件 + 直接投递
  // M-A/M-B/M-H/M-L：Claude Code / Codex / Kimi Code / ZCode 的多文件观察跟随（增量 → 同一个状态机）
  const ccFollow = followClaudeLogs({ onEvent: applyEvent });
  const cxFollow = followCodexLogs({ onEvent: applyEvent });
  const kmFollow = followKimiLogs({ onEvent: applyEvent });
  const zcFollow = followZcodeLogs({ onEvent: applyEvent });
  console.log('  观察通道： DSH=日志tail/插件 · Claude Code=转录tail · Codex=rollout tail · Kimi Code=wire.jsonl tail · ZCode=sqlite轮询（M-L）');
  console.log('  控制通道： ' + (cliChannelsCache().map((c) => c.name + '(' + c.bin + ')').join(' · ') || '无（CLI 不在 PATH）') + '；新建必须发送首条消息；ZCode 精确管道投递');
  // 管道回滚补偿：上次服务在管道回合中被重启 → 标记文件里还留着未完成的回滚
  try { const n = recoverZcodePendingRollbacks(); if (n) console.log('  ZCode 管道回滚补偿：已恢复 ' + n + ' 个会话的模型选择'); } catch { /* ignore */ }
  refreshAgentStatus();
  setInterval(probePlugin, 30_000);
  setInterval(refreshAgentStatus, 3000);   // 软件四态（ps + mtime 探测，实测 ~40ms）
  setInterval(broadcast, 2000);            // 心跳 + 计时刷新（qa M4：不依赖 DSH 会话日志是否存在）
  refreshUsage();                          // Token 用量：首轮全量后 60s 增量轮询（usage-collect 文件级缓存）
  setInterval(refreshUsage, 60_000);
  setInterval(flushNewQueues, 20_000);     // 投递即新建的排队项：CLI 恢复可用后自动重试
});
export { snapshot, deliverInput };
