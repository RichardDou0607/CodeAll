#!/usr/bin/env node
/**
 * demo/build-html.mjs — 生成自包含可视化演示 demo/frame.html（生成产物，不入库）
 * 输入：fixtures/contract-sample.pet.jsonl（合成契约样本）+ 合成的多会话事件（演示 5 行 + 折叠 +N）。
 * 隐私口径：真实会话录制一律只留在本地（fixtures/session-replay*.pet.jsonl 已 gitignore），演示数据全部合成。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const replay = fs.readFileSync(path.join(ROOT, 'fixtures', 'contract-sample.pet.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const base = replay[0].ts;
const events = replay.map(e => ({ ...e, t: e.ts - base }));
const synth = [];
let st = 0;
const mk = (source, sessionId, type, data, dt) => { st += dt; synth.push({ v: 1, seq: 9000 + synth.length, ts: base + st, source, sessionId, workspace: '/Users/demo/' + sessionId, type, data, t: st, synthetic: true }); };
mk('claude-code', 'cc-api-fix', 'session.start', { nativeSessionId: 'cc-api-fix', startedAt: base, workspace: '/Users/demo/api-fix' }, 200);
mk('claude-code', 'cc-api-fix', 'turn.start', { turnId: 't1', inputKind: 'user' }, 400);
mk('codex', 'cx-docs', 'session.start', { nativeSessionId: 'cx-docs', startedAt: base, workspace: '/Users/demo/docs' }, 300);
mk('codex', 'cx-docs', 'step.start', { turnId: 't1', stepId: 's1', index: 1 }, 500);
mk('cursor', 'cu-ui', 'session.start', { nativeSessionId: 'cu-ui', startedAt: base, workspace: '/Users/demo/web-ui' }, 300);
mk('cursor', 'cu-ui', 'tool.call', { callId: 'c1', toolName: 'edit_file', category: 'write', risk: 2, summary: 'src/App.tsx' }, 600);
mk('claude-code', 'cc-api-fix', 'approval.request', { requestId: 'req-1', kind: 'file-write', summary: '要修改 src/auth.ts（3 处）', risk: 2 }, 900);
mk('gemini-cli', 'gm-tests', 'session.start', { nativeSessionId: 'gm-tests', startedAt: base, workspace: '/Users/demo/tests' }, 400);
mk('codex', 'cx-docs', 'tool.result', { callId: 'c2', status: 'ok', durationMs: 812 }, 700);
mk('aider', 'ai-lint', 'session.start', { nativeSessionId: 'ai-lint', startedAt: base, workspace: '/Users/demo/lint' }, 500);
mk('claude-code', 'cc-api-fix', 'approval.resolved', { requestId: 'req-1', decision: 'allow', latencyMs: 4200 }, 1400);
mk('claude-code', 'cc-api-fix', 'tool.result', { callId: 'c3', status: 'error', durationMs: 233 }, 900);
mk('cursor', 'cu-ui', 'tool.result', { callId: 'c1', status: 'ok', durationMs: 1500 }, 800);
mk('codex', 'cx-docs', 'turn.end', { turnId: 't1', status: 'ok', durationMs: 42000 }, 900);
mk('gemini-cli', 'gm-tests', 'session.end', { nativeSessionId: 'gm-tests', endedAt: base + st, reason: 'done' }, 700);
mk('cursor', 'cu-ui', 'session.end', { nativeSessionId: 'cu-ui', endedAt: base + st, reason: 'done' }, 900);
mk('aider', 'ai-lint', 'error.raised', { scope: 'session', message: '模型调用失败（演示）', fatal: false }, 700);
const all = events.concat(synth).map((e, i) => ({ ...e, i }));
function buildHtml() {
  const css = fs.readFileSync(new URL('./assets/frame.css', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('./assets/frame-player.js', import.meta.url), 'utf8')
    .replace('__EVENTS__', JSON.stringify(all))
    .replace('__REAL__', String(events.length))
    .replace('__SYNTH__', String(synth.length));
  return '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<title>Agent 工作框 · 可视化演示（契约 v1.2）</title>\n<style>\n' + css + '\n</style>\n</head>\n<body>\n' +
    '<div class="stage">\n  <div class="frame" id="frame"></div>\n' +
    '  <div class="panel">\n    <h3>最近事件（规范事件 · 契约 v1.2）</h3>\n    <div class="log" id="log"></div>\n' +
    '    <h3 style="margin-top:12px">状态时间线</h3>\n    <div class="strip" id="strip"></div>\n' +
    '    <div class="hint" style="margin-top:8px;text-align:left" id="stats"></div>\n  </div>\n</div>\n' +
    '<div class="ctrls">\n  <button id="play">暂停</button>\n  <button id="step">单步</button>\n' +
    '  <label style="font-size:12px;color:var(--dim)">速度 <input id="speed" type="range" min="1" max="20" value="6"></label>\n' +
    '  <span class="badge" id="pos"></span>\n  <button id="restart">重播</button>\n</div>\n' +
    '<div class="hint"><b>真实数据</b>：__REAL__ 条规范事件来自本机 DSH 会话的真实录制（<code>fixtures/session-replay.pet.jsonl</code>，转换脚本 <code>demo/record-replay.mjs</code>）；另 __SYNTH__ 条为<b>合成多会话事件</b>（演示 5 行 + 折叠 +N 布局，标记 synthetic）。状态机与计数器严格按 <code>docs/00-interface-contract.md</code> v1.2 §4 实现（与 <code>adapters/_reference/hub-minimal.mjs</code> 同规则）。</div>\n' +
    '<script>\n' + js + '\n</script>\n</body>\n</html>\n';
}
const html = buildHtml().replace('__REAL__', String(events.length)).replace('__SYNTH__', String(synth.length));
fs.writeFileSync('demo/frame.html', html);
console.log(JSON.stringify({ out: 'demo/frame.html', bytes: html.length, realEvents: events.length, synthEvents: synth.length, total: all.length }, null, 1));
