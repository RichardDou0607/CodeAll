#!/usr/bin/env node
/**
 * check-fixtures.mjs — fixtures/*.pet.jsonl 自检（契约 v1.2，docs/00-interface-contract.md）
 * 负责人：队友 C（adapter-recon）。只读输入，不修改任何文件。
 *
 * 校验项：
 *   1. 帧分类：带 ctl 且无 type = 控制帧（§2.2）；带 type 且无 ctl = 事件；两者都有或都没有 = 非法
 *   2. 事件信封必填（§2.1/§2.3）：v / seq / ts / source / sessionId / workspace / type / data
 *   3. 每行 ≤ 8192 字节（§2.3）
 *   4. 按 §3 逐 type 校验必填 data 字段与枚举（**16 个 type 字符串 / 16 行**，v1.2 口径）
 *      v1.2 新增：[session.start] 必填 startedAt（Unix ms）、[session.end] 必填 endedAt（Unix ms）、
 *      所有控制帧必填 contract（hello/ack/snapshot/decide），hello.observes 可选（观测能力等级 §5.2.1）
 *   5. seq：per-(source, sessionId) 从 0 稠密、无重复（去重键 §2.4）；乱序窗口必须≤32 条且 ts 跨度≤2s（§2.4）
 *   6. 配对：approval.resolved 必须配到未决 approval.request（否则 orphanApprovals）；user.answer 同理（§3.3）
 *   7. 状态机回放：按 §4.2 真值表 + §4.3 优先级 + §4.5 陈旧清理 + §4.7 错误分级（瞬态 TTL 回稳定态 /
 *      持久错误 / 连续 3 次瞬态且间隔 <60 s 升级），输出每个会话的迁移与 6 状态覆盖
 *   注：§3.1 表格写「session.end(reason=error) → error 状态 3 s」，而 §4.7 把 session.end(error) 归为持久错误，
 *      两者冲突；本脚本按 §4.7（较新且更具体）实现，并在 40-adapters.md §8 记录该冲突。
 *
 * 用法：node scripts/check-fixtures.mjs [file.pet.jsonl ...]
 * 退出码：0 = 通过；1 = 有失败项。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const MAX_LINE_BYTES = 8192;
const DISORDER_MAX_EVENTS = 32;
const DISORDER_MAX_MS = 2000;
const STALE_MS = 10 * 60 * 1000;
const DONE_HOLD_MS = 2000;
const SESSION_END_ERROR_HOLD_MS = 3000;
const APPROVAL_TIMEOUT_HOLD_MS = 1500;
const TRANSIENT_ERROR_HOLD_MS = 2000;   // tool.result/step.end 的 error：契约未写明退出条件，本脚本按 2s 瞬态实现（见 40-adapters.md §8）
const BACKEND_SESSION_ID = 'backend';

// 16 个 type 字符串 / 16 行（契约 v1.2 §3 口径）
const SPEC = {
  'session.start':    { req: ['nativeSessionId', 'startedAt'], opt: ['workspace', 'agentName', 'agentVersion', 'title'], numbers: ['startedAt'] },
  'session.end':      { req: ['nativeSessionId', 'endedAt', 'reason'], opt: ['durationMs', 'summary'], numbers: ['endedAt'], enums: { reason: ['done', 'aborted', 'error', 'unknown'] } },
  'pet.heartbeat':    { req: [], opt: ['nativeSessionId', 'load', 'sessionCount'] },
  'turn.start':       { req: ['turnId', 'inputKind'], enums: { inputKind: ['user', 'system', 'webhook', 'unknown'] } },
  'turn.end':         { req: ['turnId', 'status'], opt: ['durationMs', 'summary'], enums: { status: ['ok', 'aborted', 'error'] } },
  'step.start':       { req: ['turnId', 'stepId', 'index'] },
  'step.end':         { req: ['turnId', 'stepId', 'index', 'status'], opt: ['durationMs'], enums: { status: ['ok', 'error', 'aborted'] } },
  'message.assistant':{ req: ['turnId', 'text', 'truncated'] },
  'tool.call':        { req: ['callId', 'toolName', 'category', 'risk'], opt: ['summary'], enums: { category: ['read', 'write', 'exec', 'net', 'other'] } },
  'tool.result':      { req: ['callId', 'status'], opt: ['durationMs', 'summary'], enums: { status: ['ok', 'error', 'denied'] } },
  'approval.request': { req: ['requestId', 'kind', 'summary', 'risk'], opt: ['callId', 'expiresAt'], enums: { kind: ['command', 'file-write', 'network', 'permission', 'other'] } },
  'approval.resolved':{ req: ['requestId', 'decision'], opt: ['latencyMs'], enums: { decision: ['allow', 'deny', 'timeout'] } },
  'user.question':    { req: ['questionId', 'text'], opt: ['options'] },
  'user.answer':      { req: ['questionId', 'choice'], opt: ['custom'] },
  'agent.status':     { req: ['state'], opt: ['detail', 'force'], enums: { state: ['idle', 'thinking', 'working', 'waiting', 'error'] } },
  'error.raised':     { req: ['scope', 'message', 'fatal'], opt: ['code'], enums: { scope: ['session', 'tool', 'llm', 'adapter'] } },
};
const ALL_TYPES = new Set(Object.keys(SPEC));
const ALL_STATES = ['idle', 'thinking', 'working', 'waiting', 'error', 'done'];
const PRIORITY = { idle: 0, done: 1, thinking: 2, working: 3, error: 4, waiting: 5 };
const CONTROL_KINDS = ['hello', 'ack', 'decide', 'snapshot'];

const failures = [];
const notes = [];
const fail = (file, line, msg) => failures.push(`${file}:${line} ${msg}`);

function replaySession(events, file) {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const transitions = [];
  const seen = new Set(['idle']);
  const pending = new Map();          // requestId/questionId -> { prev, kind }
  const stats = { gated: 0, overrideRejected: 0, orphanApprovals: 0, orphanAnswers: 0, stale: 0,
                  recoveredErrors: 0, escalatedErrors: 0, persistentCleared: 0 };
  let state = 'idle', holdUntil = null, holdTo = null, holdKind = null;
  let persistentError = false, lastStable = 'idle';
  let lastChange = sorted.length ? sorted[0].ts : 0;
  const transientAt = [];                    // §4.7 失败连击窗口
  const go = (next, ts, why, branch) => {
    if (next === state) return;
    const label = why.branch || branch;
    transitions.push(`${state} -> ${next}  (seq=${why.seq} ${why.type}${label ? ' ' + label : ''})`);
    state = next; seen.add(state); lastChange = ts;
    if (next === 'idle' || next === 'thinking' || next === 'working') lastStable = next;   // §4.7 稳定状态
    holdUntil = null; holdTo = null; holdKind = null;
  };
  const hold = (until, to, kind = 'other') => { holdUntil = until; holdTo = to; holdKind = kind; };
  const request = (next, ev, branch) => {
    if (next === state) return;
    if (PRIORITY[next] < PRIORITY[state]) { stats.gated++; return; }   // §4.3：低优先级不得打断高优先级
    go(next, ev.ts, { ...ev, branch });
  };
  // §4.7 瞬态错误：TTL 到期回「该会话上一个稳定状态」；同会话连续 3 次（间隔 <60 s）升级为持久错误
  const transientError = (ev, branch, ttlMs) => {
    transientAt.push(ev.ts);
    if (transientAt.filter(t => ev.ts - t < 60000).length >= 3) {
      persistentError = true; stats.escalatedErrors++; go('error', ev.ts, ev, branch + ' → escalated');
      return;
    }
    go('error', ev.ts, ev, branch);
    hold(ev.ts + ttlMs, lastStable, 'transient');
  };
  // §4.7 成功事件（turn.start / step.start / tool.result(ok)）清除持久错误
  const success = (next, ev, branch) => {
    if (persistentError) { persistentError = false; stats.persistentCleared++; go(next, ev.ts, ev, branch + ' → persistent cleared'); }
    else request(next, ev, branch);
  };
  for (const ev of sorted) {
    if (holdUntil !== null && ev.ts >= holdUntil) {
      const t = holdTo, k = holdKind; holdUntil = null; holdTo = null; holdKind = null;
      if (k === 'transient') stats.recoveredErrors++;                      // §4.7：TTL 到期恢复
      go(t, lastChange, { seq: ev.seq, type: k === 'transient' ? '(transient TTL → 稳定态)' : k === 'persistent' ? '(persistent cleared)' : '(hold expired)' });
    }
    if (!persistentError && holdUntil === null && ev.ts - lastChange >= STALE_MS && state !== 'idle') {
      pending.clear(); stats.stale++; go('idle', ev.ts, { seq: ev.seq, type: '(stale 10min)' });
    }
    const d = ev.data || {};
    switch (ev.type) {
      case 'session.start': request('thinking', ev); break;
      case 'session.end':
        if (d.reason === 'error') { persistentError = true; go('error', ev.ts, ev, 'reason=error → persistent（§4.7；§3.1 的 3 s 口径与之冲突）'); }
        else if (d.reason === 'done') { go('done', ev.ts, ev, 'reason=done'); hold(ev.ts + DONE_HOLD_MS, 'idle'); }
        else { pending.clear(); go('idle', ev.ts, ev, 'reason=' + d.reason); }
        break;
      case 'pet.heartbeat': break;                                  // no-op，不刷新 lastChange（§4.5）
      case 'turn.start': success('thinking', ev, 'turn.start'); break;      // §4.7 成功事件
      case 'turn.end':
        if (d.status === 'ok') { persistentError = false; go('done', ev.ts, ev, 'ok'); hold(ev.ts + DONE_HOLD_MS, 'idle'); }
        else if (d.status === 'error') { persistentError = true; go('error', ev.ts, ev, 'error → persistent（§4.7）'); }
        else { request('idle', ev, 'aborted'); }
        break;
      case 'step.start': success('working', ev, 'step.start'); break;       // §4.7 成功事件
      case 'step.end':
        if (d.status === 'error') transientError(ev, 'error → transient', TRANSIENT_ERROR_HOLD_MS);
        else if (d.status === 'aborted') request('idle', ev, 'aborted');
        break;
      case 'message.assistant': break;
      case 'tool.call': request('working', ev); break;
      case 'tool.result':
        if (d.status === 'error') transientError(ev, 'error → transient', TRANSIENT_ERROR_HOLD_MS);
        else if (d.status === 'ok') success('working', ev, 'tool.result(ok)');   // §4.7 成功事件
        break;
      case 'approval.request':
        pending.set(d.requestId, { prev: state, kind: 'approval' });
        go('waiting', ev.ts, ev, 'requestId=' + d.requestId);
        break;
      case 'approval.resolved': {
        const p = pending.get(d.requestId);
        if (!p) { stats.orphanApprovals++; break; }                 // §3.3：忽略并计数，不猜 FIFO
        pending.delete(d.requestId);
        const back = pending.size ? 'waiting' : (p.prev ?? 'working');
        if (d.decision === 'timeout') {
          // §4.7：瞬态错误，TTL 后回「上一个稳定状态」（§3.3 写「回登记前状态」，以 §4.7 为准，见 40-adapters.md §8）
          transientError(ev, 'timeout → transient', APPROVAL_TIMEOUT_HOLD_MS);
        } else go(back, ev.ts, ev, d.decision);   // 配对回退不走优先级闸门（§4.6）
        break;
      }
      case 'user.question':
        pending.set(d.questionId, { prev: state, kind: 'question' });
        go('waiting', ev.ts, ev, 'questionId=' + d.questionId);
        break;
      case 'user.answer': {
        const p = pending.get(d.questionId);
        if (!p) { stats.orphanAnswers++; break; }
        pending.delete(d.questionId);
        if (pending.size === 0) go(p.prev ?? 'working', ev.ts, ev, 'answered');   // 配对回退不走优先级闸门（§4.6）
        break;
      }
      case 'agent.status': {
        const next = d.state;
        if (!ALL_STATES.includes(next) || next === 'done') { fail(file, ev.seq, `agent.status.state=${next} 非法（§3.4 只允许 5 个状态）`); break; }
        const accepted = d.force === true || PRIORITY[next] >= PRIORITY[state];
        if (!accepted) { stats.overrideRejected++; break; }
        go(next, ev.ts, ev, d.force === true ? 'force' : undefined);
        break;
      }
      case 'error.raised':
        if (d.fatal === true) { persistentError = true; go('error', ev.ts, ev, 'fatal'); }
        break;
      default: break;                                                // 未知 type：忽略
    }
  }
  if (holdUntil !== null) { const t = holdTo; holdUntil = null; holdTo = null; go(t, lastChange, { seq: -1, type: '(tail hold expired)' }); }
  if (!persistentError && state !== 'idle' && sorted.length && sorted[sorted.length - 1].ts - lastChange >= STALE_MS) { stats.stale++; go('idle', lastChange + STALE_MS, { seq: -1, type: '(tail stale)' }); }
  return { transitions, seen, finalState: state, stats, pending: pending.size };
}

function checkFile(path) {
  const lines = readFileSync(path).toString('utf8').split('\n');
  const events = [], control = [], sessions = new Map();
  const unknownTypes = new Map();
  let maxLine = 0, parseErrors = 0;
  const pendingApprovals = new Map(), pendingQuestions = new Map();
  const pair = { orphanApprovals: 0, orphanAnswers: 0 };

  lines.forEach((text, i) => {
    const n = i + 1;
    if (!text.trim()) return;
    const bytes = Buffer.byteLength(text);
    maxLine = Math.max(maxLine, bytes);
    if (bytes > MAX_LINE_BYTES) fail(path, n, `单行 ${bytes}B 超过 ${MAX_LINE_BYTES}B 上限`);
    let o; try { o = JSON.parse(text); } catch (e) { parseErrors++; fail(path, n, 'JSON 解析失败: ' + e.message); return; }
    if (typeof o !== 'object' || o === null || Array.isArray(o)) { fail(path, n, '顶层不是 JSON 对象'); return; }

    // ---- 帧分类（§2.2/§5.2：先判 ctl 再判 type）----
    const hasCtl = 'ctl' in o, hasType = 'type' in o;
    if (hasCtl && hasType) { fail(path, n, '同时含 ctl 与 type：控制帧必须无 type（§2.2）'); return; }
    if (!hasCtl && !hasType) { fail(path, n, '既无 ctl 也无 type：既不是控制帧也不是事件'); return; }
    if (hasCtl) {
      if (typeof o.ctl !== 'string' || !o.ctl) fail(path, n, 'ctl 必须是非空字符串');
      if (!CONTROL_KINDS.includes(o.ctl)) notes.push(`${path}:${n} 未知控制帧 ctl=${o.ctl}（消费者应忽略）`);
      if (o.contract !== 1) fail(path, n, `控制帧 ${o.ctl} 的 contract 必须为 1（v1.2 §2.2）`);   // 含 snapshot
      if (o.ctl === 'ack' && typeof o.ok !== 'boolean') fail(path, n, 'ack 帧必须有 boolean ok');
      if (o.ctl === 'hello') {
        if (o.resumeAfter !== null && o.resumeAfter !== undefined && !Number.isInteger(o.resumeAfter)) fail(path, n, 'hello.resumeAfter 必须是整数或 null');
        if (o.observes !== undefined && (!Array.isArray(o.observes) || o.observes.some(x => typeof x !== 'string'))) fail(path, n, 'hello.observes 必须是字符串数组（§5.2.1）');
      }
      if (o.ctl === 'snapshot') {
        if (typeof o.ts !== 'number') fail(path, n, 'snapshot 帧缺少 ts');
        if (!ALL_STATES.includes(o.agg)) fail(path, n, `snapshot.agg=${o.agg} 非法`);
        if (!Array.isArray(o.sessions)) fail(path, n, 'snapshot.sessions 必须是数组');
      }
      if (o.ctl === 'decide') notes.push(`${path}:${n} 出现 decide 控制帧（§5.4 属 Phase 2 能力）`);
      control.push(o);
      return;
    }

    // ---- 事件信封（§2.1/§2.3）----
    for (const f of ['v', 'seq', 'ts', 'source', 'sessionId', 'workspace', 'type', 'data'])
      if (!(f in o)) fail(path, n, `缺少必填字段 ${f}`);
    if (o.v !== 1) fail(path, n, `v 必须为 1，实际 ${JSON.stringify(o.v)}`);
    if (!Number.isInteger(o.seq) || o.seq < 0) fail(path, n, 'seq 必须是非负整数');
    if (!Number.isInteger(o.ts) || o.ts <= 0) fail(path, n, 'ts 必须是正的 Unix ms 整数');
    if (typeof o.source !== 'string' || !o.source) fail(path, n, 'source 必须是非空字符串');
    if (o.sessionId !== null && typeof o.sessionId !== 'string') fail(path, n, 'sessionId 必须是字符串或 null');
    if (o.sessionId === null && o.type === 'pet.heartbeat') notes.push(`${path}:${n} 后端级心跳建议用保留值 sessionId="${BACKEND_SESSION_ID}"（§2.4）`);
    if (o.workspace !== null && typeof o.workspace !== 'string') fail(path, n, 'workspace 必须是字符串或 null');
    if (typeof o.data !== 'object' || o.data === null || Array.isArray(o.data)) fail(path, n, 'data 必须是对象');
    if (o.privacy !== undefined) {
      if (typeof o.privacy !== 'object' || o.privacy === null || !Array.isArray(o.privacy.fields)) fail(path, n, 'privacy.fields 必须是数组');
    }
    const spec = SPEC[o.type];
    if (!spec) { unknownTypes.set(o.type, (unknownTypes.get(o.type) || 0) + 1); events.push(o); return; }
    const d = o.data || {};
    for (const f of spec.req) if (!(f in d)) fail(path, n, `${o.type} 缺少必填 data 字段 ${f}`);
    for (const [f, allowed] of Object.entries(spec.enums || {})) if (f in d && !allowed.includes(d[f])) fail(path, n, `${o.type}.${f}=${JSON.stringify(d[f])} 不在允许集合 [${allowed.join(', ')}]`);
    for (const f of spec.numbers || []) if (f in d && (!Number.isInteger(d[f]) || d[f] <= 0)) fail(path, n, `${o.type}.${f} 必须是正的 Unix ms 整数（v1.2 §3）`);
    if ('risk' in d && (!Number.isInteger(d.risk) || d.risk < 0 || d.risk > 3)) fail(path, n, `${o.type}.risk 必须是 0..3 整数`);
    if ('load' in d && (typeof d.load !== 'number' || d.load < 0 || d.load > 1)) fail(path, n, 'pet.heartbeat.load 必须是 0..1');
    if (o.type === 'message.assistant') {
      if (typeof d.text !== 'string') fail(path, n, 'message.assistant.text 必须是字符串');
      else if (d.text.length > 280) fail(path, n, `message.assistant.text 长度 ${d.text.length} > 280（§3.2）`);
      if (typeof d.truncated !== 'boolean') fail(path, n, 'message.assistant.truncated 必须是布尔');
    }
    if (o.type === 'error.raised' && typeof d.fatal !== 'boolean') fail(path, n, 'error.raised.fatal 必须是布尔（§3.4）');
    // 配对（§3.3）
    const key = o.source + '|' + o.sessionId;
    if (o.type === 'approval.request') pendingApprovals.set(key + '|' + d.requestId, o.seq);
    if (o.type === 'user.question') pendingQuestions.set(key + '|' + d.questionId, o.seq);
    if (o.type === 'approval.resolved') {
      const k = key + '|' + d.requestId;
      if (!pendingApprovals.has(k)) { pair.orphanApprovals++; fail(path, n, `approval.resolved requestId=${d.requestId} 找不到未决 approval.request（§3.3 orphanApprovals）`); }
      else pendingApprovals.delete(k);
    }
    if (o.type === 'user.answer') {
      const k = key + '|' + d.questionId;
      if (!pendingQuestions.has(k)) { pair.orphanAnswers++; fail(path, n, `user.answer questionId=${d.questionId} 找不到未决 user.question（§3.3 orphanAnswers）`); }
      else pendingQuestions.delete(k);
    }
    events.push(o);
  });

  // ---- seq：per-(source, sessionId) ----
  const groups = new Map();
  for (const e of events) {
    const key = e.source + '||' + (e.sessionId === null ? '(null)' : e.sessionId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const disorderWindows = [];
  for (const [key, list] of groups) {
    const seqs = list.map(e => e.seq);
    const dup = seqs.filter((s, i) => seqs.indexOf(s) !== i);
    if (dup.length) fail(path, 0, `[${key}] seq 重复（去重键 ${key.split('||')[0]}, sessionId, seq）：${[...new Set(dup)].join(',')}`);
    const sorted = [...new Set(seqs)].sort((a, b) => a - b);
    if (sorted[0] !== 0) fail(path, 0, `[${key}] seq 未从 0 开始（最小 ${sorted[0]}）`);
    for (let i = 0; i < sorted.length; i++) if (sorted[i] !== i) { fail(path, 0, `[${key}] seq 不稠密：期望 ${i} 实际 ${sorted[i]}`); break; }
    let i = 0, expected = 0;
    while (i < list.length) {
      if (list[i].seq === expected) { expected++; i++; continue; }
      const start = expected, win = [];
      while (i < list.length) {
        const have = new Set(win.map(e => e.seq)), k = win.length;
        let contiguous = k > 0;
        for (let x = 0; x < k; x++) if (!have.has(start + x)) { contiguous = false; break; }
        if (contiguous && (i >= list.length || list[i].seq === start + k)) break;
        win.push(list[i]); i++;
        if (win.length > DISORDER_MAX_EVENTS + 1) break;
      }
      const wSeqs = win.map(e => e.seq).sort((a, b) => a - b);
      const ok = wSeqs.length > 0 && wSeqs.every((s, x) => s === start + x);
      const span = win.length ? Math.max(...win.map(e => e.ts)) - Math.min(...win.map(e => e.ts)) : 0;
      disorderWindows.push({ key, count: win.length, spanMs: span, seqs: win.map(e => e.seq) });
      if (!ok) fail(path, 0, `[${key}] 乱序窗口不是连续 seq 区间 ${start}..${start + win.length - 1} 的排列：${win.map(e => e.seq).join(',')}`);
      if (win.length > DISORDER_MAX_EVENTS) fail(path, 0, `[${key}] 乱序窗口 ${win.length} 条 > ${DISORDER_MAX_EVENTS}（§2.4）`);
      if (span > DISORDER_MAX_MS) fail(path, 0, `[${key}] 乱序窗口 ts 跨度 ${span}ms > ${DISORDER_MAX_MS}ms（§2.4）`);
      expected = start + win.length;
    }
  }

  // ---- 状态机回放（按会话）----
  const perSession = [];
  const aggregateSeen = new Set();
  let aggFinal = 'idle';
  for (const [key, list] of groups) {
    const r = replaySession(list, path);
    perSession.push({ key, ...r });
    for (const s of r.seen) aggregateSeen.add(s);
    if (PRIORITY[r.finalState] > PRIORITY[aggFinal]) aggFinal = r.finalState;
    for (const [k, v] of Object.entries(r.stats)) if (v) notes.push(`${path} [${key}] ${k}=${v}`);
  }

  return {
    path,
    lines: lines.filter(l => l.trim()).length, events: events.length, control: control.length,
    maxLine, parseErrors, unknownTypes, disorderWindows, pair,
    types: new Set(events.map(e => e.type)), perSession, aggregateSeen, aggFinal,
    pendingLeft: pendingApprovals.size + pendingQuestions.size,
  };
}

function main() {
  const args = process.argv.slice(2);
  let files = args;
  if (!files.length) {
    try { files = readdirSync('fixtures').filter(f => f.endsWith('.pet.jsonl')).map(f => join('fixtures', f)); } catch { files = []; }
  }
  if (!files.length) { console.error('未找到 fixtures/*.pet.jsonl'); process.exit(1); }
  let totalEvents = 0, totalUnknown = 0, totalControl = 0;
  const covered = new Set();
  for (const f of files) {
    if (!statSync(f).isFile()) continue;
    const r = checkFile(f);
    totalEvents += r.events; totalControl += r.control;
    for (const t of r.types) { covered.add(t); if (!r.unknownTypes.has(t)) continue; totalUnknown += r.unknownTypes.get(t); }
    console.log(`\n=== ${relative(process.cwd(), f)} ===`);
    console.log(`  行数(非空): ${r.lines} | 事件: ${r.events} | 控制帧: ${r.control} | 最大单行: ${r.maxLine}B / ${MAX_LINE_BYTES}B`);
    console.log(`  type 覆盖: 规范 ${[...r.types].filter(t => ALL_TYPES.has(t)).length}/${ALL_TYPES.size}${r.unknownTypes.size ? ` | 未知 ${r.unknownTypes.size} 种（${[...r.unknownTypes].map(([t, n]) => t + '×' + n).join(', ')}）` : ''}`);
    console.log('  乱序窗口: ' + (r.disorderWindows.length
      ? r.disorderWindows.map(w => `${w.count} 条(seq ${w.seqs[0]}..${w.seqs[w.seqs.length - 1]}, ${w.spanMs}ms)`).join('; ') : '无'));
    console.log(`  配对: orphanApprovals=${r.pair.orphanApprovals}, orphanAnswers=${r.pair.orphanAnswers}, 结束时未决=${r.pendingLeft}`);
    for (const s of r.perSession) {
      console.log(`  会话 [${s.key}] 终态=${s.finalState} 迁移 ${s.transitions.length} 次，覆盖=[${[...s.seen].join(', ')}]`);
      for (const t of s.transitions) console.log('    · ' + t);
    }
    console.log(`  聚合终态=${r.aggFinal}，聚合覆盖状态=[${[...r.aggregateSeen].join(', ')}]`);
  }
  const missing = [...ALL_TYPES].filter(t => !covered.has(t));
  console.log('\n=== 汇总 ===');
  console.log(`文件数 ${files.length} | 事件 ${totalEvents} | 控制帧 ${totalControl}`);
  console.log(`规范 type 覆盖 ${ALL_TYPES.size - missing.length}/${ALL_TYPES.size}${missing.length ? ' | 缺失: ' + missing.join(', ') : ' | 全部覆盖（16 个 type 字符串 / 16 行）'}`);
  console.log(`未知 type 事件 ${totalUnknown} 条（§7.3：忽略并计数，不得抛异常）`);
  for (const n of notes) console.log('  [note] ' + n);
  if (failures.length) {
    console.log(`\n✗ 失败 ${failures.length} 项：`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('\n✓ 全部检查通过（契约 v1.2）');
}
main();
