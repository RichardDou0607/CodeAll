// Minimal Hub prototype: reads canonical events (JSONL) from stdin or file,
// applies the contract state machine, prints pet.snapshot-style status lines.
// Used as the skeleton reference for packages/hub in the roadmap.
import fs from 'node:fs';
import readline from 'node:readline';

const PRIORITY = { waiting: 5, 'transient-error': 4, error: 3, working: 2, thinking: 1, done: 0, idle: -1 };
const sessions = new Map(); // sessionId -> { state, since, stable, pending: Map }
let counters = { unknownEvents: 0, noop: 0, orphanApprovals: 0, duplicates: 0, lateEvents: 0, recoveredErrors: 0, escalatedErrors: 0 };
const seen = new Set();
const TTL_TRANSIENT = new Map(); // sessionId -> { revertTo, at }

function agg() {
  let best = 'idle';
  for (const s of sessions.values()) if (PRIORITY[s.state] > PRIORITY[best]) best = s.state;
  return best;
}
function setState(sess, state) { if (sess.state !== state) { sess.state = state; sess.since = Date.now(); } }

function apply(ev) {
  const key = ev.source + '|' + ev.sessionId + '|' + ev.seq;
  if (seen.has(key)) { counters.duplicates++; return; }
  seen.add(key);
  const id = ev.sessionId ?? 'backend';
  let sess = sessions.get(id);
  if (!sess) { sess = { state: 'idle', since: ev.ts, stable: 'idle', pending: new Map() }; sessions.set(id, sess); }
  const d = ev.data ?? {};
  const t = ev.type;
  switch (t) {
    case 'session.start': case 'turn.start': setState(sess, 'thinking'); break;
    case 'turn.end': setState(sess, d.status === 'ok' ? 'done' : d.status === 'error' ? 'error' : 'idle'); break;
    case 'session.end': setState(sess, d.reason === 'error' ? 'error' : 'idle'); break;
    case 'step.start': case 'tool.call': setState(sess, 'working'); break;
    case 'tool.result': case 'step.end':
      if (d.status === 'error') { TTL_TRANSIENT.set(id, { revertTo: sess.stable, at: Date.now() }); setState(sess, 'transient-error'); counters.recoveredErrors++; }
      break;
    case 'approval.request': case 'user.question': {
      const rid = d.requestId ?? d.questionId;
      sess.pending.set(rid, { before: sess.state });
      sess.stable = sess.state === 'waiting' ? sess.stable : sess.state;
      setState(sess, 'waiting'); break;
    }
    case 'approval.resolved': case 'user.answer': {
      const rid = d.requestId ?? d.questionId;
      if (!sess.pending.has(rid)) { counters.orphanApprovals++; break; }
      const before = sess.pending.get(rid).before; sess.pending.delete(rid);
      setState(sess, d.decision === 'timeout' ? 'error' : (before === 'waiting' ? 'working' : before));
      break;
    }
    case 'agent.status': setState(sess, d.state); break;
    case 'error.raised': if (d.fatal) setState(sess, 'error'); break;
    case 'pet.heartbeat': case 'message.assistant': counters.noop++; break;
    default: counters.unknownEvents++;
  }
  if (!['waiting', 'transient-error', 'error'].includes(sess.state)) sess.stable = sess.state;
}

const input = process.argv[2] ? fs.createReadStream(process.argv[2]) : process.stdin;
const rl = readline.createInterface({ input });
let lines = 0;
for await (const line of rl) {
  if (!line.trim()) continue;
  let ev; try { ev = JSON.parse(line); } catch { continue; }
  if (ev.ctl) continue; // control frames are not events
  lines++; apply(ev);
}
console.log(JSON.stringify({ events: lines, agg: agg(), counters,
  sessions: [...sessions.entries()].map(([sessionId, s]) => ({ sessionId, state: s.state, since: s.since, pending: s.pending.size })) }, null, 1));
