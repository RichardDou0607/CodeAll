const EVENTS = __EVENTS__;
const PRIORITY = { waiting: 5, 'transient-error': 4, error: 3, working: 2, thinking: 1, done: 0, idle: -1 };
const LABEL = { idle: '空闲', thinking: '思考中', working: '工作中', waiting: '等待批准', 'transient-error': '出错', error: '错误', done: '已完成' };
const COLOR = { idle: '#8b98a9', thinking: '#4aa8ff', working: '#3fb950', waiting: '#e3b341', 'transient-error': '#e3b341', error: '#f85149', done: '#bc8cff' };
const MAXROWS = 5, REAL_N = __REAL__, SYNTH_N = __SYNTH__;
const hub = { sessions: new Map(), pending: new Map(), recent: [], counters: { unknownEvents: 0, noop: 0, orphanApprovals: 0, recoveredErrors: 0, escalatedErrors: 0, duplicates: 0 }, last: null, agg: 'idle' };
function agg() { let b = 'idle'; for (const s of hub.sessions.values()) if (PRIORITY[s.state] > PRIORITY[b]) b = s.state; return b; }
function set(s, st, why) { if (s.state === st) return; s.state = st; s.since = hub.last ? hub.last.ts : Date.now(); s.why = why || ''; if (!['waiting', 'transient-error', 'error'].includes(st)) s.stable = st; }
function apply(ev) {
  if (ev.ctl) return;
  const id = ev.sessionId ?? 'backend';
  let s = hub.sessions.get(id);
  if (!s) { s = { id, source: ev.source, state: 'idle', stable: 'idle', since: ev.ts, title: (ev.data && (ev.data.title || ev.data.workspace)) || id.replace(/^session-/, '').slice(0, 10), pending: 0, synthetic: !!ev.synthetic }; hub.sessions.set(id, s); }
  if (ev.data && ev.data.workspace && !s.synthetic) s.title = String(ev.data.workspace).split('/').pop();
  const d = ev.data || {}; hub.last = ev;
  switch (ev.type) {
    case 'session.start': case 'turn.start': set(s, 'thinking', ev.type); break;
    case 'turn.end': set(s, d.status === 'ok' ? 'done' : d.status === 'error' ? 'error' : 'idle', 'turn.end'); break;
    case 'session.end': set(s, d.reason === 'error' ? 'error' : d.reason === 'done' ? 'done' : 'idle', 'session.end'); break;
    case 'step.start': case 'step.end': set(s, d.status === 'error' ? 'transient-error' : 'working', ev.type); break;
    case 'tool.call': s.lastTool = d.summary || d.toolName || ''; set(s, 'working', 'tool:' + (d.toolName || '')); break;
    case 'tool.result': if (d.status === 'error') { hub.counters.recoveredErrors++; set(s, 'transient-error', 'tool error'); } break;
    case 'approval.request': case 'user.question': { const rid = d.requestId ?? d.questionId ?? ('anon' + ev.seq); hub.pending.set(rid, { sid: id, before: s.state }); s.pending++; set(s, 'waiting', ev.type); break; }
    case 'approval.resolved': case 'user.answer': { const rid = d.requestId ?? d.questionId; const p = hub.pending.get(rid); if (!p) { hub.counters.orphanApprovals++; break; } hub.pending.delete(rid); s.pending = Math.max(0, s.pending - 1); if (d.decision === 'timeout') set(s, 'transient-error', 'timeout'); else set(s, p.before === 'waiting' ? 'working' : p.before, 'resolved'); break; }
    case 'agent.status': set(s, d.state, 'agent.status'); break;
    case 'error.raised': if (d.fatal) set(s, 'error', 'fatal'); else hub.counters.noop++; break;
    case 'pet.heartbeat': case 'message.assistant': hub.counters.noop++; break;
    default: hub.counters.unknownEvents++;
  }
  hub.recent.unshift({ ts: ev.ts, type: ev.type, text: describe(ev) });
  if (hub.recent.length > 7) hub.recent.pop();
  hub.agg = agg();
}
function describe(ev) { const d = ev.data || {}; switch (ev.type) {
  case 'tool.call': return '调用 ' + (d.toolName || '?') + (d.summary ? ' · ' + clip(d.summary, 30) : '');
  case 'tool.result': return '工具' + (d.status === 'ok' ? '成功' : d.status === 'error' ? '失败' : '被拒') + (d.durationMs ? ' · ' + d.durationMs + 'ms' : '');
  case 'step.start': return '第 ' + (d.index ?? '?') + ' 步开始'; case 'step.end': return '第 ' + (d.index ?? '?') + ' 步结束';
  case 'message.assistant': return '助手输出（已截断/脱敏）'; case 'turn.start': return '新一轮开始';
  case 'turn.end': return '本轮结束（' + (d.status || '?') + '）'; case 'session.start': return '会话开始';
  case 'session.end': return '会话结束（' + (d.reason || '?') + '）'; case 'approval.request': return '等待批准：' + clip(d.summary || '', 24);
  case 'approval.resolved': return '审批结果：' + (d.decision || '?'); case 'error.raised': return '错误：' + clip(d.message || '', 24);
  default: return ev.type; } }
function clip(s, n) { s = String(s).replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function mmss(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function render(i) {
  const ev = EVENTS[i], now = ev ? ev.ts : Date.now(), A = hub.agg;
  const sess = [...hub.sessions.values()].sort((a, b) => PRIORITY[b.state] - PRIORITY[a.state]);
  const pend = sess.reduce((a, s) => a + s.pending, 0);
  const cur = hub.sessions.get((hub.last && hub.last.sessionId) ?? 'backend') || { since: now };
  const elapsed = now - cur.since;
  const d = (hub.last && hub.last.data) || {};
  const action = (d.index ? '第 ' + d.index + ' 步 · ' : '') + (d.toolName || d.summary || '—');
  const rows = sess.slice(0, MAXROWS).map(s => '<div class="row"><i class="bar" style="background:' + COLOR[s.state] + '"></i><span class="dot" style="background:' + COLOR[s.state] + ';color:' + COLOR[s.state] + '"></span><span class="src">' + esc(s.source.toUpperCase()) + '</span><span class="name">' + esc(s.title || s.id) + '</span><span class="st" style="color:' + COLOR[s.state] + '">' + LABEL[s.state] + '</span><span class="tm">' + (s.state === 'idle' ? '--' : s.state === 'done' ? '完成' : mmss(now - s.since)) + '</span>' + (s.pending ? '<span class="pend">+' + s.pending + '</span>' : '') + '</div>').join('');
  document.getElementById('frame').innerHTML =
    '<div class="head"><span class="dot" style="background:' + COLOR[A] + ';color:' + COLOR[A] + '"></span><span class="agg" style="color:' + COLOR[A] + '">' + LABEL[A] + '</span><span class="action">' + esc(clip(action, 26)) + '</span><span class="time">' + mmss(elapsed) + '</span>' + (pend ? '<span class="pend">+' + pend + '</span>' : '') + '</div>' + rows +
    '<div class="foot"><span>' + (sess.length > MAXROWS ? '+' + (sess.length - MAXROWS) + ' 个会话（折叠）' : sess.length + ' 个会话') + '</span><span>未知 ' + hub.counters.unknownEvents + ' · 孤儿审批 ' + hub.counters.orphanApprovals + ' · no-op ' + hub.counters.noop + '</span></div>';
  document.getElementById('log').innerHTML = hub.recent.map(r => '<div><span class="t">' + mmss(now - r.ts) + ' 前</span><span class="ty">' + esc(r.type) + '</span><span class="tx">' + esc(r.text) + '</span></div>').join('');
  document.getElementById('strip').innerHTML = EVENTS.slice(Math.max(0, i - 59), i + 1).map(e => { const s = hub.sessions.get(e.sessionId ?? 'backend'); return '<i style="background:' + COLOR[(s && s.state) || 'idle'] + '" title="#' + e.i + ' ' + e.type + '"></i>'; }).join('');
  document.getElementById('pos').textContent = (i + 1) + ' / ' + EVENTS.length;
  document.getElementById('stats').innerHTML = '聚合状态：<b style="color:' + COLOR[A] + '">' + LABEL[A] + '</b> · 会话 ' + sess.length + ' 个 · 事件 ' + EVENTS.length + ' 条（真实 ' + REAL_N + ' / 合成 ' + SYNTH_N + '）';
}
function reset() { hub.sessions.clear(); hub.pending.clear(); hub.recent = []; hub.last = null; hub.agg = 'idle'; hub.counters = { unknownEvents: 0, noop: 0, orphanApprovals: 0, recoveredErrors: 0, escalatedErrors: 0, duplicates: 0 }; }
let idx = 0, playing = true, acc = 0, lastT = performance.now();
function tick(t) {
  const dt = t - lastT; lastT = t; const speed = Number(document.getElementById('speed').value);
  if (playing) {
    acc += dt * speed * 0.05;
    while (acc >= 1 && idx < EVENTS.length) { apply(EVENTS[idx]); idx++; acc -= 1; }
    if (idx >= EVENTS.length) { playing = false; document.getElementById('play').textContent = '已结束 · 重播'; }
    render(Math.max(0, Math.min(idx, EVENTS.length - 1)));
  }
  requestAnimationFrame(tick);
}
document.getElementById('play').onclick = () => { if (idx >= EVENTS.length) { reset(); idx = 0; playing = true; } else playing = !playing; document.getElementById('play').textContent = playing ? '暂停' : '继续'; };
document.getElementById('step').onclick = () => { playing = false; document.getElementById('play').textContent = '继续'; if (idx < EVENTS.length) { apply(EVENTS[idx]); idx++; } render(Math.max(0, idx - 1)); };
document.getElementById('restart').onclick = () => { reset(); idx = 0; playing = true; document.getElementById('play').textContent = '暂停'; };
apply(EVENTS[0]); idx = 1; render(0); requestAnimationFrame(t => { lastT = t; tick(t); });