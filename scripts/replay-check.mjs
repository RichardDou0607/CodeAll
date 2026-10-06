#!/usr/bin/env node
// scripts/replay-check.mjs —— 契约 **v1.2** 独立校验器 + 最小状态机消费者（T6 contract-verifier 自研，不复用 T3 的 check-fixtures.mjs）
//
// 用法：
//   node scripts/replay-check.mjs fixtures/contract-sample.pet.jsonl [更多.jsonl ...]
//   node scripts/replay-check.mjs --selftest            # 主样例（16 type 覆盖）+ v1.2 分支专项 + 负例
//   node scripts/replay-check.mjs --json <file>         # 机器可读
// 选项：--buffer-ms=2000 --buffer-count=32 --stale-ms=600000 --offline-ms=45000
//
// v1.2 依据：§2.1 信封 / §2.2 控制帧 / §2.3 必填规则 / §2.4 顺序去重乱序 / §3 真值表 / §4.1–§4.7
//            §5.2 握手续传 / §5.2.1 observes / §7 验收。
// 与 v1.1 版的差异：控制帧合法化（ctl）、必填按「未标注=必填」、requestId 配对 + orphan 计数、
//            瞬态/持久错误 TTL（§4.7）、会话级 aborted 例外（§4.2）、45s source 离线（§4.4）、
//            10min 会话陈旧以 lastStateChangeTs 计（§4.5，心跳不刷新）、迟到不倒退（§4.6）、noop 计数（§7.3）。

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONTRACT_REV = 'v1.2';
const KNOWN_TYPES = new Set([
  'session.start', 'session.end', 'pet.heartbeat',
  'turn.start', 'turn.end', 'step.start', 'step.end', 'message.assistant',
  'tool.call', 'tool.result', 'approval.request', 'approval.resolved',
  'user.question', 'user.answer', 'agent.status', 'error.raised',
]);
// §2.3：标 * = 必填，标 ? = 可选，未标注 = 必填
const DATA_REQUIRED = {
  'session.start': ['nativeSessionId', 'startedAt'],
  'session.end': ['nativeSessionId', 'endedAt', 'reason'],
  'pet.heartbeat': [],
  'turn.start': ['turnId', 'inputKind'],
  'turn.end': ['turnId', 'status'],
  'step.start': ['turnId', 'stepId', 'index'],
  'step.end': ['turnId', 'stepId', 'index', 'status'],
  'message.assistant': ['turnId', 'text', 'truncated'],
  'tool.call': ['callId', 'toolName', 'category', 'risk'],
  'tool.result': ['callId', 'status'],
  'approval.request': ['requestId', 'kind', 'summary', 'risk'],
  'approval.resolved': ['requestId', 'decision'],
  'user.question': ['questionId', 'text'],
  'user.answer': ['questionId', 'choice'],
  'agent.status': ['state'],
  'error.raised': ['scope', 'message', 'fatal'],
};
const DATA_ENUMS = {
  'session.end': { reason: ['done', 'aborted', 'error', 'unknown'] },
  'turn.start': { inputKind: ['user', 'system', 'webhook', 'unknown'] },
  'turn.end': { status: ['ok', 'aborted', 'error'] },
  'step.end': { status: ['ok', 'error', 'aborted'] },
  'tool.call': { category: ['read', 'write', 'exec', 'net', 'other'] },
  'tool.result': { status: ['ok', 'error', 'denied'] },
  'approval.request': { kind: ['command', 'file-write', 'network', 'permission', 'other'] },
  'approval.resolved': { decision: ['allow', 'deny', 'timeout'] },
  'agent.status': { state: ['idle', 'thinking', 'working', 'waiting', 'error'] },
  'error.raised': { scope: ['session', 'tool', 'llm', 'adapter'] },
};
const CONTROL_CTLS = new Set(['hello', 'ack', 'decide', 'snapshot']);
const PRIORITY = { waiting: 1, error: 2, 'transient-error': 2, working: 3, thinking: 4, done: 5, idle: 6 };
const MAX_EVENT_BYTES = 8 * 1024;
const HEARTBEAT_MS = 15_000;
const OFFLINE_MS = 45_000;
const STALE_MS = 600_000;
const TTL = { transient: 2000, approvalTimeout: 1500, done: 2000, sessionEndError: 3000 };
const BACKEND_SESSION = 'backend';   // §2.4 后端级事件保留 sessionId

// ── 校验层 ──────────────────────────────────────────────────────────────────
function validateFrame(raw, bytes) {
  const errors = [], warnings = [];
  let o = null;
  try { o = JSON.parse(raw); } catch (e) { return { ok: false, errors: ['JSON 解析失败: ' + e.message], warnings, o: null }; }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return { ok: false, errors: ['顶层必须是对象'], warnings, o: null };

  // §2.2 控制帧：无 type、有 ctl
  if (typeof o.ctl === 'string') {
    if (!CONTROL_CTLS.has(o.ctl)) errors.push('未知控制帧 ctl=' + o.ctl + '（§2.2 只定义 hello/ack/decide/snapshot）');
    for (const k of ['ctl', 'contract']) if (!(k in o)) errors.push('控制帧缺字段 ' + k);
    if ('contract' in o && o.contract !== 1) errors.push('控制帧 contract=' + o.contract + ' 与支持的 1 不符');
    if (o.ctl === 'hello' && !('source' in o)) errors.push('hello 缺 source');
    if (o.ctl === 'decide') warnings.push('decide 是 Phase 2 帧（§5.4）；Phase 1 适配器不应发送');
    if (o.ctl === 'snapshot' && !Array.isArray(o.sessions)) warnings.push('snapshot 缺 sessions 数组（§5.3）');
    if ('observes' in o && !Array.isArray(o.observes)) errors.push('observes 必须是 glob 字符串数组（§5.2.1）');
    return { ok: errors.length === 0, errors, warnings, o, isControlFrame: true, ctl: o.ctl };
  }

  // §2.1 事件信封
  for (const k of ['v', 'seq', 'ts', 'source', 'sessionId', 'workspace', 'type', 'data']) {
    if (!(k in o)) errors.push('缺少必填字段 ' + k + '（§2.1/§2.3）');
  }
  if ('v' in o && (!Number.isInteger(o.v) || o.v < 0)) errors.push('v 必须是非负整数');
  if (Number.isInteger(o.v) && o.v !== 1) errors.push('v=' + o.v + ' 与本消费者支持的主版本 1 不匹配');
  if ('seq' in o && (!Number.isInteger(o.seq) || o.seq < 0)) errors.push('seq 必须是非负整数');
  if ('ts' in o && !Number.isInteger(o.ts)) errors.push('ts 必须是整数(Unix ms)');
  if ('source' in o && (typeof o.source !== 'string' || !o.source)) errors.push('source 必须是非空字符串');
  if ('type' in o && (typeof o.type !== 'string' || !o.type)) errors.push('type 必须是非空字符串');
  if ('data' in o && (o.data === null || typeof o.data !== 'object' || Array.isArray(o.data))) errors.push('data 必须是对象');
  if ('sessionId' in o && o.sessionId !== null && typeof o.sessionId !== 'string') errors.push('sessionId 必须是非空字符串或 null');
  if ('workspace' in o && o.workspace !== null && typeof o.workspace !== 'string') errors.push('workspace 必须是非空字符串或 null');
  if (bytes > MAX_EVENT_BYTES) errors.push('序列化后 ' + bytes + ' B > 8 KB 上限（§2.3）');

  const isKnown = typeof o.type === 'string' && KNOWN_TYPES.has(o.type);
  if (typeof o.type === 'string' && !isKnown) warnings.push('未知 type "' + o.type + '" → 忽略并计 unknownEvents（§1.5/§7.3）');
  if (isKnown) {
    const req = DATA_REQUIRED[o.type] || [];
    if (o.data && typeof o.data === 'object') {
      for (const f of req) if (!(f in o.data)) errors.push(o.type + '.data 缺必填字段 ' + f + '（§3 + §2.3「未标注=必填」）');
      const en = DATA_ENUMS[o.type];
      if (en) for (const [k, allowed] of Object.entries(en)) {
        if (k in o.data && !allowed.includes(o.data[k])) errors.push(o.type + '.' + k + '=' + JSON.stringify(o.data[k]) + ' 不在枚举 [' + allowed.join('|') + '] 内');
      }
      if ('risk' in o.data && (!Number.isInteger(o.data.risk) || o.data.risk < 0 || o.data.risk > 3)) errors.push(o.type + '.risk 必须是 0..3 整数');
    }
  }
  return { ok: errors.length === 0, errors, warnings, o, isKnown };
}
function parseJsonl(text) {
  const out = [];
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '') return;
    const bytes = Buffer.byteLength(raw, 'utf8');
    out.push({ lineNo: i + 1, raw, bytes, ...validateFrame(raw, bytes) });
  });
  return out;
}

// ── 状态机消费者（§4）────────────────────────────────────────────────────────
class Hub {
  constructor(opts = {}) {
    this.offlineMs = opts.offlineMs ?? OFFLINE_MS;
    this.staleMs = opts.staleMs ?? STALE_MS;
    this.sessions = new Map();      // key = source|sessionId -> { state, stable, expireAt, lastChangeTs, fails:[] }
    this.pending = new Map();       // requestId/questionId -> { key, kind, prevState, at }
    this.override = null;           // { state, until, key }
    this.lastFrameTs = new Map();   // source -> ts（事件或控制帧，§4.4）
    this.offlineSources = new Set();// 已判定离线的 source（边沿触发，收到新帧才恢复）
    this.current = 'idle';
    this.timers = [];
    this.dedupe = new Set();        // (source,sessionId,seq) §2.4
    this.seqHigh = new Map();       // key -> 已见最大 seq
    this.transitions = [];
    this.counters = { frames: 0, events: 0, controlFrames: 0, unknownEvents: 0, noop: 0, stale: 0, offline: 0,
                      duplicates: 0, lateEvents: 0, orphanApprovals: 0, orphanAnswers: 0, overrideRejected: 0,
                      recoveredErrors: 0, escalatedErrors: 0 };
    this.problems = [];
    this.branchHits = {};           // §4.2 真值表分支命中统计
  }
  hit(b) { this.branchHits[b] = (this.branchHits[b] || 0) + 1; }
  keyOf(ev) { return ev.source + '|' + (ev.sessionId ?? BACKEND_SESSION); }
  sess(key) {
    if (!this.sessions.has(key)) this.sessions.set(key, { state: 'idle', stable: 'idle', expireAt: null, lastChangeTs: null, fails: [] });
    return this.sessions.get(key);
  }
  setState(next, ctx, reason) {
    if (next === this.current) return;
    const from = this.current; this.current = next;
    this.transitions.push({ seq: ctx.seq, ts: ctx.ts, from, to: next, reason });
  }
  aggregate() {
    if ([...this.pending.values()].length > 0) return 'waiting';           // §4.3 有未决 → 整体 waiting
    let best = 'idle';
    for (const s of this.sessions.values()) if (PRIORITY[s.state] < PRIORITY[best]) best = s.state;
    return best;
  }
  recompute(ctx, reason) {
    let next = this.aggregate();
    if (this.override && (this.lastFrameTs.get(this.override.source) ?? 0) <= this.override.until && ctx.ts <= this.override.until) {
      next = this.override.state;    // 已通过 §3.4 规则的覆盖
    } else if (this.override && ctx.ts > this.override.until) { this.override = null; }
    this.setState(next, ctx, reason);
  }
  schedule(key, state, at, kind, stable) {
    const s = this.sess(key);
    s.state = state; if (stable !== undefined) s.stable = stable;
    s.expireAt = at; s.lastChangeTs = this.lastTs;
    this.timers.push({ at, kind, key });
  }
  fireTimers(now, ctx) {
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const t = this.timers.find(x => x.at <= now);
      if (!t) break;
      this.timers.splice(this.timers.indexOf(t), 1);
      const s = this.sessions.get(t.key);
      if (!s || s.expireAt !== t.at) continue;
      if (t.kind === 'transient') { s.state = s.stable; s.expireAt = null; s.lastChangeTs = t.at; this.counters.recoveredErrors++; this.hit('§4.7 transient TTL 到期恢复'); this.recompute({ seq: ctx.seq, ts: t.at }, 'transient-error TTL 到期 → 回到 ' + s.stable); }
      else if (t.kind === 'approvalTimeout') { s.state = s.stable; s.expireAt = null; this.recompute({ seq: ctx.seq, ts: t.at }, 'approval timeout 1.5 s → 回登记前状态'); }
      else if (t.kind === 'done') { s.state = 'idle'; s.stable = 'idle'; s.expireAt = null; this.recompute({ seq: ctx.seq, ts: t.at }, 'done 2 s → idle'); }
      else if (t.kind === 'sessionEndError') { s.state = 'idle'; s.stable = 'idle'; s.expireAt = null; this.recompute({ seq: ctx.seq, ts: t.at }, 'session.end(error) 3 s → idle'); }
    }
  }
  checkOffline(now, ctx) {
    for (const [src, last] of this.lastFrameTs) {
      if (now - last <= this.offlineMs) continue;
      if (this.offlineSources.has(src)) { this.lastFrameTs.set(src, now); continue; }   // 边沿触发：离线期间不重复计数
      let touched = false;
      for (const [k, s] of [...this.sessions]) if (k.startsWith(src + '|')) { this.sessions.delete(k); touched = true; }
      for (const [id, p] of [...this.pending]) if (p.key.startsWith(src + '|')) { this.pending.delete(id); touched = true; }
      if (this.override && this.override.source === src) this.override = null;
      this.lastFrameTs.set(src, now);
      this.offlineSources.add(src);
      this.counters.offline++; this.hit('§4.4 45 s source 离线 → 清聚合');
      this.offlineDetail = this.offlineDetail || []; this.offlineDetail.push(src + '@' + now + '(last=' + last + ')');
      this.problems.push('source ' + src + ' 超过 ' + this.offlineMs + ' ms 无任何帧 → 标记 offline 并清空其会话/未决（§4.4）');
      if (touched) this.recompute(ctx, '§4.4 source ' + src + ' 离线清理');
    }
  }
  checkStale(now, ctx) {
    for (const [k, s] of this.sessions) {
      const base = s.lastChangeTs;
      if (base === null || now - base <= this.staleMs) continue;
      if (s.state === 'idle') continue;
      for (const [id, p] of [...this.pending]) if (p.key === k) this.pending.delete(id);
      s.state = 'idle'; s.stable = 'idle'; s.expireAt = null; s.lastChangeTs = now;
      this.counters.stale++; this.hit('§4.5 会话 10 min 无状态变化 → 清理');
      this.problems.push('会话 ' + k + ' 超过 ' + this.staleMs + ' ms 无状态变化（心跳不刷新）→ stale 清理（§4.5）');
      this.recompute(ctx, '§4.5 会话陈旧清理');
    }
  }
  apply(frame, opts) {
    const ctx = { seq: frame.o?.seq ?? 0, ts: frame.o?.ts ?? 0 };
    this.counters.frames++;
    if (frame.isControlFrame) {
      this.counters.controlFrames++; this.hit('§2.2 控制帧 ' + frame.ctl);
      if (frame.o.ctl === 'hello') this.observes = frame.o.observes ?? null;
      if (frame.o.ctl === 'snapshot') this.counters.snapshots = (this.counters.snapshots || 0) + 1;
      if (frame.o.ctl === 'decide') this.problems.push('收到 Phase 2 的 decide 控制帧（§5.4 规定 Phase 1 只读）');
      if (frame.o.ctl === 'hello' && frame.o.source) this.connectionSource = frame.o.source;
      const ctlSrc = frame.o.source ?? this.connectionSource;
      const ctlTs = Number.isInteger(frame.o.ts) ? frame.o.ts : (ctlSrc ? (this.lastFrameTs.get(ctlSrc) ?? null) : null);
      if (ctlTs !== null) this.checkOffline(ctlTs, ctx);   // §4.4：控制帧到达时也要判定其它 source 是否已离线（无 ts 的控制帧不参与）
      if (ctlTs !== null) this.checkStale(ctlTs, ctx);
      if (ctlTs !== null) this.fireTimers(ctlTs, ctx);
      if (ctlSrc && ctlTs !== null) { this.lastFrameTs.set(ctlSrc, Math.max(this.lastFrameTs.get(ctlSrc) ?? 0, ctlTs)); if (this.offlineSources.has(ctlSrc)) { this.offlineSources.delete(ctlSrc); this.counters.recoveredOnline = (this.counters.recoveredOnline || 0) + 1; } }
      return;   // 控制帧处理完毕，绝不落入事件分支
    }
    const ev = frame.o;
    if (!frame.isKnown) { this.counters.unknownEvents++; this.hit('§1.5/§7.3 未知 type 忽略'); this.unknownDetail = (this.unknownDetail || []); this.unknownDetail.push((frame.lineNo ?? '?') + ':' + ev.type); return; }
    this.counters.events++;
    const key = this.keyOf(ev);
    const dk = ev.source + '|' + (ev.sessionId ?? BACKEND_SESSION) + '|' + ev.seq;
    if (this.dedupe.has(dk)) { this.counters.duplicates++; this.hit('§2.4 重复 seq 丢弃'); return; }
    this.dedupe.add(dk);
    const hi = this.seqHigh.get(key);
    const isLate = hi !== undefined && ev.seq < hi;
    if (isLate) { this.counters.lateEvents++; this.hit('§4.6 窗口外迟到'); }
    this.seqHigh.set(key, Math.max(hi ?? -1, ev.seq));
    this.lastTs = ev.ts;
    this.checkOffline(ev.ts, ctx);   // 先用上一帧时间判定离线，再记录本帧
    if (this.offlineSources.has(ev.source)) { this.offlineSources.delete(ev.source); this.counters.recoveredOnline = (this.counters.recoveredOnline || 0) + 1; this.problems.push('source ' + ev.source + ' 恢复（收到新帧，§4.4）'); }
    this.lastFrameTs.set(ev.source, Math.max(this.lastFrameTs.get(ev.source) ?? 0, ev.ts));
    this.checkStale(ev.ts, ctx);
    this.fireTimers(ev.ts, ctx);

    const d = ev.data || {};
    const S = () => this.sess(key);
    const setSession = (state, reason, { ttl, stable, hit } = {}) => {
      const s = S();
      if (['done', 'error', 'transient-error'].includes(state) && state !== 'error') { /* 过渡态 */ }
      if (state === 'error' || state === 'transient-error') { /* 持久/瞬态由调用方决定 */ }
      s.state = state;
      if (stable !== undefined) s.stable = stable;
      else if (['idle', 'thinking', 'working', 'waiting', 'error'].includes(state)) s.stable = state;   // 稳定态即新的回退点（§4.7）
      s.lastChangeTs = ev.ts; s.expireAt = ttl ? ev.ts + ttl : null;
      if (ttl) this.timers.push({ at: ev.ts + ttl, kind: hit || state, key });
      if (hit) this.hit(hit);
      // §4.6 迟到不得让状态倒退：迟到事件若给出更低优先级，只记 side-effect，不改状态
      if (isLate && PRIORITY[state] > PRIORITY[this.current]) {
        this.problems.push('迟到事件 seq=' + ev.seq + '（' + ev.type + '）被接受但按 §4.6 不使状态倒退（候选 ' + state + ' < 当前 ' + this.current + '）');
        s.state = s.stable;
      }
      this.recompute(ctx, reason);
    };
    const escalateIfNeeded = () => {
      const s = S();
      s.fails = s.fails.filter(t => ev.ts - t < 60_000);
      s.fails.push(ev.ts);
      if (s.fails.length >= 3) { s.state = 'error'; s.stable = 'error'; s.expireAt = null; this.counters.escalatedErrors++; this.hit('§4.7 连续 3 次瞬态错误 → 升级持久 error'); this.problems.push('会话 ' + key + ' 在 60 s 内累计 3 次瞬态错误 → 升级为持久 error（§4.7）'); return true; }
      return false;
    };
    switch (ev.type) {
      case 'session.start': setSession('thinking', 'session.start → 会话 thinking', { hit: '§4.2 session.start' }); break;
      case 'turn.start': S().fails = []; setSession('thinking', 'turn.start → thinking（成功事件清除持久错误，§4.7）', { hit: '§4.2 turn.start' }); break;
      case 'step.start': setSession('working', 'step.start → working', { hit: '§4.2 step.start' }); break;
      case 'step.end':
        if (d.status === 'error') { this.hit('§4.2 step.end(error) → transient'); if (!escalateIfNeeded()) setSession('transient-error', 'step.end(error) → transient-error（TTL 2 s）', { ttl: TTL.transient, hit: 'transient' }); else this.recompute(ctx, 'step.end(error) 升级持久 error'); }
        else if (d.status === 'aborted') { this.hit('§4.2 step.end(aborted) 会话级例外'); setSession('idle', 'step.end(aborted) → 会话 idle（例外条款，不打散其他会话 waiting）'); }
        else { this.counters.noop++; this.hit('§7.3 no-op'); }
        break;
      case 'message.assistant': this.counters.noop++; this.hit('§7.3 no-op'); break;
      case 'tool.call': setSession('working', 'tool.call → working', { hit: '§4.2 tool.call' }); break;
      case 'tool.result':
        if (d.status === 'error') {
          this.hit('§4.2 tool.result(error) → transient');
          const risk3 = (d.risk === 3);
          if (risk3 || escalateIfNeeded()) { S().state = 'error'; S().stable = 'error'; S().expireAt = null; if (risk3) { this.counters.escalatedErrors++; this.hit('§4.7 risk=3 → 持久 error'); } this.recompute(ctx, 'tool.result(error) → 持久 error（risk=3 或连击）'); }
          else setSession('transient-error', 'tool.result(error) → transient-error（TTL 2 s）', { ttl: TTL.transient, hit: 'transient' });
        } else if (d.status === 'denied') { this.counters.noop++; this.hit('§7.3 no-op'); }
        else { S().fails = []; S().state = S().stable = ['error', 'transient-error'].includes(S().state) ? 'working' : S().state; S().expireAt = null; this.counters.noop++; this.hit('§4.7 成功事件清除持久错误'); this.recompute(ctx, 'tool.result(ok) → no-op（并清除持久错误）'); }
        break;
      case 'turn.end':
        if (d.status === 'ok') { this.hit('§4.2 turn.end(ok) → done'); S().fails = []; setSession('done', 'turn.end(ok) → done（2 s → idle）', { ttl: TTL.done, stable: 'idle', hit: 'done' }); }
        else if (d.status === 'error') { this.hit('§4.2 turn.end(error) → 持久 error'); S().state = 'error'; S().stable = 'error'; S().expireAt = null; S().lastChangeTs = ev.ts; this.recompute(ctx, 'turn.end(error) → 持久 error（直到成功事件/离线清理）'); }
        else { this.hit('§4.2 turn.end(aborted) 会话级例外'); setSession('idle', 'turn.end(aborted) → 会话 idle（例外条款）'); }
        break;
      case 'session.end':
        if (d.reason === 'error') { this.hit('§4.2 session.end(error)'); S().state = 'error'; S().stable = 'idle'; S().expireAt = ev.ts + TTL.sessionEndError; S().lastChangeTs = ev.ts; this.timers.push({ at: ev.ts + TTL.sessionEndError, kind: 'sessionEndError', key }); this.recompute(ctx, 'session.end(error) → error 3 s → idle'); }
        else if (d.reason === 'done') { this.hit('§4.2 session.end(done) → done 2 s'); for (const [id, p] of [...this.pending]) if (p.key === key) this.pending.delete(id); setSession('done', 'session.end(done) → 会话 done（2 s → idle）', { ttl: TTL.done, stable: 'idle', hit: 'done' }); }
        else { this.hit('§4.2 session.end(aborted|unknown) 会话级例外'); for (const [id, p] of [...this.pending]) if (p.key === key) this.pending.delete(id); this.sessions.delete(key); this.recompute(ctx, 'session.end(' + d.reason + ') → 移除会话（例外条款）'); }
        break;
      case 'pet.heartbeat': this.counters.noop++; this.hit('§4.2/§4.5 心跳 no-op（不刷新状态超时）'); break;
      case 'approval.request': {
        this.pending.set(d.requestId, { key, kind: 'approval', prevState: S().state === 'idle' ? 'working' : S().state, at: ev.ts });
        setSession('waiting', 'approval.request(' + d.requestId + ') → waiting', { hit: '§4.2 approval.request' });
        break;
      }
      case 'approval.resolved': {
        const p = this.pending.get(d.requestId);
        if (!p) { this.counters.orphanApprovals++; this.hit('§3.3 orphanApprovals'); this.problems.push('approval.resolved(' + d.requestId + ') 无匹配未决 → 忽略并计 orphanApprovals（§3.3；seq=' + ev.seq + '）'); break; }
        this.pending.delete(d.requestId);
        if (d.decision === 'timeout') { this.hit('§4.2 approval.resolved(timeout)'); const s = this.sess(p.key); s.state = 'transient-error'; s.stable = p.prevState; s.expireAt = ev.ts + TTL.approvalTimeout; s.lastChangeTs = ev.ts; this.timers.push({ at: ev.ts + TTL.approvalTimeout, kind: 'approvalTimeout', key: p.key }); this.recompute(ctx, 'approval.resolved(timeout) → error 1.5 s → 登记前状态'); }
        else {
          this.hit('§4.2 approval.resolved(' + d.decision + ')');
          const s = this.sess(p.key);
          // v1.2 未定义「未决期间会话又发生了别的状态变更」时如何回退；本实现采用保守规则：
          // 仅当该会话仍停在 waiting（说明没有其它事件推进它）才恢复到登记前状态，否则保留更新后的状态。
          if (s.state === 'waiting') { s.state = p.prevState; s.stable = p.prevState; }
          else { this.counters.pendingRestoreSkipped = (this.counters.pendingRestoreSkipped || 0) + 1; this.problems.push('approval.resolved(' + d.requestId + ') 到达时会话已不在 waiting（当前 ' + s.state + '）→ 保留较新状态，不按「登记前状态」回退（v1.2 §4.2 未定义的边界，见 V-09）'); }
          s.expireAt = null; s.lastChangeTs = ev.ts;
          this.recompute(ctx, 'approval.resolved(' + d.decision + ') → 回到登记前状态 ' + p.prevState + '（或保留较新状态）');
        }
        break;
      }
      case 'user.question': {
        this.pending.set(d.questionId, { key, kind: 'question', prevState: S().state === 'idle' ? 'working' : S().state, at: ev.ts });
        setSession('waiting', 'user.question(' + d.questionId + ') → waiting', { hit: '§4.2 user.question' });
        break;
      }
      case 'user.answer': {
        const p = this.pending.get(d.questionId);
        if (!p) { this.counters.orphanAnswers++; this.hit('§3.3 orphanAnswers'); this.problems.push('user.answer(' + d.questionId + ') 无匹配未决 → 忽略并计 orphanAnswers'); break; }
        this.pending.delete(d.questionId);
        const s = this.sess(p.key);
        if (s.state === 'waiting') { s.state = p.prevState; s.stable = p.prevState; }
        else { this.counters.pendingRestoreSkipped = (this.counters.pendingRestoreSkipped || 0) + 1; }
        s.expireAt = null; s.lastChangeTs = ev.ts;
        this.recompute(ctx, 'user.answer → 回到登记前状态 ' + p.prevState);
        break;
      }
      case 'agent.status': {
        const cur = this.current === 'idle' && PRIORITY[this.aggregate()] < PRIORITY.idle ? this.aggregate() : this.aggregate();
        const okPriority = PRIORITY[d.state] <= PRIORITY[cur];
        if (!okPriority && d.force !== true) { this.counters.overrideRejected++; this.hit('§3.4 overrideRejected'); this.problems.push('agent.status(' + d.state + ') 优先级低于当前聚合 ' + cur + ' 且未 force → 拒绝（§3.4；seq=' + ev.seq + '）'); break; }
        this.override = { state: d.state, until: ev.ts + 10_000, source: ev.source };
        this.hit('§3.4 覆盖生效' + (d.force === true ? '（force）' : ''));
        this.recompute(ctx, 'agent.status(' + d.state + ') 覆盖 10 s' + (d.force ? '（force）' : ''));
        break;
      }
      case 'error.raised':
        if (d.fatal === true) { this.hit('§4.2 error.raised(fatal) → 持久 error'); S().state = 'error'; S().stable = 'error'; S().expireAt = null; S().lastChangeTs = ev.ts; this.recompute(ctx, 'error.raised(fatal=true) → 持久 error'); }
        else { this.counters.noop++; this.hit('§4.2 error.raised(fatal=false) no-op'); }
        break;
      default: break;
    }
  }
  finish(nowTs, ctx) {
    const endTs = this.override ? Math.max(nowTs, this.override.until) : nowTs;
    if (this.override && endTs >= this.override.until) this.override = null;
    this.fireTimers(endTs, { seq: 'end', ts: endTs });
    this.recompute({ seq: 'end', ts: endTs }, '流结束结算');
  }
}

// ── 乱序缓冲（§2.4/§4.6）─────────────────────────────────────────────────────
class Replay {
  constructor(opts = {}) { this.hub = new Hub(opts); this.buf = []; this.opts = opts; }
  static keyOf(f) { const o = f.o || {}; return [o.ts ?? 0, o.source ?? '', o.sessionId ?? BACKEND_SESSION, o.seq ?? 0]; }
  feed(frame) {
    const first = this.buf[0];
    const overCount = this.buf.length >= (this.opts.bufferCount ?? 32);
    const overTime = !!first && ((frame.o?.ts ?? 0) - (first.o?.ts ?? 0)) > (this.opts.bufferMs ?? 2000);
    if (overCount || overTime) this.flush();
    this.buf.push(frame);
  }
  flush() {
    if (!this.buf.length) return;
    const sorted = [...this.buf].sort((a, b) => { const x = Replay.keyOf(a), y = Replay.keyOf(b); for (let i = 0; i < x.length; i++) { if (x[i] < y[i]) return -1; if (x[i] > y[i]) return 1; } return 0; });
    this.buf = [];
    for (const f of sorted) this.hub.apply(f);
  }
  run(frames) { for (const f of frames) this.feed(f); this.flush(); const last = frames[frames.length - 1]; this.hub.finish(last?.o?.ts ?? 0, { seq: 'end', ts: last?.o?.ts ?? 0 }); return this.hub; }
}
function replayInOrder(frames, opts) {
  const hub = new Hub(opts);
  const valid = frames.filter(f => !f.isControlFrame && f.isKnown);
  const sorted = [...valid].sort((a, b) => { const x = Replay.keyOf(a), y = Replay.keyOf(b); for (let i = 0; i < x.length; i++) { if (x[i] < y[i]) return -1; if (x[i] > y[i]) return 1; } return 0; });
  for (const f of sorted) hub.apply(f);
  const last = sorted[sorted.length - 1];
  hub.finish(last?.o?.ts ?? 0, { seq: 'end', ts: last?.o?.ts ?? 0 });
  return hub;
}

// ── 报告 ─────────────────────────────────────────────────────────────────────
function report(name, entries, opts, asJson) {
  const invalid = entries.filter(e => !e.ok);
  const frames = entries.filter(e => e.ok);
  const events = frames.filter(f => !f.isControlFrame && f.isKnown);
  const unknowns = frames.filter(f => !f.isControlFrame && !f.isKnown);
  const cf = frames.filter(f => f.isControlFrame);
  const ordered = replayInOrder(frames, opts);
  const receive = new Replay(opts).run(frames);
  const out = {
    file: name, contractRev: CONTRACT_REV, lines: entries.length, valid: frames.length, invalid: invalid.length,
    bytesMax: Math.max(0, ...entries.map(e => e.bytes)),
    eventFrames: events.length, unknownFrames: unknowns.length, controlFrames: cf.map(f => f.ctl),
    unknownTypes: [...new Set(unknowns.map(f => f.o.type))],
    invalidDetail: invalid.map(e => ({ line: e.lineNo, errors: e.errors })),
    warnings: entries.filter(e => e.warnings.length).map(e => ({ line: e.lineNo, warnings: e.warnings })),
    transitions: receive.transitions, final: receive.current, finalBaseline: ordered.current,
    converges: receive.current === ordered.current,
    sameSequence: JSON.stringify(receive.transitions) === JSON.stringify(ordered.transitions),
unknownDetail: receive.unknownDetail || [], offlineDetail: receive.offlineDetail || [],
    observes: receive.observes ?? null,
  };
  if (asJson) return out;
  const L = [];
  L.push('=== ' + name + '（契约 ' + CONTRACT_REV + '）===');
  L.push('行数 ' + out.lines + ' | 通过校验 ' + out.valid + ' | 失败 ' + out.invalid + ' | 最大单行 ' + out.bytesMax + ' B');
  L.push('帧分类: 事件帧 ' + out.eventFrames + ' | 未知 type ' + out.unknownFrames + ' | 控制帧 ' + out.controlFrames.length + (cf.length ? ' (' + out.controlFrames.join(',') + ')' : '') + (out.observes ? ' | observes=' + JSON.stringify(out.observes) : ''));
  if (process.env.PET_DEBUG_FRAMES) for (const e of entries) L.push('  [debug] line=' + e.lineNo + ' ok=' + e.ok + ' ctl=' + e.ctl + ' isControlFrame=' + e.isControlFrame + ' isKnown=' + e.isKnown + ' type=' + (e.o && e.o.type));
  if (out.invalidDetail.length) { L.push('--- 校验失败明细 ---'); for (const d of out.invalidDetail) L.push('  第' + d.line + '行: ' + d.errors.join('; ')); }
  if (out.warnings.length) { L.push('--- 警告（' + out.warnings.length + '）---'); for (const w of out.warnings.slice(0, 10)) L.push('  第' + w.line + '行: ' + w.warnings.join('; ')); }
  L.push('--- 状态迁移序列（接收顺序 + 2 s/32 条乱序缓冲）---');
  if (!receive.transitions.length) L.push('  (无迁移)');
  for (const t of receive.transitions) L.push('  [seq=' + t.seq + ' ts=' + t.ts + '] ' + t.from + ' → ' + t.to + '   // ' + t.reason);
  L.push('--- 判定 ---');
  L.push('  最终状态（接收顺序）= ' + out.final + ' ; 基线 = ' + out.finalBaseline + ' → §7.4 收敛: ' + (out.converges ? '一致 ✅' : '不一致 ❌'));
  L.push('  迁移序列完全相同: ' + (out.sameSequence ? '是 ✅' : '否 ⚠️'));
  L.push('  计数: ' + JSON.stringify(receive.counters));
  L.push('--- §4.2 真值表分支命中 ---');
  const hits = Object.entries(receive.branchHits);
  if (!hits.length) L.push('  (无)');
  for (const [k, v] of hits.sort()) L.push('  ' + k + ' × ' + v);
  if (receive.problems.length) { L.push('--- 契约/数据问题 ---'); for (const p of receive.problems.slice(0, 25)) L.push('  · ' + p); }
  L.push('');
  return L.join('\n');
}

// ── 自测样例 ─────────────────────────────────────────────────────────────────
export function selfTestSample() {
  const T0 = 1791172500000, A = 'session-AAAA', B = 'session-BBBB', C = 'session-CCCC';
  let seqA = 0, seqB = 0, seqC = 0, seqBE = 0;
  const ev = (dt, type, data, sid = A) => {
    const seq = sid === A ? seqA++ : sid === B ? seqB++ : seqC++;
    return JSON.stringify({ v: 1, seq, ts: T0 + dt, source: 'dsh', sessionId: sid, workspace: '/Users/x/proj', type, data });
  };
  const hb = (dt, load, count) => JSON.stringify({ v: 1, seq: seqBE++, ts: T0 + dt, source: 'dsh', sessionId: 'backend', workspace: null, type: 'pet.heartbeat', data: { nativeSessionId: null, load, sessionCount: count } });
  const out = [
    JSON.stringify({ ctl: 'hello', contract: 1, source: 'dsh', adapterVersion: '0.1.0', resumeAfter: null, observes: ['session.*', 'turn.*', 'step.*', 'tool.*', 'approval.*', 'user.*', 'agent.*', 'error.*', 'pet.*'] }),
    JSON.stringify({ ctl: 'ack', contract: 1, ok: true, heartbeatMs: 15000, canDecide: false }),
    ev(0, 'session.start', { nativeSessionId: A, startedAt: T0, title: 'T6 v1.2 自测' }),
    ev(1000, 'turn.start', { turnId: 't1', inputKind: 'user' }),
    ev(2000, 'step.start', { turnId: 't1', stepId: 's1', index: 0 }),
    ev(3000, 'tool.call', { callId: 'c1', toolName: 'Bash', category: 'exec', risk: 1, summary: 'npm test' }),
    ev(4000, 'tool.result', { callId: 'c1', status: 'error', durationMs: 900, summary: 'exit 1' }),      // 瞬态 #1
    ev(7000, 'tool.call', { callId: 'c2', toolName: 'Bash', category: 'exec', risk: 1, summary: 'npm test' }),
    ev(8000, 'tool.result', { callId: 'c2', status: 'error', durationMs: 800 }),                          // 瞬态 #2
    ev(11000, 'tool.call', { callId: 'c3', toolName: 'Bash', category: 'exec', risk: 1, summary: 'npm test' }),
    ev(12000, 'tool.result', { callId: 'c3', status: 'error', durationMs: 700 }),                         // 瞬态 #3 → 升级持久
    ev(13000, 'step.start', { turnId: 't1', stepId: 's2', index: 1 }),                                    // 成功事件清除持久错误
    ev(14000, 'approval.request', { requestId: 'r1', kind: 'command', summary: '允许执行 pnpm test?', risk: 2, callId: 'c9' }),
    ev(15000, 'approval.resolved', { requestId: 'r1', decision: 'allow', latencyMs: 1000 }),
    ev(16000, 'approval.resolved', { requestId: 'rX', decision: 'allow' }),                               // orphanApprovals
    ev(17000, 'user.question', { questionId: 'q1', text: '选 A 还是 B？', options: ['A', 'B'] }),
    ev(18000, 'user.answer', { questionId: 'q1', choice: 'A' }),
    ev(19000, 'user.answer', { questionId: 'qY', choice: 'B' }),                                          // orphanAnswers
    ev(20000, 'agent.status', { state: 'idle' }),                                                         // 低优先级 → overrideRejected
    ev(21000, 'agent.status', { state: 'error', force: true }),                                           // force → 生效
    ev(22000, 'message.assistant', { turnId: 't1', text: '好的。', truncated: false }),                   // no-op
    ev(23000, 'step.end', { turnId: 't1', stepId: 's2', index: 1, status: 'ok' }),                        // no-op
    ev(24000, 'step.end', { turnId: 't1', stepId: 's3', index: 2, status: 'aborted' }),                   // 会话级例外
    ev(25000, 'session.start', { nativeSessionId: B, startedAt: T0 + 25000 }, B),
    ev(26000, 'turn.start', { turnId: 'tb1', inputKind: 'user' }, B),
    ev(27000, 'approval.request', { requestId: 'r2', kind: 'file-write', summary: '写入 ~/.zshrc', risk: 3 }, B),
    ev(28000, 'turn.end', { turnId: 'tb1', status: 'aborted' }, B),                                       // 不得顶掉整体 waiting
    ev(29000, 'approval.resolved', { requestId: 'r2', decision: 'deny' }, B),
    ev(30000, 'turn.end', { turnId: 't1', status: 'ok' }),                                                // done → 2 s → idle
    hb(31000, 0.1, 2),                                                                                    // no-op，不刷新 §4.5 计时
    ev(32000, 'x-future.type', { whatever: true }),                                                       // unknownEvents
    ev(33000, 'session.end', { nativeSessionId: B, endedAt: T0 + 33000, reason: 'done', durationMs: 8000 }, B),
    ev(42000, 'session.start', { nativeSessionId: C, startedAt: T0 + 42000 }, C),
    ev(43000, 'error.raised', { scope: 'adapter', message: 'fatal 演示', fatal: true }, C),               // 持久 error
    ev(44000, 'error.raised', { scope: 'tool', message: '非致命', fatal: false }, C),                     // no-op
  ];
  // §4.5：用每 30 s 的心跳把 source 保活（心跳不算状态变化），让「只有心跳的静默会话」被 stale 清理（§7.6）
  for (let t = 60000; t <= 690000; t += 30000) out.push(hb(t, 0.05, 1));
  out.push(ev(745000, 'turn.start', { turnId: 'tc1', inputKind: 'system' }, C));                          // 会话 C 已被 stale 清理
  return out;
}

// v1.2 分支专项：逐条覆盖 §4.7 TTL/升级、§4.2 会话级例外、§3.4 override、§4.4 离线、§4.5 陈旧、§4.6 迟到、§2.4 去重
export function branchSample() {
  const T0 = 1791180000000, X = 'session-XXXX', Y = 'session-YYYY';
  let seqX = 0, seqY = 0, seqCC = 0, seqBE = 0;
  const ev = (dt, type, data, sid = X) => {
    const seq = sid === X ? seqX++ : sid === Y ? seqY++ : seqCC++;
    const source = sid === 'cc-1' ? 'claude-code' : 'dsh';
    return JSON.stringify({ v: 1, seq, ts: T0 + dt, source, sessionId: sid, workspace: null, type, data });
  };
  const hb = (dt) => JSON.stringify({ v: 1, seq: seqBE++, ts: T0 + dt, source: 'dsh', sessionId: 'backend', workspace: null, type: 'pet.heartbeat', data: { nativeSessionId: null, load: 0, sessionCount: 1 } });
  const raw = (sid, seq, dt, type, data) => JSON.stringify({ v: 1, seq, ts: T0 + dt, source: sid === 'cc-1' ? 'claude-code' : 'dsh', sessionId: sid, workspace: null, type, data });
  const out = [
    JSON.stringify({ ctl: 'hello', contract: 1, source: 'dsh', adapterVersion: '0.1.0', resumeAfter: 14, observes: ['session.*', 'turn.*', 'tool.*', 'approval.*'] }),
    // ① §4.7 瞬态 TTL 恢复：tool.result(error) → transient → 2 s 后回 working
    ev(0, 'session.start', { nativeSessionId: X, startedAt: T0 }),
    ev(500, 'turn.start', { turnId: 't', inputKind: 'user' }),
    ev(1000, 'tool.call', { callId: 'c', toolName: 'Edit', category: 'write', risk: 1 }),
    ev(1500, 'tool.result', { callId: 'c', status: 'error' }),
    ev(4000, 'step.start', { turnId: 't', stepId: 's', index: 0 }),
    // ② §4.2 会话级 aborted 例外：X 处于 waiting，Y 的 aborted/end 不得顶掉整体 waiting
    ev(5000, 'approval.request', { requestId: 'rx', kind: 'command', summary: 'x', risk: 1 }),
    ev(6000, 'session.start', { nativeSessionId: Y, startedAt: T0 + 6000 }, Y),
    ev(6100, 'turn.start', { turnId: 'ty', inputKind: 'user' }, Y),
    ev(6200, 'turn.end', { turnId: 'ty', status: 'aborted' }, Y),
    ev(6300, 'session.end', { nativeSessionId: Y, endedAt: T0 + 6300, reason: 'aborted' }, Y),
    // ③ §3.4 override：低优先级被拒；force 生效
    ev(10000, 'agent.status', { state: 'idle' }),
    ev(10500, 'agent.status', { state: 'waiting', force: true }),
    // ④ §4.4 45 s source 离线：claude-code 在 21000 后不再有帧
    ev(20000, 'session.start', { nativeSessionId: 'cc-1', startedAt: T0 + 20000 }, 'cc-1'),
    ev(21000, 'turn.start', { turnId: 'tcc', inputKind: 'user' }, 'cc-1'),
  ];
  for (let t = 30000; t <= 660000; t += 30000) out.push(hb(t));   // 心跳保活 dsh（不刷新 §4.5 计时）
  out.push(
    // ⑤ §4.6 窗口外迟到（seq 2 < 高水位 3，且从未出现过）+ §2.4 重复 seq（seq 3 第二次到达）
    raw('session-ZZZZ', 0, 700000, 'session.start', { nativeSessionId: 'session-ZZZZ', startedAt: T0 + 700000 }),
    raw('session-ZZZZ', 1, 700200, 'turn.start', { turnId: 'tz', inputKind: 'user' }),
    raw('session-ZZZZ', 3, 700400, 'tool.call', { callId: 'cz', toolName: 'Bash', category: 'exec', risk: 0 }),   // 故意跳过 seq 2
    raw('session-ZZZZ', 2, 700600, 'step.start', { turnId: 'tz', stepId: 's1', index: 0 }),                       // ← 迟到（§4.6）
    raw('session-ZZZZ', 3, 700800, 'tool.call', { callId: 'cz', toolName: 'Bash', category: 'exec', risk: 0 }),   // ← 重复（§2.4）
    JSON.stringify({ ctl: 'snapshot', contract: 1, ts: T0 + 702000, agg: 'idle', sessions: [], bubble: null, effect: null, unknownEvents: 0, offlineSources: ['claude-code'], now: null, counters: {}, clearedPending: [] }),
  );
  return out;
}


function negativeCases() {
  const base = { v: 1, seq: 0, ts: 1791172500000, source: 'dsh', sessionId: 'session-X', workspace: null, type: 'turn.start', data: { turnId: 't', inputKind: 'user' } };
  const big = 'x'.repeat(9000);
  return [
    ['缺 data 字段', JSON.stringify((({ data, ...r }) => r)(base))],
    ['seq 是字符串', JSON.stringify({ ...base, seq: '0' })],
    ['type 非字符串', JSON.stringify({ ...base, type: 42 })],
    ['sessionId 字段缺失（v1.2 必填）', JSON.stringify((({ sessionId, ...r }) => r)(base))],
    ['v=2 版本不匹配', JSON.stringify({ ...base, v: 2 })],
    ['单事件 > 8KB', JSON.stringify({ ...base, data: { turnId: 't', inputKind: 'user', text: big } })],
    ['approval.request 缺 requestId（v1.2 必填）', JSON.stringify({ ...base, type: 'approval.request', data: { kind: 'command', summary: 's', risk: 1 } })],
    ['tool.call 缺 risk（§2.3 未标注=必填）', JSON.stringify({ ...base, type: 'tool.call', data: { callId: 'c', toolName: 'Bash', category: 'exec' } })],
    ['turn.end.status 非法枚举', JSON.stringify({ ...base, type: 'turn.end', data: { turnId: 't', status: 'done' } })],
    ['agent.status 用 done（v1.2 不支持）', JSON.stringify({ ...base, type: 'agent.status', data: { state: 'done' } })],
    ['未知 ctl 控制帧', JSON.stringify({ ctl: 'bogus', contract: 1 })],
  ];
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opts = {
  bufferMs: Number((argv.find(a => a.startsWith('--buffer-ms=')) || '').split('=')[1]) || 2000,
  bufferCount: Number((argv.find(a => a.startsWith('--buffer-count=')) || '').split('=')[1]) || 32,
  staleMs: Number((argv.find(a => a.startsWith('--stale-ms=')) || '').split('=')[1]) || STALE_MS,
  offlineMs: Number((argv.find(a => a.startsWith('--offline-ms=')) || '').split('=')[1]) || OFFLINE_MS,
};
const asJson = argv.includes('--json');
const files = argv.filter(a => !a.startsWith('--'));
let exitCode = 0;
const outputs = [];

if (argv.includes('--selftest')) {
  const dir = mkdtempSync(join(tmpdir(), 'pet-v12-'));
  const main = join(dir, 'selftest-v12.pet.jsonl');
  const lines = selfTestSample();
  writeFileSync(main, lines.join('\n') + '\n');
  outputs.push(report(main, parseJsonl(lines.join('\n') + '\n'), opts, asJson));
  const br = join(dir, 'branch-v12.pet.jsonl');
  const blines = branchSample();
  writeFileSync(br, blines.join('\n') + '\n');
  outputs.push(report(br, parseJsonl(blines.join('\n') + '\n'), opts, asJson));
  const neg = negativeCases();
  const negLines = ['=== 负例（v1.2 规则，应全部被拒绝）==='];
  for (const [label, raw] of neg) negLines.push('  ' + (validateFrame(raw, Buffer.byteLength(raw, 'utf8')).ok ? '❌ 未被拒绝' : '✅ 已拒绝') + ' | ' + label + ' → ' + validateFrame(raw, Buffer.byteLength(raw, 'utf8')).errors.join('; '));
  outputs.push(negLines.join('\n'));
} else if (files.length === 0) {
  console.error('用法: node scripts/replay-check.mjs <fixture.pet.jsonl ...> | --selftest [--json]');
  process.exit(2);
} else {
  for (const f of files) {
    let text;
    try { text = readFileSync(f, 'utf8'); } catch (e) { console.error('无法读取 ' + f + ': ' + e.message); exitCode = 1; continue; }
    const entries = parseJsonl(text);
    const rep = report(f, entries, opts, asJson);
    outputs.push(rep);
    if (entries.some(e => !e.ok)) exitCode = 1;
  }
}
console.log(asJson ? JSON.stringify(outputs, null, 1) : outputs.join('\n'));
process.exit(exitCode);
