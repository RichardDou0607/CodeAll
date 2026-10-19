#!/usr/bin/env node
/**
 * demo/test-aborted-state.mjs — 「手动停止 ≠ 出错」回归（契约 v1.4）
 * 背景：ZCode 被用户中断时，在飞工具落盘 state.status='error' + "… was cancelled" 错误文本，
 *       且回合不再写终态——旧映射把它当 tool.result(error) → transient-error（PINNED 永不过期），
 *       mini 条该会话就一直显示「出错」。本测试锁住三层口径：
 *   ① zcode 适配器：取消签名 → tool.result(aborted) / 粗状态 aborted（真错误仍走 error/running）
 *   ② frame.mjs hub（契约参考实现）：aborted 事件 → 会话态 aborted，不计 recoveredErrors
 *   ③ mini.html：aborted 会话显示「手动停止」，不抢 waiting 的紧急显示
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { createHub } from './frame.mjs';
import { createUiSandbox } from './test-ui-dom.mjs';
import { mapZcodeRow, coarseStateFromZcodeRows, isCancelledToolError } from '../adapters/zcode-adapter.mjs';

const checks = [];
const check = (name, pass) => { checks.push([name, pass]); };

// ---------- ① zcode 适配器：取消签名判定 ----------
// 签名样本取自 2026-10-19 本机 ~/.zcode 全库 tool error 文本分布（真实用户中断落盘）
const CANCEL_SAMPLES = [
  'Agent was cancelled before the subagent returned findings or backgrounded',
  'Bash was cancelled and the child process was asked to stop',
  'TaskOutput was cancelled while waiting for the task to finish',
  'WebFetch was cancelled before the page could be processed',
  'MCP tool mcp__computer-use__wait was cancelled',
  'Tool execution was interrupted during streaming recovery before this tool call completed',
];
const REAL_ERROR_SAMPLES = [
  'File has been modified since read, either by the user or by a linter',
  'fetch failed: connect ECONNREFUSED 168.235.95.131:443',
  'String to replace not found in file. String: int main() {',
  'Tool input failed inputSchema validation',
];
check('取消签名全部识别（cancelled/interrupted）', CANCEL_SAMPLES.every(t => isCancelledToolError(t) === true));
check('真错误全部不误判', REAL_ERROR_SAMPLES.every(t => isCancelledToolError(t) === false));
check('空值 / 对象型错误不误判', isCancelledToolError(null) === false && isCancelledToolError(undefined) === false
  && isCancelledToolError({ message: 'Bash was cancelled and the child process was asked to stop' }) === true);

// ---------- ①' mapZcodeRow：事件分流 ----------
const ctx = { sessionId: 'sess_t', seq: 0 };
const row = (data) => mapZcodeRow({ tbl: 'part', data, time_created: 1, time_updated: 2 }, ctx);
const evCancelled = row({ type: 'tool', tool: 'Agent', callID: 'c1', state: { status: 'error', error: 'Agent was cancelled before the subagent returned findings' } });
const evReal = row({ type: 'tool', tool: 'Edit', callID: 'c2', state: { status: 'error', error: 'String to replace not found in file.' } });
const evOk = row({ type: 'tool', tool: 'Read', callID: 'c3', state: { status: 'completed' } });
check('被取消的工具 → tool.result(aborted)', evCancelled.length === 1 && evCancelled[0].type === 'tool.result' && evCancelled[0].data.status === 'aborted');
check('真错误工具 → tool.result(error)（行为不变）', evReal.length === 1 && evReal[0].data.status === 'error');
check('成功工具 → tool.result(ok)（行为不变）', evOk.length === 1 && evOk[0].data.status === 'ok');
const evTurnAborted = mapZcodeRow({ tbl: 'message', data: { role: 'assistant', finish: 'interrupted' }, time_created: 1, time_updated: 2 }, ctx);
check('消息 finish=interrupted → turn.end(aborted)（行为不变）', evTurnAborted[0].data.status === 'aborted');

// ---------- ①'' coarseStateFromZcodeRows：目录粗状态 ----------
const rows = (arr) => arr.map(([tbl, data]) => ({ tbl, data, time_updated: 5, time_created: 1 }));
const coarse = (arr) => coarseStateFromZcodeRows(rows(arr), { now: 10_000 });
check('目录：最新显著行为被取消工具 → aborted', coarse([[ 'part', { type: 'tool', tool: 'Bash', state: { status: 'error', error: 'Bash was cancelled and the child process was asked to stop' } } ]]).state === 'aborted');
check('目录：真错误工具后 agent 继续 → running（行为不变）', coarse([[ 'part', { type: 'tool', tool: 'Edit', state: { status: 'error', error: 'String to replace not found' } } ]]).state === 'running');
check('目录：finish=interrupted 消息 → aborted（原 idle）', coarse([[ 'message', { role: 'assistant', finish: 'interrupted' } ]]).state === 'aborted');
check('目录：finish=stop 消息 → done（行为不变）', coarse([[ 'message', { role: 'assistant', finish: 'stop' } ]]).state === 'done');

// 滞留修正的取消例外：tool-calls 消息（最新显著行）+ 其下几毫秒的被取消工具 + 超 5min 无新行 → aborted（非 idle）
// （真实形态：2026-10-19 中断会话的尾部——msg tool-calls @…04.154 盖住 cancelled tool @…04.149）
const staleRows = [
  ['message', { role: 'assistant', finish: 'tool-calls' }],                                            // 最新显著行 → running
  ['part', { type: 'tool', tool: 'Agent', state: { status: 'error', error: 'Agent was cancelled before the subagent returned findings' } }],
];
const coarseStale = (arr, now) => coarseStateFromZcodeRows(rows(arr), { now });
check('目录：滞留 running + 尾部被取消工具 → aborted', coarseStale(staleRows, 10_000 + 300_001).state === 'aborted');
check('目录：滞留 running + 尾部真错误工具 → idle（行为不变）', coarseStale([
  ['message', { role: 'assistant', finish: 'tool-calls' }],
  ['part', { type: 'tool', tool: 'Edit', state: { status: 'error', error: 'String to replace not found' } }],
], 10_000 + 300_001).state === 'idle');
check('目录：滞留 running + 无工具行 → idle（行为不变）', coarseStale([['message', { role: 'assistant', finish: 'tool-calls' }]], 10_000 + 300_001).state === 'idle');

// ---------- ② frame.mjs hub：aborted 会话态 ----------
const hub = createHub();
const send = (type, data) => hub.apply({ v: 1, seq: hubSeq++, ts: Date.now(), source: 'zcode', sessionId: 'sess_t', type, data });
let hubSeq = 1;
send('session.start', { workspace: '/a/agent宠' });
send('tool.call', { callId: 'c1', toolName: 'Agent', category: 'other' });
const recoveredBefore = hub.counters.recoveredErrors;
send('tool.result', { callId: 'c1', status: 'aborted' });
const st = hub.sessions.get('sess_t');
check('hub：tool.result(aborted) → 会话态 aborted', st?.state === 'aborted');
check('hub：aborted 不计入 recoveredErrors（错误计数）', hub.counters.recoveredErrors === recoveredBefore);
send('turn.end', { turnId: 'turn-1', status: 'aborted' });
check('hub：turn.end(aborted) → 保持 aborted（非 idle）', hub.sessions.get('sess_t')?.state === 'aborted');

// ---------- ③ mini.html：手动停止显示与不抢占 ----------
const html = fs.readFileSync(new URL('./mini.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/let es=null;[\s\S]*$/, '');
const ui = createUiSandbox(html);
ui.sandbox.window.__PET_TOKEN__ = 't';
const sandbox = ui.sandbox;
vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'mini-inline.js' });
const now = Date.now();
const sess = (id, source, state, sinceAgo) => ({ id, source, label: id + '-标题', state, since: now - sinceAgo, elapsedMs: sinceAgo, pending: 0, model: 'm', kind: 'main', projectKey: 'ws-1' });
const snap = (sessions) => ({ v: 1, ts: now, agg: 'idle', sessions, counters: {}, stateCounts: {}, agents: [], inputs: [], lastEvent: null, capabilities: {}, catalog: { projects: [{ key: 'ws-1', name: 'agent桌宠', cwd: '/a' }], history: [] } });

// 仅有 aborted 会话 → 显示「手动停止」+ 右侧时间位「停止」
const outAborted = sandbox.render(snap([sess('s-z', 'zcode', 'aborted', 30_000)]));
check('mini：aborted 会话显示「手动停止」', outAborted.state === '手动停止');
const tmEl = ui.getEl('m-tm');
check('mini：aborted 时间位显示「停止」（非计时）', tmEl.textContent === '停止');
// aborted 与 running 并存 → 显示 running（手动停止不抢占优先级）
const outMixed = sandbox.render(snap([sess('s-z', 'zcode', 'aborted', 5_000), sess('s-r', 'claude-code', 'running', 60_000)]));
check('mini：aborted 不抢占 running 的显示', outMixed.title.includes('s-r') && outMixed.state === '运行中');
// aborted 与 waiting 并存 → 紧急显示 waiting（不被 aborted 顶掉）
const outWait = sandbox.render(snap([sess('s-z', 'zcode', 'aborted', 1_000), sess('s-w', 'codex', 'waiting', 10_000)]));
check('mini：waiting 仍优先于 aborted', outWait.state === '等你' && outWait.title.includes('s-w'));

let ok = true;
for (const [name, pass] of checks) { console.log((pass ? '✅ ' : '❌ ') + name); if (!pass) ok = false; }
process.exit(ok ? 0 : 1);
