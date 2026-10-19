#!/usr/bin/env node
/**
 * Agent 工作框 · 终端演示版（demo/frame.mjs）
 *
 * 用途：把「真实 DSH 会话日志 → 契约 v1 规范事件 → Hub 状态机 → 工作框渲染」这条
 *       已经验证过的链路，做成可在终端里实时观看的演示。
 *
 * 用法：
 *   node demo/frame.mjs                      # 实时跟随最新会话（毫秒级刷新）
 *   node demo/frame.mjs --session <id>       # 指定会话
 *   node demo/frame.mjs --once               # 打印一帧后退出（适合截图/CI）
 *   node demo/frame.mjs --replay <file>      # 回放规范事件 JSONL（离线演示，无需 DSH）
 *   node demo/frame.mjs --speed 8            # 回放倍速
 *   node demo/frame.mjs --no-color
 *
 * 依赖：Node ≥ 22（zlib zstd）、DSH 会话目录（默认 ~/.dsh/sessions）。
 * 说明：只读会话日志，不修改 DSH 任何文件；多帧 zstd 按魔数切帧解码（Node 内置解压只解第一帧）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const DSH_ROOT = process.env.DSH_SESSIONS || path.join(os.homedir(), '.dsh', 'sessions');

// ---------- 规范事件状态机（契约 §3/§4/§4.7 的实现，与 adapters/_reference/hub-minimal.mjs 同规则） ----------
const PRIORITY = { waiting: 5, 'transient-error': 4, error: 3, working: 2, thinking: 1, done: 0, aborted: 0, idle: -1 };
const STATE_LABEL = { idle: '空闲', thinking: '思考中', working: '工作中', waiting: '等待你', 'transient-error': '出错', error: '错误', done: '已完成', aborted: '已停止' };
const STATE_COLOR = { idle: 90, thinking: 36, working: 32, waiting: 33, 'transient-error': 33, error: 31, done: 35, aborted: 35 };
const TOOL_ICON = { read: '📖', write: '✍️ ', exec: '⌨️ ', net: '📡', other: '🔧' };
const CATEGORY_BY_TOOL = [
  [/^(read|glob|grep|list|search_files|view)/i, 'read'],
  [/^(edit|write|str_replace|create|apply_patch|notebook)/i, 'write'],
  [/^(bash|shell|run_code|exec|terminal|pwsh|process)/i, 'exec'],
  [/^(web_|fetch|http)/i, 'net'],
];
const RISK_BY_CATEGORY = { exec: 2, write: 2, net: 1, read: 0, other: 1 };

export function categoryOf(toolName = '') {
  for (const [re, cat] of CATEGORY_BY_TOOL) if (re.test(toolName)) return cat;
  return 'other';
}

export function createHub() {
  const sessions = new Map();
  const seen = new Set();
  const counters = { unknownEvents: 0, noop: 0, orphanApprovals: 0, duplicates: 0, recoveredErrors: 0, escalatedErrors: 0, oversizedDropped: 0 };
  const pending = new Map(); // requestId -> { sessionId, before, at }
  let lastEvent = null;
  const recent = [];

  function agg() {
    let best = 'idle';
    for (const s of sessions.values()) if (PRIORITY[s.state] > PRIORITY[best]) best = s.state;
    return best;
  }
  function set(sess, state, reason) {
    if (sess.state === state) return;
    sess.prev = sess.state; sess.state = state; sess.since = lastEvent?.ts ?? Date.now(); sess.reason = reason || '';
    if (!['waiting', 'transient-error', 'error'].includes(state)) sess.stable = state;
  }
  function apply(ev, nowMs = Date.now()) {
    if (ev.ctl) return;
    if (JSON.stringify(ev).length > 8192) { counters.oversizedDropped++; return; }
    const dedupKey = ev.source + '|' + ev.sessionId + '|' + ev.seq;
    if (seen.has(dedupKey)) { counters.duplicates++; return; }
    seen.add(dedupKey);
    lastEvent = ev;
    const id = ev.sessionId ?? 'backend';
    let s = sessions.get(id);
    if (!s) { s = { id, state: 'idle', stable: 'idle', since: ev.ts, title: ev.data?.title || ev.data?.workspace || shortId(id), source: ev.source, pending: 0, lastTool: null, errors: 0 }; sessions.set(id, s); }
    if (ev.data?.title) s.title = ev.data.title;
    const d = ev.data ?? {};
    switch (ev.type) {
      case 'session.start': case 'turn.start': set(s, 'thinking', ev.type); break;
      case 'turn.end': set(s, d.status === 'ok' ? 'done' : d.status === 'error' ? 'error' : d.status === 'aborted' ? 'aborted' : 'idle', 'turn.end:' + d.status); break;
      case 'session.end': set(s, d.reason === 'error' ? 'error' : d.reason === 'done' ? 'done' : d.reason === 'aborted' ? 'aborted' : 'idle', 'session.end:' + d.reason); break;
      case 'step.start': case 'step.end': set(s, d.status === 'error' ? 'transient-error' : d.status === 'aborted' ? 'aborted' : 'working', ev.type); break;
      case 'tool.call': s.lastTool = (d.summary || d.toolName || '').replaces?.('', '') ?? (d.summary || d.toolName || ''); set(s, 'working', 'tool:' + (d.toolName || '')); break;
      case 'tool.result':
        if (d.status === 'error') { counters.recoveredErrors++; set(s, 'transient-error', 'tool error'); }
        else if (d.status === 'aborted') set(s, 'aborted', 'tool cancelled');
        break;
      case 'approval.request': case 'user.question': {
        const rid = d.requestId ?? d.questionId ?? ('anon-' + (ev.seq));
        pending.set(rid, { sessionId: id, before: s.state, at: ev.ts });
        s.pending++;
        set(s, 'waiting', ev.type);
        break;
      }
      case 'approval.resolved': case 'user.answer': {
        const rid = d.requestId ?? d.questionId;
        const p = pending.get(rid);
        if (!p) { counters.orphanApprovals++; break; }
        pending.delete(rid); s.pending = Math.max(0, s.pending - 1);
        if (d.decision === 'timeout') set(s, 'transient-error', 'approval timeout');
        else set(s, p.before === 'waiting' ? 'working' : p.before, 'resolved');
        break;
      }
      case 'agent.status': set(s, d.state, 'agent.status'); break;
      case 'error.raised': if (d.fatal) set(s, 'error', 'fatal'); break;
      case 'pet.heartbeat': case 'message.assistant': counters.noop++; break;
      default: counters.unknownEvents++;
    }
    recent.unshift({ ts: ev.ts, type: ev.type, text: describe(ev) });
    if (recent.length > 6) recent.pop();
  }
  return { sessions, counters, pending, apply, agg, recent, get lastEvent() { return lastEvent; } };
}

function shortId(id) { return String(id).replace(/^session-/, '').slice(0, 8); }
function describe(ev) {
  const d = ev.data ?? {};
  switch (ev.type) {
    case 'tool.call': return '调用 ' + (d.toolName || '?') + (d.summary ? ' · ' + clip(d.summary, 34) : '');
    case 'tool.result': return '工具' + (d.status === 'ok' ? '成功' : d.status === 'error' ? '失败' : d.status === 'aborted' ? '被取消' : '被拒') + (d.durationMs ? ' · ' + d.durationMs + 'ms' : '');
    case 'step.start': return '第 ' + (d.index ?? '?') + ' 步开始';
    case 'step.end': return '第 ' + (d.index ?? '?') + ' 步结束';
    case 'assistant/message': case 'message.assistant': return '回复：' + clip(d.text || '', 34);
    case 'user/message': return '收到用户输入';
    case 'turn.start': return '新一轮开始';
    case 'turn.end': return '本轮结束（' + (d.status || '?') + '）';
    case 'session.start': return '会话开始';
    case 'session.end': return '会话结束（' + (d.reason || '?') + '）';
    case 'approval.request': return '等待批准：' + clip(d.summary || '', 28);
    case 'approval.resolved': return '审批结果：' + (d.decision || '?');
    default: return ev.type;
  }
}
function clip(s, n) { s = String(s).replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
// 终端宽度：CJK 与全角标点按 2 列计算，保证卡片对齐
function width(s) { let w = 0; for (const ch of String(s)) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1; return w; }
function padTo(s, cols) { s = String(s); const w = width(s); if (w === cols) return s; if (w < cols) return s + ' '.repeat(cols - w); let out = '', acc = 0; for (const ch of s) { const cw = width(ch); if (acc + cw > cols) break; out += ch; acc += cw; } return out + ' '.repeat(cols - acc); }
function clipW(s, cols) { s = String(s).replace(/\s+/g, ' '); if (width(s) <= cols) return s; let out = '', acc = 0; for (const ch of s) { const cw = width(ch); if (acc + cw > cols) break; out += ch; acc += cw; } return out; }
function mmss(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }

// ---------- DSH 原生事件 → 规范事件（契约 v1.2） ----------
export function makeMapper(sessionHeader) {
  const source = 'dsh';
  const workspace = sessionHeader?.cwd ?? null;
  const sessionId = sessionHeader?.id ?? 'unknown';
  const startedAt = sessionHeader?.createdAt ?? Date.now();
  let seq = -1;
  return function map(native) {
    if (!native || typeof native.type !== 'string') return [];
    const seqNo = Number.isFinite(native.seq) ? native.seq : ++seq;
    seq = Math.max(seq, seqNo);
    const ts = Number.isFinite(native.time) ? native.time : startedAt;
    const data = native.data ?? {};
    const base = { v: 1, seq: seqNo, ts, source, sessionId, workspace, agent: { name: 'DSH', version: sessionHeader?.version ? 'v' + sessionHeader.version : 'unknown' } };
    switch (native.type) {
      case 'turn/start': return [{ ...base, type: 'turn.start', data: { turnId: data.turnId ?? ('turn-' + seqNo), inputKind: 'user' } }];
      case 'turn/end': return [{ ...base, type: 'turn.end', data: { turnId: data.turnId ?? ('turn-' + seqNo), status: data.status === 'error' ? 'error' : data.status === 'aborted' ? 'aborted' : 'ok', durationMs: data.durationMs } }];
      case 'step/start': return [{ ...base, type: 'step.start', data: { turnId: data.turnId ?? 'turn', stepId: data.stepId ?? ('step-' + seqNo), index: data.index ?? seqNo } }];
      case 'step/end': return [{ ...base, type: 'step.end', data: { turnId: data.turnId ?? 'turn', stepId: data.stepId ?? ('step-' + seqNo), index: data.index ?? seqNo, status: data.status === 'error' ? 'error' : 'ok', durationMs: data.durationMs } }];
      case 'tool/call': {
        const toolName = data.toolName ?? data.name ?? 'unknown';
        const category = categoryOf(toolName);
        return [{ ...base, type: 'tool.call', data: { callId: data.callId ?? data.id ?? ('call-' + seqNo), toolName, category, risk: RISK_BY_CATEGORY[category], summary: summarizeToolInput(data.input) } }];
      }
      case 'tool/result': return [{ ...base, type: 'tool.result', data: { callId: data.callId ?? data.id ?? ('call-' + seqNo), status: data.status === 'error' ? 'error' : data.status === 'denied' ? 'denied' : 'ok', durationMs: data.durationMs, summary: typeof data.output === 'string' ? clip(data.output, 60) : undefined } }];
      case 'assistant/message': return [{ ...base, type: 'message.assistant', data: { turnId: data.turnId ?? 'turn', text: clip(typeof data.text === 'string' ? data.text : JSON.stringify(data.text ?? ''), 280), truncated: true } }];
      case 'approval/asked': return [{ ...base, type: 'approval.request', data: { requestId: data.requestId ?? data.id ?? ('req-' + seqNo), kind: data.kind ?? 'other', summary: clip(data.summary ?? data.message ?? '等待用户批准', 120), risk: data.risk ?? 2 } }];
      case 'approval/decided': return [{ ...base, type: 'approval.resolved', data: { requestId: data.requestId ?? data.id ?? ('req-' + seqNo), decision: /allow|approve|accept/i.test(String(data.decision ?? data.outcome)) ? 'allow' : /timeout|expire/i.test(String(data.outcome)) ? 'timeout' : 'deny', nativeOutcome: data.outcome ?? data.decision } }];
      case 'session/end': return [{ ...base, type: 'session.end', data: { nativeSessionId: sessionId, endedAt: ts, reason: data.reason ?? 'done' } }];
      case 'llm/retry': return [{ ...base, type: 'error.raised', data: { scope: 'llm', message: '模型重试', fatal: false } }];
      default: return [];
    }
  };
}
function summarizeToolInput(input) {
  if (!input) return undefined;
  if (typeof input === 'string') return clip(input, 60);
  const pick = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.code ?? input.url;
  return pick ? clip(String(pick), 60) : clip(JSON.stringify(input), 60);
}

// ---------- 多帧 zstd 增量读取 ----------
function decodeFrames(buf) {
  const offsets = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i >= 0) { offsets.push(i); i = buf.indexOf(MAGIC, i + 1); }
  const events = [];
  let cursor = 0, bad = 0;
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k];
    if (start < cursor) continue;
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    let slice = buf.subarray(start, end);
    let text = null;
    try { text = zlib.zstdDecompressSync(slice).toString('utf8'); }
    catch {
      // 末帧可能仍在写入：若已是最后一个候选帧，留待下次；否则记录坏帧
      if (k + 1 === offsets.length) break;
      bad++; continue;
    }
    cursor = end;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { events.push(JSON.parse(t)); } catch { /* 半行 */ }
    }
  }
  return { events, nextOffset: cursor, badFrames: bad };
}

export function findSessionLog(explicitId) {
  const dirs = fs.existsSync(DSH_ROOT) ? fs.readdirSync(DSH_ROOT).filter(d => d.startsWith('--')) : [];
  const candidates = [];
  for (const d of dirs) {
    const dir = path.join(DSH_ROOT, d);
    for (const s of fs.readdirSync(dir)) {
      if (explicitId && s !== explicitId) continue;
      const p = path.join(dir, s);
      for (const f of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']) {
        const file = path.join(p, f);
        if (fs.existsSync(file)) candidates.push({ file, dir: p, session: s, mtime: fs.statSync(file).mtimeMs });
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0] ?? null;
}

// ---------- 工作框渲染（终端） ----------
function visible(s) { return Math.max(1, Math.min(5, s)); }

/** 需要颜色时，用零宽标记包裹；渲染器只统计可见字符宽度（CJK=2），颜色不参与布局。 */
function paint(txt, code, color) { return color && code ? '\u0001' + code + '\u0002' + txt + '\u0003' : txt; }
function stripMarks(s) { return String(s).replace(/[\u0001\u0002\u0003][0-9;]*/g, ''); }
function toAnsi(s) { return String(s).replace(/\u0001([0-9;]*)m?\u0002/g, '\x1b[$1m').replace(/\u0003/g, '\x1b[0m'); }

export function render(hub, opts = {}) {
  const color = opts.color !== false;
  const now = opts.now ?? Date.now();
  const agg = hub.agg();
  const ev = hub.lastEvent;
  const W = 62;                       // 卡片内部列数（CJK 记 2 列）
  const rule = '─'.repeat(W);
  // 所有单元格宽度显式声明：3 + 37 + 9 + 9 + 4 = 62
  const COLS = { dot: 3, main: 37, state: 9, time: 9, pend: 4 };
  // 单元格 = 补齐到指定列数；颜色用零宽标记包裹，不参与宽度计算
  const cellW = (s, cols, code) => {
    let t = String(s).replace(/\s+/g, ' ');
    if (width(t) > cols) { let out = '', acc = 0; for (const ch of t) { const cw = width(ch); if (acc + cw > cols) break; out += ch; acc += cw; } t = out; }
    const pad = ' '.repeat(Math.max(0, cols - width(t)));
    return code ? paint(t, code, color) + pad : t + pad;
  };
  const lastTool = ev?.data?.toolName ?? ev?.data?.summary ?? '—';
  const step = ev?.data?.index ?? null;
  const pend = [...hub.sessions.values()].reduce((a, s) => a + (s.pending || 0), 0);
  const lines = ['┌' + rule + '┐'];
  const action = step ? '第 ' + step + ' 步 · ' + String(lastTool) : String(lastTool);
  const timeCell = (s) => (s.state === 'idle' ? '--' : s.state === 'done' ? '完成' : mmss(now - s.since));
  const sessCount = [...hub.sessions.values()].length;
  lines.push('│' + cellW('▌●', COLS.dot, STATE_COLOR[agg]) +
    cellW('汇总' + (sessCount ? ' · ' + sessCount + ' 个会话' : '') + (action !== '—' ? ' · ' + action : ''), COLS.main, '1;' + STATE_COLOR[agg]) +
    cellW(STATE_LABEL[agg], COLS.state, '1;' + STATE_COLOR[agg]) +
    cellW(mmss(ev ? now - (hub.sessions.get(ev.sessionId ?? 'backend')?.since ?? ev.ts) : 0), COLS.time) +
    cellW(pend ? '[+' + pend + ']' : '', COLS.pend) + '│');
  const sess = [...hub.sessions.values()].sort((a, b) => PRIORITY[b.state] - PRIORITY[a.state]);
  for (const s of sess.slice(0, visible(sess.length))) {
    lines.push('│' + cellW('▌●', COLS.dot, STATE_COLOR[s.state]) +
      cellW(String(s.source).toUpperCase() + ' ' + (s.title ?? shortId(s.id)), COLS.main) +
      cellW(STATE_LABEL[s.state], COLS.state, STATE_COLOR[s.state]) +
      cellW(timeCell(s), COLS.time) +
      cellW(s.pending ? '[+' + s.pending + ']' : '', COLS.pend) + '│');
  }
  if (!sess.length) lines.push('│' + cellW('▌●', COLS.dot, '90') + cellW('（尚无会话）', COLS.main) + cellW('--', COLS.state) + cellW('--', COLS.time) + cellW('', COLS.pend) + '│');
  if (sess.length > 5) lines.push('│' + cellW('+' + (sess.length - 5) + ' 个会话（折叠）', W) + '│');
  lines.push('├' + rule + '┤');
  for (const r of hub.recent.slice(0, 5)) {
    lines.push('│' + cellW(mmss(now - r.ts) + ' 前', 9) + cellW(r.type, 18) + cellW(r.text, 35) + '│');
  }
  lines.push('├' + rule + '┤');
  const cc = hub.counters;
  lines.push('│' + cellW('事件 ' + (opts.eventCount ?? '?') + ' · 未知 ' + cc.unknownEvents + ' · 重复 ' + cc.duplicates +
    ' · 孤儿审批 ' + cc.orphanApprovals + ' · 瞬态恢复 ' + cc.recoveredErrors, W) + '│');
  lines.push('└' + rule + '┘');
  return lines.map(l => toAnsi(l)).join('\n');
}
// ---------- CLI ----------
function parseArgs(argv) {
  const o = { color: true, speed: 4, tail: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') o.once = true;
    else if (a === '--no-color') o.color = false;
    else if (a === '--session') o.session = argv[++i];
    else if (a === '--replay') o.replay = argv[++i];
    else if (a === '--speed') o.speed = Number(argv[++i]) || 4;
    else if (a === '--file') o.file = argv[++i];
  }
  return o;
}

async function runLive(opts) {
  const target = opts.file ? { file: opts.file, session: 'local' } : findSessionLog(opts.session);
  if (!target) { console.error('未找到 DSH 会话日志：' + DSH_ROOT); process.exit(2); }
  const hub = createHub();
  let offset = 0, count = 0, mapper = null, header = null, lastRender = 0;
  const read = () => {
    let buf;
    try { buf = fs.readFileSync(target.file); } catch { return; }
    const fresh = offset > buf.length ? buf : buf.subarray(offset);
    if (offset > buf.length) offset = 0; // 日志被轮转/重写
    const { events, nextOffset } = decodeFrames(fresh);
    offset += nextOffset;
    for (const native of events) {
      if (native.type === 'session' && !header) { header = native; mapper = makeMapper(native); continue; }
      if (!mapper) mapper = makeMapper({ id: 'unknown', cwd: null, createdAt: Date.now() });
      for (const ev of mapper(native)) { hub.apply(ev); count++; }
    }
    if (opts.once) {
      console.log(render(hub, { color: opts.color, eventCount: count }));
      console.log('\n会话日志：' + target.file + '\n事件数：' + count + '（原生事件 → 规范事件）');
      process.exit(0);
    }
    const now = Date.now();
    if (now - lastRender > 400) {
      lastRender = now;
      process.stdout.write('\x1b[2J\x1b[H' + render(hub, { color: opts.color, eventCount: count, now }) + '\n' +
        ' 实时跟随：' + path.basename(target.session) + '（Ctrl-C 退出）\n');
    }
  };
  read();
  try { fs.watch(target.file, () => read()); } catch { /* 回退到轮询 */ }
  setInterval(read, 1000);
  process.on('SIGINT', () => { process.stdout.write('\x1b[0m\n'); process.exit(0); });
}

async function runReplay(opts) {
  const hub = createHub();
  const lines = fs.readFileSync(opts.replay, 'utf8').split('\n').filter(l => l.trim());
  const events = [];
  for (const l of lines) { try { const o = JSON.parse(l); if (!o.ctl) events.push(o); } catch {} }
  if (opts.once) {
    for (const ev of events) hub.apply(ev, ev.ts);
    console.log(render(hub, { color: opts.color, eventCount: events.length, now: events.at(-1)?.ts ?? Date.now() }));
    process.exit(0);
  }
  let i = 0;
  process.stdout.write('\x1b[?25l');
  const timer = setInterval(() => {
    if (i >= events.length) { clearInterval(timer); process.stdout.write('\x1b[?25h\n回放结束：' + events.length + ' 条事件\n'); process.exit(0); }
    hub.apply(events[i], events[i].ts);
    process.stdout.write('\x1b[2J\x1b[H' + render(hub, { color: opts.color, eventCount: i + 1, now: events[i].ts }) + '\n' +
      ' 回放：' + path.basename(opts.replay) + '  ' + (i + 1) + '/' + events.length + '（' + opts.speed + 'x）\n');
    i++;
  }, Math.max(40, 320 / opts.speed));
}

// 注意：路径可能含中文，必须用 fileURLToPath 解码（new URL().pathname 会给出 %E6%... 导致判定失败）
const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.replay) runReplay(opts); else runLive(opts);
}
